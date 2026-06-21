import { isTerminalLedgerStatus } from '../progress-ledger.js';
import { isProgressActionAllowed } from '../progress-intent.js';

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

function rowAction(row) {
  return sanitizeText(row?.action, 80).toLowerCase();
}

function followItemId(username, existing) {
  return existing && rowAction(existing) && rowAction(existing) !== 'follow'
    ? `follow:${usernameKey(username) || sanitizeText(username, 80)}`
    : username;
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
    const state = match[1].toLowerCase() === 'follow' ? 'not_followed' : 'already_followed';
    buttons.push({
      site: 'github',
      kind: 'github_stargazer_follow_button',
      action: 'follow',
      id: username,
      label: username,
      state,
      username,
      refId: match[3],
      url: `/${username}`,
    });
  }
  return buttons;
}

export function buildGithubStargazerProgressCandidates(pageContent = '') {
  return parseGithubStargazerFollowButtons(pageContent);
}

export function buildGithubStargazerProgressItems(rows = [], pageContent = '', opts = {}) {
  const buttons = Array.isArray(pageContent) ? pageContent : buildGithubStargazerProgressCandidates(pageContent);
  const session = opts.session || null;
  const followAllowed = isProgressActionAllowed(session, 'follow');
  const excluded = new Set((Array.isArray(opts.excludedUsernames) ? opts.excludedUsernames : [])
    .map(usernameKey)
    .filter(Boolean));
  const existingByKey = new Map();
  const existingFollowByKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const keys = [
      rowKey(row),
      usernameKey(row?.label),
      usernameKey(row?.target),
    ].filter(Boolean);
    for (const key of keys) {
      if (!existingByKey.has(key)) existingByKey.set(key, row);
      if (rowAction(row) === 'follow' && !existingFollowByKey.has(key)) {
        existingFollowByKey.set(key, row);
      }
    }
  }

  const items = [];
  const stats = {
    observedButtons: buttons.length,
    addedPending: 0,
    alreadyFollowedSkipped: 0,
    excludedSkipped: 0,
  };
  if (!followAllowed) {
    return { items, candidates: buttons, buttons, stats };
  }

  for (const button of buttons) {
    const key = usernameKey(button.username);
    if (!key) continue;
    const existing = existingByKey.get(key);
    const existingFollow = existingFollowByKey.get(key);
    if (excluded.has(key)) {
      if (!existingFollow || !isTerminalLedgerStatus(existingFollow.status)) {
        items.push({
          id: existingFollow?.id || followItemId(button.username, existing),
          label: button.username,
          action: 'follow',
          status: 'skipped',
          reason: 'excluded by user request',
          fields: { followState: button.state, refId: button.refId },
          ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
          ...(session?.pageScope ? { pageScope: session.pageScope } : {}),
        });
      }
      stats.excludedSkipped += 1;
      continue;
    }

    if (button.state === 'not_followed') {
      if (existingFollow && isTerminalLedgerStatus(existingFollow.status)) continue;
      items.push({
        id: existingFollow?.id || followItemId(button.username, existing),
        label: button.username,
        action: 'follow',
        status: existingFollow?.status === 'acted' ? 'acted' : 'pending',
        url: `/${button.username}`,
        fields: { followState: 'not_followed', refId: button.refId },
        ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
        ...(session?.pageScope ? { pageScope: session.pageScope } : {}),
      });
      if (!existingFollow) stats.addedPending += 1;
      continue;
    }

    const existingFollowState = sanitizeText(existingFollow?.fields?.followState, 80).toLowerCase();
    if (
      existingFollow
      && normalizeStatus(existingFollow.status, 'pending') === 'pending'
      && existingFollowState !== 'not_followed'
    ) {
      items.push({
        id: existingFollow.id || button.username,
        label: existingFollow.label || button.username,
        action: 'follow',
        status: 'skipped',
        reason: 'already followed before this task',
        fields: { followState: 'already_followed', refId: button.refId },
        ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
        ...(session?.pageScope ? { pageScope: session.pageScope } : {}),
      });
      stats.alreadyFollowedSkipped += 1;
    }
  }

  return { items, candidates: buttons, buttons, stats };
}
