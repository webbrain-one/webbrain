'use strict';

// Right-click menu for tabs and the side panel: the usual browser entries plus
// whatever WebBrain registered with chrome.contextMenus.

const { Menu, MenuItem, clipboard } = require('electron');
const { t } = require('./i18n');

function buildContextMenu(ctx, tab, params, contents) {
  const wc = contents || tab.wc;
  const w = tab ? tab.owner : ctx.lastFocusedWindow();
  const items = [];
  const add = (opts) => items.push(new MenuItem(opts));
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') add({ type: 'separator' }); };

  if (params.linkURL) {
    add({ label: t('context.openLinkTab'), click: () => w?.addTab({ url: params.linkURL, active: false, after: tab || undefined }) });
    add({ label: t('context.openLinkWindow'), click: () => ctx.createWindow({ url: params.linkURL }) });
    add({ label: t('context.copyLink'), click: () => clipboard.writeText(params.linkURL) });
    sep();
  }
  if (params.mediaType === 'image' && params.srcURL) {
    add({ label: t('context.openImageTab'), click: () => w?.addTab({ url: params.srcURL, active: false, after: tab || undefined }) });
    add({ label: t('context.saveImage'), click: () => {
      ctx.downloads.start({ url: params.srcURL, saveAs: true }, wc)
        .catch((error) => console.error('[murshid] could not save image:', error));
    } });
    add({ label: t('context.copyImage'), click: () => wc.copyImageAt(params.x, params.y) });
    add({ label: t('context.copyImageAddress'), click: () => clipboard.writeText(params.srcURL) });
    sep();
  }
  if (params.isEditable) {
    if (params.misspelledWord && params.dictionarySuggestions?.length) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        add({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
      }
      add({ label: t('context.addToDictionary'), click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      sep();
    }
    add({ role: 'undo', label: t('context.undo'), enabled: params.editFlags.canUndo });
    add({ role: 'redo', label: t('context.redo'), enabled: params.editFlags.canRedo });
    sep();
    add({ role: 'cut', label: t('context.cut'), enabled: params.editFlags.canCut });
    add({ role: 'copy', label: t('context.copy'), enabled: params.editFlags.canCopy });
    add({ role: 'paste', label: t('context.paste'), enabled: params.editFlags.canPaste });
    add({ role: 'pasteAndMatchStyle', label: t('context.pasteAndMatchStyle'), enabled: params.editFlags.canPaste });
    add({ role: 'selectAll', label: t('context.selectAll') });
    sep();
  } else if (params.selectionText) {
    const text = params.selectionText.trim();
    add({ role: 'copy', label: t('context.copy') });
    if (text && tab) {
      const shown = text.length > 28 ? `${text.slice(0, 28)}…` : text;
      add({ label: t('context.searchFor', { text: shown }), click: () => w?.addTab({ url: ctx.settings.searchUrl(text), after: tab }) });
    }
    sep();
  }
  if (tab && !params.linkURL && !params.isEditable && !params.selectionText && params.mediaType === 'none') {
    const history = wc.navigationHistory;
    add({ label: t('context.back'), enabled: history.canGoBack(), click: () => history.goBack() });
    add({ label: t('context.forward'), enabled: history.canGoForward(), click: () => history.goForward() });
    add({ label: t('context.reload'), click: () => wc.reload() });
    sep();
    add({ label: t('context.print'), click: () => wc.print() });
    add({ label: t('context.viewSource'), enabled: /^https?:/i.test(tab.url), click: () => w?.addTab({ url: `view-source:${tab.url}`, after: tab }) });
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
  add({ label: t('context.inspect'), click: () => {
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
