/**
 * PDF reading for the agent (Firefox).
 *
 * Why a separate module: Firefox's built-in PDF viewer is a privileged
 * page (about:reader-style) that our content scripts cannot inject into,
 * so click / read_page / get_accessibility_tree all silently no-op
 * against PDF tabs. The agent ends up clicking around the viewer's
 * chrome indefinitely.
 *
 * What this module does instead: fetches the PDF binary from the
 * tab URL via plain `fetch()`, parses it with the bundled pdfjs-dist
 * library, and returns per-page text. Works with all model providers
 * (text-only too) — the LLM gets readable text instead of being
 * stuck in a viewer-navigation loop.
 *
 * Tier 2 ("Claude passthrough"): when the active provider is
 * Anthropic, we ALSO attach the raw PDF bytes as a `document` content
 * block on a follow-up user message. Claude's API natively
 * understands PDF documents, so the model gets the full layout +
 * embedded images, not just plain text. The text extraction still
 * happens (tool result must be a string), the document attachment is
 * additional context.
 */

let pdfjsModule = null;

/**
 * Lazy-load pdfjs only on first PDF read. The legacy bundle is ~1 MB
 * and the worker is ~2.3 MB; we don't want to pay that startup cost
 * for users who never open a PDF.
 */
async function getPdfjs() {
  if (pdfjsModule) return pdfjsModule;
  pdfjsModule = await import(browser.runtime.getURL('vendor/pdfjs/pdf.mjs'));
  // Worker URL must be set BEFORE the first getDocument() call. We resolve
  // it via runtime.getURL so it works at any extension-id deploy target.
  pdfjsModule.GlobalWorkerOptions.workerSrc =
    browser.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
  return pdfjsModule;
}

/**
 * Cheap byte-array → base64 conversion that doesn't blow the call
 * stack on multi-MB PDFs. fromCharCode.apply has a per-call argument
 * limit (~64k in V8), so we chunk.
 */
const BASE64_MAX_INPUT_BYTES = 32 * 1024 * 1024; // 32 MB safety cap

function bytesToBase64(bytes) {
  if (bytes.length > BASE64_MAX_INPUT_BYTES) {
    throw new Error(`PDF too large for base64 conversion (${bytes.length} bytes, cap ${BASE64_MAX_INPUT_BYTES}).`);
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Heuristic: does this URL look like a PDF? Used by `read_page` to
 * decide whether to redirect to `read_pdf`.
 */
export function isPdfUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.pathname.toLowerCase().endsWith('.pdf')) return true;
  // Some servers include the .pdf in a query parameter (e.g. content-disposition
  // viewers, Google Drive previews). Catch the common patterns.
  const fileParam = parsed.searchParams.get('file');
  if (fileParam && fileParam.toLowerCase().endsWith('.pdf')) return true;
  return false;
}

/**
 * Fetch the PDF binary from `url`. Returns a Uint8Array.
 * Throws with a helpful message on failure — file:// URLs in Firefox
 * are blocked by default for extensions; about:config
 * `extensions.webextensions.background.allowed_protocols` would have to
 * be modified, which is not user-friendly. We surface a descriptive
 * error instead of leaving the agent guessing.
 */
