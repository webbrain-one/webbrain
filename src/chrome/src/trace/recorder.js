/**
 * Trace recorder — writes per-run traces (LLM requests/responses, tool calls,
 * screenshots) into IndexedDB for later inspection and cross-model comparison.
 *
 * Schema (db `webbrain_traces`, v1):
 *   - runs       keyPath=runId                  // top-level run metadata
 *   - events     keyPath=[runId, seq]           // ordered event log
 *   - shots      keyPath=[runId, seq]           // screenshot Blobs
 *
 * All writes are fire-and-forget. Recording is gated on the `tracingEnabled`
 * setting; when disabled, every call is a cheap no-op.
 */

const DB_NAME = 'webbrain_traces';
const DB_VERSION = 1;

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('runs')) {
        const s = db.createObjectStore('runs', { keyPath: 'runId' });
        s.createIndex('startedAt', 'startedAt');
        s.createIndex('model', 'model');
        s.createIndex('providerId', 'providerId');
      }
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: ['runId', 'seq'] });
        s.createIndex('runId', 'runId');
      }
      if (!db.objectStoreNames.contains('shots')) {
        const s = db.createObjectStore('shots', { keyPath: ['runId', 'seq'] });
        s.createIndex('runId', 'runId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(db, stores, mode = 'readwrite') {
  return db.transaction(stores, mode);
}

function promisifyReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ----- Settings gate ---------------------------------------------------------

async function tracingEnabled() {
  try {
    const { tracingEnabled } = await chrome.storage.local.get(['tracingEnabled']);
    return tracingEnabled === true;
  } catch { return false; }
}

// ----- Per-run state (held in memory on the service worker) ------------------
//
// A run lives only as long as its processMessage() call. If the SW gets
// evicted mid-run we lose the in-memory seq counter, but since we ended up
// awakened for each tool call anyway, the counter is refreshed from disk
// on the first write of each wake cycle via `_peekSeq`.

const _runState = new Map(); // runId -> { seq, model, providerId, ... }

async function _peekSeq(db, runId) {
  // Find the max seq already in the events store for this runId.
  const t = tx(db, ['events'], 'readonly');
  const idx = t.objectStore('events').index('runId');
  const cursor = idx.openCursor(IDBKeyRange.only(runId), 'prev');
  const result = await new Promise((resolve) => {
    cursor.onsuccess = () => resolve(cursor.result ? cursor.result.value.seq : 0);
    cursor.onerror = () => resolve(0);
  });
  return result;
}

function _newSeq(runId) {
  const st = _runState.get(runId);
  if (!st) return 0;
  st.seq += 1;
  return st.seq;
}

// ----- Public API ------------------------------------------------------------

export async function startRun(meta) {
  if (!(await tracingEnabled())) return null;
  try {
    const db = await openDB();
    const runId = meta.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      runId,
      // Stable per-conversation id so the Traces UI can group sibling runs
      // (= turns of the same chat). Set by the agent from its conversationIds
      // map keyed by tabId. Older runs have null here — viewer treats those
      // as singletons.
      conversationId: meta.conversationId || null,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      status: 'running',
      model: meta.model || '',
      providerId: meta.providerId || '',
      providerClass: meta.providerClass || '',
      webbrainVersion: meta.webbrainVersion || '',
      userMessage: meta.userMessage || '',
      tabUrl: meta.tabUrl || '',
      tabTitle: meta.tabTitle || '',
      mode: meta.mode || 'act',
      stepCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      finalContent: null,
    };
    await promisifyReq(tx(db, ['runs']).objectStore('runs').put(record));
    _runState.set(runId, { seq: 0, model: record.model, providerId: record.providerId });
    return runId;
  } catch (e) {
    console.warn('[trace] startRun failed:', e);
    return null;
  }
}

async function _appendEvent(runId, kind, data) {
  if (!runId) return;
  if (!(await tracingEnabled())) return;
  try {
    const db = await openDB();
    if (!_runState.has(runId)) {
      // Recover from SW eviction.
      const seq = await _peekSeq(db, runId);
      _runState.set(runId, { seq });
    }
    const seq = _newSeq(runId);
    const ev = { runId, seq, ts: Date.now(), kind, data: data || null };
    await promisifyReq(tx(db, ['events']).objectStore('events').put(ev));
    return seq;
  } catch (e) {
    console.warn('[trace] appendEvent failed:', e);
  }
}

