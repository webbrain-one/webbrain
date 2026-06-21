const CANONICAL_ACTIONS = new Set([
  'follow',
  'unfollow',
  'star',
  'unstar',
  'watch',
  'unwatch',
  'connect',
  'subscribe',
  'unsubscribe',
  'save',
  'unsave',
  'like',
  'unlike',
  'block',
  'unblock',
  'report',
  'send',
  'submit',
  'add',
  'remove',
  'collect_email',
  'collect_profile',
  'process_item',
  'visit',
  'open',
]);

const ACTION_ALIASES = new Map([
  ['collect emails', 'collect_email'],
  ['collect email', 'collect_email'],
  ['email', 'collect_email'],
  ['emails', 'collect_email'],
  ['collect profiles', 'collect_profile'],
  ['collect profile', 'collect_profile'],
  ['profile', 'collect_profile'],
  ['profiles', 'collect_profile'],
  ['process', 'process_item'],
  ['process items', 'process_item'],
  ['process item', 'process_item'],
  ['open_url', 'open'],
  ['open page', 'open'],
  ['visit page', 'visit'],
]);

function sanitizeText(value, max = 500) {
  if (value == null) return '';
  return String(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function normalizeProgressAction(value) {
  const raw = sanitizeText(value, 120).toLowerCase().replace(/[-\s]+/g, '_');
  if (!raw) return '';
  const spaced = raw.replace(/_/g, ' ');
  const alias = ACTION_ALIASES.get(raw) || ACTION_ALIASES.get(spaced);
  if (alias && CANONICAL_ACTIONS.has(alias)) return alias;
  return CANONICAL_ACTIONS.has(raw) ? raw : '';
}

export function normalizeProgressIntent(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const taskText = sanitizeText(raw.taskText || raw.task_text || opts.taskText || '', 1200);
  const rawMode = sanitizeText(raw.mode || raw.intent || raw.status || '', 40).toLowerCase();
  const mode = ['active', 'read_only', 'inactive'].includes(rawMode)
    ? rawMode
    : (raw.active === true ? 'active' : 'inactive');
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;
  const allowedActions = unique(
    firstArray(raw.allowedActions, raw.allowed_actions)
      .map(normalizeProgressAction)
  );
  const forbiddenActions = unique(
    firstArray(raw.forbiddenActions, raw.forbidden_actions)
      .map(normalizeProgressAction)
  );
  const targets = unique(
    firstArray(raw.targets)
      .map(value => sanitizeText(value, 160))
  ).slice(0, 20);
  const pageScope = sanitizeText(raw.pageScope || raw.page_scope || opts.pageScope || '', 240);
  const pageScopePolicy = sanitizeText(raw.pageScopePolicy || raw.page_scope_policy || '', 40).toLowerCase();

  return {
    taskText,
    mode,
    allowedActions,
    forbiddenActions,
    targets,
    confidence,
    ...(pageScope ? { pageScope } : {}),
    pageScopePolicy: pageScopePolicy === 'page' || pageScopePolicy === 'site' ? pageScopePolicy : (pageScope ? 'page' : 'none'),
    source: sanitizeText(opts.source || raw.source || 'classifier', 40) || 'classifier',
    reason: sanitizeText(raw.reason || '', 300),
  };
}

export function isProgressIntentActive(session, opts = {}) {
  const minConfidence = Number.isFinite(Number(opts.minConfidence)) ? Number(opts.minConfidence) : 0.45;
  return !!session
    && session.mode === 'active'
    && Number(session.confidence || 0) >= minConfidence
    && Array.isArray(session.allowedActions)
    && session.allowedActions.length > 0;
}

export function isProgressActionAllowed(session, action, opts = {}) {
  const canonical = normalizeProgressAction(action);
  if (!canonical || !isProgressIntentActive(session, opts)) return false;
  const allowed = new Set((session.allowedActions || []).map(normalizeProgressAction).filter(Boolean));
  const forbidden = new Set((session.forbiddenActions || []).map(normalizeProgressAction).filter(Boolean));
  return allowed.has(canonical) && !forbidden.has(canonical);
}
