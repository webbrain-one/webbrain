/**
 * fetch() wrapper that falls back to an offscreen document proxy
 * when the service worker can't reach the server directly.
 *
 * This solves Chrome MV3's Private Network Access restrictions that
 * block service worker fetch() to local network IPs (192.168.*, 10.*, etc.)
 * even with host_permissions and privateNetworkAccess.
 */

import { ensureOffscreen } from '../offscreen/ensure.js';

// (Previously this file had its own ensureOffscreen() — moved to a shared
// helper in ../offscreen/ensure.js so the recorder and the fetch proxy
// can co-exist in one offscreen document. See that file for the full
// rationale on why reasons must be declared together up front.)

// User-configurable connection-phase timeout for LLM HTTP requests.
//
// Lives in chrome.storage.local under `requestTimeoutMs`. Default 120s —
// errs on the local-model side (llama.cpp / Ollama / LM Studio with a
// large model + long context can take 60–180s before the first byte).
// Cloud providers (OpenAI / Anthropic / Gemini) start their SSE stream
// within a couple seconds, so the higher default costs them nothing —
// the timer only ever fires for genuinely stalled endpoints. Users bump
// or lower it via Settings → Display → "LLM request timeout".
//
// Cached at module scope after a lazy first read, refreshed in-place
// when the settings page writes a new value. Providers don't pass
// `timeoutMs` explicitly — they rely on this default — so a single
// setting change applies to every subsequent request without provider
// reconstruction.
let _cachedTimeoutMs = 120000;
let _timeoutInitialized = false;
let _storageListener = null;
const TIMEOUT_FLOOR_MS = 5000;        // 5s — anything lower than this is a typo
const TIMEOUT_CEILING_MS = 600000;    // 10 min — well past any reasonable first-byte wait

async function _ensureTimeoutInitialized() {
  if (_timeoutInitialized) return;
  _timeoutInitialized = true;
  try {
    const api = (typeof chrome !== 'undefined' && chrome?.storage)
      ? chrome
      : ((typeof browser !== 'undefined' && browser?.storage) ? browser : null);
    if (!api?.storage?.local?.get) return;
    const stored = await api.storage.local.get(['requestTimeoutMs']);
    const v = stored?.requestTimeoutMs;
    if (typeof v === 'number' && v >= TIMEOUT_FLOOR_MS && v <= TIMEOUT_CEILING_MS) {
      _cachedTimeoutMs = v;
    }
    if (api.storage.onChanged?.addListener && !_storageListener) {
      _storageListener = (changes, area) => {
        if (area !== 'local' || !changes.requestTimeoutMs) return;
        const next = changes.requestTimeoutMs.newValue;
        if (typeof next === 'number' && next >= TIMEOUT_FLOOR_MS && next <= TIMEOUT_CEILING_MS) {
          _cachedTimeoutMs = next;
        } else if (next == null) {
          _cachedTimeoutMs = 120000;
        }
      };
      api.storage.onChanged.addListener(_storageListener);
    }
  } catch { /* keep the hardcoded default */ }
}

/**
 * Try direct fetch first. If it fails with a network error, retry
 * through the offscreen document proxy.
 *
 * The timeout aborts only the *connection / time-to-headers* phase. Once
 * fetch() resolves, the timer is cleared so streaming bodies can run as
 * long as needed. Without this, a stalled endpoint hangs the UI forever.
 *
 * If the caller passes an explicit `timeoutMs`, it wins. Otherwise the
 * user's setting (or the 60s fallback) is used.
 *
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} options
 * @returns {Promise<Response>}
 */
export async function fetchWithFallback(url, options = {}) {
  await _ensureTimeoutInitialized();
  const { timeoutMs = _cachedTimeoutMs, ...fetchOptions } = options;

  // Fast path: try direct fetch first, with a connection-phase timeout.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (directError) {
    clearTimeout(timeoutId);

    // If we aborted on timeout, surface that directly — don't fall through to
    // the offscreen proxy, since the same endpoint is likely unresponsive.
    if (directError.name === 'AbortError') {
      throw new Error(
        `Request to ${url} timed out after ${timeoutMs}ms. ` +
        `The endpoint may be unreachable, blocked by CORS, or stalled. ` +
        `Check the URL/credentials and that the server is responding.`
      );
    }

    // Network error (Failed to fetch) — try offscreen proxy
    console.warn(
      `[WebBrain] Direct fetch to ${url} failed (${directError.message}), trying offscreen proxy...`
    );

    try {
      await ensureOffscreen();

      // Race the proxy round-trip against the same timeout, since
      // chrome.runtime.sendMessage has no native cancellation.
      const proxyResult = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'offscreen-fetch',
          url,
          method: fetchOptions.method || 'POST',
          headers: fetchOptions.headers || {},
          body: fetchOptions.body || undefined,
          stream: false,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`offscreen proxy timed out after ${timeoutMs}ms`)),
            timeoutMs
          )
        ),
      ]);

      if (proxyResult.error) {
        throw new Error(
          `Both direct fetch and offscreen proxy failed for ${url}. ` +
          `Direct: ${directError.message}. Proxy: ${proxyResult.error}`
        );
      }

      return new Response(proxyResult.body, {
        status: proxyResult.status,
        statusText: proxyResult.ok ? 'OK' : 'Error',
        headers: { 'Content-Type': proxyResult.contentType || 'application/json' },
      });
    } catch (proxyError) {
      // Offscreen proxy also failed — throw the most useful error
      if (proxyError.message?.includes('Both direct')) {
        throw proxyError;
      }
      throw new Error(
        `Could not reach ${url}. Direct: ${directError.message}. ` +
        `Offscreen proxy: ${proxyError.message}. ` +
        `If the server is on your local network, make sure it has CORS enabled ` +
        `(vLLM: --allowed-origins \'["*"]\', Ollama: OLLAMA_ORIGINS=*).`
      );
    }
  }
}
