/**
 * PDF reading for the agent.
 *
 * Why a separate module: Chrome's PDF viewer is a `chrome-extension://`
 * page that our content scripts cannot inject into, so click /
 * read_page / get_accessibility_tree all silently no-op against
 * PDF tabs. The agent ends up clicking around the viewer's chrome
 * indefinitely (see the qwen3.6-27b lease trace from 2026-05-04 —
 * 17 steps, 184 seconds, 345k input tokens, no progress).
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

import { ensureOffscreen } from '../offscreen/ensure.js';
import {
  getAllowLocalNetwork,
  registrableDomain,
  validateFetchUrl,
  watchFetchAddresses,
} from '../network/network-tools.js';
import {
  PDF_EXTRACTION_MESSAGE,
  PDF_EXTRACTION_READY_MESSAGE,
  PDF_FETCH_VERDICT_MESSAGE,
  normalizePdfUrl,
  PDF_PASSTHROUGH_MAX_BYTES,
  bytesToBase64,
} from './pdf-extraction.js';

// chrome.offscreen.createDocument() resolves when the document exists, not
// when its module scripts have registered their listeners. Probe the PDF host
// for up to one second so the first read after a cold start cannot race it.
const PDF_HOST_READY_ATTEMPTS = 40;
const PDF_HOST_READY_RETRY_MS = 25;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPdfExtractionHost() {
  let lastError = null;
  for (let attempt = 0; attempt < PDF_HOST_READY_ATTEMPTS; attempt++) {
    let refusal = null;
    try {
      const response = await chrome.runtime.sendMessage({ type: PDF_EXTRACTION_READY_MESSAGE });
      if (response?.ready === true) return;
      // An explicit error means the host answered and refused. Retrying cannot
      // change the outcome, and reporting it as "not ready" sends whoever is
      // debugging to the wrong subsystem.
      if (response?.error) refusal = new Error(response.error);
    } catch (error) {
      // No listener: the document went away between ensureOffscreen() seeing it
      // and this probe. Recreate it rather than retrying into a dead channel.
      lastError = error;
      try {
        await ensureOffscreen();
      } catch (ensureError) {
        lastError = ensureError;
      }
    }
    if (refusal) throw refusal;
    if (attempt + 1 < PDF_HOST_READY_ATTEMPTS) await wait(PDF_HOST_READY_RETRY_MS);
  }
  const detail = lastError?.message ? ` ${lastError.message}` : '';
  throw new Error(`The offscreen PDF parser did not become ready.${detail}`);
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

// Compare the validated document URLs, including when either side is wrapped
// in our PDF viewer. Viewer hostnames identify the extension, not the site.
export async function pdfFetchCredentials(url, tabId) {
  const target = new URL(normalizePdfUrl(url));
  if (!/^https?:$/.test(target.protocol) || tabId == null) return 'omit';
  try {
    const tab = await chrome.tabs.get(tabId);
    const active = new URL(normalizePdfUrl(tab?.url));
    if (!/^https?:$/.test(active.protocol)) return 'omit';
    const domain = registrableDomain(target.hostname);
    return domain && domain === registrableDomain(active.hostname) ? 'include' : 'omit';
  } catch {
    return 'omit';
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
export async function extractPdfText(url, opts = {}, ctx = {}) {
  const normalizedUrl = normalizePdfUrl(url);
  const allowLocal = getAllowLocalNetwork();
  const isNetwork = !normalizedUrl.startsWith('file:');
  if (isNetwork) {
    const check = validateFetchUrl(normalizedUrl, { allowLocalNetwork: allowLocal });
    if (!check.ok) throw new Error(check.error);
  }
  const attachCookies = (await pdfFetchCredentials(normalizedUrl, ctx?.tabId ?? opts.tabId)) === 'include';
  await ensureOffscreen();
  await waitForPdfExtractionHost();
  // Register in the service worker before telling the offscreen host to fetch.
  const addresses = isNetwork ? watchFetchAddresses(normalizedUrl, allowLocal, { requireAddress: true }) : null;
  if (isNetwork && !addresses) throw new Error('PDF response address verification is unavailable.');
  const requestId = crypto.randomUUID();
  const verdictListener = (message, sender, sendResponse) => {
    if (message?.type !== PDF_FETCH_VERDICT_MESSAGE || message.requestId !== requestId) return false;
    if (sender?.id !== chrome.runtime.id || sender?.tab != null
      || sender?.url !== chrome.runtime.getURL('src/offscreen/offscreen.html')) {
      sendResponse({ ok: false, error: 'Unauthorized PDF response verification sender.' });
      return false;
    }
    (async () => {
      const error = await addresses?.settledFailure('fetch');
      sendResponse(error ? { ok: false, error } : { ok: true });
    })().catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  };
  try {
    chrome.runtime.onMessage.addListener(verdictListener);
    const response = await chrome.runtime.sendMessage({
      type: PDF_EXTRACTION_MESSAGE,
      requestId,
      url: normalizedUrl,
      options: {
        fromPage: opts.fromPage,
        toPage: opts.toPage,
        maxChars: opts.maxChars,
        includeBase64: opts.includeDocument === true,
        allowLocalNetwork: allowLocal,
        attachCookies,
      },
    });
    if (!response?.ok || !response.result) {
      throw new Error(response?.error || 'The offscreen PDF parser returned no result.');
    }
    return response.result;
  } finally {
    chrome.runtime.onMessage.removeListener(verdictListener);
    addresses?.close();
  }
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
 * Build the `document` content block for the Anthropic Messages API from
 * raw PDF bytes or base64 produced from those same bytes. Caller is
 * responsible for size-checking — Claude's cap is ~32 MB base64 / ~24 MB
 * binary as of writing, but we cap lower (16 MB binary) to leave room for
 * the rest of the conversation.
 */
export function buildClaudeDocumentBlock(bytesOrBase64, name) {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: typeof bytesOrBase64 === 'string'
        ? bytesOrBase64
        : bytesToBase64(bytesOrBase64),
    },
    ...(name ? { title: name } : {}),
  };
}

export { PDF_PASSTHROUGH_MAX_BYTES };
