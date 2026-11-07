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
export const SENSITIVE_NAME_RE = /pwd|password|passwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|verification[-_\s]?code|confirmation[-_\s]?code|security[-_\s]?code|one[-_\s]?time[-_\s]?code|email[-_\s]?code|recovery[-_\s]?code|backup[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|client[-_\s]?secret|private[-_\s]?key|seed[-_\s]?phrase|passphrase|pin[-_\s]?code/i;

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

export const REDACTED_CREDENTIAL = '[redacted credential]';

/**
 * Replace every exact occurrence of the known credential values in `text`.
 * Strict secret mode uses it on notes the agent pins and persists (scratchpad,
 * progress ledger), where an instruction alone did not keep credentials out.
 * A URL-encoded copy (a value written into a link) counts as an occurrence.
 * Every occurrence of every value, overlapping ones included, is found first
 * and their union replaced, one marker per merged stretch: replacing one
 * match at a time left the rest of an overlapping value behind ("abc123" and
 * "123xyz" known, "abc123xyz" became "[redacted credential]xyz"). The
 * inserted marker is never matched again.
 *
 * Short values are everywhere in ordinary text: a value of digits only under
 * 6 digits (a 4-digit PIN such as 2024) is never struck, as dates, ids and
 * file names hold it ("report-2024-10.pdf downloadId=12024"); any other value
 * under 8 characters, and a longer value of digits only (a one-time code), is
 * struck only as a whole token, with no letter or digit right before or after
 * it. Longer values are struck wherever they occur.
 *
 * @param {string} text
 * @param {string[]} values
 * @returns {string} the text, unchanged when nothing matched
 */
export function redactCredentialValues(text, values = []) {
  if (typeof text !== 'string' || !text) return text;
  // Each variant, and whether it has to stand as a whole token.
  const variants = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !value) continue;
    const digitsOnly = /^\p{Nd}+$/u.test(value);
    if (digitsOnly && value.length < 6) continue;
    const wholeToken = digitsOnly || value.length < 8;
    const add = variant => variants.set(variant, wholeToken && variants.get(variant) !== false);
    add(value);
    try {
      const encoded = encodeURIComponent(value);
      add(encoded);
      add(encoded.replace(/%20/g, '+'));
    } catch { /* a lone surrogate cannot be encoded; the raw value still is */ }
  }
  const tokenChar = /[\p{L}\p{N}]/u;
  const spans = [];
  for (const [variant, wholeToken] of variants) {
    for (let at = text.indexOf(variant); at >= 0; at = text.indexOf(variant, at + 1)) {
      const to = at + variant.length;
      if (wholeToken && ((at > 0 && tokenChar.test(text[at - 1])) || (to < text.length && tokenChar.test(text[to])))) continue;
      spans.push([at, to]);
    }
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  let [start, end] = spans[0];
  for (const [from, to] of spans.slice(1)) {
    if (from <= end) {
      end = Math.max(end, to);
      continue;
    }
    out += text.slice(cursor, start) + REDACTED_CREDENTIAL;
    cursor = end;
    [start, end] = [from, to];
  }
  return out + text.slice(cursor, start) + REDACTED_CREDENTIAL + text.slice(end);
}

// The words of a ledger field name for isCredentialKeyName.
const CREDENTIAL_KEY_NOUNS = new Set(['password', 'passwd', 'pwd', 'passphrase', 'passcode', 'secret', 'otp', 'totp',
  'cvv', 'cvc', 'credential', 'credentials']);
const CREDENTIAL_KEY_JOINED = new Set(['apikey', 'accesstoken', 'authtoken', 'refreshtoken', 'secretkey', 'privatekey',
  'clientsecret', 'seedphrase']);
const CREDENTIAL_KEY_QUALIFIED = new Map([
  ['token', new Set(['access', 'auth', 'authentication', 'authorization', 'refresh', 'bearer', 'api', 'session', 'id',
    'csrf', 'xsrf', 'oauth', 'jwt'])],
  ['code', new Set(['verification', 'confirmation', 'security', 'recovery', 'backup', 'email', 'sms', 'access', 'auth',
    'login', 'otp', 'totp', '2fa', 'mfa', 'twofactor', 'pin', 'onetime'])],
  ['key', new Set(['api', 'private', 'secret', 'access', 'encryption', 'signing', 'ssh'])],
  ['pin', new Set(['card', 'atm', 'debit', 'credit', 'bank', 'sim', 'account', 'login', 'security', 'wallet', 'new', 'old',
    'current', 'confirm'])],
  ['phrase', new Set(['seed', 'pass', 'recovery'])],
  ['number', new Set(['pin'])],
]);
const CREDENTIAL_KEY_REPEATS = new Set(['confirmation', 'confirm', 'repeat', 'again', 'retype']);

