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
