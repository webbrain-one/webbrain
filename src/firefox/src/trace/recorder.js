import { normalizeRuntimeTraceConfig } from './runtime-config.js';
import { buildPromptTraceProvenance } from './prompt-provenance.js';
import { formatErrorMessage } from '../error-format.js';
import { TRACE_FORMAT_VERSION, makeEvent } from './event-model.js';
import { normalizeErrorCode } from './error-codes.js';
import { normalizeRunHeader, effectiveDelegationDepth, generateTraceRunId } from './run-header.js';
import { clampUtf8Value, fitUtf8Prefix, utf8ByteLength } from './utf8-budget.js';
import {
  buildTraceRepairPlan,
  isStaleRunningTrace,
  normalizedThreshold,
  TRACE_REPAIR_STALE_AFTER_MS,
} from './repair.js';
import { createTraceStats, addTraceEvent, aggregateTraceRuns } from './stats.js';
import { projectTraceEventData, projectTraceRun } from './privacy.js';
import { toolOutcome } from './tool-outcome.js';
import { feedbackRecordingPolicy, feedbackRunsToEvict, FEEDBACK_RUN_BYTES, FEEDBACK_HISTORY_BYTES } from './feedback-policy.js';
import { normalizeRejectedToolResponse } from '../agent/model-output-diagnostics.js';
import { secureRandomBase36Token } from '../agent/random-token.js';

/**
 * Trace recorder — writes per-run traces (LLM requests/responses, tool calls,
 * screenshots) into IndexedDB for later inspection and cross-model comparison.
 *
 * Schema (db `webbrain_traces`, v2):
 *   - runs       keyPath=runId                  // top-level run metadata
 *   - events     keyPath=[runId, seq]           // ordered event log
 *   - shots      keyPath=[runId, seq]           // screenshot Blobs
 *
 * All writes are fire-and-forget. Recording is gated on the `tracingEnabled`
 * setting, explicit forced runs, or bounded automatic feedback diagnostics.
 */

const traceStorage = () => (typeof browser !== 'undefined' ? browser : chrome).storage.local;
const DB_NAME = 'webbrain_traces';
const DB_VERSION = 2;

// Lossless tier bounds: tool results up to 200 KB verbatim, request payloads
// up to 500 KB before the head is clamped with a truncation marker. Keeps an
// opt-in debugging tier from exhausting IndexedDB on a single long run.
const LOSSILESS_RESULT_CAP = 200_000;
const LOSSILESS_REQUEST_CAP = 500_000;
const LOSSILESS_RUN_CAP = 5_000_000;
const LOSSILESS_TOTAL_CAP = 50_000_000;

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
      // v2: lineage lookup indexes. `conversationId` IS the session identity
      // (grouping key for sibling runs); the index carries the semantic name
      // so session-level queries read naturally. Records with null keys are
      // skipped by IndexedDB, so old runs are simply absent from the index.
      const runsStore = req.transaction ? req.transaction.objectStore('runs') : null;
      if (runsStore) {
        if (!runsStore.indexNames.contains('sessionId')) {
          runsStore.createIndex('sessionId', 'conversationId');
        }
        if (!runsStore.indexNames.contains('parentRunId')) {
          runsStore.createIndex('parentRunId', 'parentRunId');
        }
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
    if (typeof indexedDB === 'undefined') return false;
    const { tracingEnabled } = await traceStorage().get(['tracingEnabled']);
    return tracingEnabled === true;
  } catch { return false; }
}

async function isForcedTraceRun(runId) {
  if (!runId) return false;
  if (_runState.get(runId)?.feedbackOnly === true) {
    const settings = await traceStorage().get('feedbackDiagnosticsEnabled');
    return settings.feedbackDiagnosticsEnabled !== false;
  }
  if (_runState.get(runId)?.forced === true) return true;
  try {
    const db = await openDB();
    const record = await promisifyReq(
      tx(db, ['runs'], 'readonly').objectStore('runs').get(runId),
    );
    if (record?.feedbackOnly === true) {
      const settings = await traceStorage().get('feedbackDiagnosticsEnabled');
      return settings.feedbackDiagnosticsEnabled !== false;
    }
    return record?.forced === true;
  } catch { return false; }
}

async function tracingEnabledForRun(runId) {
  return (await tracingEnabled()) || (await isForcedTraceRun(runId));
}

// Restore per-run flags after SW eviction from the durable run record so the
// lossless tier decision survives a worker restart mid-run.
async function peekRunFlags(db, runId) {
  try {
    const record = await promisifyReq(
      tx(db, ['runs'], 'readonly').objectStore('runs').get(runId),
    );
    return { forced: record?.forced === true, feedbackOnly: record?.feedbackOnly === true, feedbackBytes: record?.feedbackBytes || 0, lossless: record?.lossless === true, losslessBytes: record?.losslessBytes || 0, losslessBytesEncoding: record?.losslessBytesEncoding || '' };
  } catch { return { forced: false, lossless: false, losslessBytes: 0 }; }
}

// ----- Per-run state (held in memory on the service worker) ------------------
//
// A run lives only as long as its processMessage() call. If the SW gets
// evicted mid-run we lose the in-memory seq counter, but since we ended up
// awakened for each tool call anyway, the counter is refreshed from disk
// on the first write of each wake cycle via `_peekSeq`.

const _runState = new Map(); // runId -> { seq, model, providerId, ... }
const _runWriteQueues = new Map(); // runId -> serialized event-write promise
// Bounded raw tool payloads live only for the active worker lifetime. The
// agent turns them into the existing value-free saved-workflow schema at
// successful run completion; they never cross the default durable trace
// boundary.
const _workflowTraceCaptures = new Map(); // runId -> { run, events, nextSeq }

