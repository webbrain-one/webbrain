// The card WebBrain shows when one of its own guards cannot verify a
// consequential step (guard-policy.js, onCannotDecide 'ask'): a commit,
// publish or submit whose content or effect could not be confirmed. Instead
// of refusing the step, WebBrain shows the user what the page holds now and
// asks "go ahead?" with two fixed answers, 'once' and 'deny'. The sign-in
// password guard (credential-not-provided) asks on the same card whether to
// type text the user never gave ('type'), showing it masked, or not at all
// with strict secret handling.
//
// The card's content is page text, so it is untrusted: it is bounded here,
// the side panel renders it with textContent only, and it is never sent to
// the model. These helpers normalize the card for the agent, for scheduler
// persistence and for a side panel that restores the card after reopening.
// Shared verbatim by the Chrome and Firefox builds.

export const UNVERIFIED_STEP_PROMPT_KIND = 'unverifiedStepConfirmation';
// What the step does; each has a localized question in the side panel.
export const UNVERIFIED_STEP_ACTIONS = Object.freeze(['commit', 'submit', 'publish', 'click', 'type']);
// Why WebBrain could not verify it; each has a localized sentence.
export const UNVERIFIED_STEP_REASONS = Object.freeze([
  'editor_unverified', 'draft_unverified', 'draft_unobserved',
  'submit_unclear', 'target_unresolved', 'repeat_unverified', 'step_unverified',
  'credential_not_provided',
]);
// Where the shown text comes from, or how it is shown; each has a localized
// label. 'masked' is text WebBrain would type, all but its first character
// hidden; 'hidden' shows no text (strict secret handling).
export const UNVERIFIED_STEP_CONTENT_LABELS = Object.freeze(['editor', 'composer', 'page', 'masked', 'hidden']);
export const UNVERIFIED_STEP_CONTENT_LIMIT = 1500;

/**
 * Plain text for the card: line breaks normalized, at most `limit`
 * characters, cut with an ellipsis. Never splits a surrogate pair, and
 * applying it twice changes nothing.
 */
export function clipUnverifiedStepContent(value, limit = UNVERIFIED_STEP_CONTENT_LIMIT) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * The display fields of an unverified-step card, bounded and limited to the
 * known values. `hard` cards (a hard-class guard) never time out.
 */
export function normalizeUnverifiedStepConfirmation(value) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clip = (item, limit) => String(item ?? '').slice(0, limit);
  return {
    guardId: clip(obj.guardId, 80),
    hard: obj.hard === true,
    action: UNVERIFIED_STEP_ACTIONS.includes(obj.action) ? obj.action : 'submit',
    host: clip(obj.host, 300),
    reason: UNVERIFIED_STEP_REASONS.includes(obj.reason) ? obj.reason : 'step_unverified',
    content: obj.contentLabel === 'hidden' ? '' : clipUnverifiedStepContent(obj.content),
    contentLabel: UNVERIFIED_STEP_CONTENT_LABELS.includes(obj.contentLabel) ? obj.contentLabel : 'page',
  };
}
