import { normalizePdfOcrResult, renderPdfOcrTextLayer } from '../agent/pdf-ocr.js';
import { readPdfResponseBytes } from '../agent/pdf-stream.js';
import { trackViewerWindow } from './pdf-viewer-window.js';

const api = globalThis.browser || globalThis.chrome;
const elements = Object.fromEntries([
  'pdf-title', 'pdf-stage', 'pdf-status', 'pdf-pages', 'previous-page', 'page-number',
  'page-count', 'next-page', 'zoom-out', 'fit-width', 'zoom-in', 'rotate-page',
  'search-form', 'document-search', 'search-submit', 'download-pdf', 'print-pdf', 'ocr-page', 'cancel-ocr-page',
  'native-viewer', 'disable-pdf-viewer',
].map(id => [id, document.getElementById(id)]));

const MIN_SCALE = .5;
const MAX_SCALE = 3;
const SCALE_STEP = .15;
const PDF_VIEWER_ENABLED_KEY = 'pdfViewerEnabled';
const PDF_NATIVE_BYPASS_KEY_PREFIX = 'pdfNativeBypassTab:';
const PDF_NATIVE_BYPASS_TTL_MS = 30_000;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
// Render every page upfront only for small documents. Larger documents get
// lightweight placeholder shells plus a rendered window around the current
// page so a 500-page PDF does not mount 500 canvases + text layers at once.
const EAGER_PAGE_LIMIT = 20;
const RENDER_WINDOW = 3;
const WINDOW_RENDER_DEBOUNCE_MS = 120;

const state = {
  pdf: null,
  pdfjs: null,
  streamInfo: null,
  currentPage: 1,
  requestedPage: 1,
  scale: 1.15,
  fitWidth: true,
  rotation: 0,
  pageViews: new Map(),
  renderedPages: new Set(),
  textCache: new Map(),
  ocrCache: new Map(),
  textLayerCount: 0,
  ocrTextLayerCount: 0,
  ocrInFlight: false,
  ocrRequestId: null,
  renderSequence: 0,
  renderTask: null,
  searchSequence: 0,
  resizeTimer: null,
  windowRenderTimer: null,
  windowRenderSequence: 0,
  scrollFrame: null,
  printing: false,
};

function setStatus(message, kind = '') {
  elements['pdf-status'].textContent = message;
  elements['pdf-status'].dataset.kind = kind;
}

async function markNativeBypassForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  try {
    await api?.storage?.local?.set?.({ [`${PDF_NATIVE_BYPASS_KEY_PREFIX}${tabId}`]: Date.now() });
  } catch {
    // Best-effort per-tab bypass marker before navigating back to the PDF URL.
  }
}

async function consumeNativeBypassForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  const key = `${PDF_NATIVE_BYPASS_KEY_PREFIX}${tabId}`;
  try {
    const stored = await api?.storage?.local?.get?.(key);
    const timestamp = Number(stored?.[key]);
    if (!Number.isFinite(timestamp)) return false;
    await api?.storage?.local?.remove?.(key);
    return Date.now() - timestamp <= PDF_NATIVE_BYPASS_TTL_MS;
  } catch {
    return false;
  }
}

async function fallbackToNative(message = '') {
  if (message) setStatus(message, 'error');
  try {
    const params = new URLSearchParams(globalThis.location.search);
    const url = new URL(String(params.get('url') || ''));
    const tabIdValue = params.get('tabId');
    const tabId = tabIdValue == null ? NaN : Number(tabIdValue);
    if (['http:', 'https:'].includes(url.protocol) && Number.isInteger(tabId) && tabId >= 0) {
      let targetTabId = tabId;
      try {
        const currentTab = await api?.tabs?.getCurrent?.();
        if (Number.isInteger(currentTab?.id) && currentTab.id >= 0) {
          targetTabId = currentTab.id;
        }
      } catch {}
      await markNativeBypassForTab(targetTabId);
      await api?.tabs?.update?.(targetTabId, { url: url.href });
      return;
    }
  } catch {
    // This was not an explicit top-level viewer, so try the MIME handler path.
  }
  try {
    if (api?.mimeHandler?.abortAndFallbackToNativeHandler) {
      await api.mimeHandler.abortAndFallbackToNativeHandler();
    }
  } catch {
    // Keep the actionable error visible if native fallback is unavailable.
  }
}