function _queueRunWrite(runId, write) {
  if (!runId) return Promise.resolve();
  const previous = _runWriteQueues.get(runId) || Promise.resolve();
  const current = previous.catch(() => {}).then(write);
  _runWriteQueues.set(runId, current);
  current.finally(() => {
    if (_runWriteQueues.get(runId) === current) _runWriteQueues.delete(runId);
  }).catch(() => {});
  return current;
}

async function _flushRunWrites(runId) {
  let pending = _runWriteQueues.get(runId);
  while (pending) {
    await pending.catch(() => {});
    const next = _runWriteQueues.get(runId);
    if (!next || next === pending) return;
    pending = next;
  }
}

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

const _runStateLoads = new Map();

async function _ensureRunState(runId, db = null) {
  if (!runId) return null;
  const existing = _runState.get(runId);
  if (existing) return existing;
  const pending = _runStateLoads.get(runId);
  if (pending) return pending;
  const load = (async () => {
    try {
      const resolvedDb = db || await openDB();
      const seq = await _peekSeq(resolvedDb, runId);
      const flags = await peekRunFlags(resolvedDb, runId);
      const state = { seq, forced: flags.forced, feedbackOnly: flags.feedbackOnly, feedbackBytes: flags.feedbackBytes, lossless: flags.lossless, losslessBytes: Number(flags.losslessBytes) || 0, losslessBytesEncoding: flags.losslessBytesEncoding };
      _runState.set(runId, state);
      return state;
    } catch { return null; }
  })();
  _runStateLoads.set(runId, load);
  try { return await load; }
  finally { if (_runStateLoads.get(runId) === load) _runStateLoads.delete(runId); }
}

function boundedToolNames(tools) {
  return Array.isArray(tools)
    ? tools.slice(0, 100).map(tool => String(tool?.function?.name || '?').slice(0, 120))
    : [];
}

function clampLosslessRequest(messages, tools, maxBytes = LOSSILESS_REQUEST_CAP) {
  const request = { messages: messages ?? null, tools: tools ?? null };
  let serialized;
  try { serialized = JSON.stringify(request); } catch { serialized = null; }
  if (!serialized) {
    return {
      messages: { _truncated: true, length: null, head: '(unserializable request)', toolNames: boundedToolNames(tools) },
      tools: null,
    };
  }
  const byteLength = utf8ByteLength(serialized);
  const limit = Math.max(0, Math.min(LOSSILESS_REQUEST_CAP, Number(maxBytes) || 0));
  if (byteLength <= limit) return { messages, tools };
  // Keep one bounded head of the combined request. Tool names remain visible
  // even when the head ends before the dynamic tool catalog.
  const toolNames = boundedToolNames(tools);
  const buildMarker = head => ({
    messages: {
      _truncated: true,
      length: byteLength,
      head,
      toolNames,
    },
    tools: null,
  });
  while (toolNames.length && utf8ByteLength(JSON.stringify(buildMarker(''))) > limit) {
    toolNames.pop();
  }
  const head = fitUtf8Prefix(serialized, limit, prefix => JSON.stringify(buildMarker(prefix)));
  return buildMarker(head);
}

function boundedLosslessRequestMetadata(data) {
  const metadata = {};
  for (const [key, limit] of [
    ['providerClass', 160],
    ['providerId', 160],
    ['model', 240],
    ['phase', 40],
  ]) {
    const value = String(data?.[key] || '').trim();
    if (value) metadata[key] = value.slice(0, limit);
  }
  for (const key of [
    'attempt',
    'messageCount',
    'toolsCount',
    'imageBlockCount',
    'documentBlockCount',
  ]) {
    const value = Number(data?.[key]);
    if (Number.isFinite(value)) metadata[key] = Math.max(0, Math.min(1_000_000, Math.trunc(value)));
  }
  if (data?.repair === true) metadata.repair = true;
  if (data?.localWikipediaRag && typeof data.localWikipediaRag === 'object') {
    const rag = data.localWikipediaRag;
    metadata.localWikipediaRag = {
      status: String(rag.status || '').slice(0, 40),
      attempted: rag.attempted === true,
      matchCount: Math.max(0, Math.min(1_000_000, Math.trunc(Number(rag.matchCount) || 0))),
      multiSource: rag.multiSource === true,
      archiveDates: (Array.isArray(rag.archiveDates) ? rag.archiveDates : [])
        .slice(0, 3)
        .map(value => String(value || '').slice(0, 20)),
    };
  }
  return metadata;
}

function losslessBudgetMarker(kind, data) {
  const budgetHead = '(per-run lossless budget reached)';
  if (kind === 'llm_request') {
    let length = data?.messages?._truncated ? data.messages.length : null;
    if (length == null) {
      try { length = utf8ByteLength(JSON.stringify({ messages: data?.messages ?? null, tools: data?.tools ?? null })); } catch {}
    }
    const toolNames = Array.isArray(data?.messages?.toolNames)
      ? data.messages.toolNames.slice(0, 100).map(value => String(value || '?').slice(0, 120))
      : boundedToolNames(data?.tools);
    return {
      step: data?.step ?? null,
      ...boundedLosslessRequestMetadata(data),
      lossless: true,
      messages: { _truncated: true, length, head: budgetHead, toolNames },
      tools: null,
      losslessBudgetOmitted: true,
    };
  }

  let length = data?.result?._truncated ? data.result.length : null;
  if (length == null) {
    try { length = utf8ByteLength(JSON.stringify(data?.result)); } catch {}
  }
  return {
    step: data?.step ?? null,
    name: String(data?.name || '').slice(0, 120),
    args: null,
    result: { ...data?.outcome, _truncated: true, length, head: budgetHead },
    outcome: data?.outcome || {},
    latencyMs: data?.latencyMs ?? null,
    losslessBudgetOmitted: true,
  };
}

