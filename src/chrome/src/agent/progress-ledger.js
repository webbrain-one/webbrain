import { sanitizeText as sanitizeSharedText } from './text-sanitize.js';

const sanitizeText = (value, max = 240) => sanitizeSharedText(value, max, { collapseWhitespace: true });

const VALID_STATUSES = new Set(['pending', 'acted', 'processed', 'skipped', 'failed']);
const TERMINAL_STATUSES = new Set(['processed', 'skipped', 'failed']);
const CLICK_ACTION_TOOLS = new Set(['click', 'click_ax', 'iframe_click']);
const APP_OWNED_BOOLEAN_FIELD_KEYS = new Set(['completionRequirement', 'classifierTarget']);
const APP_OWNED_INTEGER_FIELD_KEYS = new Set(['expectedOrdinal']);
// The ledger actions a click can do to an item, and what each one does, for
// the progress_action question a model answers about a clicked label.
export const PROGRESS_CLICK_ACTION_MEANINGS = Object.freeze({
  follow: 'follow an account, person or page',
  unfollow: 'stop following an account, person or page',
  star: 'star a repository or item',
  unstar: 'remove a star from a repository or item',
  watch: 'watch a repository or item for updates',
  unwatch: 'stop watching a repository or item',
  connect: 'send a connection or contact request to a person',
  subscribe: 'subscribe to a channel, list or item',
  unsubscribe: 'unsubscribe from a channel, list or item',
  save: 'save or bookmark an item',
  unsave: 'remove an item from saved items or bookmarks',
  like: 'like or favourite an item',
  unlike: 'remove a like or favourite from an item',
  block: 'block an account',
  unblock: 'unblock an account',
  report: 'report an account or item',
  send: 'send a message, invitation or item to someone',
  submit: 'submit a form or entry',
  add: 'add an item to a list, cart or collection',
  remove: 'remove an item from a list, cart or collection',
});

// The progress_action question's context for one action.
export function progressClickActionContext(action) {
  const meaning = PROGRESS_CLICK_ACTION_MEANINGS[action];
  return meaning ? { action: `${action}: ${meaning}` } : null;
}
const IDENTITY_ACTION_PREFIX_RE = /^\s*(?:follow|unfollow|star|unstar|watch|unwatch|connect|subscribe|unsubscribe|save|unsave|like|unlike|block|unblock|report|send|submit|add|remove|collect_email|collect_profile|process_item|visit|open)(?:\s*:\s*|\s+)(?!$)/i;
const GENERIC_TARGET_RE = /^(button|link|item|result|profile|user|member|person|this|that|it|here|there|more|submit|save|send|add|remove|follow|unfollow|changes?|message|comment|reply|post|form|details|settings|preferences)$/i;

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

// A missing value is JSON null (or the literal "null" a model wrote as a
// string). Whether some other text only says the value is missing, in any
// language, is read by a model where it matters: the expected-items check.
// A field the item itself has no value for (a profile with no bio) is told
// apart by name, in the row's emptyFields, not by its value.
function sanitizeFieldValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = sanitizeText(value, 500);
    if (/^null$/i.test(text)) return null;
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

// The field names a row lists as checked and empty: up to 20 distinct names,
// never an app-owned field. undefined when the item gives no list, [] for an
// empty one (which clears the row's list).
function sanitizeEmptyFieldNames(value) {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list)) return undefined;
  return [...new Set(list
    .filter(name => typeof name === 'string')
    .map(name => sanitizeText(name, 80))
    .filter(name => name && !APP_OWNED_BOOLEAN_FIELD_KEYS.has(name) && !APP_OWNED_INTEGER_FIELD_KEYS.has(name)))]
    .slice(0, 20);
}

// Whether a row records `field` as checked on the item and empty: the item
// has no value for it. Names match ignoring case ("Bio" lists the required
// "bio"). A field that is only null or absent was never filled.
export function ledgerFieldCheckedEmpty(row, field) {
  if (!Array.isArray(row?.emptyFields)) return false;
  const name = String(field).toLowerCase();
  return row.emptyFields.some(listed => String(listed).toLowerCase() === name);
}

