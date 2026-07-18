/**
 * Image utilities for the CDP client.
 *
 * Runs in the MV3 service worker, which has OffscreenCanvas and
 * createImageBitmap but no DOM. That's enough to decode base64 PNG tiles,
 * composite them, and re-encode.
 *
 * Nothing here throws into the caller — every utility returns either the
 * combined image or a sensible fallback so full-page captures never go
 * silently empty just because one tile failed to decode.
 */

/**
 * Stitch a grid of viewport screenshots into a single full-page image.
 *
 * @param {Array<{x:number,y:number,width:number,height:number,data:string}>} tiles
 *   Base64 PNG tiles with CSS-pixel positions. Coordinates are in CSS
 *   pixels; the tile's bitmap resolution is CSS × dpr.
 * @param {number} cssWidth   Total content width in CSS pixels.
 * @param {number} cssHeight  Total content height in CSS pixels.
 * @param {number} [dpr=1]    Pixel scale used when the tiles were captured.
 *   The caller passes the page's current devicePixelRatio for native output.
 * @param {{
 *   onWarning?:(message:string)=>void,
 *   onFallback?:(bounds:{x:number,y:number,width:number,height:number})=>void
 * }} [options]
 *   Receives best-effort fallback details without suppressing the returned image.
 * @returns {Promise<string>} Combined image as base64 PNG (no data: prefix),
 *   matching the return shape the caller expects.
 */
export async function combineImages(tiles, cssWidth, cssHeight, dpr = 1, options = {}) {
  if (!Array.isArray(tiles) || tiles.length === 0) return '';
  const warn = (message) => {
    try { options?.onWarning?.(message); } catch {}
  };
  const firstTile = () => tiles[0]?.data || '';
  const assemblyFallback = (reason) => {
    warn(`Full-page screenshot assembly failed (${reason}). Showing the first captured tile instead.`);
    const tile = tiles[0];
    if (tile) {
      try {
        options?.onFallback?.({
          x: Number(tile.x) || 0,
          y: Number(tile.y) || 0,
          width: Number(tile.width) || 0,
          height: Number(tile.height) || 0,
        });
      } catch {}
    }
    return firstTile();
  };

  // Decode every tile in parallel. Bad tiles are dropped rather than
  // aborting the whole composite — a partial full-page image is more useful
  // to the agent than nothing.
  const decodeErrors = [];
  const decoded = await Promise.all(
    tiles.map(async (t) => {
      try {
        const blob = await (await fetch(`data:image/png;base64,${t.data}`)).blob();
        const bmp = await createImageBitmap(blob);
        return { ...t, bmp };
      } catch (error) {
        decodeErrors.push(error?.message || String(error));
        return null;
      }
    })
  );

  const goodTiles = decoded.filter(Boolean);
  if (goodTiles.length === 0) {
    return assemblyFallback(decodeErrors[0] || 'no screenshot tile could be decoded');
  }
  if (goodTiles.length < tiles.length) {
    warn(
      `Full-page screenshot assembly skipped ${tiles.length - goodTiles.length} tile(s) that could not be decoded; the combined image may be incomplete.`
    );
  }

  // Canvas dims are native pixels. Guard against the occasional 0-dim input
  // (empty page, very short pages where contentHeight == 0).
  const canvasW = Math.max(1, Math.round(cssWidth * dpr));
  const canvasH = Math.max(1, Math.round(cssHeight * dpr));
  let canvas;
  let ctx;
  try {
    canvas = new OffscreenCanvas(canvasW, canvasH);
    ctx = canvas.getContext('2d');
  } catch (error) {
    return assemblyFallback(error?.message || String(error));
  }
  if (!ctx) return assemblyFallback('the browser could not create a 2D canvas context');

  let drawFailures = 0;
  for (const t of goodTiles) {
    const dx = Math.round(t.x * dpr);
    const dy = Math.round(t.y * dpr);
    // Draw the whole bitmap — its intrinsic size already matches the
    // tile's CSS width/height × dpr. If it's larger than the destination
    // slot (e.g. last-row or last-column tiles captured at native viewport
    // even though only part is content), clip via width/height args.
    const dw = Math.min(bmpWidth(t.bmp), canvasW - dx);
    const dh = Math.min(bmpHeight(t.bmp), canvasH - dy);
    if (dw <= 0 || dh <= 0) continue;
    try {
      ctx.drawImage(t.bmp, 0, 0, dw, dh, dx, dy, dw, dh);
    } catch {
      drawFailures++;
    }
  }
  if (drawFailures > 0) {
    warn(
      `Full-page screenshot assembly could not draw ${drawFailures} tile(s); the combined image may be incomplete.`
    );
  }

  // Re-encode as PNG, return base64 (no data URL prefix).
  try {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await blob.arrayBuffer();
    return arrayBufferToBase64(buf);
  } catch (error) {
    return assemblyFallback(error?.message || String(error));
  }
}

function bmpWidth(bmp) { return bmp?.width || 0; }
function bmpHeight(bmp) { return bmp?.height || 0; }

/**
 * Encode an ArrayBuffer to base64 without blowing the call stack on large
 * buffers (a full-page screenshot can easily be 10+ MB).
 */
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