function _repairRunInTransaction(db, runId, { now, staleAfterMs }) {
  return new Promise((resolve, reject) => {
    const transaction = tx(db, ['runs', 'events'], 'readwrite');
    const runsStore = transaction.objectStore('runs');
    const eventsStore = transaction.objectStore('events');
    let run = null;
    let events = null;
    let pending = 2;
    let repairedRunId = null;
    let requestError = null;

    const fail = (error) => {
      requestError = error || new Error('trace repair request failed');
      try { transaction.abort(); } catch {}
    };
    const apply = () => {
      pending -= 1;
      if (pending > 0 || requestError) return;
      const plan = buildTraceRepairPlan(run, events, { now, staleAfterMs });
      if (!plan) return;
      // Last-instant liveness check: a run resumed between the candidate scan
      // and this transaction has registered itself in memory again.
      if (_runState.has(runId)) return;
      for (const event of plan.events) eventsStore.put(event);
      runsStore.put(plan.run);
      repairedRunId = runId;
    };

    transaction.oncomplete = () => resolve(repairedRunId);
    transaction.onerror = () => reject(requestError || transaction.error || new Error('trace repair failed'));
    transaction.onabort = () => {
      if (requestError) reject(requestError);
      else if (!repairedRunId) resolve(null);
    };

    const runRequest = runsStore.get(runId);
    runRequest.onsuccess = () => { run = runRequest.result || null; apply(); };
    runRequest.onerror = () => fail(runRequest.error);
    const eventsRequest = eventsStore.index('runId').getAll(IDBKeyRange.only(runId));
    eventsRequest.onsuccess = () => { events = eventsRequest.result || []; apply(); };
    eventsRequest.onerror = () => fail(eventsRequest.error);
  });
}

function _newSeq(runId) {
  const st = _runState.get(runId);
  if (!st) return 0;
  st.seq += 1;
  return st.seq;
}

function normalizeTraceAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).slice(0, 20).map(attachment => ({
    kind: ['image', 'document', 'text', 'video'].includes(attachment?.kind) ? attachment.kind : 'document',
    name: String(attachment?.name || 'attachment').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240),
    mimeType: String(attachment?.mimeType || '').slice(0, 120),
    size: Number.isFinite(Number(attachment?.size)) ? Math.max(0, Number(attachment.size)) : 0,
    source: attachment?.source === 'slash_screenshot' ? 'slash_screenshot' : 'user_upload',
  }));
}

// ----- Public API ------------------------------------------------------------

