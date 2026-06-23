export const SCHEDULED_JOBS_KEY = 'wb_scheduled_jobs';
export const SCHEDULED_TASKS_ENABLED_KEY = 'scheduledTasksEnabled';
export const SCHEDULED_REQUIRE_CONFIRMATION_KEY = 'scheduledRequireConsequentialConfirmation';
export const SCHEDULED_ALARM_PREFIX = 'wb_scheduled_job:';

export const MIN_RESUME_DELAY_MS = 30 * 1000;
export const MIN_DELAY_MS = 60 * 1000;
export const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export const QUEUE_RETRY_MS = 30 * 1000;
export const MAX_QUEUE_DEFERRALS = 120;
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 525600; // one year
const ALARM_KEEPALIVE_INTERVAL_MS = 20 * 1000;
const LIVE_SCHEDULED_STATUSES = new Set(['pending', 'queued', 'running', 'needs_user_input']);
const DUPLICATE_COALESCED_ERROR = 'Duplicate scheduled job coalesced into an existing live job.';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function isValidUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sameDocumentUrl(a, b) {
  try {
    const left = new URL(String(a || ''));
    const right = new URL(String(b || ''));
    return left.origin === right.origin &&
      left.pathname === right.pathname &&
      left.search === right.search &&
      left.hash === right.hash;
  } catch {
    return String(a || '') === String(b || '');
  }
}

function sameTargetUrl(a, b) {
  try {
    return new URL(String(a || '')).href === new URL(String(b || '')).href;
  } catch {
    return String(a || '') === String(b || '');
  }
}

function normalizePendingClarify(data, now = Date.now()) {
  const obj = asObject(data);
  const clarifyId = String(obj.clarifyId || '').trim();
  if (!clarifyId) return null;
  const pending = {
    clarifyId: clarifyId.slice(0, 120),
    question: String(obj.question || '').slice(0, 1000),
    options: Array.isArray(obj.options)
      ? obj.options.map((option) => String(option).slice(0, 200)).filter(Boolean).slice(0, 4)
      : [],
    reason: obj.reason ? String(obj.reason).slice(0, 400) : null,
    createdAt: iso(now),
  };
  const permission = asObject(obj.permission);
  if (permission.capability || permission.host) {
    pending.permission = {
      capability: String(permission.capability || '').slice(0, 80),
      host: String(permission.host || '').slice(0, 300),
    };
  }
  return pending;
}

function isActiveRunError(error) {
  return /agent run is already in progress|active WebBrain run/i.test(String(error?.message || error || ''));
}

function canonicalText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalUrl(value) {
  try {
    return new URL(String(value || '').trim()).href;
  } catch {
    return String(value || '').trim();
  }
}

