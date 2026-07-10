/**
 * Local, heuristic screenshot redaction for the Vision pipeline.
 *
 * Goal (see issue #312): before any screenshot is sent to a Vision endpoint,
 * blur/redact locally-detected PII so it never leaves the browser. Everything
 * here runs inside the extension — no redaction data is ever transmitted.
 *
 * Phase 1 (this file) is a fully-local, no-model heuristic:
 *   - Form fields (password / text / email / tel / search inputs, textareas)
 *     are redacted using DOM-aware capture metadata (their on-screen rects).
 *   - Emails and phone numbers rendered as page text are redacted by scanning
 *     element text for common PII patterns (also DOM-aware — the content
 *     script supplies the rects of matching elements).
 *
 * Phase 2 (future, optional) could add an on-device NER model via
 * transformers.js + WebGPU for higher-confidence detection; it would feed the
 * same `regions` shape into `pixelateDataUrl`. Phase 1 already degrades
 * gracefully when WebGPU is unavailable because it needs no model.
 *
 * IMPORTANT LIMITATION: this is best-effort, regex/DOM heuristics. It is NOT a
 * security guarantee. Anything not rendered as a recognized element/text
 * (canvas-drawn text, images containing PII, etc.) may slip through. The UI
 * surfaces this disclaimer.
 *
 * The pure helpers (`selectRedactionRegions`, `mapRegionsToImage`,
 * `REGION_KIND`) contain no browser APIs so they can be unit-tested under
 * plain Node. `pixelateDataUrl` uses OffscreenCanvas and only runs inside the
 * service worker.
 */

// Kinds of regions we redact. Kept as a frozen set so callers can decide
// whether to redact each kind (e.g. only blur passwords, or also blur
// detected emails/phones).
export const REGION_KIND = Object.freeze({
  PASSWORD: 'password',
  INPUT: 'input',
  EMAIL: 'email',
  PHONE: 'phone',
});

// Matches most address-like strings: local@domain.tld, possibly with
// subdomains and +tags. Intentionally conservative — we'd rather miss an odd
// address than blur half the page.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Phone heuristic: 7–15 digits, optionally with an international prefix
// (+, 00) and common separators (spaces, dashes, dots, parentheses). The
// leading/trailing digit requirement plus the digit-count floor avoids
// matching arbitrary short numbers. We also reject pure year-like 4-digit
// runs (handled below in selectRedactionRegions).
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/;

// Input element types whose *value* is sensitive and should always be
// redacted when redaction is on.
const SENSITIVE_INPUT_TYPES = new Set([
  'password', 'email', 'tel', 'search', 'text', 'url', 'number',
]);

/**
 * Decide which regions to redact from a list of page element descriptors.
 *
 * @param {Array<{
 *   kind: 'input'|'textarea'|'select'|'text',
 *   type?: string,            // input type attribute (lowercased)
 *   rect: {x:number,y:number,w:number,h:number}, // CSS pixels
 *   text?: string,            // innerText for text elements
 *   value?: string            // current value for inputs
 * }>} elements
 * @param {object} [opts]
 * @param {boolean} [opts.redactTextInputs=true]  Blur plain text/email/tel inputs (not just passwords).
 * @param {boolean} [opts.redactDetectedPii=true] Blur text elements matching email/phone patterns.
 * @param {number} [opts.maxRegions=400]          Safety cap on returned regions.
 * @param {{x?:number,y?:number,w?:number,h?:number}} [opts.viewport]  Captured area in the SAME
 *   CSS-pixel space as the element rects. Regions fully outside it are dropped
 *   (e.g. a budget-scaled viewport capture that doesn't include a far-off
 *   element). Optional — when omitted, no culling is applied.
 * @returns {Array<{kind:string, rect:{x,y,w,h}}>} Regions in the SAME coordinate space as the input rects.
 */
