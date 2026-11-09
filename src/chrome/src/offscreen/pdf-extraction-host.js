import {
  PDF_EXTRACTION_MESSAGE,
  PDF_EXTRACTION_READY_MESSAGE,
  PDF_FETCH_VERDICT_MESSAGE,
  PDF_PASSTHROUGH_MAX_BYTES,
  bytesToBase64,
  extractPdfTextFromBytes,
  fetchPdfBytes,
  isTrustedPdfExtractionSender,
  normalizePdfUrl,
} from '../agent/pdf-extraction.js';

const PDF_MESSAGE_TYPES = new Set([PDF_EXTRACTION_MESSAGE, PDF_EXTRACTION_READY_MESSAGE]);

let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(chrome.runtime.getURL('vendor/pdfjs/index.mjs')).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL('vendor/pdfjs/worker.mjs');
      return pdfjs;
    });
    // The offscreen document outlives any single read, so never memoize a
    // rejection: one transient import failure would otherwise make every
    // later read_pdf fail until the document is torn down.
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!PDF_MESSAGE_TYPES.has(message?.type)) return false;

  // A 16 MB PDF answers with ~21 MB of base64, and an oversized or
  // unserializable reply makes sendResponse throw. Without this guard that
  // throw would reach the catch below and call sendResponse a second time on
  // an already-closed channel, hiding the original failure.
  let responded = false;
  const respond = (payload) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(payload);
    } catch (error) {
      console.warn('[pdf-extraction-host] failed to deliver response', error);
    }
  };

  if (!isTrustedPdfExtractionSender(sender)) {
    respond({ ok: false, ready: false, error: 'Unauthorized PDF extraction sender.' });
    return false;
  }
  if (message.type === PDF_EXTRACTION_READY_MESSAGE) {
    respond({ ok: true, ready: true });
    return false;
  }

  (async () => {
    const url = normalizePdfUrl(message.url);
    const bytes = await fetchPdfBytes(url, {
      timeoutMs: message.options?.timeoutMs || 60000,
      allowLocalNetwork: message.options?.allowLocalNetwork === true,
      attachCookies: message.options?.attachCookies === true,
      verifyResponse: async () => {
        const verdict = await chrome.runtime.sendMessage({
          type: PDF_FETCH_VERDICT_MESSAGE, requestId: message.requestId,
        });
        if (verdict?.ok !== true) throw new Error(verdict?.error || 'PDF response address verification failed.');
      },
    });
    // PDF.js can transfer and detach the input buffer, so keep a copy of the
    // optional Claude document taken before parsing: text and document then
    // come from the same fetch. The ~4/3 base64 message overhead is
    // intentional to preserve that single-fetch, byte-identical guarantee.
    // The encode itself is deferred until parsing succeeds, so a corrupt PDF
    // that throws in getDocument() does not pay for a string nobody reads.
    const wantsBase64 = message.options?.includeBase64 === true
      && bytes.length <= PDF_PASSTHROUGH_MAX_BYTES;
    const passthrough = wantsBase64 ? bytes.slice() : null;
    const pdfjs = await getPdfjs();
    const result = await extractPdfTextFromBytes(pdfjs, bytes, message.options || {});
    if (passthrough) result._pdfBase64 = bytesToBase64(passthrough);
    respond({ ok: true, result });
  })().catch((error) => {
    respond({ ok: false, error: error?.message || String(error) });
  });

  return true;
});