async function disablePdfViewerAndFallback() {
  if (elements['disable-pdf-viewer']) elements['disable-pdf-viewer'].disabled = true;
  try {
    await api?.storage?.local?.set?.({ [PDF_VIEWER_ENABLED_KEY]: false });
  } catch {
    // Continue with runtime disable and fallback even if storage write fails.
  }
  try {
    await api?.mimeHandler?.setMimeHandlerOptions?.('application/pdf', { enabled: false });
  } catch {
    // Background storage listener also reconciles mimeHandler options.
  }
  await fallbackToNative();
}

function clampScale(value) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(value) || 1));
}

function pageCanvasDimensions(viewport, pixelRatio) {
  return {
    width: Math.max(1, Math.floor(viewport.width * pixelRatio)),
    height: Math.max(1, Math.floor(viewport.height * pixelRatio)),
  };
}

function updatePageControls() {
  const total = state.pdf?.numPages || 0;
  elements['page-number'].value = String(state.currentPage);
  elements['page-number'].max = String(Math.max(1, total));
  elements['page-count'].textContent = total ? String(total) : '—';
  elements['previous-page'].disabled = !total || state.currentPage <= 1;
  elements['next-page'].disabled = !total || state.currentPage >= total;
  updateOcrControl();
}

function currentPageHasNativeText() {
  // Unrendered shells have no text layer yet; assume text exists so the OCR
  // button does not flash on before the window render completes.
  if (!state.renderedPages.has(state.currentPage)) return true;
  return hasNativeTextSpans(state.pageViews.get(state.currentPage));
}

function updateOcrControl() {
  const button = elements['ocr-page'];
  if (!button) return;
  const hasOcr = state.ocrCache.has(state.currentPage);
  button.hidden = currentPageHasNativeText() || hasOcr || state.ocrInFlight;
  button.disabled = !state.pdf || state.ocrInFlight;
  const cancelButton = elements['cancel-ocr-page'];
  if (cancelButton) {
    cancelButton.hidden = !state.ocrInFlight;
    cancelButton.disabled = !state.ocrInFlight;
  }
}

function enableViewerControls() {
  for (const control of document.querySelectorAll('.pdf-controls button, .pdf-controls input')) {
    control.disabled = false;
  }
  updatePageControls();
}

function cancelRender() {
  state.renderSequence += 1;
  clearTimeout(state.windowRenderTimer);
  state.windowRenderTimer = null;
  state.windowRenderSequence += 1;
  const pendingTask = state.renderTask;
  state.renderTask = null;
  try { pendingTask?.cancel?.(); } catch { /* a completed render cannot be cancelled */ }
}

function isCurrentRender(sequence) {
  return sequence === state.renderSequence;
}

function isCurrentWindowRender(sequence, windowSequence) {
  return isCurrentRender(sequence)
    && (windowSequence == null || windowSequence === state.windowRenderSequence);
}

// PDF.js treats an explicit `rotation` as the page's *total* rotation and
// drops its intrinsic /Rotate entry, so a landscape scan stored as /Rotate 90
// would render sideways. Compose the viewer rotation on top of the page's own.
function pageRotation(page) {
  const intrinsic = Number(page?.rotate) || 0;
  return (((intrinsic + state.rotation) % 360) + 360) % 360;
}

// PDF.js only sets `--font-height`/`--scale-x` on each text-layer span; the
// span's real font size comes from `--total-scale-factor`, which the embedding
// page owns. Without it every span falls back to the body font and the
// selectable boxes stop lining up with the glyphs painted on the canvas.
function applyTextLayerScale(element, viewport) {
  element?.style?.setProperty(
    '--total-scale-factor',
    String((Number(viewport?.scale) || 1) * (Number(viewport?.userUnit) || 1)),
  );
}

