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
const QUOTA_POLL_MS = 60000;

// The companion keeps its settings, including the panel key, in its own config
// folder (webbrain-systray/internal/paths); reading it lets Murshid ask the
// panel API for subscription quotas.
function configFile() {
  const home = os.homedir();
  if (process.env.WBC_HOME) return path.join(process.env.WBC_HOME, 'companion.json');
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appdata, 'WebBrain Companion', 'companion.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'WebBrain Companion', 'companion.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdg, 'webbrain-companion', 'companion.json');
}

// Picks the row that says how much a whole plan has left, as the Companion's
// tray menu does: unscoped windows first (the least left stops the plan);
// with only per-model or per-feature pools, the healthiest pool's tightest
// window, so one exhausted model group does not make the plan look empty.
function tightestRow(rows) {
  const whole = rows.filter((r) => !r.scope && r.remaining != null);
  if (whole.length) return whole.reduce((m, r) => (r.remaining < m.remaining ? r : m));
  const byScope = new Map();
  for (const r of rows) {
    if (r.remaining == null) continue;
    const cur = byScope.get(r.scope);
    if (!cur || r.remaining < cur.remaining) byScope.set(r.scope, r);
  }
  const pools = [...byScope.values()];
  if (!pools.length) return null;
  return pools.reduce((m, r) => (r.remaining > m.remaining ? r : m));
}

/** The panel snapshot, narrowed to what the toolbar's quota button shows. */
function summarize(snapshot) {
  const accounts = [];
  for (const a of snapshot.accounts || []) {
    const q = a.quota || {};
    accounts.push({
      name: a.name,
      provider: a.provider_name || a.provider || '',
      plan: q.plan || '',
      who: a.email || a.label || String(a.name || '').replace(/\.json$/, ''),
      disabled: Boolean(a.disabled),
      status: q.status || 'unsupported',
      error: q.error || '',
      supported: Boolean(a.quota_supported),
      rows: (q.rows || []).map((r) => ({
        label: r.label || r.window || '',
        window: r.window || '',
        scope: r.scope || '',
        remaining: typeof r.remaining === 'number' ? r.remaining : null,
        resetAt: r.reset_at || null,
        detail: r.detail || '',
      })),
    });
  }
  let tightest = null;
  for (const a of accounts) {
    if (a.disabled || a.status !== 'ok') continue;
    const r = tightestRow(a.rows);
    if (r && r.remaining != null && (!tightest || r.remaining < tightest.remaining)) {
      tightest = { remaining: r.remaining, account: a.provider, plan: a.plan, label: r.label };
    }
  }
  return { accounts, tightest };
}

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
    this.companionSettings = null; // { port, token } read from the companion's config file
    this.summary = null;  // summarize(snapshot), refreshed from the panel API
    this.quotaError = null;
    this.quotaTimer = null;
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
    if (await this.probe()) {
      this.refreshQuotas().catch(() => {});
      return true;
    }
    if (!this.ctx.settings.get('startCompanion') || !this.exe) return false;
    if (!this.launch(['--background'])) return false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.probe()) break;
    }
    this.ctx.refreshAllWindows();
    this.refreshQuotas().then(() => this.ctx.refreshAllWindows()).catch(() => {});
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

  // ------------------------------------------------------------- quotas ---

  readCompanionSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
      return {
        port: Number(raw.port) || 0,
        token: typeof raw.panel_token === 'string' ? raw.panel_token : '',
      };
    } catch {
      return null;
    }
  }

  /** The panel's /state snapshot: accounts with their cached usage. */
  async fetchState() {
    this.companionSettings = this.readCompanionSettings();
    const token = this.companionSettings?.token || '';
    const tried = new Set();
    let answered = false; // some port spoke HTTP: a companion is up, maybe keyed differently
    for (const port of [this.port, DEFAULT_PORT, this.companionSettings?.port]) {
      if (!port || tried.has(port)) continue;
      tried.add(port);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/companion/api/state`, {
          headers: token ? { 'X-Companion-Key': token } : {},
          signal: AbortSignal.timeout(4000),
        });
        answered = true;
        if (res.status === 401) {
          this.quotaError = 'unauthorized';
          continue;
        }
        if (!res.ok) continue;
        this.port = port;
        this.running = true;
        this.quotaError = null;
        return await res.json();
      } catch {
        // This port holds no companion; try the next one.
      }
    }
    if (!answered) this.running = false;
    return null;
  }

  async refreshQuotas() {
    const snapshot = await this.fetchState();
    this.summary = snapshot ? summarize(snapshot) : null;
    return this.summary;
  }

  /** Menu action: make the companion re-read usage from the providers, then update. */
  async requestQuotaRefresh() {
    const token = this.companionSettings?.token || '';
    if (token) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/companion/api/quotas/refresh`, {
          method: 'POST',
          headers: { 'X-Companion-Key': token, 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(4000),
        });
      } catch {}
    }
    // The companion fetches in the background; give it a moment before reading.
    await new Promise((r) => setTimeout(r, 2500));
    await this.refreshQuotas();
    this.ctx.refreshAllWindows();
  }

  startQuotaLoop() {
    if (this.quotaTimer) return;
    this.quotaTimer = setInterval(() => {
      this.refreshQuotas().then(() => this.ctx.refreshAllWindows()).catch(() => {});
    }, QUOTA_POLL_MS);
    this.quotaTimer.unref?.();
  }

  /** What the toolbar's quota button renders; pushed with the window state. */
  uiState() {
    return {
      running: this.running,
      found: Boolean(this.exe),
      port: this.port,
      error: this.quotaError,
      quota: this.summary,
    };
  }
}

module.exports = { Companion, summarize, tightestRow, configFile };
