// Browser-free change detection between two screenshots for vision mode.
// Shared verbatim by the Chrome and Firefox builds (test/vision-mode.mjs).
//
// After an action WebBrain captures the viewport again and compares it with
// the last image the model saw. Only the changed rectangles are sent back
// (a "patch"), or nothing at all when the action changed nothing visible.
// A typical click that opens a menu or types into a field changes 2-15% of
// the screen, so a patch costs a fraction of a full frame's tokens and
// upload time — and "no visible change" is itself the clearest signal that a
// click missed.
//
// Inputs are RGBA byte arrays (ImageData.data) of identical dimensions.
// The comparison is cell-based: JPEG/WebP re-encoding noise, sub-pixel text
// antialiasing and a blinking caret change a few pixels in a cell; real UI
// changes flip many. Thresholds below were tuned on captured UI frames
// (test/vision-pipeline-browser.mjs).

export const VISION_DIFF_DEFAULTS = Object.freeze({
  cellSize: 16,
  // Sum of absolute R+G+B differences above which one pixel counts as
  // changed (0..765). 40 ignores encoder noise but catches 1px text edits.
  pixelThreshold: 40,
  // Changed pixels a cell needs before it counts (out of cellSize^2 = 256).
  minChangedPixelsPerCell: 6,
  // Neighbouring changed cells closer than this (in cells) share a region.
  mergeGapCells: 2,
  // Padding (image px) around each region so the model sees context.
  padding: 8,
  maxRegions: 4,
});

export const VISION_UPDATE_DEFAULTS = Object.freeze({
  // Above this share of the frame a full keyframe is simpler for the model
  // and barely more expensive than patches.
  maxPatchAreaRatio: 0.45,
  // Patches are only meaningful next to their keyframe; a long chain also
  // accumulates subthreshold drift, so refresh periodically.
  maxPatchChain: 6,
  // Patches whose estimated token cost reaches this share of a keyframe's
  // are replaced by the keyframe.
  maxPatchTokenRatio: 0.7,
  // Smallest patch side (image px). Tiny slivers are hard to read, so they
  // are grown to at least this size around their centre.
  minPatchSide: 48,
  // The provider's image grid (vision-budget.js profile.align). Patch sides
  // are grown to multiples of it, like frames and zooms, so a server that
  // resizes images to its grid (Qwen2/2.5-VL, UI-TARS: 28 px) receives the
  // patch unchanged and its pixels map 1:1 to the frame.
  align: 1,
});

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Compare two RGBA frames. Returns changed cell statistics and merged,
 * padded change regions in image pixels.
 */