export async function startRun(meta = {}) {
  try {
    if (typeof indexedDB === 'undefined') return null;
    const settings = await traceStorage().get(['tracingEnabled', 'losslessTrace', 'feedbackDiagnosticsEnabled']);
    const policy = feedbackRecordingPolicy(settings, meta.force === true);
    if (!policy.enabled) return null;
    const forced = meta.force === true || policy.feedbackOnly;
    const db = await openDB();
    // Base36 time + secure token: a decimal Date.now() in an uploaded id can be
    // rewritten by Cloud payment-card redaction (see generateTraceRunId).
    const runId = meta.runId || generateTraceRunId(Date.now(), secureRandomBase36Token(8));
    const lineage = normalizeRunHeader(meta) || {};
    // Tier is decided once per run: explicit caller override wins, otherwise
    // the opt-in setting. Never forced for local runs by default.
    const lossless = !policy.feedbackOnly && (meta.lossless === true || policy.lossless);
    const record = projectTraceRun({
      runId,
      // Stable per-conversation id so the Traces UI can group sibling runs
      // (= turns of the same chat). Set by the agent from its conversationIds
      // map keyed by tabId. Older runs have null here — viewer treats those
      // as singletons.
      conversationId: meta.conversationId || null,
      // Lineage: which run/session this run was derived from. Root runs keep
      // null/0. Only allowlisted identifiers reach these fields (run-header.js).
      parentRunId: (lineage && lineage.parentRunId) || null,
      parentSessionId: (lineage && lineage.parentSessionId) || null,
      delegationDepth: effectiveDelegationDepth(lineage),
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      status: 'running',
      model: meta.model || '',
      providerId: meta.providerId || '',
      providerClass: meta.providerClass || '',
      webbrainVersion: meta.webbrainVersion || '',
      traceFormatVersion: TRACE_FORMAT_VERSION,
      runtimeConfig: normalizeRuntimeTraceConfig(meta.runtimeConfig),
      userMessage: meta.userMessage || '',
      tabUrl: meta.tabUrl || '',
      tabTitle: meta.tabTitle || '',
      mode: meta.mode || 'act',
      attachments: normalizeTraceAttachments(meta.attachments),
      ...(lossless ? { lossless: true, losslessBytes: 0, losslessBytesEncoding: 'utf8' } : {}),
      forced,
      ...(policy.feedbackOnly ? { feedbackOnly: true, feedbackHistoryOmitted: true, feedbackBytes: 0 } : {}),
      stepCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      llmRequestCount: 0,
      llmResponseCount: 0,
      toolCallCount: 0,
      visionSubCallCount: 0,
      errorCount: 0,
      retryCount: 0,
      totalLlmLatencyMs: 0,
      totalToolLatencyMs: 0,
      finalContent: null,
    }, { includeContent: lossless });
    if (policy.feedbackOnly) {
      await pruneFeedbackDiagnostics();
      // Reserve room for final statistics and omission flags as well as events.
      record.feedbackBytes = utf8ByteLength(JSON.stringify(record)) + 1024;
    }
    if (policy.feedbackOnly) {
      const saved = await new Promise((resolve, reject) => {
        const transaction = tx(db, ['runs']);
        const store = transaction.objectStore('runs');
        const request = store.getAll();
        let inserted = false;
        request.onsuccess = () => {
          const total = request.result.filter(row => row.feedbackOnly)
            .reduce((sum, row) => sum + (Number(row.feedbackBytes) || 0), 0);
          if (record.feedbackBytes > FEEDBACK_RUN_BYTES
            || total + record.feedbackBytes > FEEDBACK_HISTORY_BYTES - 4096) return;
          store.put(record); inserted = true;
        };
        transaction.oncomplete = () => resolve(inserted);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      if (!saved) return null;
    } else await promisifyReq(tx(db, ['runs']).objectStore('runs').put(record));
    _runState.set(runId, { seq: 0, model: record.model, providerId: record.providerId, forced, feedbackOnly: policy.feedbackOnly, feedbackBytes: record.feedbackBytes || 0, lossless, losslessBytes: 0, losslessBytesEncoding: lossless ? 'utf8' : '' });
    _workflowTraceCaptures.set(runId, {
      run: {
        runId,
        conversationId: meta.conversationId || null,
        status: 'running',
        tabUrl: meta.tabUrl || '',
        webbrainVersion: meta.webbrainVersion || '',
      },
      events: [],
      nextSeq: 0,
    });
    return runId;
  } catch (e) {
    console.warn('[trace] startRun failed:', e);
    return null;
  }
}

function _putEventWithLosslessTotal(db, runId, event, losslessBytes) {
  return new Promise((resolve, reject) => {
    const transaction = tx(db, ['events', 'runs']);
    const eventsStore = transaction.objectStore('events');
    const runsStore = transaction.objectStore('runs');
    let totalUpdated = false;
    transaction.oncomplete = () => resolve(totalUpdated);
    transaction.onerror = () => reject(transaction.error || new Error('lossless trace write failed'));
    transaction.onabort = () => reject(transaction.error || new Error('lossless trace write aborted'));
    eventsStore.put(event);
    const runRequest = runsStore.get(runId);
    runRequest.onsuccess = () => {
      const run = runRequest.result;
      if (run?.lossless !== true) return;
      run.losslessBytes = losslessBytes;
      run.losslessBytesEncoding = 'utf8';
      runsStore.put(run);
      totalUpdated = true;
    };
  });
}

// A scheduler verifier can finish after endRun. Persist its event and the
// completed run's usage totals atomically, on the existing serialized queue.
function _putAuxiliaryUsage(db, runId, event) {
  return new Promise((resolve, reject) => {
    const transaction = tx(db, ['runs', 'events']);
    transaction.objectStore('events').put(event);
    const store = transaction.objectStore('runs');
    const request = store.get(runId);
    request.onsuccess = () => {
      const run = request.result;
      if (!run || run.status === 'running') return;
      const stats = { ...createTraceStats(), ...run };
      addTraceEvent(stats, event);
      for (const key of Object.keys(createTraceStats())) {
        if (key !== 'hasLoopError') run[key] = stats[key];
      }
      store.put(run);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Auxiliary trace write aborted'));
  });
}

async function _appendEventNow(runId, kind, data) {
  if (!(await tracingEnabledForRun(runId))) return;
  try {
    const db = await openDB();
    const state = await _ensureRunState(runId, db);
    if (state?.lossless === true && state.losslessBytesEncoding !== 'utf8') {
      const run = await promisifyReq(tx(db, ['runs'], 'readonly').objectStore('runs').get(runId));
      if (run?.lossless === true) {
        state.losslessBytes = await _recomputeLosslessBytes(db, run, {
          refreshActiveState: false,
          trustMarkedCurrent: false,
        });
        state.losslessBytesEncoding = 'utf8';
      }
    }
    let resolvedData = typeof data === 'function' ? data(state) : data;
    resolvedData = projectTraceEventData(kind, resolvedData, { includeContent: state?.lossless === true });
    let losslessBytes = 0;
    let losslessBudgetOmitted = false;
    if (state?.lossless === true && (kind === 'llm_request' || kind === 'tool')) {
      try { losslessBytes = new TextEncoder().encode(JSON.stringify(resolvedData)).length; } catch {}
      const remainingBytes = Math.max(0, LOSSILESS_RUN_CAP - (state.losslessBytes || 0));
      if (losslessBytes > remainingBytes) {
        resolvedData = losslessBudgetMarker(kind, resolvedData);
        losslessBudgetOmitted = true;
      }
    }
    const seq = _newSeq(runId);
    const ev = makeEvent(runId, seq, kind, resolvedData);
    if (!ev) {
      // Unknown kind or unserializable data: skip the write and surface the
      // bug at recording time instead of storing a ghost event.
      console.warn('[trace] dropped invalid event:', kind);
      return null;
    }
    if (state?.feedbackOnly === true) {
      return await writeFeedbackEvent(db, runId, ev, state);
    }
    if (state?.lossless === true && (kind === 'llm_request' || kind === 'tool')) {
      if (losslessBudgetOmitted) {
        await promisifyReq(tx(db, ['events']).objectStore('events').put(ev));
        return seq;
      }
      const bytes = losslessBytes;
      const nextLosslessBytes = (state.losslessBytes || 0) + bytes;
      const totalUpdated = await _putEventWithLosslessTotal(db, runId, ev, nextLosslessBytes);
      if (totalUpdated) {
        state.losslessBytes = nextLosslessBytes;
        state.losslessBytesEncoding = 'utf8';
        await evictOldestLosslessRuns(runId, bytes);
      }
    } else if (kind === 'note' && resolvedData?.note === 'system_one' && resolvedData.extra?.decision === 'usage') {
      await _putAuxiliaryUsage(db, runId, ev);
    } else {
      await promisifyReq(tx(db, ['events']).objectStore('events').put(ev));
    }
    return seq;
  } catch (e) {
    console.warn('[trace] appendEvent failed:', e);
  }
}

let _feedbackWriteQueue = Promise.resolve();

// Serialize the shared byte budget across concurrently running tabs.
function writeFeedbackEvent(db, runId, event, state) {
  const pending = _feedbackWriteQueue.catch(() => {}).then(async () => {
    const bytes = utf8ByteLength(JSON.stringify(event));
    return new Promise((resolve, reject) => {
      const transaction = tx(db, ['runs', 'events']);
      const store = transaction.objectStore('runs');
      // Read the budget and write the event in one transaction. Other
      // extension contexts can prune/start runs without invalidating a cache.
      const request = store.getAll();
      let saved = false;
      request.onsuccess = () => {
        const run = request.result.find(row => row.runId === runId);
        const total = request.result.filter(row => row.feedbackOnly)
          .reduce((sum, row) => sum + (Number(row.feedbackBytes) || 0), 0);
        if (!run?.feedbackOnly) return;
        // Reserve a little space for final statistics and omission flags.
        if ((run.feedbackBytes || 0) + bytes > FEEDBACK_RUN_BYTES
          || total + bytes > FEEDBACK_HISTORY_BYTES - 4096) {
          run.feedbackEventsOmitted = true;
          store.put(run);
          return;
        }
        run.feedbackBytes = (run.feedbackBytes || 0) + bytes;
        store.put(run);
        transaction.objectStore('events').put(event);
        saved = true;
      };
      transaction.oncomplete = () => {
        if (saved) state.feedbackBytes += bytes;
        resolve(saved ? event.seq : null);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Feedback diagnostic write aborted.'));
    });
  });
  _feedbackWriteQueue = pending;
  return pending;
}

export async function pruneFeedbackDiagnostics({ clear = false, now = Date.now() } = {}) {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDB();
  const rows = await promisifyReq(tx(db, ['runs'], 'readonly').objectStore('runs').getAll());
  const ids = clear ? rows.filter(run => run.feedbackOnly === true).map(run => run.runId)
    : [...new Set([...feedbackRunsToEvict(rows, now), ...rows.filter(run => run.feedbackOnly === true
      && now - (run.startedAt || 0) > 7 * 24 * 60 * 60 * 1000).map(run => run.runId)])];
  for (const id of ids) { await deleteRun(id); if (clear) _runState.delete(id); }
}

// Retain the active run and evict completed lossless runs oldest first when
// their aggregate recorded payload crosses the global budget. A cached running
// total keeps under-budget writes free of any store-wide scan; the scan itself
// walks every run rather than a newest-N window so old lossless runs still
// count toward the budget and stay evictable.
let _losslessTotalEstimate = null;

async function _recomputeLosslessBytes(db, run, {
  refreshActiveState = true,
  trustMarkedCurrent = true,
} = {}) {
  const events = await promisifyReq(
    tx(db, ['events'], 'readonly').objectStore('events').index('runId')
      .getAll(IDBKeyRange.only(run.runId)),
  );
  let bytes = 0;
  for (const event of events || []) {
    if (event?.kind !== 'llm_request' && event?.kind !== 'tool') continue;
    if (event?.data?.losslessBudgetOmitted === true) continue;
    try { bytes += new TextEncoder().encode(JSON.stringify(event.data)).length; } catch {}
  }
  const runTx = tx(db, ['runs']);
  const runStore = runTx.objectStore('runs');
  const current = await promisifyReq(runStore.get(run.runId));
  if (current?.lossless === true) {
    if (trustMarkedCurrent && current.losslessBytesEncoding === 'utf8') {
      // A serialized append or another migration committed after our event
      // snapshot. Its atomic marker+total is newer, so never overwrite it.
      bytes = Number(current.losslessBytes) || 0;
    } else if ((Number(current.losslessBytes) || 0) !== bytes
        || current.losslessBytesEncoding !== 'utf8') {
      current.losslessBytes = bytes;
      current.losslessBytesEncoding = 'utf8';
      await promisifyReq(runStore.put(current));
    }
  }
  if (refreshActiveState && _runState.get(run.runId)?.lossless === true) {
    void _queueRunWrite(run.runId, async () => {
      const refreshedBytes = await _recomputeLosslessBytes(db, run, {
        refreshActiveState: false,
        trustMarkedCurrent: false,
      });
      const state = _runState.get(run.runId);
      if (state?.lossless === true) {
        state.losslessBytes = refreshedBytes;
        state.losslessBytesEncoding = 'utf8';
      }
    });
  }
  return bytes;
}

async function _scanLosslessTotal() {
  const db = await openDB();
  const runs = [];
  await new Promise((resolve) => {
    const req = tx(db, ['runs'], 'readonly').objectStore('runs').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      if (c.value?.lossless === true) runs.push(c.value);
      c.continue();
    };
    req.onerror = () => resolve();
  });
  let total = 0;
  for (const run of runs) {
    total += run.losslessBytesEncoding === 'utf8'
      ? Number(run.losslessBytes) || 0
      : await _recomputeLosslessBytes(db, run);
  }
  _losslessTotalEstimate = total;
  return total;
}

let _losslessBudgetQueue = Promise.resolve();

function evictOldestLosslessRuns(activeRunId, addedBytes = 0) {
  const rescan = _losslessTotalEstimate === null;
  const operation = _losslessBudgetQueue.then(() => _evictOldestLosslessRuns(activeRunId, addedBytes, rescan));
  _losslessBudgetQueue = operation.catch(() => {});
  return operation;
}

async function _evictOldestLosslessRuns(activeRunId, addedBytes, rescan) {
  if (rescan || _losslessTotalEstimate === null) {
    // First lossless write of this worker lifetime: learn the true total.
    // The persisted run record already includes this write's bytes.
    await _scanLosslessTotal();
  } else {
    _losslessTotalEstimate += addedBytes;
    if (_losslessTotalEstimate <= LOSSILESS_TOTAL_CAP) return;
  }
  const db = await openDB();
  const runs = [];
  await new Promise((resolve) => {
    const req = tx(db, ['runs'], 'readonly').objectStore('runs').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      if (c.value?.lossless === true) runs.push(c.value);
      c.continue();
    };
    req.onerror = () => resolve();
  });
  let total = runs.reduce((sum, run) => sum + (Number(run.losslessBytes) || 0), 0);
  const candidates = runs
    .filter(run => run.runId !== activeRunId && run.status !== 'running')
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const run of candidates) {
    if (total <= LOSSILESS_TOTAL_CAP) break;
    await deleteRun(run.runId);
    total -= Number(run.losslessBytes) || 0;
  }
  _losslessTotalEstimate = total;
}

function _appendEvent(runId, kind, data) {
  return _queueRunWrite(runId, () => _appendEventNow(runId, kind, data));
}

export function recordLLMRequest(runId, step, payload, provenanceInput = null) {
  // Lossless tier (opt-in): persist the request's full message/tool shape for
  // deep debugging and request reconstruction. Clamped so one oversized
  // request cannot exhaust IndexedDB; the marker mirrors tool-result
  // truncation ({ _truncated, length, head }).
  return _appendEvent(runId, 'llm_request', (state) => {
    if (state?.lossless === true && provenanceInput) {
      if ((state.losslessBytes || 0) >= LOSSILESS_RUN_CAP) {
        let length = null;
        try { length = utf8ByteLength(JSON.stringify({ messages: provenanceInput.messages || null, tools: provenanceInput.tools || null })); } catch {}
        return { step, ...payload, lossless: true, messages: { _truncated: true, length, head: '(per-run lossless budget reached)', toolNames: boundedToolNames(provenanceInput.tools) }, tools: null };
      }
      const remainingBytes = Math.max(0, LOSSILESS_RUN_CAP - (state.losslessBytes || 0));
      const { messages, tools } = clampLosslessRequest(
        provenanceInput.messages || null,
        provenanceInput.tools || null,
        Math.min(LOSSILESS_REQUEST_CAP, remainingBytes),
      );
      return { step, ...payload, lossless: true, messages, tools };
    }
  // Default tier: never persist full prompts, message text, tool schemas, or
  // tool names here.
  // The optional fourth argument is reduced to content-free provenance only.
    let promptProvenance = null;
    if (provenanceInput) {
      try { promptProvenance = buildPromptTraceProvenance(provenanceInput.messages, provenanceInput.tools, provenanceInput.runtimeMode); } catch {}
    }
    return { step, ...payload, ...(promptProvenance ? { promptProvenance } : {}) };
  });
}

export function recordLLMResponse(runId, step, {
  content,
  toolCalls,
  usage,
  latencyMs,
  model,
  phase,
  attempt,
  repair,
  empty,
  emptyReason,
  finishReason,
  contentChars,
  toolCallCount,
  reasoningPresent,
  reasoningChars,
  reasoningTokens,
  outputTokens,
  requestedMaxTokens,
  recoveryAttempt,
  rejectedToolResponse,
}) {
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
    ...(Number.isInteger(attempt) ? { attempt } : {}),
    ...(repair === true ? { repair: true } : {}),
    ...(typeof empty === 'boolean' ? { empty } : {}),
    ...(emptyReason ? { emptyReason } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(Number.isInteger(contentChars) ? { contentChars } : {}),
    ...(Number.isInteger(toolCallCount) ? { toolCallCount } : {}),
    ...(typeof reasoningPresent === 'boolean' ? { reasoningPresent } : {}),
    ...(Number.isInteger(reasoningChars) ? { reasoningChars } : {}),
    ...(Number.isInteger(reasoningTokens) ? { reasoningTokens } : {}),
    ...(Number.isInteger(outputTokens) ? { outputTokens } : {}),
    ...(Number.isInteger(requestedMaxTokens) ? { requestedMaxTokens } : {}),
    ...(Number.isInteger(recoveryAttempt) && recoveryAttempt > 0 ? { recoveryAttempt } : {}),
    ...(normalizeRejectedToolResponse(rejectedToolResponse) ? { rejectedToolResponse: normalizeRejectedToolResponse(rejectedToolResponse) } : {}),
  });
}

