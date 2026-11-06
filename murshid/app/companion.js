'use strict';

// WebBrain Companion (webbrain-systray/) is Murshid's system tray side: it serves
// AI subscriptions and local models to WebBrain on 127.0.0.1:8327. Murshid starts
// it in the background (no panel) when it is not already running, from the copy
// bundled with Murshid or from a normal Companion install.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('./paths');

const DEFAULT_PORT = 8327;
const DOWNLOAD_PAGE = 'https://webbrain.one/companion/';

function candidates() {
  const bundled = paths.bundledCompanionDir();
  const home = os.homedir();
  const list = [process.env.MURSHID_COMPANION];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    if (bundled) list.push(path.join(bundled, 'WebBrainCompanion.exe'));
    list.push(path.join(local, 'Programs', 'WebBrain Companion', 'WebBrainCompanion.exe'));
  } else if (process.platform === 'darwin') {
    const inApp = (root) => path.join(root, 'WebBrain Companion.app', 'Contents', 'MacOS', 'WebBrain Companion');
    if (bundled) list.push(inApp(bundled));
    list.push(inApp('/Applications'), inApp(path.join(home, 'Applications')));
  } else {
    if (bundled) list.push(path.join(bundled, 'webbrain-companion'));
    list.push(
      path.join(home, '.local', 'bin', 'webbrain-companion'),
      '/usr/local/bin/webbrain-companion',
      '/usr/bin/webbrain-companion',
      '/opt/webbrain-companion/webbrain-companion',
    );
  }
  return list.filter(Boolean);
}

class Companion {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = false;
    this.exe = null;
    this.port = DEFAULT_PORT;
  }

  locate() {
    this.exe = candidates().find((file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    }) || null;
    return this.exe;
  }

  async probe() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/companion/v1/info`, { signal: AbortSignal.timeout(1500) });
      this.running = res.ok;
    } catch {
      this.running = false;
    }
    return this.running;
  }

  launch(args) {
    const exe = this.exe || this.locate();
    if (!exe) return false;
    try {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false, cwd: path.dirname(exe) });
      child.on('error', (error) => console.warn('[murshid] companion failed to start:', error.message));
      child.unref();
      return true;
    } catch (error) {
      console.warn('[murshid] companion failed to start:', error.message);
      return false;
    }
  }

  /** Called at startup: make sure the tray app is up, without opening its panel. */
  async ensureRunning() {
    this.locate();
    if (await this.probe()) return true;
    if (!this.ctx.settings.get('startCompanion') || !this.exe) return false;
    if (!this.launch(['--background'])) return false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.probe()) break;
    }
    this.ctx.refreshAllWindows();
    return this.running;
  }

  /** Menu entry: show the Companion's panel (starting it if needed), or get it. */
  openPanel(w) {
    if (this.launch([])) {
      setTimeout(() => this.probe().then(() => this.ctx.refreshAllWindows()), 2500);
      return;
    }
    (w || this.ctx.lastFocusedWindow() || this.ctx.createWindow({ empty: true })).addTab({ url: DOWNLOAD_PAGE });
  }

  status() {
    return { running: this.running, found: Boolean(this.exe), path: this.exe, port: this.port };
  }
}

module.exports = { Companion };
