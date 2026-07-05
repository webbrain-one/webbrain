const VALID_STATUSES = new Set(['pending', 'acted', 'processed', 'skipped', 'failed']);
const TERMINAL_STATUSES = new Set(['processed', 'skipped', 'failed']);
const CLICK_ACTION_TOOLS = new Set(['click', 'click_ax', 'iframe_click']);
const ACTION_RE = /^\s*(follow|unfollow|star|unstar|watch|unwatch|connect|subscribe|unsubscribe|save|unsave|like|unlike|block|unblock|report|send|submit|add|remove)\b(?:\s+(.+?))?\s*$/i;
const GENERIC_TARGET_RE = /^(button|link|item|result|profile|user|member|person|this|that|it|here|there|more|submit|save|send|add|remove|follow|unfollow|changes?|message|comment|reply|post|form|details|settings|preferences)$/i;

function sanitizeText(value, max = 240) {
  if (value == null) return '';
  return String(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeLedgerStatus(value, fallback = 'pending') {
  const status = sanitizeText(value, 40).toLowerCase();
  if (VALID_STATUSES.has(status)) return status;
  const unwrapped = status
    .replace(/^[\s"'`<([{\\\u300c\u300e\u201c\u2018]+/g, '')
    .replace(/[\s"'`>)\]}\\\u300d\u300f\u201d\u2019]+$/g, '');
  return VALID_STATUSES.has(unwrapped) ? unwrapped : fallback;
}

function normalizeStatus(value, fallback = 'pending') {
  return normalizeLedgerStatus(value, fallback);
}

function sanitizeFieldValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = sanitizeText(value, 500);
    if (/^(null|none|n\/a|not found|no email|unknown)$/i.test(text)) return null;
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function cleanTarget(value) {
  let text = sanitizeText(value, 180)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^\s*@/, '')
    .replace(/\s+\((?:button|link|profile|user)\)$/i, '')
    .trim();
  if (!text || GENERIC_TARGET_RE.test(text)) return '';
  return text;
}

function targetFromHref(href) {
  const raw = sanitizeText(href, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://example.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    const last = decodeURIComponent(parts[parts.length - 1] || '');
    return cleanTarget(last);
  } catch {
    const parts = raw.split(/[?#]/)[0].split('/').filter(Boolean);
    return cleanTarget(parts[parts.length - 1] || '');
  }
}

function stableIdFor(action, target, url) {
  const base = cleanTarget(target) || targetFromHref(url);
  if (!base) return '';
  const compact = base
    .replace(/^@/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitizeText(compact, 160);
}

function sanitizeFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(fields).slice(0, 20)) {
    const k = sanitizeText(key, 80);
    if (!k) continue;
    const cleaned = sanitizeFieldValue(value);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return Object.keys(out).length ? out : undefined;
}

function rowKey(row) {
  const id = sanitizeText(row?.id, 180).toLowerCase();
  if (!id) return '';
  const sessionId = sanitizeText(row?.sessionId || row?.session_id || '', 120).toLowerCase();
  return sessionId ? `${sessionId}::${id}` : id;
}

export function isTerminalLedgerStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').toLowerCase());
}

// Single source of truth for the reopen gate: a terminal row may only move
// back to a non-terminal status via an explicit allowReopen (never for auto).
export function isBlockedLedgerDowngrade(existingStatus, incomingStatus, opts = {}) {
  if (!isTerminalLedgerStatus(existingStatus) || isTerminalLedgerStatus(incomingStatus)) return false;
  return opts.source === 'auto' || opts.allowReopen !== true;
}

export function isValidLedgerStatus(status) {
  return VALID_STATUSES.has(normalizeLedgerStatus(status, ''));
}

export function normalizeLedgerItem(item, opts = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const source = sanitizeText(opts.source || item.source || 'model', 40) || 'model';
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const action = sanitizeText(item.action, 80).toLowerCase();
  const target = cleanTarget(item.target || '');
  const url = sanitizeText(item.url || item.href || '', 500);
  const id = sanitizeText(item.id || stableIdFor(action, target || item.label, url), 160);
  if (!id) return null;
  const fallbackStatus = source === 'auto' ? 'acted' : 'pending';
  const status = normalizeStatus(item.status, fallbackStatus);
  const label = sanitizeText(item.label || target || id, 220);
  const reason = sanitizeText(item.reason || item.note || '', 300);
  const sessionId = sanitizeText(item.sessionId || item.session_id || opts.sessionId || '', 120);
  const pageScope = sanitizeText(item.pageScope || item.page_scope || opts.pageScope || '', 240);
  const taskKey = sanitizeText(item.taskKey || opts.taskKey || '', 240);
  const fields = sanitizeFields(item.fields);
  const attempts = Number.isFinite(Number(item.attempts))
    ? Math.max(0, Math.floor(Number(item.attempts)))
    : (source === 'auto' ? 1 : 0);

  return {
    id,
    label,
    ...(url ? { url } : {}),
    status,
    ...(action ? { action } : {}),
    ...(fields ? { fields } : {}),
    ...(reason ? { reason } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(pageScope ? { pageScope } : {}),
    ...(taskKey ? { taskKey } : {}),
    source,
    attempts,
    firstSeenAt: Number.isFinite(Number(item.firstSeenAt)) ? Number(item.firstSeenAt) : now,
    updatedAt: now,
  };
}

export function progressCounts(rows = []) {
  const counts = { total: 0, pending: 0, acted: 0, processed: 0, skipped: 0, failed: 0, unresolved: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = normalizeStatus(row?.status, 'pending');
    counts.total += 1;
    counts[status] += 1;
    if (!isTerminalLedgerStatus(status)) counts.unresolved += 1;
  }
  return counts;
}

export function unresolvedLedgerRows(rows = [], opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Math.floor(Number(opts.limit))) : Infinity;
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || isTerminalLedgerStatus(row.status)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export function selectLedgerRows(rows = [], opts = {}) {
  const status = opts.status ? normalizeStatus(opts.status, '') : '';
  const sessionId = sanitizeText(opts.sessionId || opts.session_id || '', 120);
  const offset = Number.isFinite(Number(opts.offset)) ? Math.max(0, Math.floor(Number(opts.offset))) : 0;
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Math.floor(Number(opts.limit))) : 50;
  const filtered = (Array.isArray(rows) ? rows : [])
    .filter(row => (!status || normalizeStatus(row?.status, 'pending') === status)
      && (!sessionId || sanitizeText(row?.sessionId || row?.session_id || '', 120) === sessionId));
  return filtered.slice(offset, offset + limit);
}

export function upsertLedgerItems(rows = [], items = [], opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const source = sanitizeText(opts.source || 'model', 40) || 'model';
  const next = Array.isArray(rows) ? rows.map(row => ({ ...row, fields: row?.fields ? { ...row.fields } : undefined })) : [];
  const indexByKey = new Map();
  next.forEach((row, idx) => {
    const key = rowKey(row);
    if (key) indexByKey.set(key, idx);
  });

  const updated = [];
  const blockedDowngrades = [];
  for (const rawItem of Array.isArray(items) ? items : []) {
    const incoming = normalizeLedgerItem(rawItem, { source, now, sessionId: opts.sessionId, pageScope: opts.pageScope, taskKey: opts.taskKey });
    if (!incoming) continue;
    const key = rowKey(incoming);
    const existingIdx = indexByKey.get(key);
    if (existingIdx == null) {
      next.push(incoming);
      indexByKey.set(key, next.length - 1);
      updated.push(incoming);
      continue;
    }

    const existing = next[existingIdx] || {};
    const autoActed = source === 'auto' && incoming.status === 'acted';
    const keepTerminal = isBlockedLedgerDowngrade(existing.status, incoming.status, { source, allowReopen: opts.allowReopen });
    if (keepTerminal && !autoActed) {
      blockedDowngrades.push({ id: incoming.id, keptStatus: existing.status, requestedStatus: incoming.status });
    }
    const merged = {
      ...existing,
      label: incoming.label || existing.label,
      ...(incoming.url ? { url: incoming.url } : {}),
      status: keepTerminal ? existing.status : incoming.status,
      ...(incoming.action ? { action: incoming.action } : {}),
      fields: { ...(existing.fields || {}), ...(incoming.fields || {}) },
      ...(incoming.reason ? { reason: incoming.reason } : {}),
      sessionId: incoming.sessionId || existing.sessionId,
      pageScope: incoming.pageScope || existing.pageScope,
      taskKey: incoming.taskKey || existing.taskKey,
      source: incoming.source || existing.source,
      attempts: source === 'auto'
        ? Math.max(1, Number(existing.attempts || 0) + 1)
        : Math.max(Number(existing.attempts || 0), Number(incoming.attempts || 0)),
      firstSeenAt: Number.isFinite(Number(existing.firstSeenAt)) ? Number(existing.firstSeenAt) : incoming.firstSeenAt,
      updatedAt: now,
    };
    if (!Object.keys(merged.fields || {}).length) delete merged.fields;
    if (!merged.sessionId) delete merged.sessionId;
    if (!merged.pageScope) delete merged.pageScope;
    if (!merged.taskKey) delete merged.taskKey;
    next[existingIdx] = merged;
    updated.push(merged);
  }

  return { rows: next, updated, counts: progressCounts(next), changed: updated.length > 0, blockedDowngrades };
}

export function formatLedgerRow(row) {
  if (!row) return '';
  const status = normalizeStatus(row.status, 'pending');
  const action = sanitizeText(row.action, 60);
  const label = sanitizeText(row.label || row.id, 220);
  const id = sanitizeText(row.id, 160);
  const fields = row.fields && typeof row.fields === 'object'
    ? Object.entries(row.fields)
      .slice(0, 8)
      .map(([k, v]) => `${sanitizeText(k, 60)}=${v == null ? 'null' : sanitizeText(v, 160)}`)
      .filter(Boolean)
      .join(', ')
    : '';
  const reason = sanitizeText(row.reason || '', 240);
  return `- ${status}${action ? ` ${action}` : ''}: ${label}${id && id !== label ? ` [id: ${id}]` : ''}${fields ? ` (${fields})` : ''}${reason ? ` - ${reason}` : ''}`;
}

export function formatLedgerSummary(rows = [], opts = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return 'Progress ledger: no rows.';
  const maxRows = Number.isFinite(Number(opts.maxRows)) ? Math.max(1, Math.floor(Number(opts.maxRows))) : 18;
  const counts = progressCounts(safeRows);
  const unresolved = unresolvedLedgerRows(safeRows);
  const unresolvedKeys = new Set(unresolved.map(rowKey));
  const ordered = [
    ...unresolved,
    ...safeRows.filter(row => !unresolvedKeys.has(rowKey(row))),
  ].slice(0, maxRows);
  const countText = `total ${counts.total}; pending ${counts.pending}; acted ${counts.acted}; processed ${counts.processed}; skipped ${counts.skipped}; failed ${counts.failed}`;
  const lines = ordered.map(formatLedgerRow).filter(Boolean);
  const more = safeRows.length > ordered.length ? `\n... ${safeRows.length - ordered.length} more row(s) omitted from prompt view; call progress_read for full ledger.` : '';
  return `Progress ledger (${countText}). Unresolved rows before done: ${counts.unresolved}.\n${lines.join('\n')}${more}`;
}

export function ledgerDoneBlock(rows = [], opts = {}) {
  const unresolved = unresolvedLedgerRows(rows, { limit: opts.limit || 12 });
  if (!unresolved.length) return null;
  const counts = progressCounts(rows);
  const examples = unresolved.map(formatLedgerRow).join('\n');
  return {
    blocked: true,
    counts,
    unresolved,
    error: `The app-owned progress ledger still has ${counts.unresolved} unresolved row(s). Before calling done, use progress_update to mark each as processed, skipped, or failed, including any collected fields such as email/null. Unresolved rows:\n${examples}`,
  };
}

export function detectProgressAction(toolName, args = {}, result = {}, opts = {}) {
  if (!CLICK_ACTION_TOOLS.has(toolName)) return null;
  if (!result || result.success === false || result.error || result.noProgress) return null;
  const allowedActions = new Set((Array.isArray(opts.allowedActions) ? opts.allowedActions : [])
    .map(value => sanitizeText(value, 80).toLowerCase())
    .filter(Boolean));

  const labels = [
    args.text,
    args.name,
    args.label,
    result.requestedText,
    result.beforeText,
    result.beforeName,
    result.name,
    result.text,
  ].map(v => sanitizeText(v, 220)).filter(Boolean);
  const href = sanitizeText(result.href || result.url || '', 500);

  for (const label of labels) {
    const match = label.match(ACTION_RE);
    if (!match) continue;
    const action = match[1].toLowerCase();
    if (allowedActions.size && !allowedActions.has(action)) continue;
    const target = cleanTarget(match[2] || '') || targetFromHref(href);
    const id = stableIdFor(action, target, href);
    if (!id) continue;
    return {
      id,
      label: target ? `${action} ${target}` : label,
      action,
      status: 'acted',
      ...(href ? { url: href } : {}),
    };
  }

  return null;
}