export function recordLLMRequest(runId, step, payload) {
  // Payload is large (full message array + tool schemas). Only record when
  // verboseTracing is on — in normal mode we just record the response.
  return _appendEvent(runId, 'llm_request', { step, ...payload });
}

export function recordLLMResponse(runId, step, { content, toolCalls, usage, latencyMs, model, phase }) {
  return _appendEvent(runId, 'llm_response', {
    step,
    content: content || null,
    toolCalls: toolCalls ? toolCalls.map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      args: tc.function?.arguments, // string form, as received
    })) : [],
    usage: usage || null,
    latencyMs: latencyMs || null,
    model: model || null,
    // Carry the phase label (e.g. 'planner') so a pre-loop planner call recorded
    // at step 0 is distinguishable from the agent loop's first step-0 response.
    ...(phase ? { phase } : {}),
  });
}

export function recordToolCall(runId, step, { name, args, result, latencyMs }) {
  // Truncate very large tool results (a11y trees can be huge). Keep the first
  // 20KB verbatim and note the truncation — plenty for debugging flow, and
  // the model response still has the full thing in context anyway.
  let shortResult = result;
  try {
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    if (s && s.length > 20_000) {
      shortResult = { _truncated: true, length: s.length, head: s.slice(0, 20_000) };
    }
  } catch {}
  return _appendEvent(runId, 'tool', {
    step,
    name,
    args: args || null,
    result: shortResult,
    latencyMs: latencyMs || null,
  });
}

export async function recordScreenshot(runId, step, dataUrl, caption = '') {
  if (!runId) return;
  if (!(await tracingEnabled())) return;
  if (!dataUrl) return;
  try {
    const db = await openDB();
    if (!_runState.has(runId)) {
      const seq = await _peekSeq(db, runId);
      _runState.set(runId, { seq });
    }
    const seq = _newSeq(runId);
    // Decode data URL to a Blob so IDB stores raw bytes (no base64 overhead).
    let blob = null;
    try {
      const resp = await fetch(dataUrl);
      blob = await resp.blob();
    } catch {
      // Fall back to storing the data URL as text.
    }
    const shot = { runId, seq, ts: Date.now(), caption, step, blob, dataUrl: blob ? null : dataUrl };
    await promisifyReq(tx(db, ['shots']).objectStore('shots').put(shot));
    // Also record a lightweight marker in the events log so the timeline
    // renders screenshots in order with everything else.
    await promisifyReq(tx(db, ['events']).objectStore('events').put({
      runId, seq, ts: shot.ts, kind: 'screenshot', data: { step, caption },
    }));
    return seq;
  } catch (e) {
    console.warn('[trace] recordScreenshot failed:', e);
  }
}

export function recordError(runId, step, phase, message) {
  return _appendEvent(runId, 'error', { step, phase, message });
}

/**
 * Record a vision sub-call: the agent asked a dedicated vision model to
 * describe a screenshot so the main planning model receives text instead
 * of pixels. Captured for debugging and quality inspection — description
 * quality is the main failure mode of the split-provider design.
 */
export function recordVisionSubCall(runId, { step, context, model, baseUrl, description, latencyMs, error }) {
  return _appendEvent(runId, 'vision_sub_call', {
    step: step || null,
    context: context || null, // 'initial_user_message' | 'auto_screenshot' | ...
    model: model || null,
    baseUrl: baseUrl || null,
    description: description || null,
    latencyMs: latencyMs || null,
    error: error || null,
  });
}

export function recordNote(runId, step, note, extra = null) {
  return _appendEvent(runId, 'note', { step, note, extra });
}