// `span.markedContent` wrappers are emitted for tagged PDFs even when the page
// carries no glyphs, so an element check alone would hide the OCR button on a
// scanned page. Require a span that actually contains text.
function hasNativeTextSpans(container) {
  for (const span of container?.querySelectorAll?.('span:not([data-webbrain-ocr])') || []) {
    if (span.textContent?.trim()) return true;
  }
  return false;
}

function renderScaleFor(page) {
  if (!state.fitWidth) return clampScale(state.scale);
  const naturalViewport = page.getViewport({ scale: 1, rotation: pageRotation(page) });
  const availableWidth = Math.max(240, elements['pdf-stage'].clientWidth - 48);
  return clampScale(availableWidth / naturalViewport.width);
}

function createPageShell(pageNumber, width, height) {
  const pageView = document.createElement('section');
  pageView.className = 'pdf-page';
  pageView.dataset.pageNumber = String(pageNumber);
  pageView.style.width = `${Math.ceil(width)}px`;
  pageView.style.height = `${Math.ceil(height)}px`;
  pageView.setAttribute('aria-label', `PDF page ${pageNumber} of ${state.pdf.numPages}`);
  elements['pdf-pages'].append(pageView);
  state.pageViews.set(pageNumber, pageView);
  return pageView;
}

function createPageView(pageNumber, viewport) {
  let pageView = state.pageViews.get(pageNumber);
  if (!pageView) {
    pageView = createPageShell(pageNumber, viewport.width, viewport.height);
  } else {
    pageView.style.width = `${Math.ceil(viewport.width)}px`;
    pageView.style.height = `${Math.ceil(viewport.height)}px`;
    pageView.replaceChildren();
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.setAttribute('aria-label', `PDF page ${pageNumber}`);

  const textLayer = document.createElement('div');
  textLayer.className = 'pdf-text-layer textLayer';
  textLayer.style.width = `${Math.ceil(viewport.width)}px`;
  textLayer.style.height = `${Math.ceil(viewport.height)}px`;
  pageView.append(canvas, textLayer);
  return { pageView, canvas, textLayer };
}

function releaseFarPages(centerPageNumber) {
  if (state.printing || (state.pdf?.numPages || 0) <= EAGER_PAGE_LIMIT) return;
  for (const pageNumber of Array.from(state.renderedPages)) {
    if (Math.abs(pageNumber - centerPageNumber) > RENDER_WINDOW) {
      const pageView = state.pageViews.get(pageNumber);
      if (pageView) {
        // Drop the bitmap + text nodes; the sized shell stays for scroll position.
        for (const canvas of pageView.querySelectorAll('canvas')) {
          try {
            canvas.width = 0;
            canvas.height = 0;
          } catch {}
        }
        pageView.replaceChildren();
      }
      state.renderedPages.delete(pageNumber);
    }
  }
}

async function renderPage(pageNumber, sequence, windowSequence = null) {
  if (!isCurrentWindowRender(sequence, windowSequence)) return false;
  if (state.renderedPages.has(pageNumber)) return state.pageViews.get(pageNumber) || false;
  const page = await state.pdf.getPage(pageNumber);
  if (!isCurrentWindowRender(sequence, windowSequence)) return false;
  const renderScale = renderScaleFor(page);
  const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
  const rotation = pageRotation(page);
  const viewport = page.getViewport({ scale: renderScale, rotation });
  const renderViewport = page.getViewport({ scale: renderScale * pixelRatio, rotation });
  const { pageView, canvas, textLayer } = createPageView(pageNumber, viewport);
  applyTextLayerScale(pageView, viewport);
  const dimensions = pageCanvasDimensions(viewport, pixelRatio);
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  canvas.style.width = `${Math.ceil(viewport.width)}px`;
  canvas.style.height = `${Math.ceil(viewport.height)}px`;
  const context = canvas.getContext('2d', { alpha: false });
  const task = page.render({ canvasContext: context, viewport: renderViewport });
  state.renderTask = task;
  try {
    await task.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException' || !isCurrentWindowRender(sequence, windowSequence)) return false;
    throw error;
  } finally {
    if (state.renderTask === task) state.renderTask = null;
  }
  if (!isCurrentWindowRender(sequence, windowSequence)) return false;

  const layer = new state.pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayer,
    viewport,
  });
  await layer.render();
  if (!isCurrentWindowRender(sequence, windowSequence)) return false;
  if (hasNativeTextSpans(textLayer)) {
    state.textLayerCount += 1;
  } else {
    const ocrLines = state.ocrCache.get(pageNumber);
    const rendered = renderPdfOcrTextLayer(textLayer, ocrLines, viewport.width, viewport.height);
    if (rendered) state.ocrTextLayerCount += 1;
  }
  state.renderedPages.add(pageNumber);
  return pageView;
}

