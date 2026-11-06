'use strict';

// Every download in the browsing session, in the shape chrome.downloads uses, so
// the toolbar and WebBrain see the same list.

const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const START_TIMEOUT_MS = 30_000;

function sanitizeRelative(name) {
  const parts = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join(path.sep);
}

function uniquify(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

class Downloads extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.records = new Map();
    this.nextId = 1;
    this.pending = [];
    ctx.ses.on('will-download', (_event, item, webContents) => this.onWillDownload(item, webContents));
  }

  folder() {
    return app.getPath('downloads');
  }

  /** chrome.downloads.download */
  start(options = {}, source = null) {
    const url = String(options.url || '');
    if (!/^(https?|data|blob|file):/i.test(url)) return Promise.reject(new Error('Invalid URL'));
    return new Promise((resolve, reject) => {
      const entry = { url, options, source, resolve, reject };
      entry.timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        reject(new Error('The download did not start.'));
      }, START_TIMEOUT_MS);
      this.pending.push(entry);
      const headers = {};
      for (const header of options.headers || []) {
        if (header && header.name) headers[header.name] = header.value;
      }
      try {
        if (source) source.downloadURL(url);
        else this.ctx.ses.downloadURL(url, Object.keys(headers).length ? { headers } : undefined);
      } catch (error) {
        clearTimeout(entry.timer);
        this.pending = this.pending.filter((p) => p !== entry);
        reject(error);
      }
    });
  }

  onWillDownload(item, webContents) {
    const chain = item.getURLChain();
    const original = chain[0] || item.getURL();
    const matchesUrl = (p) => p.url === original || p.url === item.getURL();
    let pendingIndex = this.pending.findIndex((p) => p.source && p.source === webContents && matchesUrl(p));
    if (pendingIndex < 0) pendingIndex = this.pending.findIndex((p) => !p.source && matchesUrl(p));
    const request = pendingIndex >= 0 ? this.pending.splice(pendingIndex, 1)[0] : null;
    if (request) clearTimeout(request.timer);

    const id = this.nextId++;
    const options = request?.options || {};
    const relative = sanitizeRelative(options.filename) || item.getFilename() || 'download';
    let target = path.join(this.folder(), relative);
    if (options.conflictAction !== 'overwrite') target = uniquify(target);
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
    if (options.saveAs) item.setSaveDialogOptions({ defaultPath: target });
    else item.setSavePath(target);

    const record = {
      id,
      item,
      url: original,
      finalUrl: item.getURL(),
      referrer: '',
      filename: options.saveAs ? '' : target,
      mime: item.getMimeType(),
      startTime: new Date(item.getStartTime() * 1000 || Date.now()).toISOString(),
      endTime: undefined,
      state: 'in_progress',
      paused: false,
      error: undefined,
      totalBytes: item.getTotalBytes() || -1,
      bytesReceived: 0,
      exists: true,
      byExtensionId: request && !request.source ? this.ctx.webBrainId || undefined : undefined,
    };
    this.records.set(id, record);

    item.on('updated', (_event, state) => {
      const before = this.snapshot(record);
      record.bytesReceived = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes() || -1;
      record.paused = item.isPaused();
      if (!record.filename && item.getSavePath()) record.filename = item.getSavePath();
      if (state === 'interrupted') record.state = 'interrupted';
      else if (state === 'progressing') record.state = 'in_progress';
      this.changed(record, before);
    });
    item.once('done', (_event, state) => {
      const before = this.snapshot(record);
      record.bytesReceived = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes() || record.bytesReceived;
      record.filename = item.getSavePath() || record.filename;
      record.endTime = new Date().toISOString();
      record.paused = false;
      if (state === 'completed') record.state = 'complete';
      else {
        record.state = 'interrupted';
        record.error = state === 'cancelled' ? 'USER_CANCELED' : 'NETWORK_FAILED';
      }
      this.changed(record, before);
    });

    request?.resolve(id);
    const item0 = this.publicItem(record);
    this.ctx.crx?.emit(this.ctx.webBrainId, 'downloads.onCreated', [item0]);
    this.emit('update');
  }

  snapshot(record) {
    return {
      state: record.state, paused: record.paused, filename: record.filename, totalBytes: record.totalBytes,
      endTime: record.endTime, error: record.error, exists: record.exists,
    };
  }

  changed(record, before) {
    const delta = { id: record.id };
    let any = false;
    for (const key of Object.keys(before)) {
      if (before[key] !== record[key]) {
        delta[key] = { previous: before[key], current: record[key] };
        any = true;
      }
    }
    if (any && this.ctx.webBrainId) this.ctx.crx?.emit(this.ctx.webBrainId, 'downloads.onChanged', [delta]);
    this.emit('update');
  }

  publicItem(r) {
    const done = r.state === 'complete';
    return {
      id: r.id,
      url: r.url,
      finalUrl: r.finalUrl,
      referrer: r.referrer,
      filename: r.filename,
      incognito: false,
      danger: 'safe',
      mime: r.mime,
      startTime: r.startTime,
      ...(r.endTime ? { endTime: r.endTime } : {}),
      state: r.state,
      paused: r.paused,
      canResume: r.state === 'interrupted' && r.item.canResume(),
      ...(r.error ? { error: r.error } : {}),
      bytesReceived: r.bytesReceived,
      totalBytes: r.totalBytes,
      fileSize: done ? r.bytesReceived : -1,
      exists: r.exists,
      ...(r.byExtensionId ? { byExtensionId: r.byExtensionId, byExtensionName: 'WebBrain' } : {}),
    };
  }

  matches(r, q = {}) {
    if (q.id !== undefined && r.id !== q.id) return false;
    if (q.url !== undefined && r.url !== q.url) return false;
    if (q.finalUrl !== undefined && r.finalUrl !== q.finalUrl) return false;
    if (q.filename !== undefined && r.filename !== q.filename) return false;
    if (q.state !== undefined && r.state !== q.state) return false;
    if (q.mime !== undefined && r.mime !== q.mime) return false;
    if (q.exists !== undefined && r.exists !== q.exists) return false;
    if (q.paused !== undefined && r.paused !== q.paused) return false;
    if (q.urlRegex && !new RegExp(q.urlRegex).test(r.url)) return false;
    if (q.finalUrlRegex && !new RegExp(q.finalUrlRegex).test(r.finalUrl)) return false;
    if (q.filenameRegex && !new RegExp(q.filenameRegex).test(r.filename)) return false;
    if (q.startedAfter && !(r.startTime > q.startedAfter)) return false;
    if (q.startedBefore && !(r.startTime < q.startedBefore)) return false;
    if (q.endedAfter && !(r.endTime && r.endTime > q.endedAfter)) return false;
    if (q.endedBefore && !(r.endTime && r.endTime < q.endedBefore)) return false;
    if (Array.isArray(q.query) && q.query.length) {
      const hay = `${r.url} ${r.filename}`.toLowerCase();
      for (const term of q.query) {
        const t = String(term).toLowerCase();
        if (t.startsWith('-') ? hay.includes(t.slice(1)) : !hay.includes(t)) return false;
      }
    }
    return true;
  }

  search(query = {}) {
    let list = [...this.records.values()].filter((r) => this.matches(r, query));
    const order = Array.isArray(query.orderBy) && query.orderBy.length ? query.orderBy : ['-startTime'];
    list.sort((a, b) => {
      for (const field of order) {
        const desc = field.startsWith('-');
        const key = desc ? field.slice(1) : field;
        if (a[key] === b[key]) continue;
        return (a[key] > b[key] ? 1 : -1) * (desc ? -1 : 1);
      }
      return 0;
    });
    const limit = Number.isInteger(query.limit) ? query.limit : 1000;
    if (limit > 0) list = list.slice(0, limit);
    return list.map((r) => this.publicItem(r));
  }

  record(id) {
    const r = this.records.get(Number(id));
    if (!r) throw new Error(`Invalid download id ${id}`);
    return r;
  }

  control(id, action) {
    const r = this.record(id);
    if (action === 'pause') r.item.pause();
    else if (action === 'resume') {
      if (r.item.canResume()) r.item.resume();
      else throw new Error('Download can not be resumed');
    } else if (action === 'cancel') r.item.cancel();
  }

  erase(query) {
    const ids = this.search({ ...query, limit: 0 }).map((i) => i.id);
    for (const id of ids) {
      this.records.delete(id);
      this.ctx.crx?.emit(this.ctx.webBrainId, 'downloads.onErased', [id]);
    }
    this.emit('update');
    return ids;
  }

  async removeFile(id) {
    const r = this.record(id);
    if (r.state !== 'complete') throw new Error('Download must be complete');
    const before = this.snapshot(r);
    await fs.promises.rm(r.filename, { force: true });
    r.exists = false;
    this.changed(r, before);
  }

  open(id) {
    const r = this.record(id);
    if (r.state !== 'complete') throw new Error('Download must be complete');
    return shell.openPath(r.filename).then(() => undefined);
  }

  show(id) {
    shell.showItemInFolder(this.record(id).filename);
    return true;
  }

  async icon(id, options = {}) {
    const r = this.record(id);
    const size = options.size === 16 ? 'small' : options.size === 32 ? 'normal' : 'normal';
    const image = await app.getFileIcon(r.filename || '.bin', { size });
    return image.toDataURL();
  }

  summary() {
    const list = [...this.records.values()].sort((a, b) => b.id - a.id);
    return {
      active: list.filter((r) => r.state === 'in_progress').length,
      count: list.length,
      recent: list.slice(0, 8).map((r) => ({
        id: r.id,
        name: path.basename(r.filename || r.item.getFilename() || 'download'),
        state: r.state,
        paused: r.paused,
        progress: r.totalBytes > 0 ? Math.min(1, r.bytesReceived / r.totalBytes) : null,
      })),
    };
  }
}

module.exports = { Downloads };
