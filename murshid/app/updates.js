'use strict';

const { EventEmitter } = require('node:events');

const FEED_URL = 'https://murshid.one/updates/stable.json';
const ORIGIN = 'https://murshid.one';
const DAY = 24 * 60 * 60 * 1000;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('Invalid release version');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function releaseAsset(asset, version, suffix) {
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3
      || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) throw new Error('Invalid update asset');
  const url = new URL(asset.url);
  const name = `Murshid-${version}-${suffix}`;
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash
      || url.pathname !== '/download/' + name) throw new Error('Invalid update URL');
  return { url: url.href, size: asset.size, sha256: asset.sha256 };
}

function selectRelease(feed, platform, arch) {
  if (feed?.schema !== 'murshid-updates/1') throw new Error('Invalid update feed');
  const key = platform === 'darwin' && ['arm64', 'x64'].includes(arch) ? 'darwin-universal' : `${platform}-${arch}`;
  const target = feed.platforms?.[key];
  if (!target) return null;
  if (!VERSION.test(target.version || '')) throw new Error('Invalid release version');
  const suffix = key === 'darwin-universal' ? 'macos-universal.dmg'
    : key === 'win32-x64' ? 'windows-x64-setup.exe' : key === 'linux-x64' ? 'linux-x86_64.AppImage' : null;
  if (!suffix) return null;
  const release = { version: target.version, installer: releaseAsset(target.installer, target.version, suffix) };
  if (platform === 'darwin') {
    release.update = releaseAsset(target.update, target.version, 'macos-universal.zip');
    const entry = feed.releases?.find(item => item.version === target.version)?.updateTo;
    if (feed.currentRelease !== target.version || entry?.version !== target.version
        || entry?.name !== target.version || entry?.url !== release.update.url
        || entry?.sha256 !== release.update.sha256 || entry?.size !== release.update.size) {
      throw new Error('Inconsistent native update feed');
    }
  }
  return release;
}

async function readFeed(fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  timer.unref?.();
  try {
    const response = await fetchImpl(FEED_URL, { redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json' } });
    if (!response.ok || response.url && response.url !== FEED_URL) throw new Error('Update feed unavailable');
    let text = '', size = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 128 * 1024) { controller.abort(); throw new Error('Update feed too large'); }
      text += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { clearTimeout(timer); }
}

class Updates extends EventEmitter {
  constructor({ version, platform = process.platform, arch = process.arch, packaged = false,
    nativeUpdater = null, openExternal, fetchImpl = globalThis.fetch }) {
    super();
    if (!VERSION.test(version)) throw new Error('Invalid installed version');
    this.version = version;
    this.platform = platform;
    this.arch = arch;
    this.native = platform === 'darwin' && packaged ? nativeUpdater : null;
    this.openExternal = openExternal;
    this.fetchImpl = fetchImpl;
    this.release = null;
    this.pending = null;
    this.checkPromise = null;
    this.state = { status: 'idle', installedVersion: version, latestVersion: null, native: Boolean(this.native), checkedAt: null };
    if (this.native) {
      this.native.on('error', () => {
        if (['downloading', 'ready', 'installing'].includes(this.state.status)) this.finishDownload('error');
      });
      this.native.on('update-not-available', () => {
        if (this.state.status === 'downloading') this.finishDownload('current');
      });
      this.native.on('update-downloaded', (_event, _notes, name) => {
        if (this.state.status !== 'downloading' || !this.pending) return;
        this.finishDownload(name === this.pending.version ? 'ready' : 'error');
      });
    }
  }

  snapshot() { return { ...this.state }; }
  setState(values) { Object.assign(this.state, values); this.emit('change', this.snapshot()); return this.snapshot(); }

  start() {
    this.stop();
    this.startTimer = setTimeout(() => this.check(), 10000);
    this.dailyTimer = setInterval(() => this.check(), DAY);
    this.startTimer.unref?.(); this.dailyTimer.unref?.();
  }
  stop() { clearTimeout(this.startTimer); clearInterval(this.dailyTimer); }

  check() {
    if (this.checkPromise) return this.checkPromise;
    if (['downloading', 'ready', 'installing'].includes(this.state.status)) return Promise.resolve(this.snapshot());
    this.setState({ status: 'checking' });
    this.checkPromise = (async () => {
      try {
        const release = selectRelease(await readFeed(this.fetchImpl), this.platform, this.arch);
        this.release = release;
        return this.setState({ status: !release ? 'unsupported' : compareVersions(release.version, this.version) > 0 ? 'available' : 'current',
          latestVersion: release?.version || null, checkedAt: Date.now() });
      } catch {
        this.release = null;
        return this.setState({ status: 'error', latestVersion: null });
      } finally { this.checkPromise = null; }
    })();
    return this.checkPromise;
  }

  finishDownload(status) {
    if (status !== 'ready') this.pending = null;
    return this.setState({ status });
  }

  async download() {
    if (this.state.status !== 'available' || !this.release) return this.snapshot();
    if (!this.native) {
      try { await this.openExternal(this.release.installer.url); return this.setState({ status: 'opened' }); }
      catch { return this.setState({ status: 'error' }); }
    }
    this.pending = { ...this.release };
    this.setState({ status: 'downloading' });
    // Only an explicit Download click invokes Squirrel; checking alone never downloads a ZIP.
    try {
      this.native.setFeedURL({ url: FEED_URL, serverType: 'json' });
      this.native.checkForUpdates();
    } catch { this.finishDownload('error'); }
    return this.snapshot();
  }

  install() {
    if (!this.native || this.state.status !== 'ready' || !this.pending) return this.snapshot();
    this.setState({ status: 'installing' });
    try { this.native.quitAndInstall(); } catch { this.setState({ status: 'error' }); }
    return this.snapshot();
  }
}

module.exports = { Updates, FEED_URL, compareVersions, selectRelease };