export function recordToolCall(runId, step, { name, args, result, latencyMs, batch }) {
  const batchMetadata = batch ? { batch: { parentId: batch.parentId, index: batch.index, total: batch.total } } : {};
  const workflowCapture = _workflowTraceCaptures.get(runId);
  if (workflowCapture) {
    workflowCapture.nextSeq += 1;
    workflowCapture.events.push({
      seq: workflowCapture.nextSeq,
      kind: 'tool',
      data: {
        ...batchMetadata,
        step,
        name,
        args: clampUtf8Value(args ?? null, 20_000),
        result: clampUtf8Value(result ?? null, 20_000),
        latencyMs: latencyMs ?? null,
      },
    });
  }
  // Truncate very large tool results (a11y trees can be huge). Keep the first
  // 20KB verbatim by default — plenty for debugging flow — and 200KB in the
  // opt-in lossless tier; note the truncation either way.
  return _appendEvent(runId, 'tool', (state) => {
    const outcome = toolOutcome(name, args, result);
    if (state?.lossless === true && (state.losslessBytes || 0) >= LOSSILESS_RUN_CAP) {
      let length = null;
      try { const s = JSON.stringify(result); length = s ? utf8ByteLength(s) : 0; } catch {}
      return { ...batchMetadata, step, name, args: args || null, outcome, result: { ...outcome, _truncated: true, length, head: '(per-run lossless budget reached)' }, latencyMs: latencyMs || null };
    }
    const remainingBytes = Math.max(0, LOSSILESS_RUN_CAP - (state?.losslessBytes || 0));
    const cap = state?.lossless === true
      ? Math.min(LOSSILESS_RESULT_CAP, remainingBytes)
      : 20_000;
    const shortResult = clampUtf8Value(result, cap);
    return { ...batchMetadata, step, name, args: args || null, outcome, result: shortResult, latencyMs: latencyMs || null };
  });
}