function scheduledTimeMs(job) {
  const candidates = job?.status === 'queued'
    ? [job?.nextRunAt, job?.scheduledAt, job?.schedule?.run_at]
    : [job?.scheduledAt, job?.schedule?.run_at, job?.nextRunAt];
  for (const candidate of candidates) {
    const ms = Date.parse(candidate || '');
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function scheduledJobCreatedMs(job) {
  const created = Date.parse(job?.createdAt || '');
  if (Number.isFinite(created)) return created;
  const scheduled = scheduledTimeMs(job);
  return scheduled == null ? 0 : scheduled;
}

function compareScheduledJobCreation(a, b) {
  const diff = scheduledJobCreatedMs(a) - scheduledJobCreatedMs(b);
  if (diff) return diff;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function isLiveScheduledJob(job) {
  return LIVE_SCHEDULED_STATUSES.has(job?.status);
}

function scheduledJobTargetKey(job) {
  if (!job) return null;
  if (job.kind === 'task' && job.target?.type === 'url') {
    const url = canonicalUrl(job.target.url);
    return url ? `url:${url}` : null;
  }
  const tabId = job.target?.tabId ?? job.tabId;
  return tabId == null ? null : `tab:${tabId}`;
}

function scheduledJobDuplicateTargetKey(job) {
  const targetKey = scheduledJobTargetKey(job);
  if (!targetKey || job?.kind !== 'task' || job.target?.type !== 'current_tab') return targetKey;
  const originalUrl = canonicalUrl(job.target.originalUrl);
  return originalUrl ? `${targetKey}:url:${originalUrl}` : targetKey;
}

function scheduledJobConversationKey(job) {
  return String(job?.conversationId ?? job?.target?.conversationId ?? '');
}

function scheduledJobPayloadKey(job) {
  if (job?.kind === 'resume') {
    return `${canonicalText(job.reason)}\n${canonicalText(job.resumeInstruction)}`;
  }
  return canonicalText(job?.prompt);
}

function scheduledJobIsImmediate(job) {
  if (job?.kind !== 'task') return false;
  const created = Date.parse(job?.createdAt || '');
  const scheduled = Date.parse(job?.scheduledAt || job?.schedule?.run_at || '');
  const derivesImmediate = Number.isFinite(created) && Number.isFinite(scheduled);
  if (job.immediate === true && derivesImmediate) return scheduled <= created + 1000;
  if (job.immediate === true) return true;
  if (job.immediate === false) return false;
  return derivesImmediate && scheduled <= created + 1000;
}

function scheduledJobScheduleType(job) {
  return String(job?.schedule?.type || 'once');
}

function scheduledJobIntervalMinutes(job) {
  const interval = Number(job?.schedule?.interval_minutes ?? job?.intervalMinutes);
  return Number.isFinite(interval) ? Math.floor(interval) : null;
}

function scheduledTimesAreNear(a, b) {
  const left = scheduledTimeMs(a);
  const right = scheduledTimeMs(b);
  return left != null && right != null && Math.abs(left - right) <= DUPLICATE_WINDOW_MS;
}

function sameScheduledIntent(a, b) {
  const targetA = scheduledJobDuplicateTargetKey(a);
  const targetB = scheduledJobDuplicateTargetKey(b);
  return !!targetA &&
    targetA === targetB &&
    a?.kind === b?.kind &&
    scheduledJobConversationKey(a) === scheduledJobConversationKey(b) &&
    String(a?.mode || 'act') === String(b?.mode || 'act') &&
    scheduledJobPayloadKey(a) === scheduledJobPayloadKey(b) &&
    scheduledJobIsImmediate(a) === scheduledJobIsImmediate(b) &&
    scheduledJobScheduleType(a) === scheduledJobScheduleType(b) &&
    scheduledJobIntervalMinutes(a) === scheduledJobIntervalMinutes(b) &&
    scheduledTimesAreNear(a, b);
}

function findDuplicateScheduledJob(job, jobs) {
  return jobs
    .filter((candidate) => isLiveScheduledJob(candidate) && sameScheduledIntent(candidate, job))
    .sort(compareScheduledJobCreation)[0] || null;
}

function startChromeAlarmKeepAlive(api) {
  const runtime = api?.runtime;
  if (typeof runtime?.getPlatformInfo !== 'function') return () => {};
  const ping = () => {
    try {
      const maybePromise = runtime.getPlatformInfo(() => { void runtime.lastError; });
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch { /* keepalive is best-effort */ }
  };
  const timer = setInterval(ping, ALARM_KEEPALIVE_INTERVAL_MS);
  timer?.unref?.();
  return () => clearInterval(timer);
}

export function makeScheduledJobId(kind = 'job', now = Date.now()) {
  return `${kind}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeScheduledTime(input, {
  now = Date.now(),
  minDelayMs = MIN_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS,
  allowImmediate = false,
} = {}) {
  const obj = asObject(input);
  const hasAfter = obj.after_seconds != null;
  const hasRunAt = obj.run_at != null && String(obj.run_at).trim() !== '';
  if (hasAfter === hasRunAt) {
    return { ok: false, error: 'Provide exactly one of `after_seconds` or `run_at`.' };
  }

  let scheduledAtMs;
  let isImmediateAfter = false;
  if (hasAfter) {
    const seconds = Number(obj.after_seconds);
    if (!Number.isFinite(seconds)) {
      return { ok: false, error: '`after_seconds` must be a number.' };
    }
    isImmediateAfter = seconds === 0;
    scheduledAtMs = now + Math.round(seconds * 1000);
  } else {
    scheduledAtMs = Date.parse(String(obj.run_at).trim());
    if (!Number.isFinite(scheduledAtMs)) {
      return { ok: false, error: '`run_at` must be an ISO timestamp or browser-parseable date/time.' };
    }
  }

  const delay = scheduledAtMs - now;
  if (allowImmediate && isImmediateAfter) {
    return { ok: true, scheduledAtMs: now, scheduledAt: iso(now), immediate: true };
  }
  if (delay < minDelayMs) {
    return { ok: false, error: `Scheduled time must be at least ${Math.ceil(minDelayMs / 1000)} seconds in the future.` };
  }
  if (delay > maxDelayMs) {
    return { ok: false, error: `Scheduled time must be no more than ${Math.floor(maxDelayMs / 3600000)} hours in the future.` };
  }
  return { ok: true, scheduledAtMs, scheduledAt: iso(scheduledAtMs) };
}

export function validateResumeArgs(args, now = Date.now()) {
  const obj = asObject(args);
  const time = normalizeScheduledTime(obj, { now, minDelayMs: MIN_RESUME_DELAY_MS });
  if (!time.ok) return time;
  const reason = String(obj.reason || '').trim();
  const resumeInstruction = String(obj.resume_instruction || '').trim();
  if (!reason) return { ok: false, error: '`reason` is required.' };
  if (!resumeInstruction) return { ok: false, error: '`resume_instruction` is required.' };
  return {
    ok: true,
    scheduledAtMs: time.scheduledAtMs,
    scheduledAt: time.scheduledAt,
    reason: reason.slice(0, 1000),
    resumeInstruction: resumeInstruction.slice(0, 4000),
  };
}

export function validateTaskArgs(args, now = Date.now()) {
  const obj = asObject(args);
  const title = String(obj.title || '').trim();
  const prompt = String(obj.prompt || '').trim();
  const schedule = asObject(obj.schedule);
  const target = asObject(obj.target);
  const type = schedule.type || 'once';
  const mode = obj.mode === 'ask' ? 'ask' : 'act';

  if (!title) return { ok: false, error: '`title` is required.' };
  if (!prompt) return { ok: false, error: '`prompt` is required.' };
  if (type !== 'once' && type !== 'recurring') {
    return { ok: false, error: '`schedule.type` must be "once" or "recurring".' };
  }

  const time = normalizeScheduledTime(schedule, { now, allowImmediate: true });
  if (!time.ok) return time;

  let intervalMinutes = null;
  if (type === 'recurring') {
    intervalMinutes = Number(schedule.interval_minutes);
    if (!Number.isFinite(intervalMinutes)) {
      return { ok: false, error: '`schedule.interval_minutes` is required for recurring tasks.' };
    }
    intervalMinutes = Math.floor(intervalMinutes);
    if (intervalMinutes < MIN_INTERVAL_MINUTES || intervalMinutes > MAX_INTERVAL_MINUTES) {
      return { ok: false, error: `Recurring interval must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES} minutes.` };
    }
  }

  const targetType = target.type || 'current_tab';
  if (targetType !== 'current_tab' && targetType !== 'url') {
    return { ok: false, error: '`target.type` must be "current_tab" or "url".' };
  }
  if (targetType === 'url' && !isValidUrl(target.url)) {
    return { ok: false, error: '`target.url` must be an http(s) URL when target.type is "url".' };
  }

  return {
    ok: true,
    title: title.slice(0, 200),
    prompt: prompt.slice(0, 8000),
    scheduleType: type,
    scheduledAtMs: time.scheduledAtMs,
    scheduledAt: time.scheduledAt,
    immediate: time.immediate === true,
    intervalMinutes,
    target: {
      type: targetType,
      ...(targetType === 'url' ? { url: String(target.url).trim() } : {}),
    },
    mode,
  };
}

export function computeNextRunAt(job, now = Date.now()) {
  const interval = Number(job?.schedule?.interval_minutes || job?.intervalMinutes);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MINUTES) return null;
  return iso(now + Math.floor(interval) * 60 * 1000);
}

export function summarizeScheduledJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    title: job.title || job.reason || 'Scheduled job',
    status: job.status,
    scheduledAt: job.scheduledAt,
    nextRunAt: job.nextRunAt || job.scheduledAt,
    schedule: job.schedule || null,
    target: job.target || null,
    lastResult: job.lastResult || null,
    lastError: job.lastError || null,
    needsUserInput: job.status === 'needs_user_input',
    pendingClarify: job.pendingClarify || null,
    completedAt: job.completedAt || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export class ScheduledJobManager {
  constructor({
    api,
    agent,
    loadProviders = async () => {},
    sendUpdate = () => {},
    showIndicator = () => {},
    hideIndicator = () => {},
    now = () => Date.now(),
    startAlarmKeepAlive = null,
  }) {
    this.api = api;
    this.agent = agent;
    this.loadProviders = loadProviders;
    this.sendUpdate = sendUpdate;
    this.showIndicator = showIndicator;
    this.hideIndicator = hideIndicator;
    this.now = now;
    this._started = false;
    this._waitingForInput = new Set();
    this._runningTabs = new Set();
    this._jobMutation = Promise.resolve();
    this._startAlarmKeepAlive = startAlarmKeepAlive || (() => startChromeAlarmKeepAlive(this.api));
  }

  start() {
    if (this._started) return;
    this._started = true;
    this.api?.alarms?.onAlarm?.addListener?.((alarm) => {
      const run = this.handleAlarm(alarm?.name);
      run.catch((e) => {
        console.warn('[WebBrain] scheduled job alarm failed:', e);
      });
      return run;
    });
    this.restoreAlarms().catch((e) => console.warn('[WebBrain] restore scheduled alarms failed:', e));
  }

  async _getJobs() {
    const stored = await this.api.storage.local.get(SCHEDULED_JOBS_KEY);
    const jobs = stored?.[SCHEDULED_JOBS_KEY];
    return Array.isArray(jobs) ? jobs : [];
  }

  async _setJobs(jobs) {
    await this.api.storage.local.set({ [SCHEDULED_JOBS_KEY]: jobs });
  }

  async _withJobMutation(fn) {
    const previous = this._jobMutation;
    let release;
    this._jobMutation = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async _getSettings() {
    const stored = await this.api.storage.local.get([
      SCHEDULED_TASKS_ENABLED_KEY,
      SCHEDULED_REQUIRE_CONFIRMATION_KEY,
    ]);
    return {
      enabled: stored[SCHEDULED_TASKS_ENABLED_KEY] !== false,
      requireConsequentialConfirmation: stored[SCHEDULED_REQUIRE_CONFIRMATION_KEY] !== false,
    };
  }

  _alarmName(jobId) {
    return `${SCHEDULED_ALARM_PREFIX}${jobId}`;
  }

  async _setAlarm(job) {
    const when = Date.parse(job.nextRunAt || job.scheduledAt);
    if (!Number.isFinite(when)) return;
    await this.api.alarms.create(this._alarmName(job.id), { when });
  }

  async _clearAlarm(jobId) {
    try { await this.api.alarms.clear(this._alarmName(jobId)); } catch {}
  }

  _coalesceDuplicateJobs(jobs) {
    const keptLiveJobs = [];
    const cancelIds = new Set();
    for (const job of jobs.filter(isLiveScheduledJob).sort(compareScheduledJobCreation)) {
      const canonical = findDuplicateScheduledJob(job, keptLiveJobs);
      if (canonical) {
        cancelIds.add(job.id);
      } else {
        keptLiveJobs.push(job);
      }
    }
    const alarmsToClear = [];
    let changed = false;
    const updatedAt = iso(this.now());
    const next = jobs.map((job) => {
      if (!cancelIds.has(job.id)) return job;
      changed = true;
      alarmsToClear.push(job.id);
      this._waitingForInput.delete(job.id);
      return {
        ...job,
        status: 'cancelled',
        lastError: DUPLICATE_COALESCED_ERROR,
        pendingClarify: null,
        updatedAt,
      };
    });
    return { jobs: next, alarmsToClear, changed };
  }

  async _saveJobUnlessDuplicate(job) {
    return this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      const duplicate = findDuplicateScheduledJob(job, jobs);
      if (duplicate) return { job: duplicate, deduped: true };
      jobs.push(job);
      await this._setJobs(jobs);
      return { job, deduped: false };
    });
  }

  _nextQueueRetryMs(job, jobs) {
    let retryAt = this.now() + QUEUE_RETRY_MS;
    const targetKey = scheduledJobTargetKey(job);
    if (!targetKey) return retryAt;
    for (const other of jobs) {
      if (other?.id === job?.id || other?.status !== 'queued') continue;
      if (scheduledJobTargetKey(other) !== targetKey) continue;
      const queuedAt = Date.parse(other.nextRunAt || other.scheduledAt || '');
      if (Number.isFinite(queuedAt) && queuedAt >= retryAt) {
        retryAt = queuedAt + QUEUE_RETRY_MS;
      }
    }
    return retryAt;
  }

  async restoreAlarms() {
    const retryAt = iso(this.now() + QUEUE_RETRY_MS);
    const { jobs: normalized, alarmsToClear } = await this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      let changed = false;
      const recovered = jobs.map((job) => {
        if (!['running', 'needs_user_input'].includes(job.status)) return job;
        changed = true;
        this._waitingForInput.delete(job.id);
        return {
          ...job,
          status: 'queued',
          nextRunAt: retryAt,
          queueDeferrals: Number(job.queueDeferrals || 0) + 1,
          lastError: 'Scheduled run was interrupted by a background restart; queued to retry.',
          pendingClarify: null,
          updatedAt: iso(this.now()),
        };
      });
      const coalesced = this._coalesceDuplicateJobs(recovered);
      changed = changed || coalesced.changed;
      if (changed) await this._setJobs(coalesced.jobs);
      return { jobs: coalesced.jobs, alarmsToClear: coalesced.alarmsToClear };
    });
    await Promise.all(alarmsToClear.map((id) => this._clearAlarm(id)));
    const live = new Set(['pending', 'queued']);
    await Promise.all(normalized.filter((job) => live.has(job.status)).map((job) => this._setAlarm(job)));
  }

  async listJobs({ tabId = null } = {}) {
    const jobs = await this._getJobs();
    return jobs
      .filter((job) => tabId == null || job.tabId === tabId || job.target?.tabId === tabId)
      .map(summarizeScheduledJob)
      .sort((a, b) => String(a.nextRunAt || '').localeCompare(String(b.nextRunAt || '')));
  }

  async _saveJob(job) {
    return this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      const idx = jobs.findIndex((it) => it.id === job.id);
      if (idx >= 0) jobs[idx] = job; else jobs.push(job);
      await this._setJobs(jobs);
      return job;
    });
  }

  async _updateJobIf(jobId, predicate, updater) {
    return this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      const idx = jobs.findIndex((it) => it.id === jobId);
      if (idx < 0) return null;
      if (typeof predicate === 'function' && !predicate(jobs[idx])) return null;
      const updated = { ...jobs[idx], ...updater(jobs[idx]), updatedAt: iso(this.now()) };
      jobs[idx] = updated;
      await this._setJobs(jobs);
      return updated;
    });
  }

  async _updateJob(jobId, updater) {
    return this._updateJobIf(jobId, () => true, updater);
  }

  _emit(job, event = 'updated') {
    this.sendUpdate(job.tabId || job.target?.tabId || null, 'scheduled_job', {
      event,
      job: summarizeScheduledJob(job),
    });
  }

  async createResumeJob({ tabId, conversationId, mode = 'act', args, currentUrl = '', currentTitle = '' }) {
    const parsed = validateResumeArgs(args, this.now());
    if (!parsed.ok) return { success: false, error: parsed.error };
    const createdAt = iso(this.now());
    const job = {
      id: makeScheduledJobId('resume', this.now()),
      kind: 'resume',
      status: 'pending',
      tabId,
      conversationId,
      mode,
      reason: parsed.reason,
      resumeInstruction: parsed.resumeInstruction,
      scheduledAt: parsed.scheduledAt,
      nextRunAt: parsed.scheduledAt,
      createdAt,
      updatedAt: createdAt,
      originalUrl: currentUrl,
      originalTitle: currentTitle,
      queueDeferrals: 0,
      runCount: 0,
    };
    const saved = await this._saveJobUnlessDuplicate(job);
    if (!saved.deduped) {
      await this._setAlarm(saved.job);
      this._emit(saved.job, 'created');
    }
    return {
      success: true,
      scheduled: true,
      jobId: saved.job.id,
      scheduledAt: saved.job.scheduledAt,
      summary: `Scheduled a resume for ${saved.job.scheduledAt}.`,
      done: true,
      ...(saved.deduped ? { deduped: true, existingJobId: saved.job.id } : {}),
    };
  }

  async createTaskJob({ tabId = null, conversationId = null, args, source = 'agent', currentUrl = '', currentTitle = '' }) {
    const parsed = validateTaskArgs(args, this.now());
    if (!parsed.ok) return { success: false, error: parsed.error };
    const createdAt = iso(this.now());
    const target = {
      ...parsed.target,
      ...(parsed.target.type === 'current_tab' ? { tabId, conversationId, originalUrl: currentUrl, originalTitle: currentTitle } : {}),
    };
    const job = {
      id: makeScheduledJobId('task', this.now()),
      kind: 'task',
      status: 'pending',
      tabId: target.tabId || null,
      conversationId: target.conversationId || null,
      mode: parsed.mode,
      title: parsed.title,
      prompt: parsed.prompt,
      schedule: {
        type: parsed.scheduleType,
        run_at: parsed.scheduledAt,
        interval_minutes: parsed.intervalMinutes,
      },
      target,
      source,
      scheduledAt: parsed.scheduledAt,
      nextRunAt: parsed.immediate ? iso(this.now() + 1000) : parsed.scheduledAt,
      immediate: parsed.immediate,
      createdAt,
      updatedAt: createdAt,
      queueDeferrals: 0,
      runCount: 0,
    };
    const saved = await this._saveJobUnlessDuplicate(job);
    if (!saved.deduped) {
      await this._setAlarm(saved.job);
      this._emit(saved.job, 'created');
    }
    return {
      success: true,
      scheduled: true,
      jobId: saved.job.id,
      scheduledAt: saved.job.scheduledAt,
      summary: parsed.immediate ? `Started "${saved.job.title}".` : `Scheduled "${saved.job.title}" for ${saved.job.scheduledAt}.`,
      ...(saved.deduped ? { deduped: true, existingJobId: saved.job.id } : {}),
    };
  }

  async cancelJob(jobId, reason = 'cancelled') {
    const jobs = await this._getJobs();
    const existing = jobs.find((it) => it.id === jobId);
    await this._clearAlarm(jobId);
    this._waitingForInput.delete(jobId);
    if (existing && ['running', 'needs_user_input'].includes(existing.status)) {
      const tabId = existing.tabId || existing.target?.tabId;
      if (tabId != null) {
        try { this.agent.abort(tabId); } catch {}
      }
    }
    const job = await this._updateJob(jobId, () => ({ status: 'cancelled', lastError: reason, pendingClarify: null }));
    if (job) this._emit(job, 'cancelled');
    return { ok: !!job, job: summarizeScheduledJob(job) };
  }

  async deleteJob(jobId) {
    await this._clearAlarm(jobId);
    this._waitingForInput.delete(jobId);
    const { existing, removed } = await this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      const existing = jobs.find((job) => job.id === jobId);
      const next = jobs.filter((job) => job.id !== jobId);
      if (next.length !== jobs.length) await this._setJobs(next);
      return { existing, removed: next.length !== jobs.length };
    });
    if (existing && ['running', 'needs_user_input'].includes(existing.status)) {
      const tabId = existing.tabId || existing.target?.tabId;
      if (tabId != null) {
        try { this.agent.abort(tabId); } catch {}
      }
    }
    return { ok: removed };
  }

  async pauseJob(jobId) {
    await this._clearAlarm(jobId);
    let liveTabId = null;
    const job = await this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      const idx = jobs.findIndex((it) => it.id === jobId);
      if (idx < 0) return null;
      const existing = jobs[idx];
      if (['running', 'needs_user_input'].includes(existing.status)) {
        liveTabId = existing.tabId || existing.target?.tabId || null;
        this._waitingForInput.delete(jobId);
      }
      const updated = {
        ...existing,
        status: 'paused',
        pendingClarify: null,
        updatedAt: iso(this.now()),
      };
      jobs[idx] = updated;
      await this._setJobs(jobs);
      return updated;
    });
    if (liveTabId != null) {
      try { this.agent.abort(liveTabId); } catch {}
    }
    if (job) this._emit(job, 'paused');
    return { ok: !!job, job: summarizeScheduledJob(job) };
  }

  async resumeJob(jobId) {
    const job = await this._updateJob(jobId, (prev) => ({
      status: 'pending',
      nextRunAt: prev.nextRunAt || prev.scheduledAt || iso(this.now() + MIN_DELAY_MS),
      queueDeferrals: 0,
    }));
    if (job) {
      await this._setAlarm(job);
      this._emit(job, 'resumed');
    }
    return { ok: !!job, job: summarizeScheduledJob(job) };
  }

  async runNow(jobId) {
    if (this._waitingForInput.has(jobId)) {
      return {
        ok: false,
        error: 'Scheduled run is waiting for your answer. Reply to the prompt or cancel the run.',
      };
    }
    const job = await this._updateJob(jobId, () => ({
      status: 'pending',
      nextRunAt: iso(this.now() + 1000),
      queueDeferrals: 0,
    }));
    if (job) await this._setAlarm(job);
    return { ok: !!job, job: summarizeScheduledJob(job) };
  }

  async cancelForTab(tabId, reason = 'tab closed') {
    const { alarmsToSet, alarmsToClear, tabIdsToAbort } = await this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      const next = [];
      const alarmsToSet = [];
      const alarmsToClear = [];
      const tabIdsToAbort = [];
      for (const job of jobs) {
        const matches = job.tabId === tabId || job.target?.tabId === tabId;
        const isUrlTarget = job.kind === 'task' && job.target?.type === 'url';
        if (matches && isUrlTarget && ['pending', 'queued', 'paused'].includes(job.status)) {
          next.push({
            ...job,
            tabId: null,
            target: { ...job.target, tabId: null },
            updatedAt: iso(this.now()),
          });
          continue;
        }
        if (matches && isUrlTarget && job.status === 'needs_user_input') {
          this._waitingForInput.delete(job.id);
          const liveTabId = job.tabId || job.target?.tabId;
          if (liveTabId != null) tabIdsToAbort.push(liveTabId);
          const queued = {
            ...job,
            status: 'queued',
            tabId: null,
            target: { ...job.target, tabId: null },
            nextRunAt: iso(this.now() + QUEUE_RETRY_MS),
            lastError: 'Scheduled URL task tab closed while waiting for input; queued to retry.',
            pendingClarify: null,
            updatedAt: iso(this.now()),
          };
          next.push(queued);
          alarmsToSet.push(queued);
          continue;
        }
        if (matches && ['pending', 'queued', 'paused', 'running', 'needs_user_input'].includes(job.status)) {
          alarmsToClear.push(job.id);
          this._waitingForInput.delete(job.id);
          const liveTabId = job.tabId || job.target?.tabId;
          if (['running', 'needs_user_input'].includes(job.status) && liveTabId != null) tabIdsToAbort.push(liveTabId);
          next.push({ ...job, status: 'cancelled', lastError: reason, pendingClarify: null, updatedAt: iso(this.now()) });
        } else {
          next.push(job);
        }
      }
      await this._setJobs(next);
      return { alarmsToSet, alarmsToClear, tabIdsToAbort };
    });
    await Promise.all(alarmsToClear.map((id) => this._clearAlarm(id)));
    await Promise.all(alarmsToSet.map((job) => this._setAlarm(job)));
    for (const liveTabId of tabIdsToAbort) {
      try { this.agent.abort(liveTabId); } catch {}
    }
  }

  async cancelForConversation(tabId, conversationId, reason = 'conversation cleared') {
    const alarmsToClear = await this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      const next = [];
      const alarmsToClear = [];
      for (const job of jobs) {
        const matches = (job.tabId === tabId || job.target?.tabId === tabId) &&
          (!conversationId || job.conversationId === conversationId || job.target?.conversationId === conversationId);
        if (matches && ['pending', 'queued', 'paused', 'needs_user_input'].includes(job.status)) {
          alarmsToClear.push(job.id);
          this._waitingForInput.delete(job.id);
          next.push({ ...job, status: 'cancelled', lastError: reason, pendingClarify: null, updatedAt: iso(this.now()) });
        } else {
          next.push(job);
        }
      }
      await this._setJobs(next);
      return alarmsToClear;
    });
    await Promise.all(alarmsToClear.map((id) => this._clearAlarm(id)));
  }

  async handleAlarm(alarmName) {
    if (!alarmName || !alarmName.startsWith(SCHEDULED_ALARM_PREFIX)) return;
    const jobId = alarmName.slice(SCHEDULED_ALARM_PREFIX.length);
    const stopKeepAlive = this._startAlarmKeepAlive();
    try {
      await this._runJob(jobId);
    } finally {
      stopKeepAlive?.();
    }
  }

  async _markFailed(job, error) {
    const failed = await this._updateJobIf(job.id, (prev) => (
      ['pending', 'queued', 'running', 'needs_user_input'].includes(prev.status)
    ), () => ({
      status: 'failed',
      lastError: String(error || 'Scheduled job failed.'),
      pendingClarify: null,
    }));
    if (failed) this._emit(failed, 'failed');
  }

  async _requeue(job, reason) {
    const result = await this._withJobMutation(async () => {
      const jobs = await this._getJobs();
      const idx = jobs.findIndex((it) => it.id === job.id);
      if (idx < 0) return null;
      const prev = jobs[idx];
      if (!['pending', 'queued', 'running', 'needs_user_input'].includes(prev.status)) return null;
      const deferrals = Number(prev.queueDeferrals || 0) + 1;
      const updated = deferrals > MAX_QUEUE_DEFERRALS
        ? {
          ...prev,
          status: 'failed',
          lastError: `Timed out waiting to run: ${reason}`,
          pendingClarify: null,
          updatedAt: iso(this.now()),
        }
        : {
          ...prev,
          status: 'queued',
          nextRunAt: iso(this._nextQueueRetryMs(prev, jobs)),
          queueDeferrals: deferrals,
          lastError: reason,
          pendingClarify: null,
          updatedAt: iso(this.now()),
        };
      jobs[idx] = updated;
      await this._setJobs(jobs);
      return updated;
    });
    if (!result) return;
    if (result.status === 'queued') {
      await this._setAlarm(result);
      this._emit(result, 'queued');
    } else if (result.status === 'failed') {
      this._emit(result, 'failed');
    }
  }

  async _resolveTab(job) {
    if (job.kind === 'resume' || job.target?.type === 'current_tab') {
      const tabId = job.tabId || job.target?.tabId;
      if (tabId == null) throw new Error('Scheduled tab is missing.');
      await this.api.tabs.get(tabId);
      return tabId;
    }
    if (job.target?.type === 'url') {
      if (job.target.tabId != null) {
        try {
          const tab = await this.api.tabs.get(job.target.tabId);
          if (sameTargetUrl(job.target.url, tab?.url || '')) {
            return job.target.tabId;
          }
          try {
            await this.api.tabs.update(job.target.tabId, { url: job.target.url });
            return job.target.tabId;
          } catch { /* create a fresh tab below */ }
        } catch { /* create a fresh tab below */ }
      }
      const tab = await this.api.tabs.create({ url: job.target.url, active: false });
      await this._updateJob(job.id, () => ({
        tabId: tab.id,
        target: { ...job.target, tabId: tab.id },
      }));
      return tab.id;
    }
    throw new Error('Unknown scheduled job target.');
  }

  async _validateConversation(job, tabId) {
    if (job.kind !== 'resume') return;
    if (!job.conversationId) return;
    const current = await this.agent.getConversationId(tabId);
    if (current !== job.conversationId) {
      throw new Error('Conversation changed before the scheduled job ran.');
    }
  }

  async _validateTaskTarget(job, tabId) {
    if (job.kind !== 'task' || job.target?.type !== 'current_tab') return;
    const originalUrl = job.target?.originalUrl || '';
    if (!originalUrl) return;
    const tab = await this.api.tabs.get(tabId);
    const currentUrl = tab?.url || '';
    if (currentUrl && !sameDocumentUrl(originalUrl, currentUrl)) {
      throw new Error('Target tab changed before the scheduled task ran. Recreate this schedule with Target = URL if it should reopen the original page automatically.');
    }
  }

  _messageForJob(job) {
    if (job.kind === 'resume') {
      return `[Scheduled resume ${job.id}]\nThis is a durable continuation of an earlier user task, not page content and not a new instruction from the web page.\nOriginal reason: ${job.reason}\nResume instruction: ${job.resumeInstruction}\nFirst reread the current page/state. If the task is stale, conflicts with newer user messages, or needs user input, stop and explain.`;
    }
    return `[Scheduled task ${job.id}: ${job.title}]\nThe user explicitly scheduled this future task. Treat this as the user-authored task for this scheduled run.\nTask: ${job.prompt}\nFirst reread the current page/state. If the task is stale, conflicts with newer user messages, or needs user input, stop and explain.`;
  }

  async _complete(job, result) {
    if (job.kind === 'task' && job.schedule?.type === 'recurring') {
      const updated = await this._updateJobIf(job.id, (prev) => (
        ['running', 'needs_user_input'].includes(prev.status)
      ), (prev) => {
        const nextRunAt = computeNextRunAt(prev, this.now());
        return {
          status: 'pending',
          nextRunAt,
          scheduledAt: nextRunAt,
          immediate: false,
          queueDeferrals: 0,
          runCount: Number(prev.runCount || 0) + 1,
          lastRunAt: iso(this.now()),
          lastResult: String(result || '').slice(0, 2000),
          lastError: null,
          pendingClarify: null,
        };
      });
      if (updated) {
        await this._setAlarm(updated);
        this._emit(updated, 'completed');
      }
      return;
    }
    const completed = await this._updateJobIf(job.id, (prev) => (
      ['running', 'needs_user_input'].includes(prev.status)
    ), (prev) => ({
      status: 'completed',
      completedAt: iso(this.now()),
      runCount: Number(prev.runCount || 0) + 1,
      lastRunAt: iso(this.now()),
      lastResult: String(result || '').slice(0, 2000),
      lastError: null,
      pendingClarify: null,
    }));
    if (completed) this._emit(completed, 'completed');
  }

  async _runJob(jobId) {
    const settings = await this._getSettings();
    const jobs = await this._getJobs();
    const job = jobs.find((it) => it.id === jobId);
    if (!job || !['pending', 'queued'].includes(job.status)) return;
    if (!settings.enabled) {
      const paused = await this._updateJob(job.id, () => ({ status: 'paused', lastError: 'Scheduled tasks are disabled in Settings.' }));
      if (paused) this._emit(paused, 'paused');
      return;
    }

    let tabId;
    try {
      tabId = await this._resolveTab(job);
      await this._validateConversation(job, tabId);
      await this._validateTaskTarget(job, tabId);
    } catch (e) {
      await this._markFailed(job, e.message);
      return;
    }

    if (this._runningTabs.has(tabId) || this.agent.isRunning(tabId)) {
      await this._requeue(job, 'The target tab already has an active WebBrain run.');
      return;
    }
    this._runningTabs.add(tabId);

    const running = await this._updateJobIf(job.id, (prev) => (
      ['pending', 'queued'].includes(prev.status)
    ), () => ({
      status: 'running',
      tabId,
      queueDeferrals: 0,
      startedAt: iso(this.now()),
      lastError: null,
      pendingClarify: null,
    }));
    if (!running) {
      this._runningTabs.delete(tabId);
      return;
    }
    this._emit(running, 'running');

    const onUpdate = (type, data) => {
      if (type === 'clarify') {
        const pendingClarify = normalizePendingClarify(data, this.now());
        this._waitingForInput.add(job.id);
        this._updateJobIf(job.id, (prev) => prev.status === 'running', () => ({
          status: 'needs_user_input',
          lastError: 'Scheduled run needs user input.',
          ...(pendingClarify ? { pendingClarify } : {}),
        })).then((waiting) => {
          if (waiting?.status === 'needs_user_input') this._emit(waiting, 'needs_user_input');
        }).catch((e) => {
          console.warn('[WebBrain] failed to mark scheduled job as waiting for input:', e);
        });
      }
      this.sendUpdate(tabId, type, type === 'clarify' ? { ...data, scheduledJobId: job.id } : data);
    };

    this.showIndicator(tabId);
    this.agent.setScheduledRunPolicy(tabId, {
      requireConsequentialConfirmation: settings.requireConsequentialConfirmation,
    });
    try {
      await this.loadProviders();
      const result = await this.agent.processMessage(tabId, this._messageForJob(running), onUpdate, running.mode || 'act');
      this._waitingForInput.delete(job.id);
      await this._complete(running, result);
    } catch (e) {
      this._waitingForInput.delete(job.id);
      if (isActiveRunError(e)) {
        await this._requeue(running, 'The target tab already has an active WebBrain run.');
      } else {
        await this._markFailed(running, e.message);
      }
    } finally {
      this._runningTabs.delete(tabId);
      this.agent.clearScheduledRunPolicy(tabId);
      this.hideIndicator(tabId);
    }
  }
}
