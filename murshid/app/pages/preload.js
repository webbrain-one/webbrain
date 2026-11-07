'use strict';

// Registered for every frame in the browsing session, but only does anything in
// Murshid's own murshid:// pages, which get a small API for settings and info.
// The main process checks the sender's URL again before answering.

const { contextBridge, ipcRenderer } = require('electron');

if (typeof location !== 'undefined' && location.protocol === 'murshid:' && window.top === window) {
  // The page itself arrives translated; these strings are for what pages.js fills in.
  let i18n = { locale: 'en', dir: 'ltr', strings: {} };
  try { i18n = ipcRenderer.sendSync('murshid-i18n') || i18n; } catch {}
  contextBridge.exposeInMainWorld('murshid', {
    i18n,
    info: () => ipcRenderer.invoke('murshid-page', 'info'),
    settings: () => ipcRenderer.invoke('murshid-page', 'settings'),
    setSetting: (key, value) => ipcRenderer.invoke('murshid-page', 'setSetting', key, value),
    clearHistory: () => ipcRenderer.invoke('murshid-page', 'clearHistory'),
    navigate: (text) => ipcRenderer.invoke('murshid-page', 'navigate', text),
    openWebBrain: () => ipcRenderer.invoke('murshid-page', 'openWebBrain'),
    companion: () => ipcRenderer.invoke('murshid-page', 'companion'),
  });
}