export function recordScreenshot(runId, step, dataUrl, caption = '') {
  return _queueRunWrite(runId, async () => {
    if (!(await tracingEnabledForRun(runId))) return;
    if (!dataUrl) return;
    try {
      const db = await openDB();
      const state = await _ensureRunState(runId, db);
      const seq = _newSeq(runId);
      if (state?.lossless === true) {
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
      }
      // Also record a lightweight marker in the events log so the timeline
      // renders screenshots in order with everything else.
      const marker = makeEvent(
        runId,
        seq,
        'screenshot',
        projectTraceEventData('screenshot', { step, caption }, { includeContent: state?.lossless === true }),
      );
      if (marker) {
        if (state?.feedbackOnly === true) return await writeFeedbackEvent(db, runId, marker, state);
        await promisifyReq(tx(db, ['events']).objectStore('events').put(marker));
      }
      return seq;
    } catch (e) {
      console.warn('[trace] recordScreenshot failed:', e);
    }
  });
}

export function recordError(runId, step, phase, message, code) {
  const data = { step, phase, message: formatErrorMessage(message) };
  if (code) data.code = normalizeErrorCode(code);
  return _appendEvent(runId, 'error', data);
}

// Turn/step boundary events: one turn per user message plus final answer, one
// step per LLM request. They give the event log explicit lifecycle structure —
// "which step failed, with what code" — instead of deriving it from payloads.
export function recordTurnStart(runId, step, payload = {}) {
  return _appendEvent(runId, 'turn_start', { step, ...payload });
}

