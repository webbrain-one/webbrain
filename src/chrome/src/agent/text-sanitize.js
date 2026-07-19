/**
 * Strip control characters from untrusted text and clamp its length.
 *
 * The control-character regex is the security-sensitive part: keeping it in a
 * single shared place means a hardening change can't leave a second copy
 * exploitable. Callers that need single-line output (e.g. classifier fields)
 * pass `collapseWhitespace: true`; callers that preserve formatting (e.g. the
 * planner's multi-line notes) use the default.
 */
export function sanitizeText(value, max = 500, { collapseWhitespace = false } = {}) {
  if (value == null) return '';
  let out = String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ');
  if (collapseWhitespace) {
    out = out.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
  }
  return out.trim().slice(0, max);
}

function escapedLineBreakRuns(value) {
  const runs = [];
  const pattern = /(^|[^\\])((?:\\r\\n|\\n|\\r)+)/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    runs.push({
      raw: match[2],
      previous: start > 0 ? value[start - 1] : '',
      next: end < value.length ? value[end] : '',
    });
  }
  return runs;
}

/**
 * Repair one extra JSON-string escaping layer in user-visible assistant text.
 *
 * Some OpenAI-compatible model backends occasionally return Markdown as an
 * encoded string fragment, leaving literal `\n` and `\"` sequences after the
 * API response itself has already been parsed. Decoding every response would
 * corrupt legitimate code, paths, and escape-sequence explanations, so repair
 * only high-confidence cases: no real layout characters, multiple escaped
 * line breaks, a valid one-level JSON decode, and Markdown-like structure in
 * the decoded result.
 */
export function repairDoubleEscapedAssistantText(value) {
  if (typeof value !== 'string' || !value) return value;
  if (/[\r\n\t]/.test(value)) return value;

  const lineBreakRuns = escapedLineBreakRuns(value);
  const escapedLineBreakCount = lineBreakRuns.reduce(
    (count, run) => count + (run.raw.match(/\\r\\n|\\n|\\r/g) || []).length,
    0,
  );
  if (escapedLineBreakCount < 2) return value;

  // A run surrounded by whitespace or code delimiters is much more likely to
  // be an escape-sequence example (for example `/\n\n/` or "write \n here")
  // than encoded document layout. Fail closed instead of rewriting it.
  if (lineBreakRuns.some((run) => (
    (/\s/.test(run.previous) && /\s/.test(run.next))
    || run.previous === '/'
    || run.next === '/'
    || (run.previous === '`' && run.next === '`')
  ))) return value;

  let decoded;
  try {
    decoded = JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
  if (typeof decoded !== 'string' || decoded === value) return value;

  const decodedLineBreaks = decoded.match(/\r\n|\r|\n/g) || [];
  if (decodedLineBreaks.length < escapedLineBreakCount) return value;

  const hasMarkdownBlock = /(?:^|[\r\n])[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+\S|\d+[.)][ \t]+\S|>{1,3}[ \t]+\S|```|~~~|---[ \t]*(?:$|[\r\n]))/m.test(decoded);
  const hasInlineMarkdownAcrossParagraphs = /(?:\*\*[^*\r\n]+\*\*|__[^_\r\n]+__|`[^`\r\n]+`|\[[^\]\r\n]+\]\([^)]+\))/.test(decoded)
    && /\r?\n[ \t]*\r?\n/.test(decoded);
  if (!hasMarkdownBlock && !hasInlineMarkdownAcrossParagraphs) return value;

  return decoded;
}

function repairJsonQuotedPageTitleLines(value) {
  if (typeof value !== 'string' || !value || !value.includes('\\"')) return value;

  const parts = value.split(/(\r\n|\n|\r)/);
  let fence = null;

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const titleMatch = line.match(
      /^([ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?Page title:[ \t]*)("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")([ \t]*)$/i,
    );
    if (!titleMatch || !titleMatch[2].includes('\\"')) continue;

    try {
      const decodedTitle = JSON.parse(titleMatch[2]);
      if (typeof decodedTitle === 'string') {
        parts[i] = `${titleMatch[1]}${decodedTitle}${titleMatch[3]}`;
      }
    } catch {
      // Preserve malformed or incomplete JSON-looking text verbatim.
    }
  }

  return parts.join('');
}

/**
 * Normalize only high-confidence serialization artifacts in terminal assistant
 * text. Semantic gates and tool-call parsing must always inspect the original
 * provider content before this display-only repair runs.
 */
export function repairAssistantDisplayText(value) {
  return repairJsonQuotedPageTitleLines(repairDoubleEscapedAssistantText(value));
}
