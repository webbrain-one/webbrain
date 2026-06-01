# Ollama — TODO

> ⚠️ **Reconstructed file.** The original `ollama-todo.md` was accidentally
> deleted and could not be recovered (it was untracked, so not in git, and the
> deletion bypassed the Recycle Bin). This is a best-effort rebuild from the
> Ollama integration as it currently stands in the codebase — its original
> contents are unknown, so please correct or replace anything that doesn't
> match what you had.

Living list of Ollama-specific work. Each item explains *why* it matters so we
can judge later whether it's still relevant.

## Where the Ollama integration lives

- Provider config / registry — [`src/chrome/src/providers/manager.js`](src/chrome/src/providers/manager.js) (`ollama` entry, `localhost:11434/v1`, `apiKey: 'ollama'`).
- Request path — [`src/chrome/src/providers/openai.js`](src/chrome/src/providers/openai.js) (Ollama speaks the OpenAI-compatible API; 403 origin-allowlist handling lives here).
- Model listing — `listProviderModels()` / `listOllamaModels()` in `manager.js` use Ollama's native `/api/tags` (not `/v1/models`).
- Local-fetch proxy / CORS — [`src/chrome/src/providers/fetch-with-fallback.js`](src/chrome/src/providers/fetch-with-fallback.js) and the offscreen document (MV3 service workers can't reach localhost directly).
- Background message — `list_ollama_models` case in [`src/chrome/src/background.js`](src/chrome/src/background.js).
- Mirror everything in the Firefox tree under `src/firefox/...`.

## Open items

### 1. Origin allowlist (403) is a recurring onboarding failure
Ollama rejects the extension origin unless `OLLAMA_ORIGINS` permits it. We
already surface a 403 hint (`OLLAMA_ORIGINS="*"` / `moz-extension://*,chrome-extension://*`),
but users still hit this on first run. Consider detecting it during onboarding
auto-detection and showing the fix inline rather than only on a failed model
fetch.

### 2. Vision / multimodal routing for Ollama
`manager.js` notes that local stacks in 2026 are increasingly multimodal. Verify
that images are sent in the shape Ollama expects and that we don't advertise
vision for text-only models pulled into Ollama. Falling back cleanly to a
text-only path matters (see the text-only-endpoint handling in `agent.js`).

### 3. Model-list UX
`/api/tags` returns installed models; confirm names map cleanly to the model
picker and that an empty list (Ollama running but no models pulled) gives a
helpful "run `ollama pull <model>`" message instead of an empty dropdown.

### 4. `keep_alive` / cold-start latency
Local models on CPU or with large contexts can take 60–180s before the first
byte (see `st.display.request_timeout.desc`). Decide whether to pass a
`keep_alive` hint so the model stays warm between turns, and make sure the
request-timeout default doesn't abort a legitimate cold start.

### 5. Firefox parity
Any change above must land in both `src/chrome` and `src/firefox`. Keep the
provider config, 403 messaging, and model-listing logic in sync.
