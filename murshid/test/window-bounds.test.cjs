'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { initialWindowBounds, displayWorkAreas } = require('../app/window-bounds');

// A 1920x1080 laptop screen with a 40px taskbar, and a 2560x1440 monitor to its right.
const LAPTOP = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };

test('a first window opens at the default size, clamped to the primary display', () => {
  assert.deepEqual(initialWindowBounds(null, [LAPTOP]), { width: 1360, height: 880 });
  assert.deepEqual(initialWindowBounds(undefined, [{ x: 0, y: 0, width: 1280, height: 760 }]), { width: 1280, height: 760 });
  // Saved values that are not numbers are ignored.
  assert.deepEqual(initialWindowBounds({ x: 'a', y: 5, width: -1, height: NaN }, [LAPTOP]), { width: 1360, height: 880 });
  assert.deepEqual(initialWindowBounds({ width: 1000, height: 700 }, [LAPTOP]), { width: 1000, height: 700 });
});

test('a saved position on a connected display is kept', () => {
  const onLaptop = { x: 100, y: 60, width: 1200, height: 800 };
  assert.deepEqual(initialWindowBounds(onLaptop, [LAPTOP]), onLaptop);
  const onMonitor = { x: 2100, y: 120, width: 1360, height: 880 };
  assert.deepEqual(initialWindowBounds(onMonitor, [LAPTOP, RIGHT]), onMonitor);
  // Straddling both displays, with the tab strip still reachable.
  const straddling = { x: 1500, y: 200, width: 1000, height: 700 };
  assert.deepEqual(initialWindowBounds(straddling, [LAPTOP, RIGHT]), straddling);
  // A monitor to the left of the primary one has negative coordinates.
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(initialWindowBounds({ x: -1500, y: 50, width: 1200, height: 800 }, [LAPTOP, left]), { x: -1500, y: 50, width: 1200, height: 800 });
});

test('the size is clamped to the display the window opens on, not always the primary one', () => {
  const small = { x: 1920, y: 0, width: 1280, height: 984 };
  assert.deepEqual(initialWindowBounds({ x: 2000, y: 0, width: 1800, height: 1000 }, [LAPTOP, small]), { x: 2000, y: 0, width: 1280, height: 984 });
  // A tall window on a big monitor keeps its size there.
  assert.deepEqual(initialWindowBounds({ x: 2000, y: 0, width: 2400, height: 1300 }, [LAPTOP, RIGHT]), { x: 2000, y: 0, width: 2400, height: 1300 });
});

test('a window saved on a monitor that is no longer attached opens centered on the primary display', () => {
  // Electron centers a window created without x and y.
  assert.deepEqual(initialWindowBounds({ x: 2100, y: 120, width: 1360, height: 880 }, [LAPTOP]), { width: 1360, height: 880 });
  assert.deepEqual(initialWindowBounds({ x: -2500, y: 50, width: 2400, height: 1300 }, [LAPTOP]), { width: 1920, height: 1040 });
  assert.deepEqual(initialWindowBounds({ x: 100, y: 1200, width: 800, height: 600 }, [LAPTOP]), { width: 800, height: 600 });
});

