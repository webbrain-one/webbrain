/**
 * Markdown link sanitizer for the WebBrain sidepanel.
 *
 * Extracted from sidepanel.js so the security-critical sanitization logic
 * can be unit-tested in isolation. KEEP THIS FILE PURE JS — no chrome.* /
 * browser.* / DOM imports — so test/run.js can load it under Node.
 *
 * Threat model: the assistant text rendered into the sidepanel is
 * LLM output, and the LLM reads attacker-controlled page content (a
 * malicious page can prompt-inject the model into emitting arbitrary
 * markdown). The sidepanel renders that text via innerHTML in the
 * chrome-extension:// origin (full extension privileges), so a single
 * `[x](javascript:…)` or `[x](" onmouseover="…)` link would be RCE-grade.
 *
 * Defenses:
 *   1. URL scheme allowlist — only http(s), mailto, and relative URLs
 *      (#/...) produce an <a>. Anything else renders as plain text.
 *   2. Attribute escaping — `"` and `'` in the href are escaped so the
 *      URL can't break out of the href attribute and inject onXxx=.
 *   3. rel="noopener noreferrer" on every target=_blank link.
 *
 * The link-extraction regex matches one level of balanced parens in the
 * URL so links like https://en.wikipedia.org/wiki/Foo_(bar) round-trip.
 * Deeper nesting still truncates at the first unbalanced ')' — acceptable
 * for chat markdown.
 */

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

const MD_LINK_RE = /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g;

/**
 * Sanitize a single markdown link. Returns either a safe <a> string or
 * the bare label text when the URL is unsafe / unrecognized.
 */
export function sanitizeLink(label, href) {
  const trimmed = String(href || '').trim();
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.\-]*):/i);
  let safeHref;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!SAFE_SCHEMES.has(scheme)) return label;
    safeHref = trimmed;
  } else if (trimmed.startsWith('#') || trimmed.startsWith('/')) {
    safeHref = trimmed;
  } else {
    return label;
  }
  const attrEscapedHref = safeHref.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<a href="${attrEscapedHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * Replace every markdown link in `text` with the sanitized HTML output of
 * sanitizeLink. Non-link text is passed through unchanged.
 */
export function sanitizeMarkdownLinks(text) {
  return String(text == null ? '' : text).replace(MD_LINK_RE, (_m, label, href) => sanitizeLink(label, href));
}
