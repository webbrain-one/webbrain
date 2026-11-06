'use strict';

// Runs AFTER electron-chrome-extensions' preload. `chrome` is frozen by then,
// but the namespace objects it installed are not, so this file fills in what
// they leave as no-ops or leave out: chrome.downloads, chrome.tabs extras,
// chrome.runtime.lastError for Murshid's own APIs and chrome.runtime.getContexts.

const { contextBridge } = require('electron');

const isWorker = process.type === 'service-worker';
const isExtensionPage = !isWorker && typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

function murshidPost() {
  const key = Symbol.for('murshid.crx');
  const slot = globalThis[key];
  if (!slot) return;
  try { delete globalThis[key]; } catch {}
  const { call, Event } = slot;

  // electron-chrome-extensions rebuilds chrome.runtime from a copy of the native
  // object, so the native lastError getter is lost. Read it through.
  const runtime = chrome.runtime;
  if (runtime) {
    try {
      Object.defineProperty(runtime, 'lastError', {
        configurable: true,
        enumerable: true,
        get() { return slot.lastError || slot.nativeRuntime.lastError || undefined; },
      });
    } catch {}
    // Electron's own getContexts only knows the background worker; Murshid's
    // answers for its side panels and offscreen documents too.
    try { runtime.getContexts = call('runtime.getContexts'); } catch {}
  }

  if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) {
    // Supplement native webRequest events for this extension's offscreen XHRs.
    // Session-level handlers in Electron otherwise suppress those events.
    const matches = (filter, details) => {
      if (filter?.types && !filter.types.includes(details.type)) return false;
      if (!Array.isArray(filter?.urls)) return false;
      return filter.urls.some((pattern) => {
        if (pattern === '<all_urls>') return /^(https?|wss?):/i.test(details.url);
        const m = /^(\*|https?|wss?):\/\/([^/]+)(\/.*)$/.exec(pattern);
        if (!m) return false;
        try {
          const url = new URL(details.url);
          const scheme = m[1] === '*' ? /^(http|https):$/.test(url.protocol) : url.protocol === `${m[1]}:`;
          const host = m[2] === '*' || (m[2].startsWith('*.')
            ? url.hostname === m[2].slice(2) || url.hostname.endsWith(`.${m[2].slice(2)}`)
            : url.hostname === m[2]);
          const escaped = m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          return scheme && host && new RegExp(`^${escaped}$`).test(`${url.pathname}${url.search}`);
        } catch { return false; }
      });
    };
    for (const name of ['onBeforeRequest', 'onHeadersReceived']) {
      const native = chrome.webRequest?.[name];
      if (!native) continue;
      const listeners = new Map();
      const add = native.addListener.bind(native), remove = native.removeListener.bind(native);
      native.addListener = (fn, filter, extra) => { add(fn, filter, extra); listeners.set(fn, { filter, extra }); };
      native.removeListener = (fn) => { listeners.delete(fn); return remove(fn); };
      const event = new Event(`murshid.webRequest.${name}`);
      event.addListener((details, ticket) => {
        try {
          for (const [fn, options] of listeners) {
            if (!matches(options.filter, details)) continue;
            const data = { ...details, tabId: -1, frameId: 0 };
            if (!options.extra?.includes('responseHeaders')) delete data.responseHeaders;
            try { fn(data); } catch (error) { console.error(error); }
          }
        } finally { call('murshid.ackOffscreenRequest')(ticket).catch(() => {}); }
      });
    }
  }

  // chrome.downloads ------------------------------------------------------------
  if (chrome.downloads) {
    const d = chrome.downloads;
    const methods = ['download', 'search', 'pause', 'resume', 'cancel', 'erase', 'removeFile', 'open', 'show',
      'showDefaultFolder', 'getFileIcon', 'acceptDanger', 'setUiOptions', 'setShelfEnabled'];
    for (const m of methods) {
      try { d[m] = call(`downloads.${m}`); } catch {}
    }
    for (const ev of ['onCreated', 'onChanged', 'onErased', 'onDeterminingFilename']) {
      try { d[ev] = new Event(`downloads.${ev}`); } catch {}
    }
  }

  // chrome.tabs -------------------------------------------------------------------
  const tabs = chrome.tabs;
  if (tabs) {
    const set = (name, value) => {
      if (tabs[name] !== undefined) return;
      try { tabs[name] = value; } catch {}
    };
    try {
      const captureVisibleTab = call('tabs.captureVisibleTab');
      tabs.captureVisibleTab = (...args) => {
        // (windowId?, options?, callback?) — windowId may be omitted.
        if (typeof args[0] === 'object' && args[0] !== null) args.unshift(undefined);
        return captureVisibleTab(...args);
      };
    } catch {}
    set('group', call('tabs.group'));
    set('ungroup', call('tabs.ungroup'));
    set('TAB_ID_NONE', -1);
    set('TAB_INDEX_NONE', -1);
    for (const ev of ['onAttached', 'onDetached', 'onMoved', 'onHighlighted', 'onZoomChange']) set(ev, new Event(`tabs.${ev}`));

    const isInternal = (url) => typeof url === 'string' && /^(chrome|about):/i.test(url) && !/^about:blank/i.test(url);
    const navigateInternal = call('tabs.navigateInternal');
    const createInternal = call('tabs.createInternal');
    const settle = (promise, callback) => {
      if (typeof callback !== 'function') return promise;
      promise.then((value) => callback(value), (error) => {
        slot.lastError = { message: error.message };
        try { callback(); } finally { slot.lastError = null; }
      });
      return undefined;
    };

    const originalUpdate = tabs.update;
    if (typeof originalUpdate === 'function') {
      tabs.update = function update(...args) {
        const hasId = typeof args[0] === 'number';
        const props = hasId ? args[1] : args[0];
        if (props && isInternal(props.url)) {
          const callback = args.find((a) => typeof a === 'function');
          const run = (async () => {
            let id = hasId ? args[0] : undefined;
            if (id === undefined) id = (await tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
            await navigateInternal(id, props.url);
            return tabs.get(id);
          })();
          return settle(run, callback);
        }
        return originalUpdate.apply(this, args);
      };
    }
    const originalCreate = tabs.create;
    if (typeof originalCreate === 'function') {
      tabs.create = function create(props, callback) {
        if (props && isInternal(props.url)) {
          const run = createInternal(props.url, props.active !== false).then((id) => tabs.get(id));
          return settle(run, callback);
        }
        return originalCreate.apply(this, arguments);
      };
    }
  }
}

if (isWorker || isExtensionPage) {
  try {
    contextBridge.executeInMainWorld({ func: murshidPost });
  } catch (error) {
    console.error('[murshid] extension API post-preload failed:', error);
  }
}
