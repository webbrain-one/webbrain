/**
 * fetch() wrapper with a user-configurable connection-phase timeout.
 *
 * Firefox MV2 has no offscreen document, so unlike Chrome there's no
 * fetch-with-fallback layer; this is the plain-fetch path used by every
 * provider (openai, anthropic, llamacpp). Centralized here so:
 *
 *   1. The same 120s default and 10–600s range apply to every LLM call.
 *   2. There's one cached timeout value across the providers — not three
 *      copies each with its own storage read and onChanged listener.
 *   3. Changing the setting in Settings → Display → "LLM request timeout"
 *      takes effect on the next request without an extension reload.
 *
 * The timer aborts ONLY the connection / time-to-headers phase. Once
 * fetch() resolves and the timer is cleared, streaming bodies run as
 * long as they need. Without this, a stalled endpoint hangs the UI
 * forever — the original "no timeout at all" state in
 * anthropic.js / llamacpp.js before this module was extracted.
 */

let _cachedTimeoutMs = 120000;
let _timeoutInitialized = false;
const TIMEOUT_FLOOR_MS = 5000;
const TIMEOUT_CEILING_MS = 600000;

async function _ensureTimeoutInitialized() {
  if (_timeoutInitialized) return;
  _timeoutInitialized = true;
  try {
    const api = (typeof browser !== 'undefined' && browser?.storage)
      ? browser
      : ((typeof chrome !== 'undefined' && chrome?.storage) ? chrome : null);
    if (!api?.storage?.local?.get) return;
    const stored = await api.storage.local.get(['requestTimeoutMs']);
    const v = stored?.requestTimeoutMs;
    if (typeof v === 'number' && v >= TIMEOUT_FLOOR_MS && v <= TIMEOUT_CEILING_MS) {
      _cachedTimeoutMs = v;
    }
    if (api.storage.onChanged?.addListener) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.requestTimeoutMs) return;
        const next = changes.requestTimeoutMs.newValue;
        if (typeof next === 'number' && next >= TIMEOUT_FLOOR_MS && next <= TIMEOUT_CEILING_MS) {
          _cachedTimeoutMs = next;
        } else if (next == null) {
          _cachedTimeoutMs = 120000;
        }
      });
    }
  } catch { /* keep the hardcoded default */ }
}

/**
 * fetch() with a connection-phase abort timer wired to the user's
 * `requestTimeoutMs` setting. On abort, throws a descriptive Error
 * that names the URL and the timeout value — callers can echo it
 * straight to the user.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}) {
  await _ensureTimeoutInitialized();
  const timeoutMs = _cachedTimeoutMs;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error(
        `Request to ${url} timed out after ${timeoutMs}ms. ` +
        `The endpoint may be unreachable, blocked by CORS, or stalled. ` +
        `If this is a local model that needs more time, raise the timeout ` +
        `in Settings → Display → "LLM request timeout".`
      );
    }
    throw e;
  }
}
