'use strict';

// The address bar's dropdown. Tab and side panel views sit above the window's
// own webContents (the browser chrome), so the list gets a transparent view of
// its own, laid over the page just under the address bar. Typing and keys stay
// in the address bar; this view only draws the rows (ui/popup.js) and reports
// mouse picks.

const { WebContentsView } = require('electron');
const path = require('node:path');
const i18n = require('./i18n');

// Keep in step with ui/popup.css.
const ROW_HEIGHT = 36;
const CARD_CHROME = 11; // separator, padding and bottom border
const SHADOW = 14; // room under the card for its shadow
const SIDE = 8; // room either side, ditto

class OmniboxPopup {
  /** @param {import('./window').MurshidWindow} w */
  constructor(w) {
    this.w = w;
    this.view = null;
    this.ready = false;
    this.open = false;
    this.payload = null;
  }

  /** Create the view (and start loading its page) ahead of the first suggestion. */
  ensure() {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        // Its rows show favicons too: same session as the browser chrome.
        ...(this.w.ctx.uiPartition ? { partition: this.w.ctx.uiPartition } : {}),
      },
    });
    view.setBackgroundColor('#00000000');
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.on('before-input-event', (event, input) => this.w.ctx.commands.handleInput(event, input, this.w));
    wc.on('did-finish-load', () => {
      this.ready = true;
      if (this.payload) wc.send('murshid:popup', this.payload);
    });
    // A click in the list moves focus here for a moment; if it then ends up
    // somewhere other than the address bar (another app, say), close the list.
    wc.on('blur', () => {
      setTimeout(() => {
        if (!this.open || this.w.win.isDestroyed()) return;
        if (this.w.ui.isFocused() || this.isFocused()) return;
        this.hide();
        this.w.ui.send('murshid:omnibox-close');
      }, 60);
    });
    wc.loadFile(path.join(__dirname, 'ui', 'popup.html'));
    this.view = view;
    return view;
  }

  /** @param {{items: object[], selected: number, input: string, engine: string, rect: {x: number, y: number, width: number, height: number}}} payload */
  show({ items, selected, input, engine, rect } = {}) {
    if (this.w.win.isDestroyed()) return;
    if (!Array.isArray(items) || !items.length || !rect) {
      this.hide();
      return;
    }
    const view = this.ensure();
    this.payload = { items, selected: Number(selected) || 0, input: String(input || ''), engine: String(engine || '') };
    if (this.ready) view.webContents.send('murshid:popup', this.payload);

    const { width: winWidth, height: winHeight } = this.w.win.getContentBounds();
    const x = Math.max(0, Math.round(rect.x - SIDE));
    const y = Math.round(rect.y + rect.height);
    const width = Math.min(Math.round(rect.width + SIDE * 2), winWidth - x);
    const height = Math.min(ROW_HEIGHT * items.length + CARD_CHROME + SHADOW, Math.max(0, winHeight - y));
    // x is where the list appears on screen; Chromium mirrors child view
    // positions when its own locale reads right to left (see app/i18n.js).
    view.setBounds({ x: i18n.frameDir() === 'rtl' ? winWidth - x - width : x, y, width, height });
    if (!this.open) {
      this.open = true;
      this.w.win.contentView.addChildView(view);
    }
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    try { this.w.win.contentView.removeChildView(this.view); } catch {}
  }

  /** Put the list back on top after another view (a side panel) was added. */
  raise() {
    if (this.open && this.view) this.w.win.contentView.addChildView(this.view);
  }

  isFocused() {
    try {
      return Boolean(this.view && !this.view.webContents.isDestroyed() && this.view.webContents.isFocused());
    } catch {
      return false;
    }
  }

  owns(contents) {
    return Boolean(this.view && this.view.webContents === contents);
  }

  destroy() {
    this.hide();
    try { this.view?.webContents.close(); } catch {}
    this.view = null;
  }
}

module.exports = { OmniboxPopup, ROW_HEIGHT };