export async function endRun(runId, { status = 'done', finalContent = null } = {}) {
  if (!runId) return;
  if (!(await tracingEnabled())) return;
  try {
    const db = await openDB();
    // Tally usage from events. `totalCost` is the sum of `usage.cost` across
    // all llm_response events — providers report this in their native units
    // (OpenRouter & OpenAI: USD). Surfaced in the Traces UI so users can
    // spot expensive-failure runs at a glance.
    let totalIn = 0, totalOut = 0, totalCost = 0, stepCount = 0;
    let sawLoopError = false;
    await new Promise((resolve) => {
      const idx = tx(db, ['events'], 'readonly').objectStore('events').index('runId');
      const req = idx.openCursor(IDBKeyRange.only(runId));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        const ev = c.value;
        if (ev.kind === 'error' && ev.data?.phase === 'loop') sawLoopError = true;
        if (ev.kind === 'llm_response') {
          stepCount = Math.max(stepCount, ev.data?.step || 0);
          const u = ev.data?.usage;
          if (u) {
            totalIn += u.prompt_tokens || 0;
            totalOut += u.completion_tokens || 0;
            if (typeof u.cost === 'number' && Number.isFinite(u.cost)) totalCost += u.cost;
          }
        }
        c.continue();
      };
      req.onerror = () => resolve();
    });
    const existing = await promisifyReq(tx(db, ['runs'], 'readonly').objectStore('runs').get(runId));
    if (existing) {
      const finalStatus = status === 'done' && sawLoopError ? 'loop_stopped' : status;
      existing.endedAt = Date.now();
      existing.durationMs = existing.endedAt - existing.startedAt;
      existing.status = finalStatus;
      existing.finalContent = finalContent;
      existing.stepCount = stepCount;
      existing.totalInputTokens = totalIn;
      existing.totalOutputTokens = totalOut;
      existing.totalCost = totalCost; // null/0 when the provider didn't report cost
      await promisifyReq(tx(db, ['runs']).objectStore('runs').put(existing));
    }
  } catch (e) {
    console.warn('[trace] endRun failed:', e);
  } finally {
    _runState.delete(runId);
  }
}

// ----- Reader API (used by traces.html) --------------------------------------

export async function listRuns({ limit = 500, conversationId = null } = {}) {
  const db = await openDB();
  const idx = tx(db, ['runs'], 'readonly').objectStore('runs').index('startedAt');
  const out = [];
  // When conversationId is set, only matching runs count toward `limit`, so a
  // chat's tool-chain export is not starved by unrelated newer runs.
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) return resolve();
      const row = c.value;
      if (!conversationId || row?.conversationId === conversationId) {
        out.push(row);
      }
      c.continue();
    };
    req.onerror = () => reject(req.error || new Error('listRuns failed'));
  });
  return out;
}

export async function getRun(runId) {
  const db = await openDB();
  return promisifyReq(tx(db, ['runs'], 'readonly').objectStore('runs').get(runId));
}

export async function getRunEvents(runId) {
  const db = await openDB();
  const idx = tx(db, ['events'], 'readonly').objectStore('events').index('runId');
  const out = [];
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(runId));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error || new Error('getRunEvents failed'));
  });
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export async function getScreenshot(runId, seq) {
  const db = await openDB();
  return promisifyReq(tx(db, ['shots'], 'readonly').objectStore('shots').get([runId, seq]));
}

export async function deleteRun(runId) {
  const db = await openDB();
  const t = tx(db, ['runs', 'events', 'shots']);
  await promisifyReq(t.objectStore('runs').delete(runId));
  // Delete all events and shots for this runId via cursor
  await new Promise((resolve) => {
    const req = t.objectStore('events').index('runId').openCursor(IDBKeyRange.only(runId));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    req.onerror = () => resolve();
  });
  await new Promise((resolve) => {
    const req = t.objectStore('shots').index('runId').openCursor(IDBKeyRange.only(runId));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    req.onerror = () => resolve();
  });
}

export async function clearAllRuns() {
  const db = await openDB();
  const t = tx(db, ['runs', 'events', 'shots']);
  await promisifyReq(t.objectStore('runs').clear());
  await promisifyReq(t.objectStore('events').clear());
  await promisifyReq(t.objectStore('shots').clear());
}
