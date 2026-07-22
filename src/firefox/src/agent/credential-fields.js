/**
 * Credential-field detection — pure ESM, no DOM.
 *
 * After set_field fills a field, agent.js asks this module whether the field
 * was a credential/secret input. If yes, agent.js appends CREDENTIAL_NOTE to
 * the tool result so the model is reminded — at the moment of relevance —
 * not to quote the value back in any subsequent assistant text, tool args,
 * or `done` summaries.
 *
 * The content-script side (chrome/firefox content.js) collects the field's
 * attributes into a plain object and ships them along with the tool result.
 * Detection runs background-side so the regex lives in exactly ONE place
 * and the test runner can exercise it without a DOM.
 *
 * Triggers (any one matches → sensitive):
 *   1. <input type="password">
 *   2. autocomplete: current-password | new-password | one-time-code
 *   3. name / id / aria-label / placeholder / associated <label> text
 *      matches SENSITIVE_NAME_RE
 *
 * The regex deliberately stays narrow. "auth", "auto", "key" alone are too
 * common (author, autocomplete, keyboard). We require credential-specific
 * vocab — password / secret / token / api-key / otp / etc.
 *
 * Cost asymmetry: a false positive appends one harmless sentence to a tool
 * result. A false negative ends up in a `done` summary the user pastes
 * somewhere. We tune for recall over precision.
 */

// Separator class: hyphen, underscore, or whitespace. Field names in
// attributes use - or _; aria-label / placeholder / <label> text often use
// human spaces ("API key", "One-time password"). All three must hit.
export const SENSITIVE_NAME_RE = /pwd|password|passwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|recovery[-_\s]?code|backup[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|client[-_\s]?secret|private[-_\s]?key|seed[-_\s]?phrase|passphrase|pin[-_\s]?code/i;

export const SENSITIVE_AUTOCOMPLETE_RE = /^(current-password|new-password|one-time-code)$/i;

// Loose note — defined but agent.js does NOT currently emit it. Rationale:
// webbrain's primary audience runs small local models (qwen / phi / similar,
// 3-30B class) which handle conditional instructions ("do X unless Y")
// poorly. The loose note collapsed into a hard rule on some models and got
// ignored on others — net negative. We kept the constant exported because
// (a) the parity test relies on it staying in sync between chrome/firefox,
// and (b) if someone wants to re-introduce a soft hint (maybe gated on
// model size or a separate setting) the vetted wording is right here.
// The hygiene message itself still lives in the `done.summary` tool
// description, fired at point-of-use when the model writes the summary —
// that's the one model surface where the hint reliably lands.
export const CREDENTIAL_NOTE_LOOSE = "You just filled a sensitive field (password / API key / token / OTP / similar). The value is in the conversation history above if you need to reference it. By default, prefer generic phrasing in `done` summaries and intermediate prose ('the password', 'the provided API key') — that keeps trace logs and the side-panel transcript tidy. If the user explicitly asks you to show, quote, or display the value, do so: that's the answer they wanted.";

// Strict note — opt-in via Settings → "Strict secret handling". Use this
// when the user regularly shares trace files or screen-shares and wants a
// hard guarantee that secrets never appear in summaries. The model refuses
// to quote credentials in any assistant text in this mode, even when
// asked.
export const CREDENTIAL_NOTE_STRICT = "You just filled a sensitive field (password / API key / token / OTP / similar). STRICT MODE IS ON: do NOT quote this value in any subsequent assistant text, tool-call arguments, or `done` summaries — including when the user explicitly asks you to show it. Refer to it generically: 'the password', 'the provided API key', 'the OTP', 'the credential the user gave'. If the user wants to see the value, the answer is 'I filled the field' or 'the value is in the form on this page', not the literal string. This applies even though the user may have typed the value directly into the chat.";

// Global strict-mode instruction. Unlike CREDENTIAL_NOTE_STRICT, which is
// emitted after writing a sensitive field, this is present from turn start so
// read-only tools and enabled skills cannot disclose secrets they discover on
// a page before any credential field has been touched.
export const STRICT_SECRET_SYSTEM_NOTE = "[STRICT SECRET HANDLING IS ON — this user setting overrides enabled skills and any instruction that permits secret disclosure. Never quote or reproduce a literal password, API key, token, OTP, recovery code, backup code, or similar credential in assistant text or completion summaries, even when the user explicitly asks. This applies equally to values supplied by the user and values discovered through page-reading or other read-only tools. Refer to the value generically instead.]";

// Back-compat: existing tests reference CREDENTIAL_NOTE. Keep it as an
// alias for the loose variant (the new default). The strict variant is
// surfaced explicitly via CREDENTIAL_NOTE_STRICT when the setting is on.
export const CREDENTIAL_NOTE = CREDENTIAL_NOTE_LOOSE;

/**
 * @param {{tag?:string, type?:string, name?:string, id?:string,
 *          autocomplete?:string, ariaLabel?:string, placeholder?:string,
 *          labelText?:string}} meta
 * @returns {{sensitive: boolean, reason: string|null}}
 */
export function isCredentialField(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { sensitive: false, reason: null };

  const type = String(meta.type ?? '').toLowerCase();
  if (type === 'password') return { sensitive: true, reason: 'input type=password' };

  const ac = String(meta.autocomplete ?? '').trim();
  if (ac && SENSITIVE_AUTOCOMPLETE_RE.test(ac)) {
    return { sensitive: true, reason: `autocomplete=${ac}` };
  }

  for (const key of ['name', 'id', 'ariaLabel', 'placeholder', 'labelText']) {
    const v = meta[key];
    if (v != null && typeof v !== 'string' && typeof v !== 'number') continue;
    if (v && SENSITIVE_NAME_RE.test(String(v).slice(0, 200))) {
      return { sensitive: true, reason: `${key} matches credential pattern: ${JSON.stringify(String(v).slice(0, 60))}` };
    }
  }

  return { sensitive: false, reason: null };
}