/**
 * Whether a field name the model gave a progress-ledger value says the value
 * is a credential. SENSITIVE_NAME_RE finds credential vocabulary anywhere in
 * a form field's attributes, which over a ledger key also hits `tokens`,
 * `token_count`, `footprint` (otp), `screenshotPath`, `lotPrice` and
 * `secretary`; the key rule prefers precision, since a value filled into a
 * detected field is struck by value anyway. The name is split into words (at
 * non-alphanumerics, camelCase and letter-digit changes; a trailing number is
 * dropped, as `password2` is a second password), and the LAST word says what
 * the value is:
 * - a credential noun (`password`, `new_password`, `passcode`, `otp`,
 *   `cvv`, `client_secret`), or a joined term (`apikey`, `accesstoken`);
 * - `token`, `code`, `key`, `pin`, `phrase` or `number` only after a word that
 *   makes it one (`access_token`, `sms_code`, `api_key`, `card_pin`,
 *   `seed_phrase`, `pin_number`), and `pin` also as the whole name: a
 *   `next_page_token` is a cursor, a `zip_code` or `pincode` a postal code,
 *   a `map_pin` a marker;
 * - a word that repeats a credential noun (`password_confirmation`).
 * So `token_count` is a count, `password_hint` a hint, `mfa` and
 * `enable_2fa` settings, while `2fa_code` is a code.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isCredentialKeyName(name) {
  const words = String(name ?? '').slice(0, 120)
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  while (words.length && /^\p{N}+$/u.test(words[words.length - 1])) words.pop();
  if (!words.length) return false;
  const last = words[words.length - 1];
  // The word before the last, or the two before it written together
  // (`one_time_code`, `2fa_code`).
  const prior = words.length > 1 ? words[words.length - 2] : '';
  const priorTwo = words.slice(-3, -1).join('');
  if (CREDENTIAL_KEY_NOUNS.has(last) || CREDENTIAL_KEY_JOINED.has(last)) return true;
  if (last === 'pin' && words.length === 1) return true;
  const qualifiers = CREDENTIAL_KEY_QUALIFIED.get(last);
  if (qualifiers && (qualifiers.has(prior) || (words.length > 2 && qualifiers.has(priorTwo)))) return true;
  return CREDENTIAL_KEY_REPEATS.has(last) && (CREDENTIAL_KEY_NOUNS.has(prior) || prior === 'pin');
}

// The JSON object a stored tool result starts with. The run loop appends its
// own notes after a result it does not wrap as page content ("\n[TRUSTED
// CAPTCHA GATE: …]", a loop nudge), so the whole message is not JSON. A
// result cut short when stored has no complete object and gives null.
function leadingJsonObject(text) {
  const source = String(text ?? '').trimStart();
  if (!source.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(0, index + 1)); } catch { return null; }
    }
  }
  return null;
}

// The tools that type a value into a page field.
const FILL_TOOLS = new Set(['set_field', 'type_ax', 'type_text', 'iframe_type']);

/**
 * The value a fill tool call typed into a credential field, trimmed, or null.
 * The field was a credential field when its result carries the annotator's
 * `sensitiveField` marker (set_field, type_ax), or when the field metadata
 * the result reports passes the annotator's own isCredentialField check:
 * type_text and iframe_type results are not annotated, but report the field
 * they typed into (`fieldMeta`, or the `focusedField` of Chrome's typing into
 * the focused element). A result without field metadata (Chrome's selector
 * typing, the all-frames iframe fallback) shows no credential field. A live
 * result and the copy saved in a conversation give the same answer. Values
 * under 4 characters are too common in ordinary text to redact.
 *
 * @param {string} toolName
 * @param {object} args the tool call's arguments
 * @param {object} result the tool result
 * @returns {string|null}
 */
