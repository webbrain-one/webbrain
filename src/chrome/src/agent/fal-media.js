// fal.ai generative media (assistive model).
//
// Configured in Settings -> Assistive Models -> "Generative media (fal.ai)"
// and stored in extension storage as `imageGenModel = { apiKey, model }`.
// fal.ai uses a queue API: submit a prompt, poll status_url, then fetch
// response_url. Auth uses `Authorization: Key <FAL_KEY>`.

export const IMAGE_GEN_MODEL_KEY = 'imageGenModel';
export const FAL_QUEUE_BASE = 'https://queue.fal.run';
export const FAL_AUTH_PROBE_URL = 'https://api.fal.ai/v1/workflows?limit=1';
const FAL_STATUS_POLL_INTERVAL_MS = 2000;
const FAL_STATUS_TIMEOUT_MS = 120000;
const FAL_CANCEL_TIMEOUT_MS = 2000;

/** Normalize a fal.ai model id (for example, "fal-ai/flux/schnell"). */
export function normalizeFalModelId(model) {
  const id = String(model || '').trim().replace(/^\/+|\/+$/g, '');
  if (!id) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(id) || id.includes('..')) return '';
  return id;
}

export function isImageGenConfigured(cfg) {
  return !!(cfg && cfg.apiKey && cfg.model);
}

export function falQueueSubmitUrl(model) {
  return `${FAL_QUEUE_BASE}/${model}`;
}

/** Extract a usable media URL from the response shapes used by fal models. */
export function extractFalMediaUrl(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.url === 'string' && /^https:\/\//.test(payload.url)) return payload.url;
  for (const listKey of ['images', 'videos', 'audio']) {
    const list = payload[listKey];
    if (Array.isArray(list) && typeof list[0]?.url === 'string' && /^https:\/\//.test(list[0].url)) {
      return list[0].url;
    }
  }
  for (const objKey of ['image', 'video', 'audio']) {
    const obj = payload[objKey];
    if (obj && typeof obj.url === 'string' && /^https:\/\//.test(obj.url)) return obj.url;
  }
  return '';
}

async function falAuthHeaders(apiKey) {
  return { 'Authorization': `Key ${apiKey}`, 'Content-Type': 'application/json' };
}

function trustedFalQueueUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === FAL_QUEUE_BASE ? url.href : '';
  } catch {
    return '';
  }
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('fal.ai generation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function createOperationSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = new Error('fal.ai generation timed out.');
  timeoutError.name = 'TimeoutError';
  let timedOut = false;
  const onExternalAbort = () => {
    if (!controller.signal.aborted) controller.abort(abortReason(externalSignal));
  };
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort(timeoutError);
  }, timeoutMs);
  return {
    signal: controller.signal,
    timeoutError,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

async function cancelFalRequest(cancelUrl, headers, fetchImpl) {
  if (!cancelUrl) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAL_CANCEL_TIMEOUT_MS);
  try {
    await fetchImpl(cancelUrl, {
      method: 'PUT',
      headers,
      signal: controller.signal,
      keepalive: true,
    });
  } catch {
    // Cancellation is best-effort; preserve the original abort/timeout error.
  } finally {
    clearTimeout(timer);
  }
}

