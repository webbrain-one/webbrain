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

contextBridge.exposeInMainWorld('murshidUI', {
  invoke: (command, ...args) => ipcRenderer.invoke('murshid-ui', command, ...args),
  on: (channel, callback) => {
    if (!CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_event, payload) => callback(payload));
  },
});
