'use strict';

const { Menu, clipboard, shell } = require('electron');
const { t, number, percent } = require('./i18n');

const isMac = process.platform === 'darwin';

/** macOS application menu. Windows and Linux have none (keys: commands.js). */
function installAppMenu(ctx) {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const c = ctx.commands.run;
  const w = () => ctx.lastFocusedWindow();
  const item = (key, accelerator, fn) => ({ label: t(key), accelerator, click: () => fn(w()) });
  const role = (name, key) => ({ role: name, label: t(key) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Murshid',
      submenu: [
        item('mac.about', undefined, c.about),
        item('page.updates.check', undefined, c.updates),
        { type: 'separator' },
        item('mac.settings', 'Cmd+,', c.settings),
        { type: 'separator' },
        role('services', 'mac.services'),
        { type: 'separator' },
        role('hide', 'mac.hide'),
        role('hideOthers', 'mac.hideOthers'),
        role('unhide', 'mac.unhide'),
        { type: 'separator' },
        { label: t('mac.quit'), accelerator: 'Cmd+Q', click: () => ctx.quit() },
      ],
    },
    {
      label: t('mac.file'),
      submenu: [
        item('mac.newTab', 'Cmd+T', c.newTab),
        item('mac.newWindow', 'Cmd+N', c.newWindow),
        item('mac.reopenTab', 'Cmd+Shift+T', c.reopenTab),
        item('mac.openLocation', 'Cmd+L', c.focusOmnibox),
        { type: 'separator' },
        item('mac.closeTab', 'Cmd+W', c.closeTab),
        item('mac.closeWindow', 'Cmd+Shift+W', c.closeWindow),
        { type: 'separator' },
        item('mac.print', 'Cmd+P', c.print),
      ],
    },
    {
      label: t('mac.edit'),
      submenu: [
        role('undo', 'mac.undo'), role('redo', 'mac.redo'), { type: 'separator' },
        role('cut', 'mac.cut'), role('copy', 'mac.copy'), role('paste', 'mac.paste'),
        role('pasteAndMatchStyle', 'mac.pasteAndMatchStyle'),
        role('delete', 'mac.delete'), role('selectAll', 'mac.selectAll'), { type: 'separator' },
        item('mac.find', 'Cmd+F', c.find),
        item('mac.findNext', 'Cmd+G', c.findNext),
        item('mac.findPrev', 'Cmd+Shift+G', c.findPrev),
      ],
    },
    {
      label: t('mac.view'),
      submenu: [
        item('mac.reload', 'Cmd+R', c.reload),
        item('mac.hardReload', 'Cmd+Shift+R', c.hardReload),
        { type: 'separator' },
        item('mac.actualSize', 'Cmd+0', c.zoomReset),
        item('mac.zoomIn', 'Cmd+=', c.zoomIn),
        item('mac.zoomOut', 'Cmd+-', c.zoomOut),
        { type: 'separator' },
        item('mac.webBrainPanel', 'Alt+Shift+W', c.webBrain),
        { type: 'separator' },
        item('mac.fullscreen', 'Ctrl+Cmd+F', c.fullscreen),
        item('mac.viewSource', 'Cmd+Alt+U', c.viewSource),
        item('mac.devTools', 'Cmd+Alt+I', c.devTools),
      ],
    },
    {
      label: t('mac.history'),
      submenu: [
        item('mac.back', 'Cmd+[', c.back),
        item('mac.forward', 'Cmd+]', c.forward),
        item('mac.home', 'Cmd+Shift+H', c.home),
      ],
    },
    {
      label: t('mac.tab'),
      submenu: [
        item('mac.nextTab', 'Cmd+Alt+Right', c.nextTab),
        item('mac.prevTab', 'Cmd+Alt+Left', c.prevTab),
        ...Array.from({ length: 9 }, (_, i) => ({
          label: i === 8 ? t('mac.lastTab') : t('mac.tabN', { n: number(i + 1) }),
          accelerator: `Cmd+${i + 1}`,
          click: () => c.selectIndex(w(), i + 1),
        })),
      ],
    },
    {
      label: t('mac.window'),
      role: 'windowMenu',
      submenu: [
        role('minimize', 'mac.minimize'),
        role('zoom', 'mac.zoom'),
        { type: 'separator' },
        role('front', 'mac.front'),
      ],
    },
  ]));
}

