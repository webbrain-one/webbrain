// fal.ai generative media (assistive model).
//
// Configured in Providers -> Generative (fal.ai provider) and stored in
// extension storage as `imageGenModel = { apiKey, model, videoModel }`; the
// caller passes the model a request uses as `config.model`.
// fal.ai uses a queue API: submit a prompt, poll status_url, then fetch
// response_url. Auth uses `Authorization: Key <FAL_KEY>`.

export const IMAGE_GEN_MODEL_KEY = 'imageGenModel';
export const FAL_QUEUE_BASE = 'https://queue.fal.run';
export const FAL_AUTH_PROBE_URL = 'https://api.fal.ai/v1/workflows?limit=1';
const FAL_STATUS_POLL_INTERVAL_MS = 2000;
const FAL_STATUS_TIMEOUT_MS = 120000;
const FAL_CANCEL_TIMEOUT_MS = 2000;
// Reads of a queued request that may fail in a row for a passing reason before
// the request is given up: its status while it runs, and its finished result.
const FAL_STATUS_READ_ATTEMPTS = 5;
const FAL_RESULT_READ_ATTEMPTS = 3;
const FAL_READ_RETRY_MAX_MS = 15000;

/** Normalize a fal.ai model id (for example, "fal-ai/flux/schnell"). */
export function normalizeFalModelId(model) {
  const id = String(model || '').trim().replace(/^\/+|\/+$/g, '');
  if (!id) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(id) || id.includes('..')) return '';
  return id;
}

export { isImageGenConfigured } from './media-config.js';

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

// How long a response asks to wait before trying again (Retry-After in
// seconds), in milliseconds; undefined when it does not say.
function retryAfterMs(response) {
  const seconds = Number(response.headers?.get?.('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Reads a queued request's status or result. The request is submitted and paid
 * for, so a read that fails for a passing reason (the network, a gateway
 * error, a rate limit) is tried again, waiting longer each time, instead of
 * giving the request up and generating again. Returns the response, which may
 * still be a failure: any other status, or the last of `attempts`.
 */
async function readFalRequest(url, { headers, fetchImpl, signal, pollMs, attempts }) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { headers, signal, redirect: 'error', credentials: 'omit' });
    } catch (error) {
      throwIfAborted(signal);
      if (attempt >= attempts) throw error;
    }
    const passing = !response || response.status >= 500 || response.status === 408 || response.status === 429;
    if (response && (!passing || attempt >= attempts)) return response;
    await abortableDelay(Math.min(pollMs * 2 ** (attempt - 1), FAL_READ_RETRY_MAX_MS), signal);
  }
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

/**
 * Run a queued generation: submit, poll, then fetch the result. `input` adds
 * model inputs (such as a video's duration) to the prompt.
 */
export async function runFalGeneration({
  prompt,
  config,
  input = {},
  fetchImpl = fetch,
  timeoutMs = FAL_STATUS_TIMEOUT_MS,
  pollMs = FAL_STATUS_POLL_INTERVAL_MS,
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
      redirect: 'error', credentials: 'omit',
      headers,
      body: JSON.stringify({ prompt: text, ...input }),
      signal: operation.signal,
    });
    if (!submitRes.ok) {
      let body = '';
      try { body = (await submitRes.text()).slice(0, 300); } catch { /* ignore */ }
      const credit = submitRes.status === 402 ? 'the account is out of credit; add credit and try again: ' : '';
      throw Object.assign(new Error(`fal.ai submit failed (HTTP ${submitRes.status}): ${credit}${body || submitRes.statusText}`),
        { status: submitRes.status, retryAfterMs: retryAfterMs(submitRes) });
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

    const read = { headers, fetchImpl, signal: operation.signal, pollMs };
    let status = 'IN_QUEUE';
    while (true) {
      await abortableDelay(pollMs, operation.signal);
      const statusRes = await readFalRequest(statusUrl, { ...read, attempts: FAL_STATUS_READ_ATTEMPTS });
      // HTTP failures keep their status, so a refusal is not tried again.
      if (!statusRes.ok) throw Object.assign(new Error(`fal.ai status check failed (HTTP ${statusRes.status}).`), { status: statusRes.status });

      let statusPayload;
      try {
        statusPayload = await statusRes.json();
      } catch (error) {
        throw new Error(`fal.ai status returned invalid JSON: ${error.message}`);
      }
      status = String(statusPayload?.status || '').toUpperCase();
      if (status === 'COMPLETED') {
        // A request that failed says so in its status; its result is then the
        // failure itself and is read once.
        const failed = statusPayload.error != null || statusPayload.error_type != null;
        const resultRes = await readFalRequest(responseUrl, { ...read, attempts: failed ? 1 : FAL_RESULT_READ_ATTEMPTS });
        if (!resultRes.ok) {
          // fal.ai reports inputs the model rejects here (HTTP 422), with the reason.
          let detail = '';
          try { detail = (await resultRes.text()).slice(0, 300); } catch { /* no body */ }
          throw Object.assign(new Error(`fal.ai result fetch failed (HTTP ${resultRes.status})${detail ? `: ${detail}` : '.'}`), { status: resultRes.status });
        }

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

// Legacy entry points must use static exports: MV3 service workers forbid import().
export { generateImage, testImageGenProvider } from './generative-media.js';
