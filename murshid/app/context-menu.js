'use strict';

// Right-click menu for tabs and the side panel: the usual browser entries plus
// whatever WebBrain registered with chrome.contextMenus.

const { Menu, MenuItem, clipboard } = require('electron');

function buildContextMenu(ctx, tab, params, contents) {
  const wc = contents || tab.wc;
  const w = tab ? tab.owner : ctx.lastFocusedWindow();
  const items = [];
  const add = (opts) => items.push(new MenuItem(opts));
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') add({ type: 'separator' }); };

  if (params.linkURL) {
    add({ label: 'Open link in new tab', click: () => w?.addTab({ url: params.linkURL, active: false, after: tab || undefined }) });
    add({ label: 'Open link in new window', click: () => ctx.createWindow({ url: params.linkURL }) });
    add({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    sep();
  }
  if (params.mediaType === 'image' && params.srcURL) {
    add({ label: 'Open image in new tab', click: () => w?.addTab({ url: params.srcURL, active: false, after: tab || undefined }) });
    add({ label: 'Save image as…', click: () => {
      ctx.downloads.start({ url: params.srcURL, saveAs: true }, wc)
        .catch((error) => console.error('[murshid] could not save image:', error));
    } });
    add({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    add({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
    sep();
  }
  if (params.isEditable) {
    if (params.misspelledWord && params.dictionarySuggestions?.length) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        add({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
      }
      add({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      sep();
    }
    add({ role: 'undo', enabled: params.editFlags.canUndo });
    add({ role: 'redo', enabled: params.editFlags.canRedo });
    sep();
    add({ role: 'cut', enabled: params.editFlags.canCut });
    add({ role: 'copy', enabled: params.editFlags.canCopy });
    add({ role: 'paste', enabled: params.editFlags.canPaste });
    add({ role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste });
    add({ role: 'selectAll' });
    sep();
  } else if (params.selectionText) {
    const text = params.selectionText.trim();
    add({ role: 'copy' });
    if (text && tab) {
      const shown = text.length > 28 ? `${text.slice(0, 28)}…` : text;
      add({ label: `Search for “${shown}”`, click: () => w?.addTab({ url: ctx.settings.searchUrl(text), after: tab }) });
    }
    sep();
  }
  if (tab && !params.linkURL && !params.isEditable && !params.selectionText && params.mediaType === 'none') {
    const history = wc.navigationHistory;
    add({ label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() });
    add({ label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() });
    add({ label: 'Reload', click: () => wc.reload() });
    sep();
    add({ label: 'Print…', click: () => wc.print() });
    add({ label: 'View page source', enabled: /^https?:/i.test(tab.url), click: () => w?.addTab({ url: `view-source:${tab.url}`, after: tab }) });
    sep();
  }

  if (tab) {
    try {
      const extensionItems = ctx.extensions.getContextMenuItems(wc, params);
      if (extensionItems.length) {
        sep();
        extensionItems.forEach((entry) => items.push(entry));
      }
    } catch (error) {
      console.warn('[murshid] extension context menu failed:', error);
    }
  }

  sep();
  add({ label: 'Inspect', click: () => {
    if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
    wc.inspectElement(params.x, params.y);
  } });

  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  const menu = new Menu();
  items.forEach((entry) => menu.append(entry));
  return menu;
}

function showContextMenu(ctx, tab, params, contents) {
  const menu = buildContextMenu(ctx, tab, params, contents);
  const w = tab ? tab.owner : ctx.lastFocusedWindow();
  menu?.popup({ window: w?.win });
}

module.exports = { showContextMenu };