export function recordTurnEnd(runId, step, payload = {}) {
  return _appendEvent(runId, 'turn_end', { step, ...payload });
}

export function recordStepStart(runId, step, payload = {}) {
  return _appendEvent(runId, 'step_start', { step, ...payload });
}

export function recordStepEnd(runId, step, payload = {}) {
  return _appendEvent(runId, 'step_end', { step, ...payload });
}

/**
 * Record the lifecycle of an interactive Ask streaming attempt without
 * persisting token contents. Payloads contain only decision/outcome codes,
 * protocol, aggregate counts, timing, and a redacted error summary.
 */
export function recordStreaming(runId, step, payload = {}) {
  return _appendEvent(runId, 'streaming', { step, ...payload });
}

/**
 * Record a vision sub-call: the agent asked a dedicated vision model to
 * describe a screenshot so the main planning model receives text instead
 * of pixels. Captured for debugging and quality inspection — description
 * quality is the main failure mode of the split-provider design.
 */
export function recordVisionSubCall(runId, {
  step, context, visionRoute, captureId, fallbackReason,
  model, baseUrl, description, latencyMs, error, errorCode, recoveryOutcome,
}) {
  return _appendEvent(runId, 'vision_sub_call', {
    step: step || null,
    context: context || null, // 'initial_user_message' | 'auto_screenshot' | ...
    visionRoute: visionRoute || null,
    captureId: captureId || null,
    fallbackReason: fallbackReason || null,
    model: model || null,
    baseUrl: baseUrl || null,
    description: description || null,
    latencyMs: latencyMs || null,
    error: error || null,
    errorCode: errorCode || null,
    recoveryOutcome: recoveryOutcome || null,
  });
}

export function recordVisionRoute(runId, {
  step, context, visionRoute, captureId, model, fallbackReason,
}) {
  return _appendEvent(runId, 'vision_route', {
    step: step || null,
    context: context || null,
    visionRoute: visionRoute || null,
    captureId: captureId || null,
    model: model || null,
    fallbackReason: fallbackReason || null,
  });
}

export function recordNote(runId, step, note, extra = null) {
  return _appendEvent(runId, 'note', { step, note, extra });
}

async function _retryCount(db, runId, step) {
  let count = 0;
  await new Promise((resolve) => {
    const idx = tx(db, ['events'], 'readonly').objectStore('events').index('runId');
    const req = idx.openCursor(IDBKeyRange.only(runId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const event = cursor.value;
      if (event?.kind === 'note'
          && event.data?.note === 'llm_retry'
          && event.data?.step === step) count += 1;
      cursor.continue();
    };
    req.onerror = () => resolve();
  });
  return count;
}

export function recordLLMRetry(runId, step, { delayMs = 0, code = 'UNKNOWN' } = {}) {
  return _queueRunWrite(runId, async () => {
    if (!(await tracingEnabledForRun(runId))) return;
    try {
      const db = await openDB();
      await _ensureRunState(runId, db);
      const attempt = (await _retryCount(db, runId, step)) + 1;
      return _appendEventNow(runId, 'note', {
        step,
        note: 'llm_retry',
        extra: { attempt, delayMs, code: normalizeErrorCode(code) },
      });
    } catch (e) {
      console.warn('[trace] recordLLMRetry failed:', e);
    }
  });
}

export async function endRun(runId, { status = 'done', finalContent = null } = {}) {
  if (!runId) return;
  // Drain writes that enqueue migration refreshes while settling, then place
  // finalization at the tail of the same run queue.
  await _flushRunWrites(runId);
  // Finalization is a write in the same per-run sequence as events and any
  // migration refresh queued while those event writes are still settling.
  return _queueRunWrite(runId, async () => {
    let resolvedStatus = status;
    try {
      if (!(await tracingEnabledForRun(runId))) {
        _workflowTraceCaptures.delete(runId);
        return null;
      }
      const db = await openDB();
      // Tally usage from events. `totalCost` is the sum of `usage.cost` across
      // all llm_response events — providers report this in their native units
      // (OpenRouter & OpenAI: USD). Surfaced in the Traces UI so users can
      // spot expensive-failure runs at a glance.
      const stats = createTraceStats();
      let sawLoopError = false;
      await new Promise((resolve) => {
        const idx = tx(db, ['events'], 'readonly').objectStore('events').index('runId');
        const req = idx.openCursor(IDBKeyRange.only(runId));
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          const ev = c.value;
          if (ev.kind === 'error' && ev.data?.phase === 'loop') sawLoopError = true;
          addTraceEvent(stats, ev);
          c.continue();
        };
        req.onerror = () => resolve();
      });
      // Keep the read and write in one transaction so byte migration cannot
      // land between a stale snapshot and finalization's whole-record update.
      const runTx = tx(db, ['runs']);
      const runStore = runTx.objectStore('runs');
      const existing = await promisifyReq(runStore.get(runId));
      if (existing) {
        const finalStatus = status === 'done' && sawLoopError ? 'loop_stopped' : status;
        resolvedStatus = finalStatus;
        existing.endedAt = Date.now();
        existing.durationMs = existing.endedAt - existing.startedAt;
        existing.status = finalStatus;
        existing.finalContent = existing.lossless === true ? finalContent : null;
        existing.stepCount = stats.stepCount;
        existing.totalInputTokens = stats.totalInputTokens;
        existing.totalOutputTokens = stats.totalOutputTokens;
        existing.totalCost = stats.totalCost; // null/0 when the provider didn't report cost
        existing.llmRequestCount = stats.llmRequestCount;
        existing.llmResponseCount = stats.llmResponseCount;
        existing.toolCallCount = stats.toolCallCount;
        existing.visionSubCallCount = stats.visionSubCallCount;
        existing.errorCount = stats.errorCount;
        existing.retryCount = stats.retryCount;
        existing.totalLlmLatencyMs = stats.totalLlmLatencyMs;
        existing.totalToolLatencyMs = stats.totalToolLatencyMs;
        await promisifyReq(runStore.put(existing));
      }
    } catch (e) {
      console.warn('[trace] endRun failed:', e);
    } finally {
      _runState.delete(runId);
    }
    // Retention may delete this run and its transient capture. Keep the
    // completed workflow independent of which diagnostics remain on disk.
    const workflowCapture = _workflowTraceCaptures.get(runId) || null;
    _workflowTraceCaptures.delete(runId);
    await pruneFeedbackDiagnostics().catch(() => {});
    if (!workflowCapture) return null;
    workflowCapture.run.status = resolvedStatus;
    return { run: workflowCapture.run, events: workflowCapture.events };
  });
}

