'use strict';

const { Menu, clipboard, shell } = require('electron');

const isMac = process.platform === 'darwin';

/** macOS application menu. Windows and Linux have none (keys: commands.js). */
function installAppMenu(ctx) {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const c = ctx.commands.run;
  const w = () => ctx.lastFocusedWindow();
  const item = (label, accelerator, fn) => ({ label, accelerator, click: () => fn(w()) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Murshid',
      submenu: [
        item('About Murshid', undefined, c.about),
        { type: 'separator' },
        item('Settings…', 'Cmd+,', c.settings),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Murshid', accelerator: 'Cmd+Q', click: () => ctx.quit() },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('New Tab', 'Cmd+T', c.newTab),
        item('New Window', 'Cmd+N', c.newWindow),
        item('Reopen Closed Tab', 'Cmd+Shift+T', c.reopenTab),
        item('Open Location…', 'Cmd+L', c.focusOmnibox),
        { type: 'separator' },
        item('Close Tab', 'Cmd+W', c.closeTab),
        item('Close Window', 'Cmd+Shift+W', c.closeWindow),
        { type: 'separator' },
        item('Print…', 'Cmd+P', c.print),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
        { role: 'delete' }, { role: 'selectAll' }, { type: 'separator' },
        item('Find…', 'Cmd+F', c.find),
        item('Find Next', 'Cmd+G', c.findNext),
        item('Find Previous', 'Cmd+Shift+G', c.findPrev),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Reload', 'Cmd+R', c.reload),
        item('Hard Reload', 'Cmd+Shift+R', c.hardReload),
        { type: 'separator' },
        item('Actual Size', 'Cmd+0', c.zoomReset),
        item('Zoom In', 'Cmd+=', c.zoomIn),
        item('Zoom Out', 'Cmd+-', c.zoomOut),
        { type: 'separator' },
        item('WebBrain Panel', 'Alt+Shift+W', c.webBrain),
        { type: 'separator' },
        item('Enter Full Screen', 'Ctrl+Cmd+F', c.fullscreen),
        item('View Source', 'Cmd+Alt+U', c.viewSource),
        item('Developer Tools', 'Cmd+Alt+I', c.devTools),
      ],
    },
    {
      label: 'History',
      submenu: [
        item('Back', 'Cmd+[', c.back),
        item('Forward', 'Cmd+]', c.forward),
        item('Home', 'Cmd+Shift+H', c.home),
      ],
    },
    {
      label: 'Tab',
      submenu: [
        item('Next Tab', 'Cmd+Alt+Right', c.nextTab),
        item('Previous Tab', 'Cmd+Alt+Left', c.prevTab),
        ...Array.from({ length: 9 }, (_, i) => item(i === 8 ? 'Last Tab' : `Tab ${i + 1}`, `Cmd+${i + 1}`, (win) => c.selectIndex(win, i + 1))),
      ],
    },
    { role: 'windowMenu' },
  ]));
}

/** The toolbar's "⋮" menu. */
function popupMainMenu(ctx, w, { x, y }) {
  const c = ctx.commands.run;
  const tab = w.activeTab;
  const zoom = tab ? Math.round(tab.wc.getZoomFactor() * 100) : 100;
  const mod = isMac ? 'Cmd' : 'Ctrl';
  const companion = ctx.companion.status();
  const menu = Menu.buildFromTemplate([
    { label: 'New tab', accelerator: `${mod}+T`, click: () => c.newTab(w) },
    { label: 'New window', accelerator: `${mod}+N`, click: () => c.newWindow() },
    { label: 'Reopen closed tab', accelerator: `${mod}+Shift+T`, click: () => c.reopenTab(w) },
    { type: 'separator' },
    { label: 'WebBrain panel', accelerator: 'Alt+Shift+W', click: () => c.webBrain(w) },
    {
      label: companion.running ? 'WebBrain Companion — running' : companion.found ? 'Start WebBrain Companion' : 'Get WebBrain Companion',
      click: () => ctx.companion.openPanel(w),
    },
    { type: 'separator' },
    {
      label: `Zoom  ${zoom}%`,
      submenu: [
        { label: 'Zoom in', accelerator: `${mod}+=`, click: () => c.zoomIn(w) },
        { label: 'Zoom out', accelerator: `${mod}+-`, click: () => c.zoomOut(w) },
        { label: 'Reset', accelerator: `${mod}+0`, click: () => c.zoomReset(w) },
      ],
    },
    { label: 'Find…', accelerator: `${mod}+F`, click: () => c.find(w) },
    { label: 'Print…', accelerator: `${mod}+P`, click: () => c.print(w) },
    { label: 'Downloads folder', click: () => shell.openPath(ctx.downloads.folder()) },
    { type: 'separator' },
    {
      label: 'More tools',
      submenu: [
        { label: 'Developer tools', accelerator: 'F12', click: () => c.devTools(w) },
        { label: 'View source', accelerator: `${mod}+U`, click: () => c.viewSource(w) },
        { label: 'Inspect WebBrain panel', enabled: Boolean(w.panelContents()), click: () => c.panelDevTools(w) },
        { label: 'Inspect browser UI', click: () => c.uiDevTools(w) },
        { type: 'separator' },
        { label: 'Copy page address', enabled: Boolean(tab?.url), click: () => clipboard.writeText(tab.url) },
      ],
    },
    { type: 'separator' },
    { label: 'Settings', click: () => c.settings(w) },
    { label: 'About Murshid', click: () => c.about(w) },
    { type: 'separator' },
    { label: 'Exit', accelerator: isMac ? 'Cmd+Q' : `${mod}+Shift+Q`, click: () => ctx.quit() },
  ]);
  menu.popup({ window: w.win, x: Math.round(x), y: Math.round(y) });
}

function popupTabMenu(ctx, w, tab, { x, y }) {
  const menu = Menu.buildFromTemplate([
    { label: 'New tab to the right', click: () => w.addTab({ after: tab }) },
    { type: 'separator' },
    { label: 'Reload', click: () => tab.wc.reload() },
    { label: 'Duplicate', click: () => w.addTab({ url: tab.url, after: tab }) },
    { label: tab.wc.isAudioMuted() ? 'Unmute site' : 'Mute site', click: () => { tab.wc.setAudioMuted(!tab.wc.isAudioMuted()); w.scheduleState(); } },
    { label: 'Open WebBrain for this tab', click: () => { w.selectTab(tab); ctx.crx.clickAction(w); } },
    { type: 'separator' },
    { label: 'Close tab', click: () => w.closeTab(tab) },
    {
      label: 'Close other tabs',
      enabled: w.tabs.length > 1,
      click: () => w.tabs.filter((t) => t !== tab).forEach((t) => w.closeTab(t)),
    },
    {
      label: 'Close tabs to the right',
      enabled: w.tabs.indexOf(tab) < w.tabs.length - 1,
      click: () => w.tabs.slice(w.tabs.indexOf(tab) + 1).forEach((t) => w.closeTab(t)),
    },
    { type: 'separator' },
    { label: 'Reopen closed tab', enabled: w.closedTabs.length > 0, click: () => w.reopenClosedTab() },
  ]);
  menu.popup({ window: w.win, x: Math.round(x), y: Math.round(y) });
}

module.exports = { installAppMenu, popupMainMenu, popupTabMenu };