export async function fetchPdfBytes(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    let res;
    try {
      res = await fetch(url, { credentials: 'include', signal: controller.signal });
    } catch (e) {
      if (typeof url === 'string' && url.startsWith('file://')) {
        throw new Error(
          'Cannot fetch local PDF from a file:// URL. Firefox blocks ' +
          'extension fetches against file:// for privacy. Workaround: ' +
          'open the PDF over http(s) (e.g. drag it into a local web ' +
          'server, or upload it to a file host) and try read_pdf again.'
        );
      }
      throw new Error(`PDF fetch failed: ${e.message}`);
    }
    if (!res.ok) {
      throw new Error(`PDF fetch returned HTTP ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract text from a PDF.
 *
 * Returns:
 *   {
 *     success, title, totalPages, fromPage, toPage, pageCount,
 *     pages: ['page 1 text', 'page 2 text', ...],
 *     hasExtractableText, truncated, byteLength
 *   }
 *
 * `hasExtractableText` is a heuristic — a PDF that's pure scanned
 * images returns near-empty text from getTextContent(). The flag tells
 * the planner "you need a vision model for this PDF" without us
 * having to render every page to PNG ourselves.
 */
export async function extractPdfText(url, opts = {}) {
  const fromPage = Math.max(1, Math.floor(opts.fromPage || 1));
  const requestedTo = opts.toPage ? Math.floor(opts.toPage) : fromPage + 49;
  const maxChars = Math.max(1000, Math.floor(opts.maxChars || 50000));

  const bytes = await fetchPdfBytes(url);
  const pdfjs = await getPdfjs();

  const loadingTask = pdfjs.getDocument({
    data: bytes,
    // Suppress pdfjs's noisy console.warn for "non-embedded font fallback" etc.
    // We surface real errors via the catch below.
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;

  const totalPages = pdf.numPages;
  const startPage = Math.min(fromPage, totalPages);
  const endPage = Math.min(totalPages, Math.max(startPage, requestedTo));

  // Best-effort title from the document's metadata dictionary.
  let title = '';
  try {
    const meta = await pdf.getMetadata();
    title = meta?.info?.Title || '';
  } catch { /* ignore */ }

  const pages = [];
  let charCount = 0;
  let truncated = false;
  // Last page actually read, so the truncation notice's "read more with
  // fromPage" advice resolves to a page that was really covered. Reporting
  // `endPage` after an early `break` would make a caller resume past the
  // unread pages and silently lose them.
  let lastRead = startPage - 1;

  for (let i = startPage; i <= endPage; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // pdfjs returns text items as a flat array with positional info.
    // For LLM consumption we just join them with spaces — preserving
    // exact layout would be more accurate but blows the token budget.
    const pageText = content.items
      .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (charCount + pageText.length > maxChars) {
      const remaining = Math.max(0, maxChars - charCount);
      pages.push(pageText.slice(0, remaining) + '… [page truncated, use read_pdf with fromPage to read more]');
      lastRead = i;
      truncated = true;
      break;
    }

    pages.push(pageText);
    charCount += pageText.length;
    lastRead = i;

    // Free per-page resources — pdfjs caches aggressively otherwise.
    page.cleanup?.();
  }

  // Heuristic: <100 chars across the whole requested range almost certainly
  // means the pages are scanned images with no text layer. Tell the model.
  const hasExtractableText = pages.join('\n').length > 100;

  return {
    success: true,
    title,
    totalPages,
    fromPage: startPage,
    toPage: lastRead,
    pageCount: pages.length,
    pages,
    hasExtractableText,
    truncated,
    byteLength: bytes.length,
    // The raw bytes are kept on `_pdfBytes` for the Tier 2 Claude
    // passthrough path; the batch loop strips it before stringifying
    // so the LLM doesn't see ~1 MB of base64 nonsense in the tool
    // result text.
    _pdfBytes: bytes,
  };
}

/**
 * Whether the given provider can natively consume PDFs as a
 * `document` content block. Currently Anthropic only — OpenAI's
 * gpt-4o has its own PDF API surface (file-uploads + references)
 * that's a different shape, not portable from the Anthropic format,
 * so we keep that for a future iteration.
 */
export function providerSupportsPdfPassthrough(provider) {
  if (!provider) return false;
  const className = provider.constructor?.name || '';
  if (className === 'AnthropicProvider') return true;
  // Some users route Claude through OpenAI-compatible endpoints; the
  // model name is the only signal there.
  const model = (provider.config?.model || '').toLowerCase();
  if (className === 'OpenAICompatibleProvider' && model.includes('claude')) return true;
  return false;
}

/**
 * Build the `document` content block for the Anthropic Messages API
 * from raw PDF bytes. Caller is responsible for size-checking — Claude's
 * cap is ~32 MB base64 / ~24 MB binary as of writing, but we cap
 * lower (16 MB binary) to leave room for the rest of the conversation.
 */
export function buildClaudeDocumentBlock(bytes, name) {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: bytesToBase64(bytes),
    },
    ...(name ? { title: name } : {}),
  };
}

export const PDF_PASSTHROUGH_MAX_BYTES = 16 * 1024 * 1024; // 16 MB