test('a window that is mostly off-screen, or whose tab strip cannot be grabbed, moves onto the display', () => {
  // Only 40px of the window are left on the laptop after the monitor on the right went away.
  assert.deepEqual(initialWindowBounds({ x: 1880, y: 120, width: 1360, height: 880 }, [LAPTOP]), { x: 560, y: 120, width: 1360, height: 880 });
  // The tab strip (the title bar) is above the top of the work area.
  assert.deepEqual(initialWindowBounds({ x: 200, y: -300, width: 1200, height: 800 }, [LAPTOP]), { x: 200, y: 0, width: 1200, height: 800 });
  // The tab strip is under a taskbar at the top of the screen.
  const topTaskbar = { x: 0, y: 48, width: 1920, height: 1032 };
  assert.deepEqual(initialWindowBounds({ x: 200, y: 10, width: 1200, height: 800 }, [topTaskbar]), { x: 200, y: 48, width: 1200, height: 800 });
  // Only the bottom few pixels of the strip are on screen: the window moves down onto the display.
  assert.deepEqual(initialWindowBounds({ x: 1000, y: 1030, width: 800, height: 600 }, [LAPTOP]), { x: 1000, y: 440, width: 800, height: 600 });
  // The resolution went down: the window is resized to the display and moved onto it.
  const smaller = { x: 0, y: 0, width: 1280, height: 680 };
  assert.deepEqual(initialWindowBounds({ x: 1250, y: 100, width: 1360, height: 880 }, [smaller]), { x: 0, y: 0, width: 1280, height: 680 });
  // The strip is judged at the size the window will have: 2400px wide, 100px of it would be on the
  // laptop, but shrunk to the laptop's 1920px the window would be entirely to its left.
  assert.deepEqual(initialWindowBounds({ x: -2300, y: 50, width: 2400, height: 800 }, [LAPTOP]), { x: 0, y: 50, width: 1920, height: 800 });
  // When most of the window is on a display that is still attached, it moves onto that one.
  assert.deepEqual(initialWindowBounds({ x: 1900, y: -200, width: 1360, height: 880 }, [LAPTOP, RIGHT]), { x: 1920, y: 0, width: 1360, height: 880 });
});

test('displayWorkAreas lists the primary display first', () => {
  const primary = { id: 2, workArea: LAPTOP };
  const screen = { getPrimaryDisplay: () => primary, getAllDisplays: () => [{ id: 1, workArea: RIGHT }, primary] };
  assert.deepEqual(displayWorkAreas(screen), [LAPTOP, RIGHT]);
});

test('MurshidWindow opens a window saved on a detached monitor where it can be seen', () => {
  const created = [];
  const noop = () => {};
  class BrowserWindow {
    constructor(options) {
      created.push(options);
      this.id = created.length;
      this.webContents = { loadFile: noop, on: noop, setWindowOpenHandler: noop };
    }
    once() {}
    on() {}
  }
  const electron = {
    BrowserWindow,
    WebContentsView: class {},
    nativeTheme: { shouldUseDarkColors: false, on: noop, off: noop },
    screen: { getPrimaryDisplay: () => ({ id: 1, workArea: LAPTOP }), getAllDisplays: () => [{ id: 1, workArea: LAPTOP }] },
    dialog: {},
  };
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'electron' ? electron : original.call(this, name, ...args); };
  let MurshidWindow;
  try {
    for (const file of ['../app/window', '../app/tab', '../app/omnibox-popup']) delete require.cache[require.resolve(file)];
    ({ MurshidWindow } = require('../app/window'));
  } finally {
    Module._load = original;
  }
  const settings = (saved) => ({ get: (key) => (key === 'windowBounds' ? saved : undefined) });
  new MurshidWindow({ settings: settings({ x: 2100, y: 120, width: 1360, height: 880 }), commands: {} });
  new MurshidWindow({ settings: settings({ x: 300, y: 80, width: 1000, height: 700 }), commands: {} });
  assert.equal('x' in created[0], false);
  assert.equal('y' in created[0], false);
  assert.deepEqual([created[0].width, created[0].height], [1360, 880]);
  assert.deepEqual([created[1].x, created[1].y, created[1].width, created[1].height], [300, 80, 1000, 700]);
});

test('every asset the browser chrome and murshid:// pages load exists', () => {
  const app = path.join(__dirname, '..', 'app');
  const assets = path.join(__dirname, '..', 'assets');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|css|js)$/.test(entry.name)) files.push(full);
    }
  };
  walk(app);
  const refs = new Set();
  for (const file of files) {
    for (const [, rel] of fs.readFileSync(file, 'utf8').matchAll(/(?:\.\.\/\.\.\/assets|murshid:\/\/assets)\/([\w./@-]+)/g)) refs.add(rel);
  }
  assert.ok(refs.has('icons/webbrain-mark.svg'));
  for (const rel of refs) assert.ok(fs.existsSync(path.join(assets, rel)), `missing murshid/assets/${rel}`);
});
