/**
 * Browser-neutral PDF fetching and text extraction helpers.
 *
 * PDF.js itself is loaded by an extension page, not by the MV3 service
 * worker. Keeping the extraction loop here lets the offscreen host own the
 * browser-only PDF.js runtime while the agent facade remains lightweight.
 */

export const PDF_EXTRACTION_MESSAGE = 'offscreen-pdf-extract';
export const PDF_EXTRACTION_READY_MESSAGE = 'offscreen-pdf-extract-ready';
export const PDF_PASSTHROUGH_MAX_BYTES = 16 * 1024 * 1024;

const ALLOWED_PDF_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const PDF_HANDLER_PAGE = 'src/ui/pdf-handler.html';
const BASE64_MAX_INPUT_BYTES = 32 * 1024 * 1024;

// When the native MIME handler owns a PDF tab, the tab URL is our own viewer
// page wrapping the real URL in ?url=. read_pdf falls back to the tab URL when
// called without an explicit one, so unwrap it before the scheme check.
function unwrapPdfHandlerUrl(url, runtime = globalThis.chrome?.runtime) {
  if (url.protocol !== 'chrome-extension:' && url.protocol !== 'moz-extension:') return url;
  if (typeof runtime?.getURL !== 'function') return url;
  let handler;
  try {
    handler = new URL(runtime.getURL(PDF_HANDLER_PAGE));
  } catch {
    return url;
  }
  if (url.origin !== handler.origin || url.pathname !== handler.pathname) return url;
  const inner = url.searchParams.get('url');
  if (!inner) return url;
  try {
    return new URL(inner);
  } catch {
    return url;
  }
}

export function normalizePdfUrl(value, runtime = globalThis.chrome?.runtime) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('PDF extraction requires a valid URL.');
  }
  url = unwrapPdfHandlerUrl(url, runtime);
  if (!ALLOWED_PDF_PROTOCOLS.has(url.protocol)) {
    throw new Error('PDF URL must use http:, https:, or file:.');
  }
  return url.href;
}

// Derived from the manifest rather than hardcoded: a rename of the service
// worker entry would otherwise reject every extraction with a "not ready"
// error that points at the wrong subsystem.
function backgroundScriptPath(runtime) {
  const manifest = typeof runtime?.getManifest === 'function' ? runtime.getManifest() : null;
  return manifest?.background?.service_worker || 'src/background.js';
}

export function isTrustedPdfExtractionSender(sender, runtime = globalThis.chrome?.runtime) {
  if (!runtime?.id || typeof runtime.getURL !== 'function') return false;
  return sender?.id === runtime.id
    && sender?.tab == null
    && sender?.url === runtime.getURL(backgroundScriptPath(runtime));
}

export function bytesToBase64(bytes) {
  if (bytes.length > BASE64_MAX_INPUT_BYTES) {
    throw new Error(`PDF too large for base64 conversion (${bytes.length} bytes, cap ${BASE64_MAX_INPUT_BYTES}).`);
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function fetchPdfBytes(url, { timeoutMs = 60000 } = {}) {
  const normalizedUrl = normalizePdfUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(normalizedUrl, { credentials: 'include', signal: controller.signal });
    } catch (error) {
      if (normalizedUrl.startsWith('file:')) {
        throw new Error(
          'Cannot fetch local PDF from a file:// URL. WebBrain needs ' +
          'file-URL access in Chrome: open chrome://extensions, find ' +
          'WebBrain, click "Details", and enable "Allow access to file URLs". ' +
          'Then reload the PDF tab and try read_pdf again.'
        );
      }
      throw new Error(`PDF fetch failed: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`PDF fetch returned HTTP ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractPdfTextFromBytes(pdfjs, bytes, opts = {}) {
  const fromPage = Math.max(1, Math.floor(opts.fromPage || 1));
  const requestedTo = opts.toPage ? Math.floor(opts.toPage) : fromPage + 49;
  const maxChars = Math.max(1000, Math.floor(opts.maxChars || 50000));

  // PDF.js may transfer this buffer to its worker, detaching the caller's
  // Uint8Array. Capture the length before getDocument() so metadata remains
  // accurate after parsing.
  const byteLength = bytes.length;
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;

  const totalPages = pdf.numPages;
  const startPage = Math.min(fromPage, totalPages);
  const endPage = Math.min(totalPages, Math.max(startPage, requestedTo));

  let title = '';
  try {
    const meta = await pdf.getMetadata();
    title = meta?.info?.Title || '';
  } catch { /* metadata is best-effort */ }

  const pages = [];
  let charCount = 0;
  let truncated = false;
  let lastRead = startPage - 1;

  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map(item => (item && typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (charCount + pageText.length > maxChars) {
      const remaining = Math.max(0, maxChars - charCount);
      pages.push(pageText.slice(0, remaining) + '… [page truncated, use read_pdf with fromPage to read more]');
      lastRead = pageNumber;
      truncated = true;
      page.cleanup?.();
      break;
    }

    pages.push(pageText);
    charCount += pageText.length;
    lastRead = pageNumber;
    page.cleanup?.();
  }

  return {
    success: true,
    title,
    totalPages,
    fromPage: startPage,
    toPage: lastRead,
    pageCount: pages.length,
    pages,
    hasExtractableText: pages.join('\n').length > 100,
    truncated,
    byteLength,
  };
}
