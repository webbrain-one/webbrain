# What’s New in WebBrain v24

v24 is a **provider / model-compatibility major release**. It does not redesign the agent loop, tools, or browser automation surface. It changes how WebBrain talks to LLMs—especially official OpenAI GPT-5.6 and other OpenAI-compatible endpoints with different wire formats.

---

## TL;DR

| Area | What changed |
|------|----------------|
| **Official OpenAI GPT-5.6** | First-class model family (default **Terra**), 1.05M context, **Responses API** on `api.openai.com` |
| **Older / proxy endpoints** | Still use **Chat Completions**; no forced `/v1/responses` on proxies or non-OpenAI hosts |
| **Configurable compatibility** | Per-provider settings for reasoning, system role, max-token field, and safe extra JSON body |
| **Who is affected at runtime** | OpenAI-compatible providers, Azure OpenAI, llama.cpp |
| **Who is not** | Native Anthropic and AWS Bedrock request builders (UI panel may show; runtime path does not apply compat) |

---

## Did main already support GPT-5.6?

**Mostly yes, as a generic GPT-5 Chat Completions model—not as a special-cased product.**

On earlier 23.x lines:

- Any model id matching the “new OpenAI contract” (including names starting with `gpt-5`) already used `max_completion_tokens` instead of `max_tokens`.
- You could type a GPT-5.6 model id and call Chat Completions if the API accepted it.
- There was **no** first-class 5.6 default/suggestions list, **no** dedicated 5.6 context-window rule, and (until later 23.3.x work on `main`) **no** official Responses API path.

v24 (and the 23.3.x Responses work merged into this release) makes GPT-5.6 **first-class**:

- Default OpenAI model: `gpt-5.6-terra`
- Suggestions: Terra, Sol, Luna, base `gpt-5.6`, plus older GPT-5.x ids
- Context window for `gpt-5.6*`: **1,050,000** tokens (same class as GPT-5.5-pro)
- Official OpenAI only: route GPT-5.6 family traffic to **`POST /v1/responses`**

### Responses API gate (intentionally narrow)

Responses is used only when **all** of these hold:

