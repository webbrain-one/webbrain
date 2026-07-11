/**
 * Lightweight, all-frame DOM region collector for local screenshot redaction.
 * Runs in the extension's isolated world. Form field *values* never leave
 * their frame — only rects and kinds are reported. Matched email/phone
 * *text* is the exception: it rides along in the `text` field so the agent
 * can re-classify it, but it never leaves the local background/service
 * worker (no network transmission).
 *
 * The email/phone regex heuristics below (`looksLikePiiText`) are a twin of
 * `EMAIL_RE`/`PHONE_RE` in agent/screenshot-redaction.js. Keep both in sync —
 * this file's pre-filter and the agent's re-classification must agree, or
 * regions selected here can be silently dropped downstream.
 */
(function () {
  'use strict';
  if (globalThis.__webbrain_redaction_regions_injected) return;
  globalThis.__webbrain_redaction_regions_injected = true;

  const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
  if (!runtime?.onMessage) return;

  function collectRedactionRegions(params) {
    const space = params?.coordinateSpace === 'page' ? 'page' : 'viewport';
    const sx = space === 'page' ? (window.scrollX || window.pageXOffset || 0) : 0;
    const sy = space === 'page' ? (window.scrollY || window.pageYOffset || 0) : 0;
    const toRect = (r) => ({
      x: Math.round(r.left + sx),
      y: Math.round(r.top + sy),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
    const visible = (r) => r.width > 0 && r.height > 0 && (
      space === 'page' || (
        r.right > 0 && r.bottom > 0 &&
        r.left < window.innerWidth && r.top < window.innerHeight
      )
    );
    const looksLikePiiText = (text) => {
      const trimmed = String(text || '').trim();
      const looksLikeEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(trimmed) &&
        trimmed.split(/\s+/).length <= 3;
      const digitCount = (trimmed.match(/\d/g) || []).length;
      const looksLikePhone = digitCount >= 7 && digitCount <= 15 &&
        /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/.test(trimmed) &&
        !/^\d{4}$/.test(trimmed) && trimmed.split(/\s+/).length <= 6;
      return looksLikeEmail || looksLikePhone;
    };

    let viewport = {
      width: Math.max(1, Math.round(window.innerWidth || 1)),
      height: Math.max(1, Math.round(window.innerHeight || 1)),
    };
    if (space === 'page') {
      viewport = {
        width: Math.round(Math.max(document.documentElement.scrollWidth || viewport.width, viewport.width)),
        height: Math.round(Math.max(document.documentElement.scrollHeight || viewport.height, viewport.height)),
      };
    }

    const selected = [];
    const MAX_REGIONS = 400;
    try {
      const fields = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]), textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
      );
      for (const el of fields) {
        if (selected.length >= MAX_REGIONS) break;
        const r = el.getBoundingClientRect();
        if (!visible(r)) continue;
        const tag = (el.tagName || '').toLowerCase();
        const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
        const kind = tag === 'select' ? 'select' : (tag === 'textarea' || el.isContentEditable ? 'textarea' : 'input');
        selected.push({ kind, type, rect: toRect(r) });
      }

      const nodes = document.querySelectorAll('p, span, div, a, td, th, li, h1, h2, h3, h4, h5, h6, label, small, b, strong, i');
      let scanned = 0;
      for (const el of nodes) {
        if (scanned++ > 6000 || selected.length >= MAX_REGIONS) break;
        if (el.children.length > 0) continue;
        const text = (el.textContent || '').trim();
        if (text.length < 5 || text.length > 60 || !looksLikePiiText(text)) continue;
        const r = el.getBoundingClientRect();
        if (!visible(r)) continue;
        selected.push({ kind: 'text', type: '', rect: toRect(r), text });
      }
    } catch { /* best effort */ }

    const childFrames = [];
    try {
      for (const frame of document.querySelectorAll('iframe, frame')) {
        const r = frame.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        const transformX = r.width / (frame.offsetWidth || r.width || 1);
        const transformY = r.height / (frame.offsetHeight || r.height || 1);
        childFrames.push({
          url: frame.src || frame.getAttribute('src') || 'about:blank',
          rect: {
            x: r.left + sx + (frame.clientLeft || 0) * transformX,
            y: r.top + sy + (frame.clientTop || 0) * transformY,
            w: (frame.clientWidth || r.width) * transformX,
            h: (frame.clientHeight || r.height) * transformY,
          },
        });
      }
    } catch { /* best effort */ }

    return { elements: selected, viewport, childFrames };
  }

  runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'redaction-content' || msg.action !== 'get_redaction_regions') return;
    sendResponse(collectRedactionRegions(msg.params || {}));
  });
})();
