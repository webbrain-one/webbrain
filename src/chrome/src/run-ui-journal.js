export const RUN_UI_EVENT_LIMIT = 256;

export function createRunRequestId(tabId, supplied = '') {
  const clean = String(supplied || '').trim();
  return clean || `req_${tabId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

  begin(tabId, requestId = '') {
    const snapshot = {
      tabId,
      requestId: createRunRequestId(tabId, requestId),
      runId: null,
      status: 'running',
      seq: 0,
      ackedSeq: 0,
      truncatedBeforeSeq: 0,
      events: [],
      pendingPlanId: null,
      finalContent: '',
      startedAt: Date.now(),
      endedAt: null,
    };
    this.snapshots.set(tabId, snapshot);
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
    }
    if (type === 'plan_resolved') {
      snapshot.status = 'running';
      if (!data?.planId || String(data.planId) === String(snapshot.pendingPlanId)) snapshot.pendingPlanId = null;
    }
    this._changed(tabId, snapshot);
    return { ...event, requestId: snapshot.requestId, runId: snapshot.runId };
  }

  finish(tabId, requestId, status, finalContent = '', runId = null) {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || snapshot.requestId !== requestId) return null;
    snapshot.runId = runId || snapshot.runId || null;
    snapshot.status = status;
    snapshot.pendingPlanId = null;
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
