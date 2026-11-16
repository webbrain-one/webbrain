'use strict';

// Where a new browser window opens. The last window's bounds are saved when it
// closes and reused for every new window, but the display they were on may be
// gone by then: a monitor was unplugged, or the arrangement or resolution
// changed. Electron puts a window exactly where it is told, even entirely
// off-screen, so the saved position is kept only while the window's tab strip
// (which is also its title bar) can still be grabbed on some display.
// Otherwise the window moves onto the display it overlaps most, or, when it
// overlaps none, Electron centers it on the primary display.

const DEFAULT_WIDTH = 1360;
const DEFAULT_HEIGHT = 880;
// The tab strip is the title bar: keep its full height, and at least this much
// of its width, inside one display's work area.
const GRIP_HEIGHT = 38;
const GRIP_MIN_WIDTH = 100;

function overlap(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? { width, height } : null;
}

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const positive = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * @param {{x?: number, y?: number, width?: number, height?: number}|null|undefined} saved
 *   the remembered window bounds, if any
 * @param {Electron.Rectangle[]} workAreas every display's work area, the primary display's first
 * @returns {{width: number, height: number, x?: number, y?: number}} BrowserWindow options;
 *   without x and y, Electron centers the window on the primary display
 */
function initialWindowBounds(saved, workAreas) {
  const primary = workAreas[0];
  const width = positive(saved?.width) || DEFAULT_WIDTH;
  const height = positive(saved?.height) || DEFAULT_HEIGHT;
  const fit = (area) => ({ width: Math.min(width, area.width), height: Math.min(height, area.height) });
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return fit(primary);

  const rect = { x: saved.x, y: saved.y, width, height };
  // Check the strip at the size the window will actually have on that display.
  const home = workAreas.find((area) => {
    const size = fit(area);
    const grip = { x: rect.x, y: rect.y, width: size.width, height: Math.min(GRIP_HEIGHT, size.height) };
    const o = overlap(grip, area);
    return o && o.height >= grip.height && o.width >= Math.min(GRIP_MIN_WIDTH, grip.width);
  });
  if (home) return { x: rect.x, y: rect.y, ...fit(home) };

  let best = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const o = overlap(rect, area);
    if (o && o.width * o.height > bestArea) {
      best = area;
      bestArea = o.width * o.height;
    }
  }
  if (!best) return fit(primary);
  const size = fit(best);
  return {
    x: clamp(rect.x, best.x, best.x + best.width - size.width),
    y: clamp(rect.y, best.y, best.y + best.height - size.height),
    ...size,
  };
}

/** Every display's work area, the primary display's first. */
function displayWorkAreas(screen) {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

module.exports = { initialWindowBounds, displayWorkAreas, DEFAULT_WIDTH, DEFAULT_HEIGHT };