async function ensureWindowAround(centerPageNumber, sequence, windowSequence = null) {
  const total = state.pdf?.numPages || 0;
  if (!total) return false;
  const center = Math.max(1, Math.min(total, Math.floor(Number(centerPageNumber) || 1)));
  // Nearest-first so the visible page fills in before its neighbors.
  const order = [center];
  for (let offset = 1; offset <= RENDER_WINDOW; offset++) {
    if (center - offset >= 1) order.push(center - offset);
    if (center + offset <= total) order.push(center + offset);
  }
  for (const pageNumber of order) {
    const pageView = await renderPage(pageNumber, sequence, windowSequence);
    if (!pageView || !isCurrentWindowRender(sequence, windowSequence)) return false;
  }
  if (!isCurrentWindowRender(sequence, windowSequence)) return false;
  releaseFarPages(center);
  return true;
}

function scheduleWindowRender() {
  if (!state.pdf || state.pdf.numPages <= EAGER_PAGE_LIMIT || state.printing) return;
  clearTimeout(state.windowRenderTimer);
  const windowSequence = ++state.windowRenderSequence;
  state.windowRenderTimer = setTimeout(() => {
    state.windowRenderTimer = null;
    const sequence = state.renderSequence;
    const center = state.currentPage;
    ensureWindowAround(center, sequence, windowSequence)
      .then((ok) => {
        if (ok && isCurrentWindowRender(sequence, windowSequence)) updatePageControls();
      })
      .catch(() => {});
  }, WINDOW_RENDER_DEBOUNCE_MS);
}

async function renderAllPages() {
  if (!state.pdf) return false;
  const sequence = ++state.renderSequence;
  clearTimeout(state.windowRenderTimer);
  state.windowRenderTimer = null;
  const windowSequence = ++state.windowRenderSequence;
  state.textLayerCount = 0;
  state.ocrTextLayerCount = 0;
  state.pageViews.clear();
  state.renderedPages.clear();
  elements['pdf-pages'].replaceChildren();
  const total = state.pdf.numPages;
  if (total <= EAGER_PAGE_LIMIT) {
    setStatus(`Rendering ${total} pages…`);
    for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber++) {
      const pageView = await renderPage(pageNumber, sequence);
      if (!pageView || !isCurrentRender(sequence)) return false;
    }
    if (!isCurrentRender(sequence)) return false;
    state.scale = renderScaleFor(await state.pdf.getPage(state.currentPage));
    updatePageControls();
    const target = state.pageViews.get(state.requestedPage);
    target?.scrollIntoView({ block: 'start' });
    if (state.textLayerCount === 0 && state.ocrTextLayerCount === 0) {
      setStatus(`Loaded ${total} pages; this PDF has no selectable text. Use OCR on the current page when a vision model is available.`, 'warning');
    } else {
      setStatus(`Page ${state.currentPage} of ${total} · ${Math.round(state.scale * 100)}%`);
    }
    updateOcrControl();
    return true;
  }
  // Virtualized path: sized shells for scrollbar + rendered window around the
  // requested page. Sizes are estimated from the first page and corrected as
  // each page renders, avoiding an O(n) getPage scan and O(n) canvas memory.
  setStatus(`Rendering page ${state.requestedPage} of ${total}…`);
  let shellWidth = 800;
  let shellHeight = 1050;
  try {
    const firstPage = await state.pdf.getPage(1);
    if (!isCurrentRender(sequence)) return false;
    const firstViewport = firstPage.getViewport({ scale: renderScaleFor(firstPage), rotation: pageRotation(firstPage) });
    shellWidth = firstViewport.width;
    shellHeight = firstViewport.height;
  } catch {
    // Fall back to the default shell size above.
  }
  for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber++) {
    createPageShell(pageNumber, shellWidth, shellHeight);
    if (!isCurrentRender(sequence)) return false;
  }
  state.currentPage = Math.max(1, Math.min(total, Math.floor(Number(state.requestedPage) || 1)));
  const ok = await ensureWindowAround(state.currentPage, sequence, windowSequence);
  if (!ok || !isCurrentRender(sequence)) return false;
  try {
    state.scale = renderScaleFor(await state.pdf.getPage(state.currentPage));
  } catch {}
  updatePageControls();
  const target = state.pageViews.get(state.requestedPage);
  target?.scrollIntoView({ block: 'start' });
  setStatus(`Page ${state.currentPage} of ${total} · ${Math.round(state.scale * 100)}%`);
  updateOcrControl();
  return true;
}