// A row's checked-empty names after an update. A list the update gives
// replaces the row's. Without one, a name stays listed until the update
// writes a different value for that field: the later value wins, so a bio
// found on a second look is not shown as checked empty next to it.
function mergedEmptyFieldNames(existing, incoming) {
  if (incoming?.emptyFields) return incoming.emptyFields;
  if (!Array.isArray(existing?.emptyFields)) return undefined;
  const rewritten = new Set(Object.entries(incoming?.fields || {})
    .filter(([key, value]) => value != null && String(value).trim() !== '' && value !== existing.fields?.[key])
    .map(([key]) => key.toLowerCase()));
  return existing.emptyFields.filter(name => !rewritten.has(String(name).toLowerCase()));
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

function normalizeIdentityText(value) {
  let text = cleanTarget(value);
  if (!text) return '';
  try { text = text.normalize('NFKC'); } catch {}
  text = text
    .replace(IDENTITY_ACTION_PREFIX_RE, '')
    .replace(/^\s*@/, '')
    .replace(/\/+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return text && !GENERIC_TARGET_RE.test(text) ? text : '';
}

function identityEntries(item) {
  const entries = new Map();
  const add = (key, strength) => {
    if (!key) return;
    entries.set(key, Math.max(strength, entries.get(key) || 0));
  };
  const addUrl = (value) => {
    const raw = sanitizeText(value, 500);
    if (!raw) return;
    try {
      const url = new URL(raw);
      if (!/^https?:$/i.test(url.protocol)) return;
      const host = url.hostname.toLowerCase();
      const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
      add(`url:${host}${pathname.toLowerCase()}`, 4);
      const parts = pathname.split('/').filter(Boolean);
      if (!parts.length) return;
      let tail = '';
      try { tail = decodeURIComponent(parts[parts.length - 1] || ''); } catch { tail = parts[parts.length - 1] || ''; }
      tail = normalizeIdentityText(tail);
      if (!tail) return;
      add(`profile:${host}/${tail}`, 3);
      if (/^[^@\s]+@[^@\s]+$/.test(tail)) {
        add(`acct:${tail}`, 3);
      } else if ((parts[parts.length - 1] || '').startsWith('@')) {
        add(`acct:${tail}@${host}`, 3);
      }
      add(`text:${tail}`, 1);
    } catch {}
  };
  const addText = (value, strength = 1) => {
    const raw = sanitizeText(value, 500);
    if (!raw) return;
    if (/^https?:\/\//i.test(raw)) {
      addUrl(raw);
      return;
    }
    const text = normalizeIdentityText(raw);
    if (!text) return;
    add(`text:${text}`, strength);
    if (/^[^@\s]+@[^@\s]+$/.test(text)) add(`acct:${text}`, Math.max(3, strength));
  };

  const id = sanitizeText(item?.id, 180);
  if (id && !/^(?:expected|requirement):/i.test(id)) addText(id, 2);
  addText(item?.target, 2);
  addText(item?.label, 1);
  addUrl(item?.url || item?.href);
  return entries;
}

export function progressIdentityKeys(item) {
  return [...identityEntries(item).keys()];
}

export function progressIdentitiesAreUnique(items = []) {
  const strongestKeys = (Array.isArray(items) ? items : []).map(item => {
    const entries = identityEntries(item);
    const strongest = Math.max(0, ...entries.values());
    return new Set([...entries]
      .filter(([, strength]) => strength === strongest)
      .map(([key]) => key));
  });
  return strongestKeys.every(keys => keys.size > 0)
    && strongestKeys.every((keys, index) => strongestKeys.every((other, otherIndex) => (
      index === otherIndex || ![...keys].some(key => other.has(key))
    )));
}

function identityMatchScore(left, right) {
  const leftEntries = identityEntries(left);
  const rightEntries = identityEntries(right);
  let score = 0;
  for (const [key, leftStrength] of leftEntries) {
    const rightStrength = rightEntries.get(key);
    if (rightStrength) score = Math.max(score, Math.min(leftStrength, rightStrength));
  }
  return score;
}

function isCanonicalProgressRow(row) {
  const ordinal = Number(row?.fields?.expectedOrdinal);
  return row?.fields?.completionRequirement === true
    || row?.fields?.classifierTarget === true
    || (Number.isInteger(ordinal) && ordinal > 0);
}

// A planner-seeded expected slot nothing has claimed yet: no classifier
// target, target or url is bound to it, and it is still pending.
function isBareExpectedSlot(row) {
  const ordinal = Number(row?.fields?.expectedOrdinal);
  return Number.isInteger(ordinal) && ordinal > 0
    && row?.fields?.classifierTarget !== true
    && !row?.target
    && !row?.url
    && normalizeStatus(row?.status, 'pending') === 'pending';
}

function rowInSession(row, sessionId) {
  return sanitizeText(row?.sessionId || row?.session_id || '', 120) === sessionId;
}

function sessionHasClassifierTargets(rows, sessionId) {
  return rows.some(row => rowInSession(row, sessionId) && row?.fields?.classifierTarget === true);
}

function actionsCompatible(left, right) {
  const leftAction = sanitizeText(left?.action, 80).toLowerCase();
  const rightAction = sanitizeText(right?.action, 80).toLowerCase();
  return !leftAction || !rightAction || leftAction === rightAction;
}

function sanitizeFields(fields, opts = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(fields).slice(0, 20)) {
    const k = sanitizeText(key, 80);
    if (!k) continue;
    if (APP_OWNED_BOOLEAN_FIELD_KEYS.has(k)) {
      if (opts.allowAppOwnedFields === true && value === true) out[k] = true;
      continue;
    }
    if (APP_OWNED_INTEGER_FIELD_KEYS.has(k)) {
      const ordinal = Number(value);
      if (opts.allowAppOwnedFields === true && Number.isInteger(ordinal) && ordinal > 0 && ordinal <= 1000) {
        out[k] = ordinal;
      }
      continue;
    }
    const cleaned = sanitizeFieldValue(value);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return Object.keys(out).length ? out : undefined;
}

export function ledgerRowKey(row) {
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
  const fields = sanitizeFields(item.fields, { allowAppOwnedFields: source === 'classifier' });
  const emptyFields = sanitizeEmptyFieldNames(item.emptyFields ?? item.empty_fields);
  const attempts = Number.isFinite(Number(item.attempts))
    ? Math.max(0, Math.floor(Number(item.attempts)))
    : (source === 'auto' ? 1 : 0);

  return {
    id,
    label,
    ...(target ? { target } : {}),
    ...(url ? { url } : {}),
    status,
    ...(action ? { action } : {}),
    ...(fields ? { fields } : {}),
    // An empty list is kept here so an update can clear a row's list.
    ...(emptyFields ? { emptyFields } : {}),
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

export function reconcileLedgerItems(rows = [], items = [], opts = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const source = sanitizeText(opts.source || 'model', 40) || 'model';
  const sessionId = sanitizeText(opts.sessionId || '', 120);
  const reconciled = [];
  const rawItems = Array.isArray(items) ? items : [];
  const normalizedItems = rawItems.map(rawItem => normalizeLedgerItem(rawItem, {
    source,
    sessionId,
    pageScope: opts.pageScope,
    taskKey: opts.taskKey,
    now: opts.now,
  }));
  const semanticBindingFor = incoming => {
    if (!incoming) return null;
    const exactRow = safeRows.find(row => ledgerRowKey(row) === ledgerRowKey(incoming));
    if (exactRow && actionsCompatible(exactRow, incoming)) return null;
    let bestScore = 0;
    let matches = [];
    for (const row of safeRows) {
      const autoMayReuseRow = source === 'auto' && !isTerminalLedgerStatus(row?.status);
      if ((!isCanonicalProgressRow(row) && !autoMayReuseRow) || !actionsCompatible(row, incoming)) continue;
      const rowSessionId = sanitizeText(row?.sessionId || row?.session_id || '', 120);
      if (rowSessionId !== incoming.sessionId) continue;
      const score = identityMatchScore(row, incoming);
      if (score > bestScore) {
        bestScore = score;
        matches = [row];
      } else if (score > 0 && score === bestScore) {
        matches.push(row);
      }
    }
    return bestScore && matches.length === 1 && matches[0]?.id ? matches[0] : null;
  };
  const semanticBindings = new Map();
  normalizedItems.forEach((item, index) => {
    const canonical = semanticBindingFor(item);
    if (canonical) semanticBindings.set(index, canonical);
  });
  const batchBindings = new Map();
  if (source !== 'classifier' && sessionId) {
    const exactIncomingKeys = new Set(normalizedItems.filter(Boolean).map(ledgerRowKey));
    const availableExpected = safeRows
      .filter(row => {
        const ordinal = Number(row?.fields?.expectedOrdinal);
        const rowSessionId = sanitizeText(row?.sessionId || row?.session_id || '', 120);
        return Number.isInteger(ordinal) && ordinal > 0
          && row?.fields?.classifierTarget !== true
          && !row?.target
          && !row?.url
          && rowSessionId === sessionId
          && !exactIncomingKeys.has(ledgerRowKey(row));
      })
      .sort((a, b) => Number(a.fields.expectedOrdinal) - Number(b.fields.expectedOrdinal));
    const newIncoming = normalizedItems
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item
        && !semanticBindings.has(index)
        && !safeRows.some(row => ledgerRowKey(row) === ledgerRowKey(item) && actionsCompatible(row, item)));
    const canBindPartialBatch = source === 'model' || source === 'observe';
    // A runtime-recorded click carries no planner identity, and a bare slot
    // has none to agree with. With no classifier targets in the session there
    // is nothing to check, so the click fills the lowest-ordinal slot still
    // pending instead of becoming a row beside it. An item that already
    // matches a row of this session never takes a fresh slot.
    const autoFillsBareSlot = source === 'auto' && !sessionHasClassifierTargets(safeRows, sessionId);
    const slots = autoFillsBareSlot ? availableExpected.filter(isBareExpectedSlot) : availableExpected;
    const batchFitsAvailable = newIncoming.length === slots.length
      || ((canBindPartialBatch || autoFillsBareSlot) && newIncoming.length > 0 && newIncoming.length < slots.length);
    if (slots.length && batchFitsAvailable) {
      const identitiesAreUnique = progressIdentitiesAreUnique(newIncoming.map(({ item }) => item));
      const compatible = newIncoming.every(({ item }, index) => actionsCompatible(slots[index], item));
      const identityVerified = source !== 'auto' || (autoFillsBareSlot
        ? newIncoming.every(({ item }) => !safeRows.some(row => rowInSession(row, sessionId)
          && actionsCompatible(row, item) && identityMatchScore(row, item) > 0))
        : newIncoming.every(({ item }, index) => identityMatchScore(slots[index], item) > 0));
      if (identitiesAreUnique && compatible && identityVerified) {
        newIncoming.forEach(({ index }, expectedIndex) => batchBindings.set(index, slots[expectedIndex]));
      }
    }
  }

  const nextItems = rawItems.map((rawItem, itemIndex) => {
    const incoming = normalizedItems[itemIndex];
    const semanticCanonical = semanticBindings.get(itemIndex);
    if (incoming && semanticCanonical?.id) {
      reconciled.push({ incomingId: incoming.id, canonicalId: semanticCanonical.id });
      return {
        ...rawItem,
        id: semanticCanonical.id,
        sessionId: semanticCanonical.sessionId || incoming.sessionId || sessionId,
      };
    }
    const batchCanonical = batchBindings.get(itemIndex);
    if (incoming && batchCanonical?.id) {
      reconciled.push({ incomingId: incoming.id, canonicalId: batchCanonical.id });
      return {
        ...rawItem,
        id: batchCanonical.id,
        target: rawItem?.target
          || incoming.target
          || sanitizeText(String(incoming.label || '').replace(IDENTITY_ACTION_PREFIX_RE, ''), 180)
          || incoming.label,
        sessionId: batchCanonical.sessionId || incoming.sessionId || sessionId,
      };
    }
    if (!incoming) return rawItem;
    const exactRow = safeRows.find(row => ledgerRowKey(row) === ledgerRowKey(incoming));
    if (exactRow && actionsCompatible(exactRow, incoming)) return rawItem;
    return rawItem;
  });
  return { items: nextItems, reconciled };
}

function mergedProgressStatus(canonicalStatus, duplicateStatus) {
  const canonical = normalizeStatus(canonicalStatus, 'pending');
  const duplicate = normalizeStatus(duplicateStatus, 'pending');
  if (isTerminalLedgerStatus(canonical) && isTerminalLedgerStatus(duplicate)) {
    return canonical === duplicate ? canonical : '';
  }
  if (isTerminalLedgerStatus(canonical)) return canonical;
  if (isTerminalLedgerStatus(duplicate)) return duplicate;
  if (canonical === 'acted' || duplicate === 'acted') return 'acted';
  return 'pending';
}

function mergeCanonicalProgressFields(canonicalFields, duplicateFields) {
  const canonical = canonicalFields && typeof canonicalFields === 'object' ? canonicalFields : {};
  const duplicate = duplicateFields && typeof duplicateFields === 'object' ? duplicateFields : {};
  const out = { ...duplicate };
  for (const [key, value] of Object.entries(canonical)) {
    const collected = value !== undefined && value !== null && value !== '';
    if (collected || !Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  }
  return out;
}

function mergeCanonicalProgressRows(canonical, duplicate) {
  const status = mergedProgressStatus(canonical?.status, duplicate?.status);
  if (!status) return null;
  const ordinal = Number(canonical?.fields?.expectedOrdinal);
  const firstSeenAt = [canonical?.firstSeenAt, duplicate?.firstSeenAt]
    .map(Number).filter(Number.isFinite);
  const updatedAt = [canonical?.updatedAt, duplicate?.updatedAt]
    .map(Number).filter(Number.isFinite);
  const emptyFields = sanitizeEmptyFieldNames([
    ...(Array.isArray(canonical?.emptyFields) ? canonical.emptyFields : []),
    ...(Array.isArray(duplicate?.emptyFields) ? duplicate.emptyFields : []),
  ]);
  return {
    ...canonical,
    label: duplicate?.label || canonical?.label,
    ...(duplicate?.target ? { target: duplicate.target } : {}),
    ...(duplicate?.url ? { url: duplicate.url } : {}),
    status,
    ...(duplicate?.action ? { action: duplicate.action } : {}),
    source: duplicate?.source || canonical?.source || 'model',
    fields: {
      ...mergeCanonicalProgressFields(canonical?.fields, duplicate?.fields),
      ...(canonical?.fields?.completionRequirement === true || duplicate?.fields?.completionRequirement === true
        ? { completionRequirement: true } : {}),
      ...(canonical?.fields?.classifierTarget === true || duplicate?.fields?.classifierTarget === true
        ? { classifierTarget: true } : {}),
      ...(Number.isInteger(ordinal) && ordinal > 0 ? { expectedOrdinal: ordinal } : {}),
    },
    ...(emptyFields.length ? { emptyFields } : {}),
    attempts: Math.max(Number(canonical?.attempts || 0), Number(duplicate?.attempts || 0)),
    ...(firstSeenAt.length ? { firstSeenAt: Math.min(...firstSeenAt) } : {}),
    ...(updatedAt.length ? { updatedAt: Math.max(...updatedAt) } : {}),
  };
}

export function reconcilePersistedLedgerRows(rows = []) {
  let next = Array.isArray(rows)
    ? rows.map(row => ({ ...row, fields: row?.fields ? { ...row.fields } : undefined }))
    : [];
  const reconciled = [];
  const sessionIds = new Set(next
    .map(row => sanitizeText(row?.sessionId || row?.session_id || '', 120))
    .filter(Boolean));

  for (const sessionId of sessionIds) {
    const inSession = row => sanitizeText(row?.sessionId || row?.session_id || '', 120) === sessionId;
    const expected = next.filter(row => inSession(row) && Number.isInteger(Number(row?.fields?.expectedOrdinal)))
      .sort((a, b) => Number(a.fields.expectedOrdinal) - Number(b.fields.expectedOrdinal));
    const requirements = next.filter(row => inSession(row)
      && row?.fields?.classifierTarget === true
      && /^requirement:/i.test(String(row?.id || '')))
      .sort((a, b) => Number(String(a.id).match(/^requirement:(\d+)/i)?.[1] || 0)
        - Number(String(b.id).match(/^requirement:(\d+)/i)?.[1] || 0));
    if (expected.length && expected.length === requirements.length) {
      const targetsAreUnique = progressIdentitiesAreUnique(requirements);
      const ordinalsAreComplete = expected.every((row, index) => Number(row.fields.expectedOrdinal) === index + 1);
      const compatible = expected.every((row, index) => actionsCompatible(row, requirements[index]));
      const merged = expected.map((row, index) => mergeCanonicalProgressRows(row, requirements[index]));
      if (targetsAreUnique && ordinalsAreComplete && compatible && merged.every(Boolean)) {
        const replacementByKey = new Map(expected.map((row, index) => [ledgerRowKey(row), merged[index]]));
        const removedKeys = new Set(requirements.map(ledgerRowKey));
        next = next
          .filter(row => !removedKeys.has(ledgerRowKey(row)))
          .map(row => replacementByKey.get(ledgerRowKey(row)) || row);
        requirements.forEach((row, index) => reconciled.push({ incomingId: row.id, canonicalId: expected[index].id }));
      }
    }

    const unboundExpected = next.filter(row => inSession(row)
      && Number.isInteger(Number(row?.fields?.expectedOrdinal))
      && row?.fields?.classifierTarget !== true)
      .sort((a, b) => Number(a.fields.expectedOrdinal) - Number(b.fields.expectedOrdinal));
    const concreteRows = next.filter(row => inSession(row) && !isCanonicalProgressRow(row));
    if (unboundExpected.length && unboundExpected.length === concreteRows.length) {
      const identitiesAreUnique = progressIdentitiesAreUnique(concreteRows);
      const ordinalsAreComplete = unboundExpected.every((row, index) => Number(row.fields.expectedOrdinal) === index + 1);
      const compatible = unboundExpected.every((row, index) => actionsCompatible(row, concreteRows[index]));
      // A bare slot has no identity to agree with. With no classifier targets
      // in the session and exactly one concrete row per slot, order binds an
      // unfinished row to it, as the live path binds a runtime click. A
      // finished row is not bound by order: its outcome would reach the slot
      // without the slot's own completion evidence. Slots already bound still
      // have to agree.
      const bareSlotsBindInOrder = !sessionHasClassifierTargets(next, sessionId);
      const identityAgreement = unboundExpected.every((row, index) => identityMatchScore(row, concreteRows[index]) > 0
        || (bareSlotsBindInOrder && isBareExpectedSlot(row) && !isTerminalLedgerStatus(concreteRows[index]?.status)));
      const merged = unboundExpected.map((row, index) => {
        const mergedRow = mergeCanonicalProgressRows(row, concreteRows[index]);
        // A slot bound by order takes the target its row names, as a live
        // batch binding does, so a later batch cannot claim the slot again.
        if (mergedRow && isBareExpectedSlot(row) && !mergedRow.target && !mergedRow.url) {
          const target = sanitizeText(String(concreteRows[index]?.label || '').replace(IDENTITY_ACTION_PREFIX_RE, ''), 180)
            || sanitizeText(concreteRows[index]?.id, 180);
          if (target) mergedRow.target = target;
        }
        return mergedRow;
      });
      if (identitiesAreUnique && ordinalsAreComplete && compatible && identityAgreement && merged.every(Boolean)) {
        const replacementByKey = new Map(unboundExpected.map((row, index) => [ledgerRowKey(row), merged[index]]));
        const removedKeys = new Set(concreteRows.map(ledgerRowKey));
        next = next
          .filter(row => !removedKeys.has(ledgerRowKey(row)))
          .map(row => replacementByKey.get(ledgerRowKey(row)) || row);
        concreteRows.forEach((row, index) => reconciled.push({ incomingId: row.id, canonicalId: unboundExpected[index].id }));
      }
    }

    const canonicalRows = next.filter(row => inSession(row)
      && Number.isInteger(Number(row?.fields?.expectedOrdinal))
      && row?.fields?.classifierTarget === true);
    for (const duplicate of [...next]) {
      if (!inSession(duplicate) || isCanonicalProgressRow(duplicate)) continue;
      let bestScore = 0;
      let matches = [];
      for (const canonical of canonicalRows) {
        if (!actionsCompatible(canonical, duplicate)) continue;
        const score = identityMatchScore(canonical, duplicate);
        if (score > bestScore) {
          bestScore = score;
          matches = [canonical];
        } else if (score > 0 && score === bestScore) {
          matches.push(canonical);
        }
      }
      if (!bestScore || matches.length !== 1) continue;
      const canonical = matches[0];
      const merged = mergeCanonicalProgressRows(canonical, duplicate);
      if (!merged) continue;
      const canonicalKey = ledgerRowKey(canonical);
      const duplicateKey = ledgerRowKey(duplicate);
      next = next.filter(row => ledgerRowKey(row) !== duplicateKey)
        .map(row => ledgerRowKey(row) === canonicalKey ? merged : row);
      const canonicalIndex = canonicalRows.indexOf(canonical);
      if (canonicalIndex >= 0) canonicalRows[canonicalIndex] = merged;
      reconciled.push({ incomingId: duplicate.id, canonicalId: canonical.id });
    }
  }
  return { rows: next, changed: reconciled.length > 0, reconciled };
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
  const reconciliation = reconcileLedgerItems(next, items, { ...opts, source, now });
  const indexByKey = new Map();
  next.forEach((row, idx) => {
    const key = ledgerRowKey(row);
    if (key) indexByKey.set(key, idx);
  });

  const updated = [];
  const blockedDowngrades = [];
  for (const rawItem of reconciliation.items) {
    const incoming = normalizeLedgerItem(rawItem, { source, now, sessionId: opts.sessionId, pageScope: opts.pageScope, taskKey: opts.taskKey });
    if (!incoming) continue;
    const key = ledgerRowKey(incoming);
    const existingIdx = indexByKey.get(key);
    if (existingIdx == null) {
      if (!incoming.emptyFields?.length) delete incoming.emptyFields;
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
      ...(incoming.target ? { target: incoming.target } : {}),
      ...(incoming.url ? { url: incoming.url } : {}),
      status: keepTerminal ? existing.status : incoming.status,
      ...(incoming.action ? { action: incoming.action } : {}),
      fields: { ...(existing.fields || {}), ...(incoming.fields || {}) },
      emptyFields: mergedEmptyFieldNames(existing, incoming),
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
    if (!merged.emptyFields?.length) delete merged.emptyFields;
    if (!merged.sessionId) delete merged.sessionId;
    if (!merged.pageScope) delete merged.pageScope;
    if (!merged.taskKey) delete merged.taskKey;
    next[existingIdx] = merged;
    updated.push(merged);
  }

  return {
    rows: next,
    updated,
    counts: progressCounts(next),
    changed: updated.length > 0,
    blockedDowngrades,
    reconciled: reconciliation.reconciled,
  };
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
  const emptyFields = Array.isArray(row.emptyFields)
    ? row.emptyFields.slice(0, 8).map(name => sanitizeText(name, 60)).filter(Boolean).join(', ')
    : '';
  const reason = sanitizeText(row.reason || '', 240);
  return `- ${status}${action ? ` ${action}` : ''}: ${label}${id && id !== label ? ` [id: ${id}]` : ''}${fields ? ` (${fields})` : ''}${emptyFields ? ` [checked empty: ${emptyFields}]` : ''}${reason ? ` - ${reason}` : ''}`;
}

export function formatLedgerSummary(rows = [], opts = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return 'Progress ledger: no rows.';
  const maxRows = Number.isFinite(Number(opts.maxRows)) ? Math.max(1, Math.floor(Number(opts.maxRows))) : 18;
  const counts = progressCounts(safeRows);
  const unresolved = unresolvedLedgerRows(safeRows);
  const unresolvedKeys = new Set(unresolved.map(ledgerRowKey));
  const ordered = [
    ...unresolved,
    ...safeRows.filter(row => !unresolvedKeys.has(ledgerRowKey(row))),
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

// The labels a click names: its arguments and the clicked element's names.
export function progressClickLabels(args = {}, result = {}) {
  return [...new Set([
    args?.text,
    args?.name,
    args?.label,
    result?.requestedText,
    result?.beforeText,
    result?.beforeName,
    result?.name,
    result?.text,
  ].map(v => sanitizeText(v, 220)).filter(Boolean))];
}

// The ledger row a clicked label names for an action: among the rows for that
// action (or for none), the one whose target, label or id appears in the label
// longest, or none when two rows tie.
function ledgerRowNamedIn(label, rows = [], action = '') {
  let text = sanitizeText(label, 220);
  try { text = text.normalize('NFKC'); } catch {}
  text = text.toLocaleLowerCase();
  let best = null, bestLength = 0, tie = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const rowAction = sanitizeText(row?.action, 80).toLowerCase();
    if (rowAction && rowAction !== action) continue;
    for (const value of [row?.target, row?.label, row?.id]) {
      let name = sanitizeText(value, 180).replace(/^@/, '');
      try { name = name.normalize('NFKC'); } catch {}
      name = name.toLocaleLowerCase();
      if (name.length < 2 || !text.includes(name)) continue;
      if (name.length > bestLength) { best = row; bestLength = name.length; tie = false; }
      else if (name.length === bestLength && best && best.id !== row.id) tie = true;
    }
  }
  return tie ? null : best;
}

// A click on the ledger: a model read the clicked label, in any language, as
// doing one of the run's allowed actions to an item (`opts.readAction(label,
// action)` gives "did"), and the item is the ledger row the label names
// (`opts.rows`) or the page the clicked link opens.
export function detectProgressAction(toolName, args = {}, result = {}, opts = {}) {
  if (!CLICK_ACTION_TOOLS.has(toolName)) return null;
  if (!result || result.success === false || result.error || result.noProgress) return null;
  const readAction = typeof opts.readAction === 'function' ? opts.readAction : () => null;
  const allowedActions = [...new Set((Array.isArray(opts.allowedActions) ? opts.allowedActions : [])
    .map(value => sanitizeText(value, 80).toLowerCase())
    .filter(value => Object.hasOwn(PROGRESS_CLICK_ACTION_MEANINGS, value)))];
  if (!allowedActions.length) return null;
  const href = sanitizeText(result.href || result.url || '', 500);

  for (const label of progressClickLabels(args, result)) {
    const action = allowedActions.find(candidate => readAction(label, candidate) === 'did');
    if (!action) continue;
    const row = ledgerRowNamedIn(label, opts.rows, action);
    const target = row ? sanitizeText(row.target || row.label || row.id, 180) : targetFromHref(href);
    const id = row?.id ? sanitizeText(row.id, 180) : stableIdFor(action, target, href);
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
