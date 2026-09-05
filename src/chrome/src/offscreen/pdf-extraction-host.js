import {
  PDF_EXTRACTION_MESSAGE,
  PDF_EXTRACTION_READY_MESSAGE,
  PDF_PASSTHROUGH_MAX_BYTES,
  bytesToBase64,
  extractPdfTextFromBytes,
  fetchPdfBytes,
  isTrustedPdfExtractionSender,
  normalizePdfUrl,
} from '../agent/pdf-extraction.js';
let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(chrome.runtime.getURL('vendor/pdfjs/pdf.mjs')).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (![PDF_EXTRACTION_MESSAGE, PDF_EXTRACTION_READY_MESSAGE].includes(message?.type)) return false;
  if (!isTrustedPdfExtractionSender(sender)) {
    sendResponse({ ok: false, ready: false, error: 'Unauthorized PDF extraction sender.' });
    return false;
  }
  if (message.type === PDF_EXTRACTION_READY_MESSAGE) {
    sendResponse({ ok: true, ready: true });
    return false;
  }

  (async () => {
    const url = normalizePdfUrl(message.url);
    const bytes = await fetchPdfBytes(url);
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
    sendResponse({ ok: true, result });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });

  return true;
});
