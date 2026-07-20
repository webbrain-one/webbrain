export const RUN_UI_EVENT_LIMIT = 256;

export function createRunRequestId(tabId, supplied = '') {
  const clean = String(supplied || '').trim();
  return clean || `req_${tabId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function runUiSnapshotForRequest(snapshot, requestedRequestId = '') {
  const requested = String(requestedRequestId || '');
  if (!requested) return snapshot || null;
  return String(snapshot?.requestId || '') === requested ? snapshot : null;
}

export function compactRunUiData(type, data) {
  if (!data || typeof data !== 'object') return data;
  if (type === 'tool_result') {
    const result = data.result || {};
    return {
      name: data.name,
      result: {
        success: result.success,
        ok: result.ok,
        error: result.error ? String(result.error).slice(0, 1000) : undefined,
        warning: result.warning ? String(result.warning).slice(0, 1000) : undefined,
        summary: result.summary ? String(result.summary).slice(0, 2000) : undefined,
      },
    };
  }
  if (type === 'text' || type === 'text_delta') {
    return { ...data, content: String(data.content || '').slice(0, 30000) };
  }
  return data;
}

export class RunUiJournal {
  constructor({ eventLimit = RUN_UI_EVENT_LIMIT, onChange = null } = {}) {
    this.eventLimit = eventLimit;
    this.onChange = onChange;
    this.snapshots = new Map();
  }

  _changed(tabId, snapshot) {
    if (typeof this.onChange === 'function') this.onChange(tabId, snapshot);
    return snapshot;
  }

  begin(tabId, requestId = '', metadata = {}) {
    const snapshot = {
      tabId,
      requestId: createRunRequestId(tabId, requestId),
      mode: String(metadata?.mode || ''),
      kind: metadata?.kind === 'continue' ? 'continue' : 'chat',
      runId: null,
      status: 'running',
      seq: 0,
      ackedSeq: 0,
      truncatedBeforeSeq: 0,
      events: [],
      pendingPlanId: null,
      lastPlanResolution: null,
      finalContent: '',
      successfulDone: false,
      hadError: false,
      lastError: '',
      pendingToolCall: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.snapshots.set(tabId, snapshot);
    return this._changed(tabId, snapshot);
  }

  resume(tabId, requestId = '', metadata = {}) {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || String(snapshot.requestId) !== String(requestId)) return null;
    if (metadata?.mode) snapshot.mode = String(metadata.mode);
    if (!snapshot.kind && metadata?.kind) {
      snapshot.kind = metadata.kind === 'continue' ? 'continue' : 'chat';
    }
    snapshot.status = 'running';
    snapshot.pendingPlanId = null;
    snapshot.finalContent = '';
    snapshot.successfulDone = false;
    snapshot.endedAt = null;
    return this._changed(tabId, snapshot);
  }

  record(tabId, requestId, type, data, runId = null) {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || snapshot.requestId !== requestId) return null;
    snapshot.runId = runId || snapshot.runId || null;
    const event = {
      seq: ++snapshot.seq,
      type,
      data: compactRunUiData(type, data),
      ts: Date.now(),
    };
    snapshot.events.push(event);
    while (snapshot.events.length > this.eventLimit) {
      const removed = snapshot.events.shift();
      snapshot.truncatedBeforeSeq = removed?.seq || snapshot.truncatedBeforeSeq;
    }
    if (type === 'plan_review') {
      snapshot.status = 'awaiting_plan';
      snapshot.pendingPlanId = String(data?.planId || '') || null;
      snapshot.lastPlanResolution = null;
    }
    if (type === 'plan_resolved') {
      snapshot.status = 'running';
      if (!data?.planId || String(data.planId) === String(snapshot.pendingPlanId)) snapshot.pendingPlanId = null;
      snapshot.lastPlanResolution = {
        planId: String(data?.planId || ''),
        decision: String(data?.decision || ''),
      };
    }
    if (type === 'tool_call' && data?.outcomeUnknown === true) {
      snapshot.pendingToolCall = {
        name: String(data?.name || ''),
        seq: event.seq,
      };
    }
    if (type === 'tool_result'
        && data?.name === 'done'
        && data?.result?.done === true
        && data?.result?.outcome === 'success'
        && data?.result?.success !== false
        && !data?.result?.error
        && !data?.result?.blockedDone) {
      snapshot.successfulDone = true;
    }
    if (type === 'error' || type === 'attachment_rejected' || type === 'max_steps_reached') {
      snapshot.hadError = true;
      snapshot.lastError = String(
        data?.message
        || data?.error
        || (type === 'max_steps_reached' ? 'The run reached its maximum step limit.' : ''),
      ).slice(0, 2000);
    }
    this._changed(tabId, snapshot);
    return { ...event, requestId: snapshot.requestId, runId: snapshot.runId };
  }

  settleToolCall(tabId, requestId, name = '') {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || snapshot.requestId !== requestId || !snapshot.pendingToolCall) return null;
    if (name && snapshot.pendingToolCall.name && snapshot.pendingToolCall.name !== String(name)) return null;
    snapshot.pendingToolCall = null;
    return this._changed(tabId, snapshot);
  }

  finish(tabId, requestId, status, finalContent = '', runId = null) {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || snapshot.requestId !== requestId) return null;
    snapshot.runId = runId || snapshot.runId || null;
    snapshot.status = status;
    snapshot.pendingPlanId = null;
    snapshot.pendingToolCall = null;
    snapshot.finalContent = String(finalContent || '').slice(0, 30000);
    snapshot.endedAt = Date.now();
    const event = {
      seq: ++snapshot.seq,
      type: 'run_complete',
      data: { status: snapshot.status, finalContent: snapshot.finalContent, endedAt: snapshot.endedAt },
      ts: snapshot.endedAt,
    };
    snapshot.events.push(event);
    while (snapshot.events.length > this.eventLimit) {
      const removed = snapshot.events.shift();
      snapshot.truncatedBeforeSeq = removed?.seq || snapshot.truncatedBeforeSeq;
    }
    return this._changed(tabId, snapshot);
  }

  restore(tabId, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    if (snapshot.successfulDone !== true) snapshot.successfulDone = false;
    if (snapshot.hadError !== true) snapshot.hadError = false;
    if (typeof snapshot.lastError !== 'string') snapshot.lastError = '';
    if (!snapshot.pendingToolCall || typeof snapshot.pendingToolCall !== 'object') {
      snapshot.pendingToolCall = null;
    }
    if (typeof snapshot.mode !== 'string') snapshot.mode = '';
    if (snapshot.kind !== 'continue' && snapshot.kind !== 'chat') snapshot.kind = 'chat';
    if (!snapshot.lastPlanResolution || typeof snapshot.lastPlanResolution !== 'object') {
      snapshot.lastPlanResolution = null;
    }
    this.snapshots.set(tabId, snapshot);
    return snapshot;
  }

  acknowledge(tabId, requestId, seq) {
    const snapshot = this.snapshots.get(tabId);
    const numericSeq = Number(seq);
    if (!snapshot || snapshot.requestId !== requestId || !Number.isFinite(numericSeq)) return null;
    snapshot.ackedSeq = Math.max(Number(snapshot.ackedSeq || 0), numericSeq);
    snapshot.events = snapshot.events.filter(event => Number(event?.seq || 0) > snapshot.ackedSeq);
    snapshot.truncatedBeforeSeq = Math.max(Number(snapshot.truncatedBeforeSeq || 0), snapshot.ackedSeq);
    return this._changed(tabId, snapshot);
  }

  get(tabId) {
    return this.snapshots.get(tabId) || null;
  }

  clear(tabId) {
    this.snapshots.delete(tabId);
  }
}
