'use strict';

// Runs in every extension service worker and extension page BEFORE
// electron-chrome-extensions' preload (which freezes `chrome` once it is done),
// and adds the namespaces Electron lacks: sidePanel, debugger, alarms,
// offscreen, tabGroups, identity, search, tabCapture.
//
// The main-world half is serialized and run with contextBridge.executeInMainWorld,
// so it must not close over anything from this file.

const { contextBridge, ipcRenderer } = require('electron');

const isWorker = process.type === 'service-worker';
const isExtensionPage = !isWorker && typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

function murshidPre() {
  const bridge = globalThis.__murshidCrx;
  try { delete globalThis.__murshidCrx; } catch {}
  if (!bridge || typeof chrome !== 'object' || !chrome || !chrome.runtime || !chrome.runtime.id) return;

  const slot = { lastError: null, nativeRuntime: chrome.runtime, events: new Map(), bridge };
  Object.defineProperty(globalThis, Symbol.for('murshid.crx'), { value: slot, configurable: true });

  class MurshidEvent {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      this.pending = [];
      slot.events.set(name, this);
    }
    addListener(fn) {
      if (typeof fn !== 'function') return;
      this.listeners.add(fn);
      if (this.pending.length) {
        const pending = this.pending.splice(0);
        Promise.resolve().then(() => pending.forEach((args) => this.dispatch(args)));
      }
    }
    removeListener(fn) { this.listeners.delete(fn); }
    hasListener(fn) { return this.listeners.has(fn); }
    hasListeners() { return this.listeners.size > 0; }
    dispatch(args) {
      if (!this.listeners.size) {
        // A worker woken for an alarm gets the event before its top-level code
        // has registered listeners; hold a few until it does.
        if (this.pending.length < 20) this.pending.push(args);
        return;
      }
      for (const fn of [...this.listeners]) {
        try { fn(...args); } catch (error) { console.error(error); }
      }
    }
  }
  slot.Event = MurshidEvent;

  function call(name) {
    return function murshidApi(...args) {
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const promise = Promise.resolve(bridge.invoke(name, ...args)).then((res) => {
        if (res && res.error) throw new Error(res.error);
        return res && res.value !== null ? res.value : undefined;
      });
      if (!callback) return promise;
      promise.then(
        (value) => { try { callback(value); } catch (error) { console.error(error); } },
        (error) => {
          slot.lastError = { message: error.message };
          try { callback(); } catch (err) { console.error(err); } finally { slot.lastError = null; }
        },
      );
      return undefined;
    };
  }
  slot.call = call;

  // The native message sender contains Chromium's real documentId. Electron's
  // runtime.getContexts omits extension pages, so the offscreen host asks its
  // worker to pass that identity to the main process over the scoped bridge.
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) {
    slot.nativeRuntime.onMessage.addListener((message, sender, reply) => {
      if (message?.type !== 'murshid-offscreen-document-identity' || sender?.id !== chrome.runtime.id) return false;
      call('murshid.registerOffscreenIdentity')({
        nonce: message.nonce, documentId: sender.documentId, url: sender.url, frameId: sender.frameId,
      }).then(() => reply({ ok: true, documentId: sender.documentId }), () => reply({ ok: false }));
      return true;
    });
  }

  bridge.onEvent((name, args) => {
    const event = slot.events.get(name);
    if (event) event.dispatch(Array.isArray(args) ? args : []);
  });

  const define = (name, factory) => {
    if (chrome[name]) return;
    try {
      Object.defineProperty(chrome, name, { value: factory(), enumerable: true, configurable: true, writable: true });
    } catch (error) {
      console.warn(`[murshid] could not provide chrome.${name}:`, error);
    }
  };

  define('sidePanel', () => ({
    setPanelBehavior: call('sidePanel.setPanelBehavior'),
    getPanelBehavior: call('sidePanel.getPanelBehavior'),
    setOptions: call('sidePanel.setOptions'),
    getOptions: call('sidePanel.getOptions'),
    open: call('sidePanel.open'),
    close: call('sidePanel.close'),
    getLayout: call('sidePanel.getLayout'),
    onOpened: new MurshidEvent('sidePanel.onOpened'),
    onClosed: new MurshidEvent('sidePanel.onClosed'),
    Side: { LEFT: 'left', RIGHT: 'right' },
  }));

  define('debugger', () => ({
    attach: call('debugger.attach'),
    detach: call('debugger.detach'),
    sendCommand: call('debugger.sendCommand'),
    getTargets: call('debugger.getTargets'),
    onEvent: new MurshidEvent('debugger.onEvent'),
    onDetach: new MurshidEvent('debugger.onDetach'),
    DetachReason: { CANCELED_BY_USER: 'canceled_by_user', TARGET_CLOSED: 'target_closed' },
    TargetInfoType: { BACKGROUND_PAGE: 'background_page', OTHER: 'other', PAGE: 'page', WORKER: 'worker' },
  }));

  define('alarms', () => {
    const create = call('alarms.create');
    const get = call('alarms.get');
    const clear = call('alarms.clear');
    return {
      create(nameOrInfo, infoOrCallback, maybeCallback) {
        if (typeof nameOrInfo === 'object' && nameOrInfo !== null) {
          return typeof infoOrCallback === 'function' ? create('', nameOrInfo, infoOrCallback) : create('', nameOrInfo);
        }
        const args = [String(nameOrInfo ?? ''), infoOrCallback || {}];
        if (typeof maybeCallback === 'function') args.push(maybeCallback);
        return create(...args);
      },
      get(name, callback) {
        if (typeof name === 'function') return get('', name);
        return callback ? get(name ?? '', callback) : get(name ?? '');
      },
      getAll: call('alarms.getAll'),
      clear(name, callback) {
        if (typeof name === 'function') return clear('', name);
        return callback ? clear(name ?? '', callback) : clear(name ?? '');
      },
      clearAll: call('alarms.clearAll'),
      onAlarm: new MurshidEvent('alarms.onAlarm'),
    };
  });

  define('offscreen', () => ({
    createDocument: call('offscreen.createDocument'),
    closeDocument: call('offscreen.closeDocument'),
    hasDocument: call('offscreen.hasDocument'),
    Reason: Object.fromEntries([
      'TESTING', 'AUDIO_PLAYBACK', 'IFRAME_SCRIPTING', 'DOM_SCRAPING', 'BLOBS', 'DOM_PARSER', 'USER_MEDIA',
      'DISPLAY_MEDIA', 'WEB_RTC', 'CLIPBOARD', 'LOCAL_STORAGE', 'WORKERS', 'BATTERY_STATUS', 'MATCH_MEDIA', 'GEOLOCATION',
    ].map((r) => [r, r])),
  }));

  define('tabGroups', () => ({
    get: call('tabGroups.get'),
    query: call('tabGroups.query'),
    update: call('tabGroups.update'),
    move: call('tabGroups.move'),
    onCreated: new MurshidEvent('tabGroups.onCreated'),
    onUpdated: new MurshidEvent('tabGroups.onUpdated'),
    onRemoved: new MurshidEvent('tabGroups.onRemoved'),
    onMoved: new MurshidEvent('tabGroups.onMoved'),
    TAB_GROUP_ID_NONE: -1,
    Color: Object.fromEntries(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].map((c) => [c.toUpperCase(), c])),
  }));

  define('identity', () => ({
    launchWebAuthFlow: call('identity.launchWebAuthFlow'),
    getRedirectURL: (path = '') => `https://${chrome.runtime.id}.chromiumapp.org/${String(path).replace(/^\//, '')}`,
    getAuthToken: (_details, callback) => {
      const error = new Error('chrome.identity.getAuthToken is not available in Murshid.');
      if (typeof callback === 'function') {
        slot.lastError = { message: error.message };
        try { callback(); } finally { slot.lastError = null; }
        return undefined;
      }
      return Promise.reject(error);
    },
    onSignInChanged: new MurshidEvent('identity.onSignInChanged'),
  }));

  define('search', () => ({
    query: call('search.query'),
    Disposition: { CURRENT_TAB: 'CURRENT_TAB', NEW_TAB: 'NEW_TAB', NEW_WINDOW: 'NEW_WINDOW' },
  }));

  define('tabCapture', () => ({
    getMediaStreamId: call('tabCapture.getMediaStreamId'),
    onStatusChanged: new MurshidEvent('tabCapture.onStatusChanged'),
  }));

  // First-run defaults Murshid wants for this extension (WebBrain: the new tab
  // page on). Only keys the extension has never written are set.
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) {
    const applied = call('murshid.defaultsApplied');
    call('murshid.defaults')().then(async (defaults) => {
      const keys = defaults && typeof defaults === 'object' ? Object.keys(defaults) : [];
      if (keys.length) {
        const current = await chrome.storage.local.get(keys);
        const missing = Object.fromEntries(keys.filter((k) => current[k] === undefined).map((k) => [k, defaults[k]]));
        if (Object.keys(missing).length) await chrome.storage.local.set(missing);
      }
    }).catch(() => {}).finally(() => applied().catch(() => {}));
  }
}

if (isWorker || isExtensionPage) {
  try {
    contextBridge.exposeInMainWorld('__murshidCrx', {
      invoke: (name, ...args) => ipcRenderer.invoke('murshid-crx', name, ...args),
      onEvent: (callback) => {
        ipcRenderer.on('murshid-crx-event', (_event, name, args) => callback(name, args));
      },
    });
    contextBridge.executeInMainWorld({ func: murshidPre });
  } catch (error) {
    console.error('[murshid] extension API preload failed:', error);
  }
}