/** The toolbar's "⋮" menu. */
function popupMainMenu(ctx, w, { x, y }) {
  const c = ctx.commands.run;
  const tab = w.activeTab;
  const zoom = tab ? Math.round(tab.wc.getZoomFactor() * 100) : 100;
  const mod = isMac ? 'Cmd' : 'Ctrl';
  const companion = ctx.companion.status();
  // Ad blocking for the site in this tab; unticking allows its ads.
  const site = ctx.adblock?.enabled ? ctx.adblock.siteOf(tab?.url) : null;
  const adblockItems = site ? [{
    label: t('menu.blockAds', { host: site }),
    type: 'checkbox',
    checked: !ctx.adblock.isAllowed(site),
    click: () => {
      ctx.adblock.setAllowed(site, !ctx.adblock.isAllowed(site));
      if (!tab.wc.isDestroyed()) tab.wc.reload();
    },
  }] : [];
  const menu = Menu.buildFromTemplate([
    { label: t('menu.newTab'), accelerator: `${mod}+T`, click: () => c.newTab(w) },
    { label: t('menu.newWindow'), accelerator: `${mod}+N`, click: () => c.newWindow() },
    { label: t('menu.reopenTab'), accelerator: `${mod}+Shift+T`, click: () => c.reopenTab(w) },
    { type: 'separator' },
    { label: t('menu.webBrainPanel'), accelerator: 'Alt+Shift+W', click: () => c.webBrain(w) },
    {
      label: t(companion.running ? 'menu.companionRunning' : companion.found ? 'menu.companionStart' : 'menu.companionGet'),
      click: () => ctx.companion.openPanel(w),
    },
    { type: 'separator' },
    {
      label: t('menu.zoom', { zoom: percent(zoom) }),
      submenu: [
        { label: t('menu.zoomIn'), accelerator: `${mod}+=`, click: () => c.zoomIn(w) },
        { label: t('menu.zoomOut'), accelerator: `${mod}+-`, click: () => c.zoomOut(w) },
        { label: t('menu.zoomReset'), accelerator: `${mod}+0`, click: () => c.zoomReset(w) },
      ],
    },
    { label: t('menu.find'), accelerator: `${mod}+F`, click: () => c.find(w) },
    { label: t('menu.print'), accelerator: `${mod}+P`, click: () => c.print(w) },
    { label: t('menu.downloadsFolder'), click: () => shell.openPath(ctx.downloads.folder()) },
    ...adblockItems,
    { type: 'separator' },
    {
      label: t('menu.moreTools'),
      submenu: [
        { label: t('menu.devTools'), accelerator: 'F12', click: () => c.devTools(w) },
        { label: t('menu.viewSource'), accelerator: `${mod}+U`, click: () => c.viewSource(w) },
        { label: t('menu.inspectPanel'), enabled: Boolean(w.panelContents()), click: () => c.panelDevTools(w) },
        { label: t('menu.inspectUI'), click: () => c.uiDevTools(w) },
        { type: 'separator' },
        { label: t('menu.copyAddress'), enabled: Boolean(tab?.url), click: () => clipboard.writeText(tab.url) },
      ],
    },
    { type: 'separator' },
    { label: t('menu.settings'), click: () => c.settings(w) },
    { label: t('menu.about'), click: () => c.about(w) },
    { label: ctx.updates?.snapshot().status === 'available'
      ? t('menu.updateAvailable', { version: ctx.updates.snapshot().latestVersion }) : t('page.updates.check'),
      click: () => c.updates(w) },
    { type: 'separator' },
    { label: t('menu.exit'), accelerator: isMac ? 'Cmd+Q' : `${mod}+Shift+Q`, click: () => ctx.quit() },
  ]);
  menu.popup({ window: w.win, x: Math.round(x), y: Math.round(y) });
}

function popupTabMenu(ctx, w, tab, { x, y }) {
  const menu = Menu.buildFromTemplate([
    { label: t('tabMenu.newTabRight'), click: () => w.addTab({ after: tab }) },
    { type: 'separator' },
    { label: t('tabMenu.reload'), click: () => tab.wc.reload() },
    { label: t('tabMenu.duplicate'), click: () => w.addTab({ url: tab.url, after: tab }) },
    { label: t(tab.wc.isAudioMuted() ? 'tabMenu.unmute' : 'tabMenu.mute'), click: () => { tab.wc.setAudioMuted(!tab.wc.isAudioMuted()); w.scheduleState(); } },
    { label: t('tabMenu.openWebBrain'), click: () => { w.selectTab(tab); ctx.crx.clickAction(w); } },
    { type: 'separator' },
    { label: t('tabMenu.close'), click: () => w.closeTab(tab) },
    {
      label: t('tabMenu.closeOthers'),
      enabled: w.tabs.length > 1,
      click: () => w.tabs.filter((other) => other !== tab).forEach((other) => w.closeTab(other)),
    },
    {
      label: t('tabMenu.closeRight'),
      enabled: w.tabs.indexOf(tab) < w.tabs.length - 1,
      click: () => w.tabs.slice(w.tabs.indexOf(tab) + 1).forEach((other) => w.closeTab(other)),
    },
    { type: 'separator' },
    { label: t('tabMenu.reopen'), enabled: w.closedTabs.length > 0, click: () => w.reopenClosedTab() },
  ]);
  menu.popup({ window: w.win, x: Math.round(x), y: Math.round(y) });
}

module.exports = { installAppMenu, popupMainMenu, popupTabMenu };