/** Run a queued generation: submit, poll, then fetch the result. */
export async function runFalGeneration({
  prompt,
  config,
  fetchImpl = fetch,
  timeoutMs = FAL_STATUS_TIMEOUT_MS,
  signal = null,
}) {
  const model = normalizeFalModelId(config?.model);
  if (!model) throw new Error('Invalid fal.ai model id.');
  if (!config?.apiKey) throw new Error('fal.ai API key not configured.');
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is required.');

  const operation = createOperationSignal(signal, timeoutMs);
  const headers = await falAuthHeaders(config.apiKey);
  let cancelUrl = '';
  let completed = false;
  try {
    throwIfAborted(operation.signal);
    const submitRes = await fetchImpl(falQueueSubmitUrl(model), {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: text }),
      signal: operation.signal,
    });
    if (!submitRes.ok) {
      let body = '';
      try { body = (await submitRes.text()).slice(0, 300); } catch { /* ignore */ }
      throw new Error(`fal.ai submit failed (HTTP ${submitRes.status}): ${body || submitRes.statusText}`);
    }

    let queued;
    try {
      queued = await submitRes.json();
    } catch (error) {
      throw new Error(`fal.ai submit returned invalid JSON: ${error.message}`);
    }
    const statusUrl = trustedFalQueueUrl(queued?.status_url);
    const responseUrl = trustedFalQueueUrl(queued?.response_url);
    cancelUrl = trustedFalQueueUrl(queued?.cancel_url)
      || (responseUrl ? `${responseUrl.replace(/\/$/, '')}/cancel` : '');
    if (!statusUrl || !responseUrl) {
      throw new Error('fal.ai submit response missing trusted status_url/response_url.');
    }

    let status = 'IN_QUEUE';
    while (true) {
      await abortableDelay(FAL_STATUS_POLL_INTERVAL_MS, operation.signal);
      const statusRes = await fetchImpl(statusUrl, { headers, signal: operation.signal });
      if (!statusRes.ok) throw new Error(`fal.ai status check failed (HTTP ${statusRes.status}).`);

      let statusPayload;
      try {
        statusPayload = await statusRes.json();
      } catch (error) {
        throw new Error(`fal.ai status returned invalid JSON: ${error.message}`);
      }
      status = String(statusPayload?.status || '').toUpperCase();
      if (status === 'COMPLETED') {
        const resultRes = await fetchImpl(responseUrl, { headers, signal: operation.signal });
        if (!resultRes.ok) throw new Error(`fal.ai result fetch failed (HTTP ${resultRes.status}).`);

        let payload;
        try {
          payload = await resultRes.json();
        } catch (error) {
          throw new Error(`fal.ai result returned invalid JSON: ${error.message}`);
        }
        const url = extractFalMediaUrl(payload);
        if (!url) throw new Error('fal.ai result contained no media URL.');
        completed = true;
        return { url, model, status };
      }
      if (status === 'FAILED' || status === 'ERROR') {
        const errorText = typeof statusPayload?.error === 'string' ? statusPayload.error : 'unknown error';
        throw new Error(`fal.ai generation failed: ${errorText}`);
      }
    }
  } catch (error) {
    if (cancelUrl && !completed) await cancelFalRequest(cancelUrl, headers, fetchImpl);
    if (operation.timedOut()) throw operation.timeoutError;
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    operation.dispose();
  }
}

/** Agent tool entry point. Reads the assistive-model config from storage. */
export async function generateImage(args, options = {}) {
  const fetchImpl = typeof options === 'function' ? options : (options.fetchImpl || fetch);
  const signal = typeof options === 'object' ? options.signal : null;
  let cfg;
  const api = (typeof browser !== 'undefined' && browser?.storage) ? browser
    : (typeof chrome !== 'undefined' ? chrome : null);
  try {
    const stored = await api.storage.local.get([IMAGE_GEN_MODEL_KEY]);
    cfg = stored?.[IMAGE_GEN_MODEL_KEY];
  } catch (error) {
    return { success: false, error: 'Failed to read generative media config: ' + error.message };
  }
  if (!isImageGenConfigured(cfg)) {
    return { success: false, error: 'Generative media is not configured. Set up fal.ai in Settings -> Assistive Models.' };
  }
  try {
    const result = await runFalGeneration({ prompt: args?.prompt, config: cfg, fetchImpl, signal });
    return { success: true, url: result.url, model: result.model };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** Verify a key against a free, read-only endpoint that requires authentication. */
export async function testImageGenProvider(fetchImpl = fetch) {
  let cfg;
  const api = (typeof browser !== 'undefined' && browser?.storage) ? browser
    : (typeof chrome !== 'undefined' ? chrome : null);
  try {
    const stored = await api.storage.local.get([IMAGE_GEN_MODEL_KEY]);
    cfg = stored?.[IMAGE_GEN_MODEL_KEY];
  } catch (error) {
    return { ok: false, error: 'Failed to read generative media config: ' + error.message };
  }
  if (!isImageGenConfigured(cfg)) {
    return { ok: false, error: 'Generative media not configured (API Key and Model are required).' };
  }
  const model = normalizeFalModelId(cfg.model);
  if (!model) return { ok: false, error: 'Invalid fal.ai model id.' };
  try {
    const res = await fetchImpl(FAL_AUTH_PROBE_URL, { headers: await falAuthHeaders(cfg.apiKey) });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'fal.ai rejected the API key (HTTP ' + res.status + ').' };
    }
    if (res.ok) return { ok: true, model };
    return { ok: false, error: `Unexpected response from fal.ai (HTTP ${res.status}).` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
