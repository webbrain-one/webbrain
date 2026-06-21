import { isTerminalLedgerStatus } from '../progress-ledger.js';

const VALID_STATUSES = new Set(['pending', 'acted', 'processed', 'skipped', 'failed']);

function sanitizeText(value, max = 240) {
  if (value == null) return '';
  return String(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeStatus(value, fallback = 'pending') {
  const status = sanitizeText(value, 40).toLowerCase();
  return VALID_STATUSES.has(status) ? status : fallback;
}

function cleanGithubUsername(value) {
  const text = sanitizeText(value, 120)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^\s*@/, '')
    .trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(text) ? text : '';
}

function usernameKey(value) {
  return cleanGithubUsername(value).toLowerCase();
}

function rowKey(row) {
  return sanitizeText(row?.id, 180).toLowerCase();
}

export function parseGithubStargazerFollowButtons(pageContent = '') {
  const text = String(pageContent || '');
  const buttons = [];
  const seen = new Set();
  const re = /\bbutton\s+"(Follow|Unfollow)\s+([^"]+)"\s+\[(ref_\d+)\]/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const username = cleanGithubUsername(match[2] || '');
    if (!username) continue;
    const key = usernameKey(username);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    buttons.push({
      state: match[1].toLowerCase() === 'follow' ? 'not_followed' : 'already_followed',
      username,
      refId: match[3],
    });
  }
  return buttons;
}

export function buildGithubStargazerProgressItems(rows = [], pageContent = '', opts = {}) {
  const buttons = parseGithubStargazerFollowButtons(pageContent);
  const excluded = new Set((Array.isArray(opts.excludedUsernames) ? opts.excludedUsernames : [])
    .map(usernameKey)
    .filter(Boolean));
  const existingByKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const keys = [
      rowKey(row),
      usernameKey(row?.label),
      usernameKey(row?.target),
    ].filter(Boolean);
    for (const key of keys) {
      if (!existingByKey.has(key)) existingByKey.set(key, row);
    }
  }

  const items = [];
  const stats = {
    observedButtons: buttons.length,
    addedPending: 0,
    alreadyFollowedSkipped: 0,
    excludedSkipped: 0,
  };

  for (const button of buttons) {
    const key = usernameKey(button.username);
    if (!key) continue;
    const existing = existingByKey.get(key);
    if (excluded.has(key)) {
      if (!existing || !isTerminalLedgerStatus(existing.status)) {
        items.push({
          id: button.username,
          label: button.username,
          action: 'follow',
          status: 'skipped',
          reason: 'excluded by user request',
          fields: { followState: button.state, refId: button.refId },
        });
      }
      stats.excludedSkipped += 1;
      continue;
    }

    if (button.state === 'not_followed') {
      if (existing && isTerminalLedgerStatus(existing.status)) continue;
      items.push({
        id: button.username,
        label: button.username,
        action: 'follow',
        status: existing?.status === 'acted' ? 'acted' : 'pending',
        url: `/${button.username}`,
        fields: { followState: 'not_followed', refId: button.refId },
      });
      if (!existing) stats.addedPending += 1;
      continue;
    }

    const existingFollowState = sanitizeText(existing?.fields?.followState, 80).toLowerCase();
    if (
      existing?.action === 'follow'
      && normalizeStatus(existing.status, 'pending') === 'pending'
      && existingFollowState !== 'not_followed'
    ) {
      items.push({
        id: existing.id || button.username,
        label: existing.label || button.username,
        action: 'follow',
        status: 'skipped',
        reason: 'already followed before this task',
        fields: { followState: 'already_followed', refId: button.refId },
      });
      stats.alreadyFollowedSkipped += 1;
    }
  }

  return { items, buttons, stats };
}