function setCurrentPage(pageNumber) {
  const total = state.pdf?.numPages || 1;
  state.currentPage = Math.max(1, Math.min(total, Math.floor(Number(pageNumber) || 1)));
  updatePageControls();
}

function setPageStatus() {
  if (!state.pdf) return;
  setStatus(`Page ${state.currentPage} of ${state.pdf.numPages} · ${Math.round(state.scale * 100)}%`);
}

function scrollToPage(pageNumber) {
  setCurrentPage(pageNumber);
  state.requestedPage = state.currentPage;
  state.pageViews.get(state.currentPage)?.scrollIntoView({ block: 'start' });
  setPageStatus();
  scheduleWindowRender();
}

function updateCurrentPageFromScroll() {
  // Throttle the O(n) page-distance scan to one pass per animation frame so
  // fast scrolls over a large document do not run getBoundingClientRect for
  // every shell on every scroll event.
  if (state.scrollFrame) return;
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = null;
    if (!state.pageViews.size) return;
    const stageRect = elements['pdf-stage'].getBoundingClientRect();
    let mostVisiblePage = state.currentPage;
    let mostVisible = 0;
    let closestPage = state.currentPage;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const [pageNumber, pageView] of state.pageViews) {
      const rect = pageView.getBoundingClientRect();
      // Track the page that occupies most of the viewport. A nearest-top scan
      // hands over to the next page as soon as its top edge gets closer, so on
      // a page taller than the stage the counter — and "OCR page" — would jump
      // ahead while the user is still reading the current page.
      const visible = Math.min(rect.bottom, stageRect.bottom) - Math.max(rect.top, stageRect.top);
      if (visible > mostVisible) {
        mostVisible = visible;
        mostVisiblePage = pageNumber;
      }
      const distance = Math.abs(rect.top - stageRect.top - 12);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = pageNumber;
      }
    }
    const nextPage = mostVisible > 0 ? mostVisiblePage : closestPage;
    if (nextPage !== state.currentPage) {
      setCurrentPage(nextPage);
      state.requestedPage = state.currentPage;
      setPageStatus();
      scheduleWindowRender();
    }
  });
}

