/**
 * Consequential-action gate for the WebBrain agent (Act mode).
 *
 * KEEP THIS FILE PURE JS — no chrome.* / browser.* / DOM imports — so
 * test/run.js can load it under Node (same convention as markdown-link.js).
 *
 * Threat model: the agent acts inside the user's authenticated session with
 * full click/type/navigate/submit power. A malicious page can prompt-inject
 * the model (see the <untrusted_page_content> wrapping in agent.js) into
 * taking a HARD-TO-REVERSE action the user never asked for — sending an
 * email, deleting data, transferring money, or navigating-and-pasting to an
 * attacker origin. System-prompt rules reduce but cannot eliminate this:
 * a clever injection can talk the model past a prompt instruction.
 *
 * Defense: classify each tool call. If it is consequential AND the user did
 * not name it in their own (trusted) instruction, the agent pauses for an
 * explicit user confirmation before executing. Actions the user explicitly
 * requested pass through with no prompt ("skip if the user already named it").
 *
 * This module is the pure decision core: it does not pause or execute, it
 * only classifies and answers "did the user authorize this?". The agent wires
 * the actual confirmation pause around these answers.
 */

import { isTopSite } from './top-sites.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Visible button/link labels that denote a hard-to-reverse action. Generic
// labels (Submit, Confirm, OK, Continue, Save) are deliberately EXCLUDED —
// they fire constantly in legitimate flows the user already asked for, so
// gating them would drown the user in prompts. We only gate specific,
// high-consequence verbs.
const DESTRUCTIVE_LABEL_RE =
  /\b(send|sending|post|posting|publish|tweet|retweet|delete|deleting|remove|removing|discard|transfer|wire|pay|paying|buy|purchase|order|checkout|withdraw|deactivate|unsubscribe|donate|bid)\b/i;

// Synonym groups: which words in the user's instruction count as "the user
// asked for THIS verb". e.g. if the button says "Publish" and the user said
// "post this", that's authorized.
const VERB_SYNONYMS = {
  send: ['send', 'email', 'e-mail', 'message', 'dm', 'reply'],
  post: ['post', 'publish', 'share', 'tweet', 'comment'],
  publish: ['publish', 'post', 'share', 'release'],
  tweet: ['tweet', 'post', 'publish', 'share'],
  retweet: ['retweet', 'repost', 'share'],
  delete: ['delete', 'remove', 'clear', 'clean', 'wipe', 'trash', 'erase'],
  remove: ['remove', 'delete', 'clear', 'clean', 'unfollow', 'detach'],
  discard: ['discard', 'delete', 'cancel'],
  transfer: ['transfer', 'send', 'move', 'pay', 'wire'],
  wire: ['wire', 'transfer', 'send', 'pay'],
  pay: ['pay', 'transfer', 'send money', 'checkout', 'purchase'],
  buy: ['buy', 'purchase', 'order', 'checkout', 'get'],
  purchase: ['purchase', 'buy', 'order', 'checkout'],
  order: ['order', 'buy', 'purchase', 'checkout'],
  checkout: ['checkout', 'buy', 'purchase', 'pay', 'order'],
  withdraw: ['withdraw', 'cash out'],
  deactivate: ['deactivate', 'disable', 'close', 'delete'],
  unsubscribe: ['unsubscribe', 'cancel', 'opt out', 'opt-out'],
  donate: ['donate', 'give', 'contribute'],
  bid: ['bid', 'offer'],
};

