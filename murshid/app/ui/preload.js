'use strict';

// Bridge for Murshid's own browser chrome (tab strip, toolbar, panel header).

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'murshid:state',
  'murshid:focus-omnibox',
  'murshid:find-open',
  'murshid:find-step',
  'murshid:find-result',
  'murshid:suggest-update',
  'murshid:popup-pick',
  'murshid:omnibox-refocus',
  'murshid:omnibox-close',
  'murshid:popup', // to the suggestion list view (popup.js)
]);

// The interface language and its strings (app/i18n.js), asked for once and
// synchronously so the chrome is never drawn in the wrong language.
let i18n = { locale: 'en', dir: 'ltr', strings: {} };
try { i18n = ipcRenderer.sendSync('murshid-i18n') || i18n; } catch {}

contextBridge.exposeInMainWorld('murshidUI', {
  i18n,
  invoke: (command, ...args) => ipcRenderer.invoke('murshid-ui', command, ...args),
  on: (channel, callback) => {
    if (!CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_event, payload) => callback(payload));
  },
});
