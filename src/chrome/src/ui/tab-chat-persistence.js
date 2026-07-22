export const TAB_CHAT_PREFIX = 'tabChat:';
export const TAB_CHAT_PERSIST_BUDGET = 7 * 1024 * 1024;
const TAB_CHAT_QUOTA_RETRY_BUDGET = 256 * 1024;
export const TRANSPARENT_PIXEL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function stripImagePayloadsForPersist(html) {
  return String(html || '').replace(
    /data:image\/[a-z0-9.+-]+(?:;[^,]*)?;base64,[a-z0-9+/=]+/gi,
    TRANSPARENT_PIXEL_PNG_DATA_URL,
  );
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function findHtmlTagEnd(source, start) {
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return i;
  }
  return -1;
}

function describeHtmlTag(raw) {
  let i = 0;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  if (raw[i] === '!' || raw[i] === '?') return { closing: false, name: '' };
  let closing = false;
  if (raw[i] === '/') {
    closing = true;
    i++;
    while (i < raw.length && /\s/.test(raw[i])) i++;
  }
  const start = i;
  if (!/[a-z]/i.test(raw[i] || '')) return null;
  while (i < raw.length && /[a-z0-9:-]/i.test(raw[i])) i++;
  return {
    closing,
    name: raw.slice(start, i).toLowerCase(),
  };
}

function htmlToPlainText(html) {
  const source = String(html || '');
  const chunks = [];
  let cursor = 0;
  let suppressedTag = '';

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) {
      if (!suppressedTag) chunks.push(source.slice(cursor));
      break;
    }
    if (!suppressedTag && open > cursor) chunks.push(source.slice(cursor, open));

    if (source.startsWith('<!--', open)) {
      const commentEnd = source.indexOf('-->', open + 4);
      if (commentEnd < 0) break;
      if (!suppressedTag) chunks.push(' ');
      cursor = commentEnd + 3;
      continue;
    }

    const close = findHtmlTagEnd(source, open + 1);
    if (close < 0) {
      if (!suppressedTag) chunks.push(source.slice(open));
      break;
    }
    const tag = describeHtmlTag(source.slice(open + 1, close));
    if (!tag) {
      if (!suppressedTag) chunks.push('<');
      cursor = open + 1;
      continue;
    }

    if (tag.name === 'script' || tag.name === 'style') {
      if (tag.closing && suppressedTag === tag.name) {
        suppressedTag = '';
        chunks.push(' ');
      } else if (!tag.closing && !suppressedTag) {
        suppressedTag = tag.name;
        chunks.push(' ');
      }
    } else if (!suppressedTag) {
      chunks.push(' ');
    }
    cursor = close + 1;
  }

  return chunks.join('');
}

export function compactTabChatForPersist(html, budget = TAB_CHAT_PERSIST_BUDGET) {
  const boundedBudget = Math.max(1024, Math.floor(Number(budget) || TAB_CHAT_PERSIST_BUDGET));
  const stripped = stripImagePayloadsForPersist(html);
  if (stripped.length <= boundedBudget) return stripped;

  // This is the last-resort stored copy only. Keep recent readable text in
  // valid markup instead of slicing arbitrary HTML and potentially restoring
  // a broken DOM. The live in-memory transcript remains untouched.
  const plainText = htmlToPlainText(stripped)
    .replace(/\s+/g, ' ')
    .trim();
  const marker = '[Earlier persisted chat content omitted to fit browser session storage.] ';
  // Entity escaping can expand a character to five bytes, so reserve a
  // conservative sixth of the available character budget for source text.
  const textBudget = Math.max(0, Math.floor((boundedBudget - 160) / 6));
  const recentText = plainText.slice(-textBudget);
  const fallback = `<div class="message system"><div class="message-text">${escapeHtml(marker + recentText)}</div></div>`;
  return fallback.slice(0, boundedBudget);
}

export async function persistTabChatToSession(storageArea, key, html, warn = console.warn) {
  const source = String(html || '');
  const initialValue = source.length > TAB_CHAT_PERSIST_BUDGET
    ? compactTabChatForPersist(source)
    : source;

  try {
    await storageArea.set({ [key]: initialValue });
    return { ok: true, degraded: initialValue !== source, recoveredFromQuota: false };
  } catch (initialError) {
    const retryValue = compactTabChatForPersist(source, TAB_CHAT_QUOTA_RETRY_BUDGET);
    let retryError = initialError;
    try {
      // The quota is shared across keys, so an individually-small chat can
      // still fail. First retry this write with a tightly bounded stored copy.
      await storageArea.set({ [key]: retryValue });
      return { ok: true, degraded: true, recoveredFromQuota: true };
    } catch (error) {
      retryError = error;
    }

    try {
      // Older per-tab chats can consume nearly the entire shared quota. Free
      // the largest stored chats one at a time and retry after each removal.
      // Removal is intentionally used instead of rewriting a stale get(null)
      // snapshot: a concurrent clear remains cleared rather than being
      // resurrected by quota recovery in another panel context.
      const stored = await storageArea.get(null);
      const candidates = Object.entries(stored || {})
        .filter(([storedKey, value]) => (
          storedKey !== key
          && storedKey.startsWith(TAB_CHAT_PREFIX)
          && typeof value === 'string'
        ))
        .sort((a, b) => b[1].length - a[1].length);
      const evictedKeys = [];

      for (const [storedKey] of candidates) {
        try {
          await storageArea.remove(storedKey);
          evictedKeys.push(storedKey);
        } catch {
          continue;
        }
        try {
          await storageArea.set({ [key]: retryValue });
          return {
            ok: true,
            degraded: true,
            recoveredFromQuota: true,
            evictedKeys,
          };
        } catch (error) {
          retryError = error;
        }
      }
    } catch (error) {
      retryError = error;
    }

    try {
      warn(
        '[WebBrain] persistTabChat: session storage write failed after compacting the stored copy; chat may not survive a panel reopen:',
        retryError?.message || retryError || initialError?.message || initialError,
      );
      return { ok: false, error: retryError || initialError };
    } catch {
      return { ok: false, error: retryError || initialError };
    }
  }
}