export function diffFrames(previous, next, width, height, options = {}) {
  const opts = { ...VISION_DIFF_DEFAULTS, ...options };
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const expected = w * h * 4;
  if (!previous || !next || previous.length < expected || next.length < expected) {
    return { comparable: false, regions: [], changedCells: 0, totalCells: 0, changedRatio: 1, regionAreaRatio: 1 };
  }
  const cell = Math.max(2, Math.floor(opts.cellSize));
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const counts = new Uint16Array(cols * rows);
  const threshold = opts.pixelThreshold;
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 4;
    const cellRow = Math.floor(y / cell) * cols;
    for (let x = 0; x < w; x++) {
      const i = rowBase + x * 4;
      const d = Math.abs(previous[i] - next[i]) + Math.abs(previous[i + 1] - next[i + 1]) + Math.abs(previous[i + 2] - next[i + 2]);
      if (d > threshold) counts[cellRow + Math.floor(x / cell)]++;
    }
  }
  const changed = new Uint8Array(cols * rows);
  let changedCells = 0;
  for (let index = 0; index < counts.length; index++) {
    // Edge cells are smaller; scale their requirement by covered area.
    const cx = index % cols;
    const cy = Math.floor(index / cols);
    const cw = Math.min(cell, w - cx * cell);
    const ch = Math.min(cell, h - cy * cell);
    const need = Math.max(1, Math.round(opts.minChangedPixelsPerCell * (cw * ch) / (cell * cell)));
    if (counts[index] >= need) {
      changed[index] = 1;
      changedCells++;
    }
  }
  const totalCells = cols * rows;
  if (!changedCells) {
    return {
      comparable: true,
      regions: [],
      changedCells: 0,
      totalCells,
      changedRatio: 0,
      regionAreaRatio: 0,
      cols,
      rows,
      cellSize: cell,
      width: w,
      height: h,
      changed,
    };
  }
  const boxes = connectedCellBoxes(changed, cols, rows, Math.max(0, Math.floor(opts.mergeGapCells)));
  let regions = boxes.map(box => ({
    x: box.x0 * cell,
    y: box.y0 * cell,
    width: Math.min(w, (box.x1 + 1) * cell) - box.x0 * cell,
    height: Math.min(h, (box.y1 + 1) * cell) - box.y0 * cell,
    cells: box.cells,
  }));
  regions = regions.map(region => padRegion(region, opts.padding, w, h));
  regions = mergeOverlappingRegions(regions, opts.padding);
  if (regions.length > opts.maxRegions) {
    regions = reduceRegions(regions, opts.maxRegions);
  }
  regions.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const regionArea = regions.reduce((sum, region) => sum + region.width * region.height, 0);
  return {
    comparable: true,
    regions,
    changedCells,
    totalCells,
    changedRatio: changedCells / totalCells,
    regionAreaRatio: Math.min(1, regionArea / (w * h)),
    cols,
    rows,
    cellSize: cell,
    width: w,
    height: h,
    changed,
  };
}

// Group changed cells into bounding boxes. Cells within `gap` cells of each
// other join one group (a dilation without allocating a second grid).
function connectedCellBoxes(changed, cols, rows, gap) {
  const seen = new Uint8Array(changed.length);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, cells: 0 };
    while (stack.length) {
      const index = stack.pop();
      const x = index % cols;
      const y = Math.floor(index / cols);
      box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
      box.cells++;
      for (let dy = -1 - gap; dy <= 1 + gap; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1 - gap; dx <= 1 + gap; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= cols || (dx === 0 && dy === 0)) continue;
          const neighbour = ny * cols + nx;
          if (changed[neighbour] && !seen[neighbour]) {
            seen[neighbour] = 1;
            stack.push(neighbour);
          }
        }
      }
    }
    boxes.push(box);
  }
  return boxes;
}

