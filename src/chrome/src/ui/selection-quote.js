const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const QUOTE_CHROME_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE', 'TEMPLATE']);
const QUOTE_CHROME_CLASSES = new Set(['code-block-header', 'code-copy-btn', 'code-lang', 'msg-copy-btn']);

function normalizedSelectionText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
}

function classListContains(node, className) {
  if (node?.classList?.contains?.(className)) return true;
  const classNameValue = typeof node?.className === 'string' ? node.className : '';
  return classNameValue.split(/\s+/).includes(className);
}

export function isSelectionQuoteChrome(node) {
  if (!node || node.nodeType !== ELEMENT_NODE) return false;
  if (QUOTE_CHROME_TAGS.has(String(node.tagName || '').toUpperCase())) return true;
  for (const className of QUOTE_CHROME_CLASSES) {
    if (classListContains(node, className)) return true;
  }
  return false;
}

function collectSelectionQuoteText(node) {
  if (!node) return '';
  if (node.nodeType === TEXT_NODE) return String(node.nodeValue ?? node.textContent ?? '');
  if (node.nodeType !== ELEMENT_NODE) return '';
  if (isSelectionQuoteChrome(node)) return '';
  if (String(node.tagName || '').toUpperCase() === 'BR') return '\n';
  let text = '';
  for (const child of node.childNodes || []) text += collectSelectionQuoteText(child);
  return text;
}

export function selectionTextFromContents(root) {
  return normalizedSelectionText(collectSelectionQuoteText(root));
}

export function selectionTextFromRange(range) {
  if (!range) return '';
  if (typeof range.cloneContents === 'function') {
    return selectionTextFromContents(range.cloneContents());
  }
  return normalizedSelectionText(range.toString?.() || '');
}

export function buildSelectionQuote(text) {
  const selection = normalizedSelectionText(text);
  if (!selection) return '';
  return `${selection.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
}

export function buildSelectionComposerDraft(selectionText, draft = '') {
  const quote = buildSelectionQuote(selectionText);
  const existingDraft = String(draft == null ? '' : draft);
  if (!quote || existingDraft.startsWith(quote)) return existingDraft;
  return `${quote}${existingDraft}`;
}

export function buildSelectionTextAttachment(text) {
  const selection = normalizedSelectionText(text);
  if (!selection) return null;
  const bytes = new TextEncoder().encode(selection);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return {
    kind: 'text',
    name: 'selected-text.txt',
    textContent: selection,
    dataUrl: `data:text/plain;charset=utf-8;base64,${btoa(binary)}`,
    mimeType: 'text/plain;charset=utf-8',
    size: bytes.byteLength,
    // A two-value flag, not a trust level: everything that is not a slash
    // screenshot normalizes to 'user_upload' before it reaches storage or the
    // model, and every attachment is wrapped as untrusted regardless of it.
    source: 'user_upload',
  };
}

export function selectionIsQuoteable({ startTextElement, endTextElement, text } = {}) {
  // A range spanning two bubbles has no unambiguous answer boundary.
  return Boolean(
    startTextElement
      && startTextElement === endTextElement
      && normalizedSelectionText(text),
  );
}

function numericRectEdge(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rectFromClientRect(rect) {
  if (!rect) return null;
  const top = numericRectEdge(rect.top);
  const left = numericRectEdge(rect.left);
  const width = numericRectEdge(rect.width);
  const height = numericRectEdge(rect.height);
  const bottom = rect.bottom == null ? top + height : numericRectEdge(rect.bottom, top + height);
  const right = rect.right == null ? left + width : numericRectEdge(rect.right, left + width);
  if (!width && !height && !top && !left && !bottom && !right) return null;
  return { top, left, bottom, right, width: right - left, height: bottom - top };
}

export function selectionRangeRect(range) {
  if (!range) return null;
  const bounding = typeof range.getBoundingClientRect === 'function'
    ? rectFromClientRect(range.getBoundingClientRect())
    : null;
  if (bounding && (bounding.width || bounding.height)) return bounding;
  const list = typeof range.getClientRects === 'function' ? range.getClientRects() : null;
  const rects = list ? Array.from(list, rectFromClientRect).filter(Boolean) : [];
  if (rects.length) {
    let top = Infinity;
    let left = Infinity;
    let bottom = -Infinity;
    let right = -Infinity;
    for (const rect of rects) {
      top = Math.min(top, rect.top);
      left = Math.min(left, rect.left);
      bottom = Math.max(bottom, rect.bottom);
      right = Math.max(right, rect.right);
    }
    return { top, left, bottom, right, width: right - left, height: bottom - top };
  }
  const startEl = range.startContainer?.nodeType === 1 ? range.startContainer : range.startContainer?.parentElement;
  const endEl = range.endContainer?.nodeType === 1 ? range.endContainer : range.endContainer?.parentElement;
  return nodeElementRect(startEl) || nodeElementRect(endEl) || bounding;
}

function nodeElementRect(node) {
  if (!node?.getBoundingClientRect) return null;
  const rect = rectFromClientRect(node.getBoundingClientRect());
  return rect && (rect.width || rect.height) ? rect : null;
}

export function selectionRangeIsVisible(rect, viewport = {}) {
  if (!rect) return false;
  const width = numericRectEdge(viewport.width);
  const height = numericRectEdge(viewport.height);
  return rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width;
}