export function filledCredentialValue(toolName, args, result) {
  if (!FILL_TOOLS.has(toolName) || !result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.sensitiveField !== true && !isCredentialField(result.fieldMeta).sensitive
      && !isCredentialField(result.focusedField).sensitive) return null;
  const value = args?.text ?? args?.value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length >= 4 && text.length <= 10_000 ? text : null;
}

/**
 * The credential values the fill calls of a saved conversation typed, oldest
 * first (filledCredentialValue of each call and its result). The agent keeps
 * known values in memory only, so a conversation restored after its worker
 * stopped rebuilds them from its own history, the tool calls and results it
 * already holds, instead of keeping secrets anywhere new. A result pairs with
 * a call of the assistant turn just before it, as providers pair them, and is
 * read from the JSON object its message starts with, before any note the run
 * loop appended.
 *
 * @param {object[]} messages the conversation
 * @param {(content: string) => string} unwrap strips the agent's
 *   untrusted-content wrapper from a tool result
 * @returns {string[]}
 */
export function filledCredentialValuesFromHistory(messages, unwrap = content => content) {
  return fillCallsFromHistory(messages, unwrap)
    .map(({ name, args, result }) => filledCredentialValue(name, args, result))
    .filter(Boolean);
}

/**
 * The fill tool calls of a saved conversation with their results, oldest
 * first: each call's tool name and arguments, and the result object its tool
 * message starts with (null for a result cut short when stored). A result
 * pairs with a call of the assistant turn just before it, as providers pair
 * them, and is read from the JSON object its message starts with, before any
 * note the run loop appended.
 *
 * @param {object[]} messages the conversation
 * @param {(content: string) => string} unwrap strips the agent's
 *   untrusted-content wrapper from a tool result
 * @returns {{name: string, args: object|null, result: object|null}[]}
 */
export function fillCallsFromHistory(messages, unwrap = content => content) {
  return toolCallsFromHistory(messages, FILL_TOOLS, unwrap).map(({ name, args, result }) => ({ name, args, result }));
}

/**
 * The calls of the named tools in a saved conversation with their results,
 * oldest first, paired as fillCallsFromHistory pairs them. `content` is the
 * unwrapped text of the tool message, notes the run loop appended included.
 *
 * @param {object[]} messages the conversation
 * @param {Iterable<string>} toolNames
 * @param {(content: string) => string} unwrap
 * @returns {{name: string, args: object|null, result: object|null, content: string}[]}
 */
export function toolCallsFromHistory(messages, toolNames, unwrap = content => content) {
  const names = toolNames instanceof Set ? toolNames : new Set(toolNames);
  const parse = value => {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value ?? '')); } catch { return null; }
  };
  const parseResult = value => (value && typeof value === 'object' ? value : leadingJsonObject(value));
  const found = [];
  let calls = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'tool') {
      calls = new Map();
      for (const call of message?.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (typeof call?.id === 'string' && names.has(call.function?.name)) calls.set(call.id, call.function);
      }
      continue;
    }
    const call = calls.get(message.tool_call_id);
    if (!call) continue;
    calls.delete(message.tool_call_id);
    const content = unwrap(message.content);
    found.push({ name: call.name, args: parse(call.arguments), result: parseResult(content),
      content: typeof content === 'string' ? content : JSON.stringify(content ?? '') });
  }
  return found;
}

// A password-type field whose own name or label says it takes a new password
// (an account's first password, a changed one, or the repeat of either).
const NEW_PASSWORD_FIELD_RE = /new|confirm|repeat|retype|re-?enter|again|create|choose|sign[-_\s]?up|regist/i;
// One that says it takes the account's existing password, even in a form that
// also sets a new one.
const CURRENT_PASSWORD_FIELD_RE = /current|old|existing/i;
// Secrets a password-type field holds that are not an account's password: a
// key or token the user copies from another service into this one.
const NON_PASSWORD_SECRET_RE = /api[-_\s]?key|token|secret|licen[cs]e|private[-_\s]?key|access[-_\s]?key|webhook/i;
const PASSWORD_WORD_RE = /pass|pwd/i;

// A field's own name, id and label texts, joined.
function fieldIdentity(meta) {
  return ['name', 'id', 'ariaLabel', 'ariaLabelledByText', 'placeholder', 'labelText']
    .map(key => meta[key])
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value).slice(0, 200))
    .join(' ');
}