export function selectRedactionRegions(elements, opts = {}) {
  if (!Array.isArray(elements)) return [];
  const redactTextInputs = opts.redactTextInputs !== false;
  const redactDetectedPii = opts.redactDetectedPii !== false;
  const maxRegions = Number.isFinite(opts.maxRegions) ? opts.maxRegions : 400;

  // Optional captured-area cull. Only applied when the caller passes a finite
  // viewport box; otherwise every selected region is kept (full-page mode).
  const vx = opts.viewport && Number.isFinite(opts.viewport.x) ? opts.viewport.x : 0;
  const vy = opts.viewport && Number.isFinite(opts.viewport.y) ? opts.viewport.y : 0;
  const vw = opts.viewport && Number.isFinite(opts.viewport.w) ? opts.viewport.w : (opts.viewport && Number.isFinite(opts.viewport.width) ? opts.viewport.width : Infinity);
  const vh = opts.viewport && Number.isFinite(opts.viewport.h) ? opts.viewport.h : (opts.viewport && Number.isFinite(opts.viewport.height) ? opts.viewport.height : Infinity);
  const cull = Number.isFinite(vw) && Number.isFinite(vh);

  const out = [];
  for (const el of elements) {
    if (!el || !el.rect) continue;
    const r = el.rect;
    if (!(r.w > 0 && r.h > 0)) continue;

    const kind = String(el.kind || '').toLowerCase();

    if (kind === 'input' || kind === 'textarea' || kind === 'select') {
      const type = String(el.type || '').toLowerCase();
      const isPassword = type === 'password';
      // Always redact password fields. Other sensitive inputs only when the
      // user opted into blurring form fields broadly.
      const sensitive = SENSITIVE_INPUT_TYPES.has(type);
      if (isPassword || (sensitive && redactTextInputs)) {
        if (!cull || rectIntersects(r, vx, vy, vw, vh)) {
          out.push({ kind: isPassword ? REGION_KIND.PASSWORD : REGION_KIND.INPUT, rect: r });
          if (out.length >= maxRegions) return out;
        }
        continue;
      }
    }

    if (redactDetectedPii && kind === 'text') {
      const text = el.text || '';
      if (text.length > 200) continue; // long blobs are noise; skip
      // Require a plausible single token (an address or a phone) rather than
      // a sentence that merely contains one — blurring a whole paragraph for
      // one embedded email is too aggressive.
      const trimmed = text.trim();
      const looksLikeEmail = EMAIL_RE.test(trimmed) && trimmed.split(/\s+/).length <= 3;
      const digitCount = (trimmed.match(/\d/g) || []).length;
      const looksLikePhone = digitCount >= 7 && digitCount <= 15 && PHONE_RE.test(trimmed) &&
        !/^\d{4}$/.test(trimmed) && trimmed.split(/\s+/).length <= 6;
      if (looksLikeEmail) {
        if (!cull || rectIntersects(r, vx, vy, vw, vh)) {
          out.push({ kind: REGION_KIND.EMAIL, rect: r });
          if (out.length >= maxRegions) return out;
        }
      } else if (looksLikePhone) {
        if (!cull || rectIntersects(r, vx, vy, vw, vh)) {
          out.push({ kind: REGION_KIND.PHONE, rect: r });
          if (out.length >= maxRegions) return out;
        }
      }
    }
  }
  return out;
}

/**
 * True when a CSS-pixel rect overlaps an axis-aligned box. Used to drop
 * redaction regions that fall outside the actually-captured area (e.g. a
 * budget-scaled viewport capture that excludes elements far below the fold).
 *
 * @param {{x,y,w,h}} r
 * @param {number} bx
 * @param {number} by
 * @param {number} bw
 * @param {number} bh
 */
export function rectIntersects(r, bx, by, bw, bh) {
  const rx2 = r.x + r.w;
  const ry2 = r.y + r.h;
  const bx2 = bx + bw;
  const by2 = by + bh;
  return rx2 > bx && r.x < bx2 && ry2 > by && r.y < by2;
}