/**
 * Repair trace records left running after a service-worker eviction. Each run
 * is re-read and updated in one transaction so a concurrent normal completion
 * wins, and a second repair pass cannot append duplicate terminal events.
 */
async function _listStaleRunCandidates(db, cutoff) {
  // Only runs old enough to be stale can qualify (last activity is never
  // older than startedAt), so scan just that slice of the startedAt index
  // instead of every run on record.
  const out = [];
  await new Promise((resolve, reject) => {
    const idx = tx(db, ['runs'], 'readonly').objectStore('runs').index('startedAt');
    const req = idx.openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      const row = c.value;
      if (row?.status === 'running' && !row.repairedBy) out.push(row);
      c.continue();
    };
    req.onerror = () => reject(req.error || new Error('stale-run scan failed'));
  });
  return out;
}

export async function repairStaleRuns({
  now = Date.now(),
  staleAfterMs = TRACE_REPAIR_STALE_AFTER_MS,
} = {}) {
  if (typeof indexedDB === 'undefined') return [];
  if (!Number.isFinite(Number(now))) return [];
  try {
    const db = await openDB();
    const cutoff = Number(now) - normalizedThreshold(staleAfterMs);
    const candidates = await _listStaleRunCandidates(db, cutoff);
    const repaired = [];
    for (const candidate of candidates) {
      if (!isStaleRunningTrace(candidate, { now, staleAfterMs })) continue;
      // A live run in this service-worker instance is still owned by the
      // agent. The durable marker handles races from another extension page.
      if (_runState.has(candidate.runId)) continue;
      await _flushRunWrites(candidate.runId);
      try {
        const repairedRunId = await _repairRunInTransaction(db, candidate.runId, { now, staleAfterMs });
        if (repairedRunId) repaired.push(repairedRunId);
      } catch (e) {
        console.warn('[trace] stale-run repair failed:', e);
      }
    }
    return repaired;
  } catch (e) {
    console.warn('[trace] stale-run scan failed:', e);
    return [];
  }
}

// ----- Reader API (used by traces.html) --------------------------------------

// Before another extension context reads the database, settle the writes that
// were already queued. Snapshot the queue so an active run cannot postpone an
// export indefinitely by continuing to record new events.
export async function flushPendingWrites() {
  await Promise.all([..._runWriteQueues.values()]);
}

export async function listRuns({ limit = 500, conversationId = null } = {}) {
  await pruneFeedbackDiagnostics();
  const db = await openDB();
  const store = tx(db, ['runs'], 'readonly').objectStore('runs');
  const sessionQuery = Boolean(conversationId && store.indexNames.contains('sessionId'));
  const idx = store.index(sessionQuery ? 'sessionId' : 'startedAt');
  const out = [];
  // When conversationId is set, only matching runs count toward `limit`, so a
  // chat's tool-chain export is not starved by unrelated newer runs.
  await new Promise((resolve, reject) => {
    const req = sessionQuery
      ? idx.openCursor(IDBKeyRange.only(conversationId))
      : idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || (!sessionQuery && out.length >= limit)) return resolve();
      const row = c.value;
      if (sessionQuery || !conversationId || row?.conversationId === conversationId) out.push(row);
      c.continue();
    };
    req.onerror = () => reject(req.error || new Error('listRuns failed'));
  });
  if (sessionQuery) out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out.slice(0, limit);
}

export async function getSessionStats(conversationId, { limit = 500 } = {}) {
  if (!conversationId) return aggregateTraceRuns([]);
  const runs = await listRuns({ limit, conversationId });
  return aggregateTraceRuns(runs);
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
  _workflowTraceCaptures.delete(runId);
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
  _losslessTotalEstimate = null;
  _workflowTraceCaptures.clear();
  const db = await openDB();
  const t = tx(db, ['runs', 'events', 'shots']);
  await promisifyReq(t.objectStore('runs').clear());
  await promisifyReq(t.objectStore('events').clear());
  await promisifyReq(t.objectStore('shots').clear());
}