async function ocrCurrentPage() {
  const pageNumber = state.currentPage;
  if (!state.pdf || !Number.isInteger(state.streamInfo?.tabId) || state.streamInfo.tabId < 0 || state.ocrInFlight) return;
  // The current page should already be rendered by the visible window, but a
  // fast scroll may have moved on before the debounced render ran. Ensure it.
  if (!state.renderedPages.has(pageNumber)) {
    clearTimeout(state.windowRenderTimer);
    state.windowRenderTimer = null;
    const windowSequence = ++state.windowRenderSequence;
    const rendered = await ensureWindowAround(pageNumber, state.renderSequence, windowSequence).catch(() => false);
    if (rendered) updatePageControls();
  }
  const pageView = state.pageViews.get(pageNumber);
  const canvas = pageView?.querySelector('.pdf-canvas');
  if (!pageView || !canvas) return;
  setStatus(`Capturing page ${pageNumber} for OCR…`);
  let imageDataUrl;
  try {
    imageDataUrl = canvas.toDataURL('image/png');
  } catch (error) {
    setStatus(`OCR could not capture page ${pageNumber}: ${error?.message || String(error)}`, 'error');
    return;
  }

  state.ocrInFlight = true;
  const requestId = `pdf-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.ocrRequestId = requestId;
  updateOcrControl();
  setStatus(`Reading text from page ${pageNumber} with OCR…`);
  try {
    const response = await api.runtime.sendMessage({
      target: 'background',
      action: 'ocr_pdf_page',
      requestId,
      tabId: state.streamInfo.tabId,
      originalUrl: String(state.streamInfo.originalUrl || ''),
      pageNumber,
      imageDataUrl,
    });
    if (state.ocrRequestId !== requestId) return;
    if (!response?.success) {
      throw new Error(response?.error || 'No OCR result was returned.');
    }
    const result = normalizePdfOcrResult(response);
    if (!result.success) throw new Error(result.error);
    setStatus(`Applying OCR to page ${pageNumber}…`);
    const wasCached = state.ocrCache.has(pageNumber);
    state.ocrCache.set(pageNumber, result.lines);
    const textLayer = pageView.querySelector('.pdf-text-layer');
    const rendered = renderPdfOcrTextLayer(textLayer, result.lines, pageView.clientWidth, pageView.clientHeight);
    if (!wasCached && rendered) state.ocrTextLayerCount += 1;
    setStatus(`OCR added ${rendered} text lines on page ${pageNumber}. Select the text to use WebBrain actions.`, 'success');
  } catch (error) {
    if (state.ocrRequestId === requestId) {
      setStatus(`OCR failed on page ${pageNumber}: ${error?.message || String(error)}`, 'error');
    }
  } finally {
    if (state.ocrRequestId === requestId) {
      state.ocrRequestId = null;
      state.ocrInFlight = false;
      updateOcrControl();
    }
  }
}

function cancelOcrRequest() {
  const requestId = state.ocrRequestId;
  if (!requestId) return false;
  state.ocrRequestId = null;
  state.ocrInFlight = false;
  setStatus('OCR cancelled.', 'warning');
  updateOcrControl();
  api.runtime.sendMessage({
    target: 'background',
    action: 'cancel_pdf_ocr',
    requestId,
  }).catch(() => {});
  return true;
}

async function pageText(pageNumber) {
  if (state.textCache.has(pageNumber)) return state.textCache.get(pageNumber);
  const page = await state.pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items.map(item => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
  state.textCache.set(pageNumber, text);
  return text;
}

async function findText(query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const sequence = ++state.searchSequence;
  if (!needle) {
    setStatus(`Page ${state.currentPage} of ${state.pdf.numPages} · ${Math.round(state.scale * 100)}%`);
    return;
  }
  setStatus(`Searching for “${needle}”…`);
  for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber++) {
    const text = await pageText(pageNumber);
    if (sequence !== state.searchSequence) return;
    if (text.toLocaleLowerCase().includes(needle)) {
      scrollToPage(pageNumber);
      setStatus(`Found “${needle}” on page ${pageNumber} of ${state.pdf.numPages}.`, 'success');
      return;
    }
  }
  setStatus(`“${needle}” was not found in this PDF.`, 'warning');
}

function safeFilename() {
  try {
    const url = new URL(String(state.streamInfo?.originalUrl || ''));
    const candidate = decodeURIComponent(url.pathname.split('/').pop() || '').replace(/\.pdf$/i, '');
    const safe = candidate.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 100);
    if (safe) return `${safe}.pdf`;
  } catch { /* use the generic name below */ }
  return 'webbrain-document.pdf';
}

async function downloadPdf() {
  if (!state.pdf) return;
  const bytes = await state.pdf.getData();
  if (!bytes?.byteLength) throw new Error('The loaded PDF has no downloadable data.');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename();
  anchor.style.display = 'none';
  // Appending the anchor to the document first is more reliably treated as a
  // user-initiated download than a detached anchor.click() in some engines.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setStatus(`Downloaded ${anchor.download}.`, 'success');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function printPdf() {
  if (!state.pdf || state.printing) return;
  if (state.pdf.numPages <= EAGER_PAGE_LIMIT) {
    globalThis.print();
    return;
  }

  const returnPage = state.currentPage;
  state.printing = true;
  elements['print-pdf'].disabled = true;
  cancelRender();
  const sequence = state.renderSequence;
  try {
    setStatus(`Rendering all ${state.pdf.numPages} pages for printing…`);
    for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber++) {
      const pageView = await renderPage(pageNumber, sequence);
      if (!pageView || !isCurrentRender(sequence)) throw new Error('Printing was interrupted.');
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    globalThis.print();
  } finally {
    state.printing = false;
    state.currentPage = returnPage;
    state.requestedPage = returnPage;
    elements['print-pdf'].disabled = false;
    await renderAllPages();
  }
}

function rerender() {
  cancelRender();
  return renderAllPages();
}

elements['previous-page'].addEventListener('click', () => scrollToPage(state.currentPage - 1));
elements['next-page'].addEventListener('click', () => scrollToPage(state.currentPage + 1));
elements['page-number'].addEventListener('change', event => scrollToPage(event.target.value));
elements['zoom-out'].addEventListener('click', () => {
  state.fitWidth = false;
  state.scale = clampScale(state.scale - SCALE_STEP);
  rerender().catch(error => fallbackToNative(`WebBrain could not zoom this PDF: ${error?.message || String(error)}`));
});
elements['zoom-in'].addEventListener('click', () => {
  state.fitWidth = false;
  state.scale = clampScale(state.scale + SCALE_STEP);
  rerender().catch(error => fallbackToNative(`WebBrain could not zoom this PDF: ${error?.message || String(error)}`));
});
elements['fit-width'].addEventListener('click', () => {
  state.fitWidth = true;
  rerender().catch(error => fallbackToNative(`WebBrain could not fit this PDF: ${error?.message || String(error)}`));
});
elements['rotate-page'].addEventListener('click', () => {
  cancelOcrRequest();
  state.rotation = (state.rotation + 90) % 360;
  state.ocrCache.clear();
  rerender().catch(error => fallbackToNative(`WebBrain could not rotate this PDF: ${error?.message || String(error)}`));
});
elements['search-form'].addEventListener('submit', event => {
  event.preventDefault();
  findText(elements['document-search'].value).catch(error => setStatus(`Search failed: ${error?.message || String(error)}`, 'error'));
});
elements['download-pdf'].addEventListener('click', () => {
  downloadPdf().catch(error => setStatus(`Download failed: ${error?.message || String(error)}`, 'error'));
});
elements['print-pdf'].addEventListener('click', () => {
  printPdf().catch(error => fallbackToNative(`WebBrain could not print this PDF: ${error?.message || String(error)}`));
});
elements['ocr-page'].addEventListener('click', () => ocrCurrentPage());
elements['cancel-ocr-page'].addEventListener('click', () => cancelOcrRequest());
elements['native-viewer']?.addEventListener('click', () => {
  fallbackToNative();
});
elements['disable-pdf-viewer']?.addEventListener('click', () => {
  disablePdfViewerAndFallback();
});
elements['pdf-stage'].addEventListener('scroll', updateCurrentPageFromScroll, { passive: true });
globalThis.addEventListener('resize', () => {
  if (!state.pdf || !state.fitWidth || state.printing) return;
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    rerender().catch(error => fallbackToNative(`WebBrain could not resize this PDF: ${error?.message || String(error)}`));
  }, 120);
});
globalThis.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === 'ArrowLeft') scrollToPage(state.currentPage - 1);
  if (event.key === 'ArrowRight') scrollToPage(state.currentPage + 1);
  if (event.key === '+' || event.key === '=') elements['zoom-in'].click();
  if (event.key === '-') elements['zoom-out'].click();
});

async function initialize() {
  const explicitUrl = (() => {
    try {
      const value = new URLSearchParams(globalThis.location.search).get('url');
      const url = new URL(String(value || ''));
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  })();
  const explicitTabIdValue = new URLSearchParams(globalThis.location.search).get('tabId');
  const explicitTabId = explicitTabIdValue == null ? NaN : Number(explicitTabIdValue);
  const explicitViewer = Boolean(explicitUrl && Number.isInteger(explicitTabId) && explicitTabId >= 0);
  const hasMimeHandler = typeof api?.mimeHandler?.getStreamInfo === 'function';
  if (!explicitViewer && !hasMimeHandler) {
    throw new Error('Chrome PDF MIME handler API is unavailable. Use the explicit WebBrain PDF viewer entry instead.');
  }
  if (!explicitViewer) {
    const stored = await api.storage.local.get({ [PDF_VIEWER_ENABLED_KEY]: true });
    if (stored?.[PDF_VIEWER_ENABLED_KEY] !== true) {
      await fallbackToNative();
      return;
    }
  }
  const streamInfo = explicitViewer
    ? { streamUrl: explicitUrl, tabId: explicitTabId, originalUrl: explicitUrl, embedded: false }
    : await api.mimeHandler.getStreamInfo();
  if (!explicitViewer) {
    if (await consumeNativeBypassForTab(streamInfo?.tabId)) {
      await fallbackToNative();
      return;
    }
    if (elements['disable-pdf-viewer']) elements['disable-pdf-viewer'].hidden = false;
    api?.storage?.onChanged?.addListener?.((changes, areaName) => {
      if (areaName !== 'local' || !changes?.[PDF_VIEWER_ENABLED_KEY]) return;
      const nextValue = changes[PDF_VIEWER_ENABLED_KEY].newValue;
      if (nextValue !== undefined && nextValue !== true) {
        fallbackToNative();
      }
    });
  }
  if (!streamInfo?.streamUrl || !Number.isInteger(streamInfo.tabId)) {
    throw new Error('No readable PDF stream was provided. Open an online PDF or use the explicit WebBrain PDF viewer link.');
  }
  state.streamInfo = streamInfo;
  if (streamInfo.embedded === true) document.body.dataset.embedded = 'true';
  elements['pdf-title'].textContent = String(streamInfo.originalUrl || 'WebBrain PDF');
  // The window this viewer is in. The background needs it before its first await to
  // tell whether WebBrain's side panel is already showing there (re-opening it closes it).
  // The tab can be dragged into another window later, so it is kept up to date.
  const submitFields = {
    tabId: streamInfo.tabId,
    originalUrl: String(streamInfo.originalUrl || ''),
  };
  await trackViewerWindow({ api, target: window, fields: submitFields, tabId: streamInfo.tabId }).refresh();
  globalThis.__webbrainSelectionShortcutConfig = {
    submitMessage: 'WB_PDF_SELECTION_SHORTCUT_SUBMIT',
    submitFields,
    allowNestedFrame: true,
  };
  await import(api.runtime.getURL('src/content/selection-shortcut.js'));

  const response = await fetch(streamInfo.streamUrl, { credentials: 'include' });
  if (!response.ok) throw new Error(`Chrome PDF stream returned HTTP ${response.status}.`);
  const bytes = await readPdfResponseBytes(response, {
    maxBytes: MAX_PDF_BYTES,
    emptyMessage: 'Chrome returned an empty PDF stream.',
    unreadableMessage: 'Chrome PDF stream could not be read safely.',
  });

  state.pdfjs = await import(api.runtime.getURL('vendor/pdfjs/index.mjs'));
  state.pdfjs.GlobalWorkerOptions.workerSrc = api.runtime.getURL('vendor/pdfjs/worker.mjs');
  state.pdf = await state.pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  if (state.pdf.numPages > MAX_PDF_PAGES) {
    throw new Error(`This PDF has more than ${MAX_PDF_PAGES} pages, so Chrome's native viewer will be used.`);
  }
  enableViewerControls();
  await renderAllPages();
}

initialize().catch(error => {
  fallbackToNative(`WebBrain could not render this PDF: ${error?.message || String(error)}`);
});