export function padRegion(region, padding, width, height) {
  const x0 = clamp(Math.floor(region.x - padding), 0, width);
  const y0 = clamp(Math.floor(region.y - padding), 0, height);
  const x1 = clamp(Math.ceil(region.x + region.width + padding), 0, width);
  const y1 = clamp(Math.ceil(region.y + region.height + padding), 0, height);
  return { ...region, x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

function intersectsOrTouches(a, b, slack = 0) {
  return a.x <= b.x + b.width + slack && b.x <= a.x + a.width + slack
    && a.y <= b.y + b.height + slack && b.y <= a.y + a.height + slack;
}

export function unionRegion(a, b) {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, cells: (a.cells || 0) + (b.cells || 0) };
}

export function mergeOverlappingRegions(regions, slack = 0) {
  let list = regions.map(region => ({ ...region }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (intersectsOrTouches(list[i], list[j], slack)) {
          list[i] = unionRegion(list[i], list[j]);
          list.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return list;
}

// Merge the pair whose union wastes the least area until `max` remain.
function reduceRegions(regions, max) {
  let list = regions.map(region => ({ ...region }));
  while (list.length > max) {
    let best = null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const union = unionRegion(list[i], list[j]);
        const waste = union.width * union.height - list[i].width * list[i].height - list[j].width * list[j].height;
        if (!best || waste < best.waste) best = { i, j, union, waste };
      }
    }
    list[best.i] = best.union;
    list.splice(best.j, 1);
    list = mergeOverlappingRegions(list);
  }
  return list;
}

/** Grow a region to at least `minSide` on each axis, centred, inside bounds. */
export function ensureMinimumSize(region, minSide, width, height) {
  let { x, y, width: rw, height: rh } = region;
  if (rw < minSide) {
    const grow = Math.min(width, minSide) - rw;
    x = clamp(Math.floor(x - grow / 2), 0, Math.max(0, width - Math.min(width, minSide)));
    rw = Math.min(width, minSide);
  }
  if (rh < minSide) {
    const grow = Math.min(height, minSide) - rh;
    y = clamp(Math.floor(y - grow / 2), 0, Math.max(0, height - Math.min(height, minSide)));
    rh = Math.min(height, minSide);
  }
  return { ...region, x, y, width: rw, height: rh };
}

/**
 * Grow a region so both sides are multiples of `align` (at least two grid
 * cells), centred on the original and kept inside the frame. A frame planned
 * for the profile is itself a multiple of `align`, so the result covers the
 * original region whenever that fits.
 */
export function alignRegion(region, align, width, height) {
  const step = Math.max(1, Math.floor(Number(align) || 1));
  if (step <= 1) return region;
  const fit = (size, bound) => {
    const aligned = Math.max(step * 2, Math.ceil(size / step) * step);
    return aligned <= bound ? aligned : (Math.floor(bound / step) * step || bound);
  };
  const w = fit(region.width, width);
  const h = fit(region.height, height);
  const x = clamp(Math.round(region.x + region.width / 2 - w / 2), 0, Math.max(0, width - w));
  const y = clamp(Math.round(region.y + region.height / 2 - h / 2), 0, Math.max(0, height - h));
  return { ...region, x, y, width: w, height: h };
}

// Aligned regions can touch or overlap again: merge, re-align, until stable.
function alignRegions(regions, align, width, height) {
  let list = regions.map(region => alignRegion(region, align, width, height));
  for (let pass = 0; pass < 8; pass++) {
    const merged = mergeOverlappingRegions(list);
    if (merged.length === list.length) return list;
    list = merged.map(region => alignRegion(region, align, width, height));
  }
  return list;
}

/**
 * Decide how to show the model the screen after an action.
 *
 * kind:
 *  - 'keyframe': send a fresh full frame (first frame, layout/URL change,
 *    large or scattered change, long patch chain, forced).
 *  - 'patch': send only `regions` (image px of the current keyframe).
 *  - 'none': nothing visible changed.
 */
export function planFrameUpdate(diff, {
  width,
  height,
  forceKeyframe = false,
  patchChainLength = 0,
  estimateTokens = (w, h) => Math.ceil((w * h) / 784),
  ...options
} = {}) {
  const opts = { ...VISION_UPDATE_DEFAULTS, ...options };
  if (forceKeyframe) return { kind: 'keyframe', reason: 'forced' };
  if (!diff || diff.comparable !== true) return { kind: 'keyframe', reason: 'not_comparable' };
  if (!diff.regions.length) return { kind: 'none', reason: 'no_visible_change' };
  if (patchChainLength >= opts.maxPatchChain) return { kind: 'keyframe', reason: 'patch_chain_limit' };
  if (diff.regionAreaRatio > opts.maxPatchAreaRatio) return { kind: 'keyframe', reason: 'large_change' };
  let regions = mergeOverlappingRegions(
    diff.regions.map(region => ensureMinimumSize(region, opts.minPatchSide, width, height)),
  );
  if (opts.align > 1) regions = alignRegions(regions, opts.align, width, height);
  const patchTokens = regions.reduce((sum, region) => sum + estimateTokens(region.width, region.height), 0);
  const frameTokens = estimateTokens(width, height);
  if (frameTokens > 0 && patchTokens >= frameTokens * opts.maxPatchTokenRatio) {
    return { kind: 'keyframe', reason: 'patch_cost', patchTokens, frameTokens };
  }
  return { kind: 'patch', reason: 'local_change', regions, patchTokens, frameTokens };
}

/**
 * True when a point (image px) lies in, or within `margin` of, any region.
 * Used to refuse a coordinate read from an image whose area has changed.
 */
export function pointTouchesRegions(point, regions, margin = 0) {
  if (!point || !Array.isArray(regions)) return false;
  return regions.some(region => point.x >= region.x - margin && point.x <= region.x + region.width + margin
    && point.y >= region.y - margin && point.y <= region.y + region.height + margin);
}

/**
 * True when a point (image px) lies in, or within `margin` of, any changed
 * cell in a `diffFrames()` result. Unlike `pointTouchesRegions(point, diff.regions, margin)`,
 * this tests the actual changed cell grid (with edge cells clipped to the
 * frame dimensions) rather than padded/merged/reduced patch bounding boxes,
 * so unchanged gaps bridged for screenshot cropping are not treated as changed.
 */
export function pointTouchesChangedCells(point, diff, margin = 0) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !diff || diff.comparable !== true) {
    return false;
  }
  const cell = Number(diff.cellSize);
  const cols = Number(diff.cols);
  const rows = Number(diff.rows);
  if (!(diff.changed instanceof Uint8Array) || !Number.isInteger(cols) || !Number.isInteger(rows)
      || cols <= 0 || rows <= 0 || !(cell > 0) || diff.changed.length < cols * rows) {
    return pointTouchesRegions(point, diff.regions, margin);
  }
  if (!diff.changedCells) return false;
  const m = Math.max(0, Number(margin) || 0);
  const w = Number.isFinite(diff.width) && diff.width > 0 ? Math.floor(diff.width) : cols * cell;
  const h = Number.isFinite(diff.height) && diff.height > 0 ? Math.floor(diff.height) : rows * cell;
  if (point.x < -m || point.y < -m || point.x > w + m || point.y > h + m) return false;
  const cx0 = clamp(Math.floor((point.x - m) / cell) - 1, 0, cols - 1);
  const cx1 = clamp(Math.floor((point.x + m) / cell), 0, cols - 1);
  const cy0 = clamp(Math.floor((point.y - m) / cell) - 1, 0, rows - 1);
  const cy1 = clamp(Math.floor((point.y + m) / cell), 0, rows - 1);
  for (let cy = cy0; cy <= cy1; cy++) {
    const y0 = cy * cell;
    const y1 = Math.min(h, (cy + 1) * cell);
    if (y1 <= y0 || point.y < y0 - m || point.y > y1 + m) continue;
    const rowOffset = cy * cols;
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!diff.changed[rowOffset + cx]) continue;
      const x0 = cx * cell;
      const x1 = Math.min(w, (cx + 1) * cell);
      if (x1 > x0 && point.x >= x0 - m && point.x <= x1 + m) return true;
    }
  }
  return false;
}

/**
 * Copy `regions` of `source` into `target` (both RGBA, same dimensions).
 * Keeps the "what the model has seen" buffer exact after a patch, so
 * changes below the per-cell threshold accumulate until they are sent.
 */
export function copyRegions(target, source, width, regions) {
  for (const region of regions || []) {
    const x0 = Math.max(0, Math.floor(region.x));
    const y0 = Math.max(0, Math.floor(region.y));
    const x1 = Math.min(width, Math.ceil(region.x + region.width));
    const rowBytes = (x1 - x0) * 4;
    if (rowBytes <= 0) continue;
    for (let y = y0; y < y0 + region.height; y++) {
      const start = (y * width + x0) * 4;
      if (start + rowBytes > target.length || start + rowBytes > source.length) break;
      target.set(source.subarray(start, start + rowBytes), start);
    }
  }
  return target;
}