function hostnameOf(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    const m = url.match(/^[a-z][a-z0-9+.\-]*:\/\/([^/?#]+)/i);
    return m ? m[1].replace(/^www\./, '').toLowerCase() : '';
  }
}

function looksLikeMutationJs(code) {
  if (typeof code !== 'string' || !code) return false;
  if (/fetch\s*\(/.test(code) && /method\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i.test(code)) return true;
  if (/\.open\s*\(\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i.test(code)) return true;
  if (/navigator\s*\.\s*sendBeacon\s*\(/.test(code)) return true;
  if (/\bXMLHttpRequest\b/.test(code) && /(POST|PUT|PATCH|DELETE)/.test(code)) return true;
  return false;
}

/**
 * Classify a tool call. Returns null for benign/read-only calls, or a
 * { kind, target, detail, verb? } descriptor for consequential ones.
 *   kind 'navigate' — going to some origin (gated only if user didn't name it)
 *   kind 'mutation' — a write-method network call (POST/PUT/PATCH/DELETE)
 *   kind 'submit'   — clicking a hard-to-reverse action button by visible text
 */
export function classifyConsequentialAction(name, args) {
  args = args || {};
  switch (name) {
    case 'navigate':
    case 'new_tab': {
      const host = hostnameOf(args.url);
      if (!host) return null;
      return { kind: 'navigate', target: host, detail: String(args.url) };
    }
    case 'fetch_url': {
      const method = String(args.method || 'GET').toUpperCase();
      if (!MUTATION_METHODS.has(method)) return null;
      return { kind: 'mutation', target: hostnameOf(args.url) || String(args.url || ''), detail: `${method} ${args.url || ''}` };
    }
    case 'execute_js': {
      const code = typeof args.code === 'string' ? args.code
        : (typeof args.script === 'string' ? args.script : '');
      if (!looksLikeMutationJs(code)) return null;
      return { kind: 'mutation', target: 'in-page script', detail: code.slice(0, 200) };
    }
    case 'click':
    case 'click_ax': {
      const label = typeof args.text === 'string' ? args.text
        : (typeof args.label === 'string' ? args.label : '');
      const m = label.match(DESTRUCTIVE_LABEL_RE);
      if (!m) return null;
      return { kind: 'submit', target: label.trim(), detail: label.trim(), verb: m[1].toLowerCase() };
    }
    default:
      return null;
  }
}

/**
 * Did the user's own (trusted) instruction text authorize this classified
 * action? userText is the concatenation of the user's chat turns for the
 * current run — NEVER page content. Returns true → no confirmation needed.
 *
 * Note: API mutations are intentionally NOT authorizable by free text here;
 * the agent grants them only via the explicit /allow-api override.
 */
export function isUserAuthorized(userText, classification) {
  if (!classification) return true;
  const text = String(userText || '').toLowerCase();
  if (!text) return false;

  switch (classification.kind) {
    case 'navigate': {
      const host = String(classification.target || '').toLowerCase();
      if (!host) return false;
      if (text.includes(host)) return true;
      // Match on the registrable label too: user says "go to github",
      // host is github.com.
      const parts = host.split('.').filter(Boolean);
      const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      return !!label && label.length >= 3 && new RegExp(`\\b${escapeRe(label)}\\b`).test(text);
    }
    case 'submit': {
      const verb = String(classification.verb || '').toLowerCase();
      const syns = VERB_SYNONYMS[verb] || [verb];
      return syns.some(s => s && text.includes(s));
    }
    case 'mutation':
      // Free text cannot authorize an API write — only the /allow-api flag,
      // which the agent checks separately.
      return false;
    default:
      return false;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stable key for an approved action, so the agent doesn't re-prompt for the
 * identical action within a run.
 */
export function actionKey(classification) {
  if (!classification) return '';
  return `${classification.kind}:${(classification.target || '').toLowerCase()}`;
}

/**
 * The single decision the agent asks: must we pause for user confirmation
 * before running this tool call? Returns false (run it) when:
 *   - the call is benign (not classified consequential),
 *   - it's a navigation to a mainstream top-site domain (not a plausible
 *     exfil endpoint) — the NARROW, navigation-only allowlist relaxation,
 *   - it's an API mutation and the user set the /allow-api override,
 *   - the user's own instruction named the action.
 * Otherwise returns true → the agent pauses for an explicit Yes/No.
 *
 * The top-site skip applies to NAVIGATION ONLY by design. Submit/delete/pay
 * and API mutations are never waived by domain reputation — those are exactly
 * the high-value injection targets on trusted sites.
 */
export function shouldConfirmAction(classification, { userText = '', apiAllowed = false } = {}) {
  if (!classification) return false;
  if (classification.kind === 'navigate' && isTopSite(classification.target)) return false;
  if (classification.kind === 'mutation' && apiAllowed) return false;
  if (isUserAuthorized(userText, classification)) return false;
  return true;
}