const namesKeyOrToken = identity => NON_PASSWORD_SECRET_RE.test(identity) && !PASSWORD_WORD_RE.test(identity);

/**
 * Whether a field takes the password of an existing account: the one secret a
 * sign-in needs that only the user can know, so WebBrain types into it only a
 * value the user gave (credential-not-provided, see agent.js). Fields that
 * create or change a password, one-time codes and API keys are left out: a
 * run may generate a new account's password, read a code from the user's
 * mailbox, or copy a key the page just issued.
 *
 * - autocomplete `current-password`: yes.
 * - autocomplete `new-password` or `one-time-code`: no.
 * - any other `<input type="password">`: yes, unless its name, id or label
 *   names a key or token rather than a password, or a new or repeated
 *   password, or its form holds more than one visible password field (a new
 *   password and its confirmation; content.js reports `passwordFields`) and
 *   the field does not name the current one.
 *
 * @param {object} meta field metadata as content.js _fieldMeta reports it
 * @returns {{guarded: boolean, reason: string|null}}
 */
export function isSignInPasswordField(meta) {
  const no = { guarded: false, reason: null };
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return no;
  const tokens = String(meta.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.includes('current-password')) return { guarded: true, reason: 'autocomplete=current-password' };
  if (tokens.includes('new-password') || tokens.includes('one-time-code')) return no;
  if (String(meta.type ?? '').toLowerCase() !== 'password') return no;
  const identity = fieldIdentity(meta);
  if (namesKeyOrToken(identity)) return no;
  if (!CURRENT_PASSWORD_FIELD_RE.test(identity)) {
    if (NEW_PASSWORD_FIELD_RE.test(identity)) return no;
    if (Number(meta.passwordFields) > 1) return no;
  }
  return { guarded: true, reason: 'input type=password' };
}

/**
 * Whether `value` appears in one of `sources`, compared after Unicode NFC
 * normalization and case-sensitively, as passwords are. A value that starts
 * or ends with a letter or digit must not continue a longer word there:
 * "pass" is not given by a message that says "password", while "hunter2" is
 * given by "my password is hunter2." An empty value gives nothing away and is
 * always provided.
 *
 * @param {string} value
 * @param {string[]} sources
 * @returns {boolean}
 */
export function credentialValueProvided(value, sources = []) {
  const normalize = text => { try { return text.normalize('NFC'); } catch { return text; } };
  const wanted = normalize(String(value ?? '').trim());
  if (!wanted) return true;
  const tokenChar = /[\p{L}\p{N}]/u;
  const checkStart = tokenChar.test(wanted[0]);
  const checkEnd = tokenChar.test(wanted[wanted.length - 1]);
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source !== 'string') continue;
    const text = normalize(source);
    for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + 1)) {
      const to = at + wanted.length;
      if (checkStart && at > 0 && tokenChar.test(text[at - 1])) continue;
      if (checkEnd && to < text.length && tokenChar.test(text[to])) continue;
      return true;
    }
  }
  return false;
}

/**
 * The passwords WebBrain typed into new-password fields in a saved
 * conversation (password-type or `new-password` fields isSignInPasswordField
 * leaves out, other than keys and tokens): a password it chose for an account
 * it created, which a later sign-in to that account may need.
 *
 * @param {object[]} messages the conversation
 * @param {(content: string) => string} unwrap
 * @returns {string[]}
 */
export function newPasswordValuesFromHistory(messages, unwrap = content => content) {
  const values = [];
  for (const { args, result } of fillCallsFromHistory(messages, unwrap)) {
    if (!result || typeof result !== 'object' || result.dispatched === false || result.noDispatch === true) continue;
    const field = [result.fieldMeta, result.focusedField].find(meta => meta && typeof meta === 'object');
    if (!field || isSignInPasswordField(field).guarded) continue;
    const tokens = String(field.autocomplete ?? '').toLowerCase().split(/\s+/);
    const passwordField = tokens.includes('new-password')
      || (String(field.type ?? '').toLowerCase() === 'password' && !tokens.includes('one-time-code')
        && !namesKeyOrToken(fieldIdentity(field)));
    const value = typeof args?.text === 'string' ? args.text.trim() : '';
    if (passwordField && value) values.push(value);
  }
  return values;
}

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