1. Provider is OpenAI (`providerName === 'openai'`)
2. Base URL is official `https://api.openai.com/v1`
3. Model matches the GPT-5.6 family: `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, including optional dated suffixes (e.g. `gpt-5.6-terra-2026-07-15`)

**Not** routed to Responses:

- GPT-5.5 and older
- OpenRouter / proxies / custom base URLs (even if the model string contains `gpt-5.6`)
- Local OpenAI-compatible servers (Ollama, LM Studio, vLLM, etc.)

### What the Responses path does

- Builds Responses-shaped bodies: `input`, `max_output_tokens`, Responses tool format, `store: false`
- Includes `reasoning.encrypted_content` and defaults reasoning effort to **medium** (with compatibility / extraBody overrides)
- Maps chat history for tools: assistant `tool_calls` → `function_call`, tool results → `function_call_output`
- Replays prior **`response_items`** so encrypted reasoning state survives multi-step tool loops
- Streams via Responses SSE events and normalizes usage back to `prompt_tokens` / `completion_tokens`
- Returns `responseItems` for the agent to attach on the next turn

Chrome uses `fetchWithFallback`; Firefox uses `fetchWithTimeout`—same provider logic, platform-appropriate fetch helpers.

---

## Configurable compatibility (“advanced model compatibility”)

**Not a new agent mode.** Per-provider knobs that change **how the HTTP request is shaped** so different servers accept the same agent conversation.

### Why it exists

“OpenAI-compatible” is not one wire format. Different stacks want different fields for the same idea:

| Idea | Examples of wire differences |
|------|------------------------------|
| Token limit | `max_tokens` vs `max_completion_tokens` vs Responses `max_output_tokens` |
| System prompt role | `system` vs `developer` |
| Reasoning / thinking | OpenAI `reasoning` / `reasoning_effort`, OpenRouter `reasoning: { effort }`, Qwen `chat_template_kwargs.enable_thinking`, DeepSeek `chat_template_kwargs.thinking` |
| Extra server flags | Template kwargs, repetition penalty, etc. |

Without config, WebBrain either hard-codes one convention or fails on some endpoints. v24 makes those choices **settings**.

### Settings UI

On each provider card → **Advanced model compatibility**:

| Control | Effect on the request |
|---------|------------------------|
| **Preset** (`auto` / OpenAI / Qwen / DeepSeek / OpenRouter / Custom) | Which family of field names to use for reasoning, etc. `auto` infers from provider/model name. |
| **Reasoning effort** (`auto` / off / minimal … max) | Turns thinking on/off or sets effort; mapped per preset. |
| **System prompt role** (`auto` / system / developer) | Optionally rewrites `system` → `developer` when building the request (**stored history is not mutated**). |
| **Max tokens field** (`auto` / `max_tokens` / `max_completion_tokens`) | Which token-limit key is sent. |
| **Custom request body JSON** | Extra object merged after the preset (e.g. `{"chat_template_kwargs":{"enable_thinking":true}}`). |

**Protected / reserved keys** cannot be overridden via custom JSON: `model`, `messages`, `input`, `instructions`, `tools`, `tool_choice`, `stream`, `max_tokens`, `max_completion_tokens`, `max_output_tokens`. Unsafe prototype keys (`__proto__`, `prototype`, `constructor`) are blocked.

There is a **Reset to automatic** control and live validation for the JSON field.

### Auto presets

| Auto detection | When |
|----------------|------|
| **openrouter** | `providerName === 'openrouter'` |
| **deepseek** | provider is deepseek *or* model name contains `deepseek` |
| **qwen** | model name contains `qwen` |
| **openai** | official `api.openai.com` |
| **standard** | everyone else — no automatic reasoning fields unless you set knobs / custom JSON |

So for Grok, Groq, Mistral, Ollama, etc., **auto is mostly a no-op** until you set reasoning / role / token field / custom body yourself (or force a preset like Qwen when serving Qwen).

### Example

Same chat (system rules + user “hello” + tools):

- **Legacy / default:** `{ messages, max_tokens, tools, … }`
- **Qwen-style + high reasoning:** messages (maybe `developer` role), `max_completion_tokens`, plus `chat_template_kwargs: { enable_thinking: true, … }`
- **Official GPT-5.6:** Responses API path; still honors reasoning/role compatibility where applicable

---

## Which providers get this?

### UI

The compatibility panel is rendered on **every provider card** in Settings.

### Runtime (actually applied)

Only implementations that call the shared helpers (`_mapMessages`, `_addConfiguredMaxTokens`, `_mergeConfiguredRequestBody`):

| Implementation type | Providers |
|---------------------|-----------|
| **`openai` (OpenAI-compatible)** | Almost the entire cloud + local list (see below) |
| **`azure_openai`** | Azure OpenAI |
| **`llamacpp`** | Local llama.cpp server |

**Not wired into the native request builders:** Anthropic Claude and AWS Bedrock. Changing the panel for those cards does not reshape their native API calls on this release.

### OpenAI-compatible provider ids (examples)

**Local / self-hosted:** WebBrain Cloud, Ollama, LM Studio, Jan, vLLM, SGLang, LocalAI, llama.cpp

**Cloud (OpenAI-compatible HTTP):** OpenAI, Gemini (compat endpoint), Cloudflare, Mistral, DeepSeek, xAI, NVIDIA, Groq, MiniMax, Alibaba/Qwen, Together, OpenRouter, Hugging Face, Fireworks, Azure OpenAI

Custom OpenAI base-URL providers you add also get the same path.

---

## Implementation map (for contributors)

| Piece | Role |
|-------|------|
| `src/*/src/providers/provider-compatibility.js` | Normalize compat config, detect Responses eligibility, map messages, max-token field, reasoning body fragments, safe extraBody merge/validation |
| `src/*/src/providers/base.js` | `_mapMessages`, `_addConfiguredMaxTokens`, `_mergeConfiguredRequestBody` |
| `src/*/src/providers/openai.js` | Chat Completions + Responses routing, streaming, `response_items` replay |
| `src/*/src/providers/azure-openai.js`, `llamacpp.js` | Use shared body merge helpers |
| `src/*/src/providers/manager.js` | OpenAI default model constant / migration |
| `src/*/src/providers/context-windows.js` | 1.05M for `gpt-5.6*` |
| `src/*/src/ui/settings.js` + `settings.html` | Advanced compatibility UI |
| `test/run.js` | Responses + compatibility regression coverage |

Chrome and Firefox stay mirrored except for platform fetch helpers.

---

## What v24 is *not*

- Not a new set of browser tools or a change to Ask vs Act safety defaults
- Not “enable GPT-5.6 by allowlist only”—you could already type model ids; v24 is about **correct wire format + usability**
- Not full native Anthropic/Bedrock compatibility knobs
- Not a guarantee that every third-party “OpenAI-compatible” server implements every optional field—you still configure per endpoint

---

## Upgrade notes

- **New installs:** OpenAI defaults to `gpt-5.6-terra`.
- **Existing installs:** Manager migration promotes untouched prior OpenAI defaults (e.g. older default model / cost metadata) to the new shipped default when safe; custom model choices you saved are preserved.
- **Proxies:** If you point `baseUrl` at a proxy that only speaks Chat Completions, keep using GPT-5.6 model ids—WebBrain will **not** call `/v1/responses` for non-official hosts.
- **Reasoning:** On official Responses, default effort is medium; use Advanced compatibility or extra body to tune. Prefer dedicated settings over stuffing reserved fields into custom JSON.

---

## Version

- Extension / package version: **24.0.0**
- See [CHANGELOG.md](./CHANGELOG.md) for the formal release entry.
