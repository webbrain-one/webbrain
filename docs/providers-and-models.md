# Providers & Models

---

## Main provider and assistive models

The **Providers** page (`ui/providers.html`, opened from **More…** in the side
panel's model menu or from the Settings header) selects the main model for
conversation, planning and final replies on its **LLM** tab. Its other tabs hold
the assistive models: Vision, Speech (speech to text), Generative (powering the
`generate_image` agent tool), Decision models, and SafeSocial. Screenshot limits
are in Settings → Budgets and screenshot redaction in Settings → Advanced.
Configuring an assistive model does not replace the active provider. Decision models share one provider/model
selection with separate completion, watch, scheduled-check, classification and browser
decision switches. See [the settings guide](https://webbrain.one/docs/settings/#multimodal)
and [data flow](privacy-and-data-flow.md#decision-models-and-completion-verification)
for setup and disclosure details. Existing `#multimodal` settings links still work.

In the side panel's composer, the model menu shows the selected provider's logo,
the same as its row in the menu (Compass Max uses the Compass logo), and an
engine icon while the logo loads or when the provider has none. The dot on the
icon's corner shows the selected provider's latest connection check: green when
it answered, red when it failed, amber while it runs. The dot is part of the
menu button, so clicking it opens the menu, and the button's accessible
description carries the status.

Browser chat includes the configured main provider and text-model labels in its
trusted per-turn context, so identity answers can use the current selection
instead of guessing. Assistive model labels stay separate. Automatic routes such
as `openrouter/free` identify the configured route; they do not establish which
upstream model the router selected. Endpoint URLs, credentials, local model paths
and private inference-profile ARNs are omitted from this identity context.

### Gemini 4 Argon and new Muse models

The Providers page suggests `gemini-4-argon` on Google Gemini and
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

A decision model answers the agent's fixed-choice questions (is the task
finished, did a watch find what it waited for, what does a request say about an
action) so the chat model does not have to. The Decision tab of the Providers
page asks one question first:

- **Auto** (default) needs no setup. In Chrome, once Compass VLD Tiny v5 (the
  in-browser chat model, below) is downloaded on this device, it is Auto's
  decision model for completion checks and scheduled watch and completion
  checks, whatever the chat provider, except while the task keeps another
  in-browser model loaded: a WebGPU chat model other than v5, or the
  in-browser model that reads screenshots for a provider that cannot see
  them. The WebGPU worker holds one model at a time, so a check would unload
  that model and the task's next turn or screenshot would load it again
  (`agent._inBrowserModels`). The Chrome install guide's **Download
  local models** button downloads it, and so does Providers → WebGPU or
  Apocalypse Mode. Without it, or while it would unload another model, a
  downloaded D1 (below), which runs in its own worker, takes the same checks:
  **Download and load** under On → D1 downloads it, in both browsers, and D1
  serves Auto while that Download or Load stands: **Unload**, **Remove cached
  model** and Off end it. While Compass is the chat provider, Compass's
  managed decision model keeps semantic decisions, and answers completion
  checks too until one of these is downloaded. Otherwise no decision model is
  used. Readiness (`agent/decision-availability.js`) is the chat model's
  ready marker in Cache Storage and the task's in-browser models (read only
  when the chat model could answer), then D1's experimental-model consent, the
  stored Load request and the package's ready marker in its OPFS directory
  (`providers/d1-cache.js`), all read without starting the offscreen document,
  the Worker or the GPU. Other downloaded chat or vision models, Ternary
  Bonsai 2 2B Vision included, never enable decisions
  ([`webgpu-models.md`](webgpu-models.md#decisions-on-webgpu)).
- **On** uses the provider configured below for every decision: completion,
  scheduled watches and completions, fast classifications, fast browser
  actions and semantic decisions. The first five each have a switch in the collapsed
  "Choose which decisions use it" section (an unset switch is on), while semantic
  decisions always use the selected provider. Profiles saved before modes existed
  with System One enabled read as On and keep their opt-in switches.
- **Off** uses no decision model, Compass's managed one included. The active
  chat model keeps verifying completion.

`decisionMode` (`auto`/`on`/`off`) is stored with the other decision settings;
`decision-config.js` resolves it, and `decisionFeatureEnabled()` is the single
check every caller makes. For On, select OpenRouter (the default), TypeSafe directly, or a local/custom System One
endpoint. OpenRouter's model list comes from its decision-model catalog and includes
all publishers. The default is `cloudflare/clef-flash`; existing
TypeSafe keys, enabled features and scheduler thresholds stay on their original
provider until changed. Provider keys are stored separately.

`cloudflare/clef-flash` reads only the first ~2K tokens of a long text state
(OpenRouter's model page says Workers AI truncates it), so
`SYSTEM_ONE_TEXT_BYTE_BUDGETS` in `systemone-judge.js` caps the state it is sent
at 1,500 UTF-8 bytes. A byte-level BPE tokenizer never produces more tokens than
bytes, so this holds for any text without shipping a tokenizer; image blocks are
left out because the provider counts them separately. A longer state is not
sent; the check takes the same fallback as for an unavailable decision model
(failure reason `state_too_long`) instead of judging evidence it only partly
read. In practice Clef Flash answers short decisions, and long completion
evidence goes to the main model.

Local [Kev](https://github.com/jaredpalmer/kev) defaults to
`http://127.0.0.1:8009`, model `kev-latest`, using `/v1/systemone`. A key is optional
and loopback requests work offline. A server elsewhere on your own network may
also use plain HTTP: private IPv4 (`10/8`, `172.16/12`, `192.168/16`), shared
`100.64/10` (Tailscale), link-local, unique-local IPv6, and `.local`,
`.home.arpa` and `.internal` names (`isPrivateNetworkHost` in
`decision-config.js`). Such a server is not treated as this device: it gets the
credential-redacted texts other routes get and needs the browser to be online.
Chrome sends its requests through the offscreen proxy the LAN chat providers
use. Any other remote endpoint requires HTTPS.
Image support follows available model capabilities or the custom override. Test
Connection checks typed answers and, when enabled, two independent image-only
facts. A successful HTTP response alone does not establish image support.

**D1 WebGPU (experimental)** is a separate, optional on-device decision
provider. It does not replace the conversational/planning model and does not
generate tokens. It supports named choice, noul (P(yes)) and ordinal score
questions over bounded text/JSON state and inline screenshots. Selecting it
does not download anything. Explicit consent and **Download and load** fetch
about 0.95 GB of pinned model data and tokenizer/configuration files from
the [Hugging Face model repository](https://huggingface.co/webbrain-one/d1-browser-decision-fp16)
into OPFS. The Chrome first-install guide no longer downloads D1: its one
download, Compass VLD Tiny v5, answers the same checks itself. The guide's
code for downloading D1 first and queueing the chat model after it
(`initializeD1Download` in `ui/install.js`, `providers/install-download-queue.js`)
stays in place and runs only for a page that has D1's line. The package stores FP16 weights and computes in FP32; it is the
[FP32 release](https://huggingface.co/webbrain-one/d1-browser-decision-fp32)
with its weights rounded once, and answers the same on its held-out test. A
cached FP32 package from an earlier version is removed on the next download. The repository name is not a production-readiness claim; this provider
remains experimental. Executable JS/WASM is packaged in the extension, not
downloaded from the model repository. Once the package is in the cache the
same button reads **Load**: it verifies the files again and loads them without
the download pass; inference cannot trigger a model download.

This experimental path needs hardware WebGPU, OPFS and substantial GPU/host
memory. Software adapters are rejected. The encoder's attention is dense, so
memory grows with the square of each row's length: rows are batched under a
256 MiB attention budget (never more than the adapter's storage-binding
limit), text-only rows are capped at 2,048 tokens on WebGPU (the state is
truncated, as the source does at its context limit), and a request whose
screenshots alone exceed the adapter limit fails with a clear error instead of
losing the GPU device. Screenshot features stay on the GPU between the vision,
projector and decision graphs. Chrome uses the shared MV3 offscreen
document with a dedicated decision Worker; Firefox uses its background-page
Worker when the corresponding browser capabilities are available. Mirrored
code is not evidence that every browser/GPU is supported. CPU/WASM control and
shape operators are permitted and explicitly disclosed; it is not a pure-GPU
claim. **Unload** or disabling outsourcing releases the Worker/GPU resources and
retains the cache; **Remove cached model** requires the model to be unloaded.
After **Download and load**, **Load** or the install guide's download, D1
stays loaded until it is unloaded, removed or switched off on the Providers
page (decisions Off, or another provider saved under On). Switching to Auto
keeps it, loaded or still downloading, while that request stands
(`releaseD1OnDecisionChange` in `background.js`); Auto uses it once it is
downloaded, and **Unload** releases it. A
decision that finds D1 unloaded (a browser restart, a discarded stalled
session, a lost GPU device) starts one reload from the verified cache in the
background and uses the fallback chain meanwhile. A reload never downloads. A decision whose caller
stops waiting (a judge timeout, Stop) is cancelled in the Worker, skipped if
it was still queued, and the loaded model stays.
Page state and screenshots remain untrusted evidence, never instructions.
No inference input goes to Hugging Face. Existing optional provider/research
sharing settings and existing privacy boundaries are not bypassed.

**In-browser chat model (experimental, Chrome)** answers decisions with the
WebGPU chat model itself, Compass VLD Tiny v5, so one downloaded model serves
chat, screenshots and decisions. It needs no extra download, key or endpoint:
download that preset under Providers → WebGPU, in Apocalypse Mode or from the
install guide first. Auto uses it by itself once it is downloaded, before a
downloaded D1; choosing it under On also sends it fast classifications, fast
browser actions and semantic decisions. The model was fine-tuned on d1's
synthetic train split for this decision protocol, and each option is scored
from a short continuation of the prefilled page state by a small probe. On
d1's held-out test it answers more questions correctly than D1 and accepted
no false completion, but d1 is synthetic and it has not been validated on
real browser traces, so like D1 a positive completion is never the sole
authority. The first decision after a browser restart loads the model and can
fall back to the existing chain. Ternary Bonsai 2 2B Vision no longer answers
decisions: real trace replays showed confident false failures and false
completions, so a saved selection of this provider now uses Compass VLD Tiny
v5. Details and numbers are in [`docs/webgpu-models.md`](webgpu-models.md).

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
uses its managed `/v1/decisions` route by default. An explicit in-browser
selection (the chat model, or a consented experimental D1), or in Auto a
downloaded Compass VLD Tiny v5 or D1 for completion and scheduled checks,
overrides only that decision route, not the main Compass provider. The fallback chain is decision model, active LLM, then existing
completion checks. These outsourcing toggles control the decision model only;
with outsourcing disabled or unconfigured, completion still uses a dedicated
call to the active LLM, subject to its normal cost allowance, followed by the
existing checks. Strict Secret Mode disables these additional calls.

| Active provider | First completion verifier | Fallback |
| --- | --- | --- |
| WebBrain Compass (default), no on-device decision model downloaded | Managed decision model | Active LLM, then existing checks |
| Explicitly selected in-browser chat model (Chrome), including with Compass | Compass VLD Tiny v5; no sole success authority | Active LLM, then existing checks |
| Explicitly enabled and consented D1, including with Compass | Experimental local D1; no sole success authority | Active LLM, then existing checks |
| Auto, Compass VLD Tiny v5 downloaded and no other in-browser model serving the task (Chrome; Compass included) | Compass VLD Tiny v5; no sole success authority | Active LLM, then existing checks |
| Auto, D1 downloaded and the chat model not, or serving the task would unload another in-browser model (Compass included) | Experimental local D1; no sole success authority | Active LLM, then existing checks |
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

Configure **Providers → Generative** for the
`generate_image` agent tool. Select one provider and save its settings:

| Provider | Settings | Default image / video model | Generation |
| --- | --- | --- | --- |
| fal.ai | API key; image and video model IDs (optional) | `fal-ai/flux/schnell` / `xai/grok-imagine-video/v1.5/lite/text-to-video` | fal.ai queue API; existing saved fal.ai settings remain compatible |
| OpenRouter | API key; image and video model IDs (optional) | `google/gemini-2.5-flash-image` / `x-ai/grok-imagine-video-1.5-lite` | [Dedicated Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) and video API; inline media appears in chat with a save link |
| Comfy Router | Comfy API key; image and video `provider/model` IDs (optional), each with optional input JSON | `bfl/flux-2-pro` / `xai/grok-imagine-video-1.5-lite` | [Queued requests](https://docs.comfy.org/development/comfy-router/queued-delivery); hosted or inline media |
| ComfyUI (localhost) | Local server URL (default `http://127.0.0.1:8188`); image workflow JSON in API format, optional video workflow | — | Local `/prompt`, `/history/{prompt_id}`, and `/view` endpoints; no API key |

Each provider has an image model and a video model. `generate_image` uses the
video model when the agent asks for a video (`media: "video"`, or any video
option such as `duration` or `scenes`) and the image model otherwise. A model
field left empty uses the default shown in it. For ComfyUI, a video request
without a video workflow uses the image workflow. Settings saved when there was
one model keep it as the image model; with OpenRouter, a saved model that the
video catalog lists makes the videos instead, and calls that do not say what
they want get a video from it, as before.

For Comfy Router models with native inputs other than `prompt`, paste their input
JSON in **Image model input JSON** or **Video model input JSON** and place
`{{prompt}}` in the text field(s). Other values, such as duration or resolution,
are preserved unless the agent sets that option for the clip. Without a
placeholder, WebBrain supplies the tool prompt as `prompt`. Refer to the model's
[input schema](https://docs.comfy.org/development/comfy-router/schemas).

For local ComfyUI, start the server, export a working workflow **in API format**,
and replace its positive prompt text with `{{prompt}}`. Keep the model names,
connections, and other inputs from the working export. Include a Save Image or
other media output node. Only loopback URLs (`localhost`, `127.0.0.1`, or `[::1]`)
are accepted. A connection test checks the server, not workflow execution.

**Test Connection** makes only free, read-only authentication/model/server probes;
it does not generate media. OpenRouter also checks both models in its image and
video catalogs, Comfy Router reads both models' metadata, and the result names
the image and video models requests will use. **Save / Clear** apply to the selected media
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

With a fal.ai, OpenRouter or Comfy Router video model, a video can be longer
than one clip. The model estimates how long the requested video should run
(`estimated_duration`). A single clip can set `duration`, `aspect_ratio` and
`resolution`, which are checked against what the video model accepts before
anything is submitted: OpenRouter's catalog entry (`supported_durations`,
`supported_aspect_ratios`, `supported_resolutions`), or the OpenAPI schema
fal.ai (`api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0`) or Comfy
Router (`/v2/models/{provider}/{model}/openapi.json`) publishes for the model,
read once per call that sets any of them. From a schema, WebBrain takes the inputs the model's request
body has, its listed clip lengths (sent as listed, such as `6`, `"6"` or
`"8s"`) or the whole seconds of its length range (sent as numbers), and its
listed aspect ratios and resolutions (matched without regard to case and sent as
listed, such as `768P`). When fal.ai's catalog has no readable clip lengths,
WebBrain also tries its public OpenAPI endpoint without credentials. If clip
lengths remain unavailable, an unspecified clip length uses the schema's valid
duration default, or a whole-second fallback starting at 8 seconds that meets
the published minimum, maximum and step size. A one-minute request can use eight distinct
8-second scenes, aiming for 64 seconds; the output is measured separately.
Fallback lengths are attempts, not advertised model limits. Explicit clip and
scene lengths can exceed the default or fallback when the published constraints
allow them; scene lengths round up as needed to satisfy those constraints.
When no valid whole-second length fits the 120-second cap, the request fails
before generation with an actionable error. String duration
inputs keep their declared encoding; a schema with no duration field uses the
provider's default without adding that field. Real submission errors still
stop the request, while missing metadata alone does not. A local
ComfyUI workflow sets its own length and shape, so these options are refused
there. A longer video is passed as `scenes`: WebBrain makes one clip per
scene at a length the model offers (a scene longer than its longest clip is
refused, so the agent splits it into scenes with their own prompts), generates
up to three clips at a time with one retry each (none when the provider refuses
the request, such as for lack of credit, or returns a clip that is not an MP4),
downloads hosted clips (up to 160 MB each) without the API key, and joins them into one MP4
without re-encoding (`src/*/src/agent/video-join.js`, which parses
the clips with the vendored mp4box.js). A clip's sound often ends a little
before its picture or starts after it; with AAC-LC sound (the usual MP4 audio,
which Grok Imagine returns) the joiner fills those gaps with silent frames, so
the sound plays without gaps and each of its frames plays within half a frame of
its time. Videos are capped at 120 seconds and 24 clips. When the estimate is
longer than 120 seconds, WebBrain asks on its own card whether to generate the
shorter version before any clip is submitted; the card never times out, and an
unattended run generates nothing. Clips that cannot be joined this way
(different encodings, edit lists or timing the joined file cannot reproduce, or
more than 160 MB together) are kept as separate clips and shown in order, and
the tool result says why (`joinError`), which traces show. The model never sees
the video, so the tool result gives it the video's measured length
(`durationSeconds`) and `clipCount` when available. Plans that knowingly fall
short of `estimated_duration` within the 120-second cap are rejected before
submission; missing clip-length metadata uses short scene clips covering the
full target. Results retain any assumed clip length (`fallbackClipSeconds`),
the original estimate (`estimatedSeconds`),
accepted plan (`plannedSeconds`), and `durationStatus`: `short`, `enough`,
or `unverified`. A measured shortfall keeps the generated asset and reports
incomplete delivery; hosted clips without a measured length stay unverified.
Each requested video keeps its own duration obligation across retries, Continue,
and worker restart. For multiple videos, use a distinct `video_id` per deliverable
and reuse it on retries; a verified intro cannot satisfy a failed outro. Without
labels, another video requested after a verified result starts a new obligation.
For local ComfyUI, corrected retries omit unsupported video options while WebBrain
retains the target separately for verification. The workflow chooses the output
length; its configured loopback `/view` result is measured without redirects.
Duration-constrained hosted MP4s use a credential-free read capped at 15 seconds.
Verification failures keep the asset and report an unverified duration.

Duration completion checks follow the quality-guard policy: by default they
refuse once, then allow a caveated completion. Known short, unjoined, or undelivered
videos downgrade that completion to partial; unavailable duration verification
alone keeps the model's outcome. Strict checks continue refusing until the video
meets its target or the model reports a partial or failed outcome.

Before writing scenes, the agent can load the default Video scenes
skill (`skills/video-scenes.md`), which asks for a shared cast and set sheet in
`prompt`, one filmable action per scene, and demonstrations instead of diagrams
or on-screen text; it is loaded only for such videos.

The Act system prompt and planner direct the model to call `generate_image` when
the user asks to generate media. Provider results are treated as untrusted content.
Inline bytes are shown in chat and excluded from model context.

### SafeSocial image classifier (experimental)

**Providers → SafeSocial** optionally filters Instagram images
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
| `webbrain_companion` | `openai`       | local    | (required)                                                         | Off / manual toggle             |
| `local_openai_proxy` | `openai`       | local    | (required)                                                         | Off / manual toggle             |
| `unsloth`            | `openai`       | local    | (required)                                                         | Off / manual toggle             |
| `webgpu` (Chromium)  | `webgpu`       | local    | Compass VLD Tiny v5; Compass Tiny v2.1; Ternary Bonsai 2 2B Vision; custom HF repo | Compass VLD and Bonsai Vision presets |
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
It is a managed, sidepanel-only runtime profile rather than a second provider
card on the Providers page. It uses the same endpoint and sends `model: max`; the hosted
backend returns `WebBrain Compass XL 1.0` and consumes usage credits at five
times the standard rate.

### Extended provider catalog

WebBrain also ships 84 disabled-by-default provider cards. Most are sourced
from the OpenCode provider catalog snapshot at commit
`62e4641235d7847dadc60da37cca8a023dd54fc1`; provider-specific additions use
their official API documentation. Together with the original cards, the
Providers page lists **118 built-in providers on Chromium** and **117 on Firefox**; the
difference is the Chromium-only in-browser WebGPU runtime.

| IDs                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-route`, `302ai`, `abacus`, `aihubmix`, `alibaba-coding-plan`, `alibaba-coding-plan-cn`, `atlascloud`, `azure-cognitive-services`, `bailing`, `baseten`, `berget`, `cerebras`, `cheaperinference`, `chutes`, `clarifai`, `cloudferro-sherlock`, `cohere`, `cortecs`, `deepinfra`, `digitalocean`, `dinference`, `drun`, `evroc`, `fastrouter`, `friendli` |
| `freebuff2api`, `google-vertex`, `google-vertex-anthropic`, `helicone`, `iflowcn`, `inception`, `inference`, `io-net`, `jiekou`, `kilo`, `kimi-for-coding`, `kuae-cloud-coding-plan`, `llama`, `lucidquery`, `meganova`, `minimax-cn-coding-plan`, `minimax-coding-plan`, `moark`, `modelscope`, `morph`                       |
| `nano-gpt`, `nearai`, `nebius`, `nova`, `novita-ai`, `ollama-cloud`, `opencode`, `opencode-go`, `opper`, `orcarouter`, `ovhcloud`, `perplexity`, `perplexity-agent`, `poe`, `pollinations`, `privatemode-ai`, `qihang-ai`, `qiniu-ai`, `requesty`, `scaleway`, `siliconflow`, `siliconflow-cn`, `stackit`                      |
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
providers. Add each service's bearer API key in its card on the Providers page, choose a
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

In WebBrain, open **Providers -> LLM -> NEAR AI Cloud**. Generate an API
key from the [NEAR AI Cloud dashboard](https://cloud.near.ai/), paste it into
the card, keep the default `z-ai/glm-5.3-flash` model, then click **Test
Connection**. If selecting a model with a smaller context window, such as
`Qwen/Qwen3.8-27B` (262144 tokens), set **Context window** to its documented
limit. Interactive Ask streaming, tool calls, and vision work through the
existing OpenAI-compatible path.

#### Cheaper Inference

[Cheaper Inference](https://cheaperinference.com) is an OpenAI-compatible LLM
gateway at `https://api.cheaperinference.com/v1`. One API key gives access to
models from several labs; model IDs are bare (such as `gpt-5.4-mini`,
`claude-sonnet-5`, `gemini-3.5-flash`, and `deepseek-v4-flash`). See the
[docs](https://cheaperinference.com/docs).

In WebBrain, open **Providers -> LLM -> Cheaper Inference**. Paste an API key
into the card, keep the default `gpt-5.4-mini` model (400000 tokens), then
click **Test Connection**. Interactive Ask streaming, tool calls, and vision
work through the existing OpenAI-compatible path.

#### Opper

[Opper](https://opper.ai) is an EU-hosted, OpenAI-compatible AI gateway at
`https://api.opper.ai/v3/compat`. One API key gives access to 700+ models from
50+ providers; model IDs are bare pool names (such as `gpt-5.4-mini`,
`claude-sonnet-4-6`, `gemini-3.8-flash`, and `deepseek-v4-flash`), and a
`provider/model` ID such as `anthropic/claude-sonnet-4-6` pins one route. See
the [docs](https://docs.opper.ai).

In WebBrain, open **Providers -> LLM -> Opper**. Create an API key at
[platform.opper.ai](https://platform.opper.ai), paste it into the card, keep
the default `gpt-5.4-mini` model (400000 tokens), then click **Test
Connection**. Interactive Ask streaming, tool calls, and vision work through
the existing OpenAI-compatible path.

#### API Route

[API Route](https://api-route.com) is an OpenAI-compatible provider at
`https://global.api-route.com/v1`. Open **Providers -> LLM -> API Route**, enter
your own API key, keep the default model `gpt-6.1-sol`, and click **Test
Connection**. API Route bills usage separately. The card starts disabled.

Interactive Ask streaming, tool calls, and vision work through the existing
OpenAI-compatible path. The 32768-token context setting is a conservative
application budget, not an advertised model context limit; adjust it to a limit
verified for your selected model and account.

#### Atlas Cloud

[Atlas Cloud](https://www.atlascloud.ai) is an OpenAI-compatible LLM gateway at
`https://api.atlascloud.ai/v1`. One API key gives access to models from several
labs; model IDs carry the lab prefix (such as `qwen/qwen3.7-plus`,
`deepseek-ai/deepseek-v4-flash`, and `moonshotai/kimi-k2.6`). The live list is
public at `https://api.atlascloud.ai/v1/models`. Create a key in the
[console](https://console.atlascloud.ai/api-keys).

In WebBrain, open **Providers -> LLM -> Atlas Cloud**. Paste an API key into
the card, keep the default `qwen/qwen3.7-plus` model (1000000 tokens), then
click **Test Connection**. Interactive Ask streaming, tool calls, and vision
work through the existing OpenAI-compatible path. Vision depends on the model:
`deepseek-ai/deepseek-v4-flash` and `deepseek-ai/deepseek-v3.2` are text-only.

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

On Chromium, **WebGPU (In-browser)** is an endpoint-free local provider.
The Providers page and Apocalypse Mode offer the same three presets, in this
order, and the Providers page also accepts a custom Hugging Face repository:

| Model | Download | Images | Browser context |
| --- | --- | --- | --- |
| [Compass VLD Tiny v5](https://huggingface.co/webbrain-one/webbrain-compass-vld-tiny-v5-onnx) (default) | 2.2 GB, Q8/FP16 | Yes | 32k |
| [Compass Tiny v2.1](https://huggingface.co/webbrain-one/webbrain-compass-tiny-v2.1) | 1.87 GB, Q4/FP16 | No | 32k |
| [Ternary Bonsai 2 2B Vision](https://huggingface.co/webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision) | 1.45 GB, Q2/FP16 | Yes | 16k |

These presets ship but are hidden from the pickers for now
(`WEBGPU_HIDDEN_MODEL_IDS` in `src/chrome/src/providers/webgpu.js`). A saved
selection still loads: the Providers page shows it as a custom model, and Apocalypse Mode
switches to an offered preset.

| Model | Download | Images | Browser context |
| --- | --- | --- | --- |
| [Ternary Bonsai 2 2B](https://huggingface.co/danyalmalik/Ternary-Bonsai-2-2B-ONNX-WebGPU) | 787 MB, Q2/FP16 | No | 16k |
| [Ternary Bonsai 2 4B](https://huggingface.co/Mike0021/Ternary-Bonsai-2-4B-text-ONNX) | 1.50 GB, Q2/FP16 | No | 16k |
| [Ternary Bonsai 2 4B Vision](https://huggingface.co/webbrain-one/Ternary-Bonsai-2-4B-ONNX-WebGPU-Vision) | 2.15 GB, Q2/FP16 | Yes | 16k |

Download sizes are approximate and exclude GPU working memory. Bonsai's native
context is larger; the browser defaults limit cache growth. Each model has its
own download and readiness state. Changing models preserves already downloaded
files, and switching back can reuse them.

In-browser models answer questions only. In the side panel, each Ask turn
makes one tool-free call. WebBrain first reads the current page, the
selection, a PDF tab and any page linked in the question, then sends that text
with a short prompt (tiny Ask, see [`docs/webgpu-models.md`](webgpu-models.md)).
Act and Dev mode are refused for this provider; choose another provider for
browser actions. The standalone chat window keeps its own page-free profile.

- [`webbrain-one/webbrain-compass-vld-tiny-v5-onnx`](https://huggingface.co/webbrain-one/webbrain-compass-vld-tiny-v5-onnx)
  (Q8 language model and embeddings, FP16 vision encoder, about 2.2 GB),
  WebBrain's Compass VLD Tiny v5 fine-tune of
  [MiniCPM-V-4.7-1B](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B): one
  model that chats and calls tools (V-L: it reads screenshots; D: it answers
  WebBrain's decision questions). It is the default for a new installation,
  the install guide's download, Auto's in-browser vision model and Auto's
  decision model once downloaded. Transformers.js has no MiniCPM-V runtime, so
  the same worker drives its three ONNX graphs through ONNX Runtime Web
  directly (`src/chrome/src/offscreen/compass-vld-runtime.js`), with the
  processor ported from PyTorch. It runs greedy with thinking disabled and
  emits Qwen3.5 XML tool calls (`<tool_call><function=...><parameter=...>`),
  which the local fallback parser accepts. Files are fetched at a pinned
  revision and each is checked against its pinned size and SHA-256. Message
  text that spells one of its added tokens (`<|image_pad|>`, `<|im_end|>`,
  and `</tool_response>`, which is added without being special) is encoded
  as ordinary text. On the first start after the update, a profile that never
  set up WebGPU moves from the previous default, Compass Tiny v2.1, to it when
  Compass Tiny v2.1 was never downloaded there; choosing Compass Tiny v2.1
  later stays.
- [`webbrain-one/webbrain-compass-tiny-v2.1`](https://huggingface.co/webbrain-one/webbrain-compass-tiny-v2.1)
  (`q4f16`, about 1.87 GB across two external-data shards), WebBrain's Compass
  Tiny v2.1 fine-tune of MiniCPM5-2B for Compact tool routing. It runs greedy
  with thinking disabled through the packaged Transformers.js 4.2 / ONNX
  Runtime Web GPU worker, and emits MiniCPM5 XML-style tool calls
  (`<function name="..."><param name="...">...</param></function>`, CDATA-wrapped
  when values contain `<`, `&`, or newlines), which the local fallback parser
  accepts. Enabling Apocalypse Mode downloads the selected preset.

Bonsai uses the packaged Qwen3.5 runtime and Q2 weight storage with FP16
activations. Its text presets reject image attachments. The Vision variants
retain Prism ML's original image tower and add its processor and image graph
to the ternary language export. They accept screenshots directly as the main
provider and also work for text-only turns. The 2B Vision preset is also an
in-browser vision choice for a text-only active model, and Auto uses it once it
is downloaded while Compass VLD Tiny v5 is not (see the Vision section below);
the 4B preset is not. Browser image processing is bounded to
approximately one megapixel per image. Build sources, tensor mapping checks,
and the hardware browser verification command are documented in
[`scripts/models/bonsai/README.md`](../scripts/models/bonsai/README.md).

Before adding, replacing or re-exporting any in-browser model, follow
[`docs/webgpu-models.md`](webgpu-models.md). It records why the first Bonsai 2
graphs prefilled on the CPU and froze the desktop, and the required checks:
`scripts/models/audit_webgpu_onnx.py` for CPU-only ops and full-sequence
logits, node placement, long-prompt timing with
`scripts/check-webgpu-long-prompts.mjs`, and how to update a published graph.

To verify the published text presets through the packaged production worker,
run these commands from the repository root with its Playwright Chromium
installed:

```powershell
node scripts/check-bonsai-webgpu.mjs --model danyalmalik/Ternary-Bonsai-2-2B-ONNX-WebGPU --profile .build/bonsai/text-2b-profile --output .build/bonsai/text-2b-result.json
node scripts/check-bonsai-webgpu.mjs --model Mike0021/Ternary-Bonsai-2-4B-text-ONNX --profile .build/bonsai/text-4b-profile --output .build/bonsai/text-4b-result.json
```

These commands download model files, run text and tool-call/result checks on
hardware WebGPU, and save JSON evidence. `--probe-only` checks the adapter and
packaged runtime without downloading weights. `--offline` repeats inference
using an existing profile and port (default 8769), requiring cached readiness
and rejecting Hugging Face fetches. Vision builds also require `--vision`;
the build README gives exact commands for local export folders, image history,
cache refresh after rebuilding, and recording browser evidence. The separate
`node test/quality/webgpu-presets-mv3.mjs` check exercises the installed extension's
offered model choices and saved settings with mocked cache readiness; it does not
establish model inference quality.

Custom Hugging Face repositories have not been tested and are likely not to
work. They must be compatible with Transformers.js text generation, provide a
`q4f16` ONNX variant, and use a chat template that accepts `tools`; WebBrain
validates the template after loading and rejects incompatible repositories.

The provider defaults to the Compact prompt tier. For Compass VLD Tiny v5,
budget roughly 4 GB of GPU headroom (about 2.2 GB of weights plus about 12 KB
of KV cache per token, and the recurrent state of its 18 linear-attention
layers); for Compass Tiny v2.1, about 1.87 GB of weights plus KV cache that
grows with context length. On constrained GPUs,
lower the context window on the WebGPU card on the Providers page (16384 is
a safe fallback) and retry with a short prompt. Each repository is cached
separately in Chrome.
After downloading a preset in Apocalypse Mode, the WebGPU card on the
**Providers** page can be configured, tested, and selected as the normal
chat provider. The nuclear standalone-chat control remains available as a
per-run override that does not change the global selection. Once its files are
cached, the selected model works without Apocalypse Mode enabled.
**Test Connection** checks only the packaged runtime and hardware WebGPU
adapter, so it does not trigger a model download. There is no API key, base
URL, localhost server, or OpenAI-compatible endpoint. Firefox does not expose
the card because its build does not package the Chromium MV3 offscreen/WebGPU
runtime.

Local endpoint providers are enabled by default. Most need no API key unless
the server was started with auth; Unsloth Studio and the generic proxy card
require their configured client keys:

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
- **WebBrain Companion**: `http://127.0.0.1:8327/v1` — the separate desktop
  app; local browser extensions need no API key. Load and select a model.
- **Local OpenAI-compatible Proxy**: `http://127.0.0.1:8317/v1` — a generic,
  authenticated local gateway; the model and proxy client API key are required.
  Its context window is set automatically after **Load Models**, a model pick or
  **Test Connection**, and falls back to 64k (see below)
- **Unsloth Studio**: `http://127.0.0.1:8888/v1` by default, with a configurable
  port — Studio's API URL, loaded model, and generated API key are required

#### ODS

Open **Providers → LLM → ODS (Local)**, set the server URL to the local
inference port in ODS's `.env`, click **Load Models**, select the running model,
and click **Test Connection**. ODS exposes OpenAI-compatible `/v1/models` and
`/v1/chat/completions`; WebBrain reads `/props` for the live context window and
vision support when the installed backend exposes it. Add an API key only if
you configured ODS to require one. When ODS switches models, select the new
model in WebBrain unless your ODS installation exposes a stable alias. See the
[ODS quickstart](https://github.com/Osmantic/ODS/blob/main/ods/QUICKSTART.md).

#### Osaurus

Start the Osaurus server on your Mac, then open **Providers → LLM →
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

In WebBrain, open **Providers → LLM → Unsloth Studio (Local)**. Enter the
Studio API address as `http://127.0.0.1:8888/v1`, replacing `8888` when the
running Studio instance shows a different port. Enter the generated API key,
click **Load Models**, select the loaded model, then click **Test Connection**.
WebBrain normalizes a
base URL entered without the terminal `/v1` after a successful request.

Unsloth model discovery, chat, interactive Ask streaming, and tool calls use
the existing OpenAI-compatible endpoints. Vision starts off: enable the manual
vision checkbox only when the model loaded in Studio accepts image input.

#### WebBrain Companion

Download the separate desktop app: [Windows installer](https://github.com/webbrain-one/webbrain/releases/download/systray-v0.1.2/WebBrain-Companion-0.1.2-windows-setup.exe),
[macOS universal app](https://github.com/webbrain-one/webbrain/releases/download/systray-v0.1.2/WebBrain-Companion-0.1.2-macos-universal.zip),
[Linux x64](https://github.com/webbrain-one/webbrain/releases/download/systray-v0.1.2/WebBrain-Companion-0.1.2-linux-x64.tar.gz),
or [Linux Arm64](https://github.com/webbrain-one/webbrain/releases/download/systray-v0.1.2/WebBrain-Companion-0.1.2-linux-arm64.tar.gz).
Its [source and full setup guide](../webbrain-systray/README.md)
describe supported accounts, the optional Bonsai local model, and the
platform-specific install steps. In **Providers → LLM → WebBrain Companion**,
leave the default `http://127.0.0.1:8327/v1` URL unless the app shows another
port. Click **Load Models**, select an available model, **Save**, and **Test
Connection** before activating it. The browser extension on the same computer
does not need an API key. If you enable access from another device, use the
address and API key shown by the app. Model requests sent to an account
subscription still go to that upstream provider; the optional Bonsai model
runs locally. Enable vision only for models that accept images.

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

**Context window.** After **Load Models**, picking a model from the loaded list,
or **Test Connection**, WebBrain sets the card's **Context window** from the first
source that knows it:

1. the proxy's `/v1/models` card for the selected model (`max_model_len`,
   `max_context_length`, `context_window`, `context_length`, `max_input_tokens`
   or `input_token_limit`);
2. `GET /props?model=<model>` at the proxy root, when a llama.cpp server behind it
   reports the loaded model's live `n_ctx`;
3. the model name, for hosted models WebBrain knows (`claude-…`, `gpt-5…`,
   `gemini-…`, …), capped at 128k because subscription gateways can serve less
   context than the vendor API advertises;
4. otherwise the **64k** proxy fallback, which is also the card's default
   (previously 16k, which starved the hosted models these gateways usually front).

A reported window (1 or 2) may shrink a manual value; a name or the fallback only
replaces the default, the old 16k default, or a value WebBrain filled in itself,
never a number you typed. If the proxy fronts a small local model and reports
nothing, lower **Context window** to that model's loaded window, because 64k can
overflow it. Untouched cards (never saved, no key) move from 16k to 64k on
upgrade; a saved card still at 16k moves at its next detection.

Ollama, llama.cpp, ODS, LM Studio, and LocalAI default to `visionMode: auto`. WebBrain asks
the selected server for model capability metadata before enrichment and sends
screenshots only when the response explicitly reports image input. A failed or
malformed metadata request is text-only for that turn and is retried later;
The Providers page can override Auto with Force on or Off. For providers whose Model
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

The agent reads `provider.contextWindow` (`providers/base.js`) to drive auto-compaction. When no value is configured, local providers default to **16k** (the Local OpenAI-compatible Proxy to **64k**); cloud/router defaults depend on the known model, with a category fallback of 128k. **Test connection** / **Load models** auto-detect for **llama.cpp**, **ODS**, **Ollama**, **LM Studio**, **vLLM**, **SGLang**, **LocalAI** and the **Local OpenAI-compatible Proxy** when reported (llama.cpp / ODS `GET /props` `n_ctx`, Ollama `GET /api/ps` live context then `/api/show` `num_ctx`, LM Studio `/api/v0/models` `loaded_context_length`, vLLM / SGLang `/v1/models` `max_model_len`, LocalAI model config `context_size`, the proxy as described in the [subscription proxy guide](#subscription-proxy-guide-easycliproxyapi--cliproxyapi)). Detection refreshes the local fallback; it shrinks a larger manual override only from live/runtime context (not from Ollama `/api/show` alone). Jan / GPT4All / Unsloth Studio do not auto-detect yet. Set `config.contextWindow` to match the server's actual loaded window; increasing the setting alone does not enlarge the model server's context.

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

**Lean mode** (Settings → Advanced → Lean mode; Auto by default) skips WebBrain's quality checks in Act runs; the run keeps its tier's tools and prompt, with one note asking the model to check its own work. Under Auto it applies only to a strong model on a cloud or router provider whose tier is Full; Compact and Mid tiers and local providers keep the checks. See [lean-mode.md](lean-mode.md).

### Vision Detection

| Provider            | Mechanism                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible   | Regex against model name (`gpt-4o`, `gpt-5`, `claude-3`, `claude-sonnet-4`, `gemini-2.0-flash`, etc.)                                             |
| DeepSeek            | The `deepseek-flash` family (including the retired `deepseek-v4-flash` aliases and dated router snapshot ids such as `deepseek-v4.1-flash-1017`) is multimodal; `deepseek-v4-pro` and the V3-era ids are text-only |
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

`deepseek-flash` (DeepSeek-V4.1-Flash, refreshed to the `-1017` snapshot on
2026-10-17 with no API or price change) is the shipped model. The retired
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` ids still serve the same
model and are billed as Flash, and router snapshot ids such as OpenRouter's
`deepseek/deepseek-v4.1-flash-1017` resolve to it too, so they keep full support
(1M context, 384K output, image input). Every other DeepSeek id — including the
retired `deepseek-v4-pro` — stays on a conservative profile (64K context, 8K
output, text-only) rather than inheriting capacities it may not have.

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
pm.getAll(); // All provider configs (for the Providers page)
await pm.testProvider("openai"); // Test connection
```

Each non-WebBrain provider config includes a persisted `configured` flag. An
explicit configuration update sets it to `true`; this is the UI's **Active**
state and is separate from `activeProvider`, which is the provider currently
**Selected** for chat. WebBrain Compass is always selectable without being marked
configured. Connection tests report reachability but do not control the Active
flag.

The Providers page can rename configurable providers using **Provider title**
and Save. The persisted `label` appears there and in the chat provider picker without
changing the provider's ID, implementation, or model.

The Providers page can create any number of independent duplicates of each configurable
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

### Provider Search

The search on the Providers page's LLM tab indexes provider IDs, labels, type/category, model,
base URL, field labels/placeholders, suggestions, and compatibility options.
Matching cards are ordered by exact provider name/ID, then name/ID prefix, then
name/ID substring, then field-only matches. Original provider order breaks
ties, and the selected provider remains visible across category filters.

### Config Persistence

Configs are stored in `chrome.storage.local` under the `providers` key, merged against defaults. Defaults provide the SHAPE (which provider keys exist); stored configs override per-key values. This allows upgrades that introduce new provider entries to work without users clearing storage. Duplicate entries share this same persistence path and therefore remain portable through Settings config export/import.

Deprecated provider entries (`webbrain`, `openai_subscription`,
`claude_subscription`) are filtered out.

### Cost Allowances

Settings → Budgets exposes session and total cloud cost allowances. The agent prefers a provider-reported `usage.cost`/`usage.cost_usd` value when present (OpenRouter reports this directly). For direct cloud providers that only return token counts, WebBrain estimates spend from the provider config fields:

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

On Chromium, **Providers -> Vision** also offers an
in-browser vision model, chosen from **Auto** (default), **Compass VLD Tiny v5**,
**Ternary Bonsai 2 2B Vision**, **WebBrain VL 2 450M** or **Off**. The choice is stored in the
Chrome-only `webgpuVisionChoice` key (`storedWebgpuVisionChoice()` and
`resolveWebgpuVisionChoice()` in `providers/webgpu.js`), separately from the
synced OpenAI-compatible vision endpoint, so changing it never touches that
endpoint or its credentials. It is not exported, profile-synced or imported by
Firefox, whose build has no MV3 offscreen document and no local option.

- **Auto** uses Compass VLD Tiny v5 once its ready marker is in Cache Storage,
  Ternary Bonsai 2 2B Vision when only that one is downloaded, and is off until
  then (`webgpuChatVisionReadiness()` in `providers/webgpu-model-cache.js`:
  cache lookups that never start the offscreen document).
- **Compass VLD Tiny v5** (`webbrain-one/webbrain-compass-vld-tiny-v5-onnx`,
  2.2 GB) and **Ternary Bonsai 2 2B Vision**
  (`webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision`, 1.45 GB) are chat
  presets themselves, read through `WebGPUChatVisionProvider`: the WebGPU chat
  provider with tools removed. Each shares its chat download, cache and the
  worker's serialized model queue, so a screenshot asked for during a chat
  generation waits its turn, and the 90-second vision deadline cancels it with
  the chat cancellation key. Its download is the ordinary text-model download,
  started only by a click. When the active chat model is one of them, it reads
  the screenshot itself and no second model is involved.
- **WebBrain VL 2 450M** runs `webbrain-one/webbrain-vl-2-450M-onnx` in a
  dedicated Worker with FP16 embeddings/vision encoder and a Q4 decoder. Its
  first download goes through the dedicated consent step: it probes WebGPU,
  records versioned consent, and then downloads approximately 810 MB of model
  data from Hugging Face. Choosing it again later re-enables it under the
  consent already given; leaving it for another choice releases the loaded
  model and GPU resources while retaining the browser-cached download. Profiles
  that enabled it before the choice existed keep it.

Neither local model is in the general provider catalog as a vision sidecar or
ever receives agent tools or planning turns. No choice, Apocalypse Mode or
screenshot operation starts a download. Downloads run in Chrome's offscreen
extension worker, so the user may switch tabs or close the Providers page while they
continue, but must keep Chrome running. Screenshots stay on-device and only the
generated description is passed to the active provider. Only the Providers
page and Apocalypse Mode may change the choice (`set_webgpu_vision_choice`).

Screenshot routing is deterministic: an explicit dedicated vision endpoint,
then a vision-capable active provider receiving raw pixels, then the in-browser
model the choice resolves to, if it is already ready. If none is ready, inspection returns a
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