/**
 * Map CSS-pixel regions to image-pixel regions for a captured screenshot.
 *
 * @param {Array<{kind:string, rect:{x,y,w,h}}>} regions  CSS-pixel regions
 *   relative to the captured area's top-left.
 * @param {object} opts
 * @param {number} [opts.scaleX=1]           Capture scale X (image_px = css_px * scaleX).
 * @param {number} [opts.scaleY=1]           Capture scale Y (image_px = css_px * scaleY).
 *   Either scaleX/scaleY or the legacy single `scale` may be supplied; when
 *   `scale` is given it applies to both axes.
 * @param {number} [opts.scale=1]            Legacy single-axis scale (used when capture isn't
 *   budget-scaled and CSS px == image px on both axes).
 * @param {number} [opts.offsetX=0]          Captured-area left in the page (CSS px).
 * @param {number} [opts.offsetY=0]          Captured-area top in the page (CSS px).
 * @param {number} [opts.imageWidth]         Image width (px); regions are clamped to it.
 * @param {number} [opts.imageHeight]        Image height (px); regions are clamped to it.
 * @returns {Array<{kind:string, rect:{x,y,w,h}}>} Image-pixel regions.
 */
export function mapRegionsToImage(regions, opts = {}) {
  if (!Array.isArray(regions)) return [];
  const scale = Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  const scaleX = Number.isFinite(opts.scaleX) && opts.scaleX > 0 ? opts.scaleX : scale;
  const scaleY = Number.isFinite(opts.scaleY) && opts.scaleY > 0 ? opts.scaleY : scale;
  const offsetX = opts.offsetX || 0;
  const offsetY = opts.offsetY || 0;
  const imgW = opts.imageWidth;
  const imgH = opts.imageHeight;

  return regions.map((region) => {
    const r = region.rect;
    let x = (r.x - offsetX) * scaleX;
    let y = (r.y - offsetY) * scaleY;
    const w = r.w * scaleX;
    const h = r.h * scaleY;

    // Never emit negative/zero dims; clamp into the image bounds so the
    // pixelation step can't draw garbage or throw.
    x = Math.max(0, x);
    y = Math.max(0, y);
    let ww = Math.max(1, w);
    let hh = Math.max(1, h);
    if (Number.isFinite(imgW)) ww = Math.min(ww, imgW - x);
    if (Number.isFinite(imgH)) hh = Math.min(hh, imgH - y);
    if (ww <= 0 || hh <= 0) return null;
    return { kind: region.kind, rect: { x: Math.round(x), y: Math.round(y), w: Math.round(ww), h: Math.round(hh) } };
  }).filter(Boolean);
}

/**
 * Pixelate (blur) the given image-pixel regions on a copy of the screenshot.
 *
 * Works in the MV3 service worker, which has OffscreenCanvas + createImageBitmap
 * but no DOM. Returns a new data URL (same MIME as the input) with the regions
 * redacted. Never throws: on any failure it returns the original dataUrl so
 * the capture is never lost just because redaction failed.
 *
 * @param {string} dataUrl            `data:image/png|jpeg;base64,...`
 * @param {Array<{kind:string, rect:{x,y,w,h}}>} regions  Image-pixel regions.
 * @param {object} [opts]
 * @param {number} [opts.block=10]     Pixelation block size (px). Smaller = sharper.
 * @returns {Promise<string>}
 */
export async function pixelateDataUrl(dataUrl, regions, opts = {}) {
  if (!dataUrl || !Array.isArray(regions) || regions.length === 0) return dataUrl;
  const block = Number.isFinite(opts.block) && opts.block > 0 ? Math.floor(opts.block) : 10;
  try {
    const mime = /^data:(image\/[a-z]+);base64,/.exec(dataUrl)?.[1] || 'image/png';
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(bmp, 0, 0);

    for (const region of regions) {
      const { x, y, w, h } = region.rect;
      // Step 1: downscale the region into a tiny offscreen canvas.
      const sw = Math.max(1, Math.floor(w / block));
      const sh = Math.max(1, Math.floor(h / block));
      const tmp = new OffscreenCanvas(sw, sh);
      const tctx = tmp.getContext('2d');
      if (!tctx) continue;
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(canvas, x, y, w, h, 0, 0, sw, sh);
      // Step 2: upscale back with smoothing off → blocky, unreadable pixels.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
    }

    const outBlob = await canvas.convertToBlob({ type: mime, quality: 0.92 });
    const buf = await outBlob.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  } catch {
    return dataUrl;
  }
}
