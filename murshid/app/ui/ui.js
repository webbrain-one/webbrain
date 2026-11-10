'use strict';

// Murshid browser chrome: renders the state the main process pushes and sends
// user actions back. All browsing happens in the tab views, never here.

const api = window.murshidUI;
const $ = (id) => document.getElementById(id);
const platform = new URLSearchParams(location.search).get('platform') || 'win32';
document.body.classList.add(platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : 'win');

// Language (app/i18n.js) ----------------------------------------------------------

const i18n = api.i18n || { locale: 'en', dir: 'ltr', strings: {} };
document.documentElement.lang = i18n.locale;
document.documentElement.dir = i18n.dir;
const rtl = i18n.dir === 'rtl';
// Where the window's own buttons are: the caption buttons are on the right on
// Windows and Linux, the traffic lights on the left on macOS, and both swap
// sides when Chromium mirrors the frame. "start" and "end" are along the line
// of this interface, which may read the other way.
const frameRtl = i18n.frameDir === 'rtl';
const controlsOnLeft = platform === 'darwin' ? !frameRtl : frameRtl;
document.body.classList.add(controlsOnLeft === !rtl ? 'controls-start' : 'controls-end');

function t(key, vars) {
  const text = i18n.strings[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text;
}
const numberFormat = new Intl.NumberFormat(i18n.locale);
const percentFormat = new Intl.NumberFormat(i18n.locale, { style: 'percent', maximumFractionDigits: 0 });

// data-t-title / data-t-aria-label / data-t-placeholder name a string; data-t-key
// is the keyboard shortcut it mentions.
for (const el of document.querySelectorAll('[data-t-title], [data-t-aria-label], [data-t-placeholder]')) {
  const vars = { key: el.dataset.tKey || '' };
  if (el.dataset.tTitle) el.title = t(el.dataset.tTitle, vars);
  if (el.dataset.tAriaLabel) el.setAttribute('aria-label', t(el.dataset.tAriaLabel, vars));
  if (el.dataset.tPlaceholder) el.placeholder = t(el.dataset.tPlaceholder, vars);
}

const els = {
  chrome: $('chrome'),
  tabs: $('tabs'),
  newTab: $('new-tab'),
  back: $('back'),
  forward: $('forward'),
  reload: $('reload'),
  omnibox: $('omnibox'),
  address: $('address'),
  site: $('site'),
  zoom: $('zoom-chip'),
  webbrain: $('webbrain'),
  webbrainIcon: $('webbrain-icon'),
  downloads: $('downloads'),
  downloadRing: $('download-ring'),
  menu: $('menu'),
  updates: $('updates'),
  findbar: $('findbar'),
  findInput: $('find-input'),
  findCount: $('find-count'),
  panelHeader: $('panel-header'),
  panelTitle: $('panel-title'),
  splitter: $('splitter'),
  caption: $('caption'),
};

let state = { tabs: [], activeId: null, panel: null };
let editing = false; // the address bar holds what the user is typing
const tabEls = new Map();

const MURSHID_ICON = '../../assets/icons/murshid.svg';

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

// -------------------------------------------------------------------- tabs

function faviconFor(tab) {
  if (tab.crashed) return { svg: 'i-warn' };
  if (tab.loading) return { spinner: true };
  if (tab.favicon === 'murshid' || tab.isNewTab) return { img: MURSHID_ICON };
  if (/^chrome-extension:/.test(tab.url) && state.webBrain?.icon) return { img: state.webBrain.icon };
  if (/^murshid:/.test(tab.url)) return { img: MURSHID_ICON };
  if (tab.favicon) return { img: tab.favicon };
  return { svg: 'i-globe' };
}

function renderFavicon(holder, tab) {
  const f = faviconFor(tab);
  const key = JSON.stringify(f);
  if (holder.dataset.key === key) return;
  holder.dataset.key = key;
  holder.textContent = '';
  if (f.spinner) {
    const s = document.createElement('i');
    s.className = 'spinner';
    holder.append(s);
  } else if (f.img) {
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = f.img;
    img.onerror = () => { holder.dataset.key = ''; holder.innerHTML = '<svg><use href="#i-globe"/></svg>'; };
    holder.append(img);
  } else {
    holder.innerHTML = `<svg><use href="#${f.svg}"/></svg>`;
  }
}

function createTabEl(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.dataset.id = String(tab.id);
  el.innerHTML = `
    <span class="favicon"></span>
    <span class="title" dir="auto"></span>
    <button class="audio" hidden tabindex="-1"></button>
    <button class="close" tabindex="-1"><svg><use href="#i-close"/></svg></button>`;
  el.querySelector('.close').setAttribute('aria-label', t('ui.closeTab'));
  el.querySelector('.close').addEventListener('click', (event) => {
    event.stopPropagation();
    api.invoke('closeTab', tab.id);
  });
  el.querySelector('.audio').addEventListener('click', (event) => {
    event.stopPropagation();
    api.invoke('mute', tab.id);
  });
  el.addEventListener('pointerdown', (event) => onTabPointerDown(event, el));
  el.addEventListener('auxclick', (event) => {
    if (event.button === 1) api.invoke('closeTab', Number(el.dataset.id));
  });
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.invoke('tabMenu', Number(el.dataset.id), { x: event.clientX, y: event.clientY });
  });
  return el;
}

function renderTabs() {
  const seen = new Set();
  state.tabs.forEach((tab, index) => {
    let el = tabEls.get(tab.id);
    if (!el) {
      el = createTabEl(tab);
      tabEls.set(tab.id, el);
    }
    seen.add(tab.id);
    if (els.tabs.children[index] !== el) els.tabs.insertBefore(el, els.tabs.children[index] || null);
    el.classList.toggle('active', tab.id === state.activeId);
    el.setAttribute('aria-selected', String(tab.id === state.activeId));
    el.title = tab.title + (tab.displayUrl ? `\n${tab.displayUrl}` : '');
    el.querySelector('.title').textContent = tab.title;
    renderFavicon(el.querySelector('.favicon'), tab);
    const audio = el.querySelector('.audio');
    audio.hidden = !(tab.audible || tab.muted);
    audio.innerHTML = tab.muted ? '<svg><use href="#i-muted"/></svg>' : '<svg><use href="#i-sound"/></svg>';
  });
  for (const [id, el] of tabEls) {
    if (!seen.has(id)) {
      el.remove();
      tabEls.delete(id);
    }
  }
  requestAnimationFrame(updateNarrowTabs);
}

// Tabs too narrow for a title show only their icon. Every tab has the same
// flex basis, so they share one width and one decision. Measured tab by tab,
// each toggle reflowed the strip before the next tab was read, and a narrow
// tab (no padding) shrinks more than a titled one, so the strip settled with
// some tabs icon-only and the rest titled.
function updateNarrowTabs() {
  const count = tabEls.size;
  const narrow = count > 0 && els.tabs.getBoundingClientRect().width / count < 72;
  for (const el of tabEls.values()) el.classList.toggle('narrow', narrow);
}

// Drag to reorder ------------------------------------------------------------

let drag = null;

function onTabPointerDown(event, el) {
  if (event.button !== 0 || event.target.closest('.close, .audio')) return;
  const id = Number(el.dataset.id);
  if (id !== state.activeId) api.invoke('selectTab', id);
  drag = { el, id, startX: event.clientX, moved: false, pointerId: event.pointerId };
  el.setPointerCapture(event.pointerId);
}

window.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.startX;
  if (!drag.moved && Math.abs(dx) < 6) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.el.classList.add('dragging');
    drag.others = [...els.tabs.children].filter((c) => c !== drag.el);
  }
  drag.el.style.transform = `translateX(${dx}px)`;
});

window.addEventListener('pointerup', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const { el, id, moved } = drag;
  drag = null;
  el.classList.remove('dragging');
  el.style.transform = '';
  if (!moved) return;
  const rect = el.getBoundingClientRect();
  const center = event.clientX - (rect.width / 2) + (rect.width / 2);
  const children = [...els.tabs.children].filter((c) => c !== el);
  // Tabs run right to left in Arabic and Persian.
  let index = children.findIndex((c) => {
    const r = c.getBoundingClientRect();
    const middle = r.left + r.width / 2;
    return rtl ? center > middle : center < middle;
  });
  if (index === -1) index = children.length;
  api.invoke('moveTab', id, index);
});

// --------------------------------------------------------------- toolbar

function prettyUrl(url) {
  if (!url) return '';
  return url.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '');
}

function renderToolbar() {
  const tab = activeTab();
  els.back.disabled = !tab?.canGoBack;
  els.forward.disabled = !tab?.canGoForward;
  const loading = Boolean(tab?.loading);
  els.reload.querySelector('use').setAttribute('href', loading ? '#i-stop' : '#i-reload');
  els.reload.title = loading ? t('ui.stopTip') : t('ui.reloadTip', { key: 'Ctrl+R' });
  els.reload.setAttribute('aria-label', loading ? t('ui.stop') : t('ui.reload'));

  // The input stays document.activeElement after focus moves to a tab view, so
  // also check that this page has focus before treating it as in use.
  const addressInUse = document.hasFocus() && document.activeElement === els.address;
  if (!editing && !addressInUse) {
    els.address.value = tab ? prettyUrl(tab.displayUrl) : '';
  }
  const isWeb = tab && tab.displayUrl;
  els.site.className = tab?.secure && isWeb ? 'secure' : '';
  els.site.querySelector('use')?.setAttribute('href', !isWeb ? '#i-search' : tab.secure ? '#i-lock' : '#i-globe');
  if (!els.site.querySelector('use')) els.site.innerHTML = '<svg><use href="#i-search"/></svg>';
  els.zoom.hidden = !tab || tab.zoom === 100;
  if (tab) els.zoom.textContent = percentFormat.format(tab.zoom / 100);

  const webBrainLoaded = state.webBrain?.loaded;
  els.webbrain.disabled = !webBrainLoaded;
  els.webbrain.title = webBrainLoaded ? t('ui.webBrainTip', { key: 'Alt+Shift+W' }) : t('ui.webBrainMissing');
  if (state.webBrain?.icon && els.webbrainIcon.dataset.src !== state.webBrain.icon) {
    els.webbrainIcon.dataset.src = state.webBrain.icon;
    els.webbrainIcon.src = state.webBrain.icon;
    els.panelHeader.querySelector('img').src = state.webBrain.icon;
  }
  els.webbrain.classList.toggle('open', Boolean(state.panel));

  els.updates.hidden = !['available', 'ready'].includes(state.updates?.status);
  if (!els.updates.hidden) {
    const label = t('menu.updateAvailable', { version: state.updates.latestVersion });
    els.updates.title = label; els.updates.setAttribute('aria-label', label);
  }
  const dl = state.downloads;
  els.downloads.hidden = !dl || dl.count === 0;
  if (dl && dl.count) {
    const active = dl.recent.find((d) => d.state === 'in_progress');
    els.downloadRing.style.setProperty('--p', active ? String(active.progress ?? 0.15) : '0');
    els.downloadRing.hidden = !active;
  }
}

function renderPanel() {
  const p = state.panel;
  const top = els.chrome.getBoundingClientRect().height;
  els.panelHeader.hidden = !p;
  els.splitter.hidden = !p;
  if (!p) return;
  els.panelHeader.style.top = `${top}px`;
  els.panelHeader.style.width = `${p.width}px`;
  els.panelTitle.textContent = p.title || 'WebBrain';
  els.splitter.style.top = `${top}px`;
  // The panel is at the end of the line (the left in right-to-left languages).
  els.splitter.style.insetInlineEnd = `${p.width}px`;
  els.splitter.style.width = `${p.splitter}px`;
}

function render() {
  document.body.classList.toggle('hide-chrome', Boolean(state.htmlFullscreen));
  document.body.classList.toggle('fullscreen', Boolean(state.fullscreen));
  els.caption.hidden = true; // native caption buttons come from the title bar overlay
  renderTabs();
  renderToolbar();
  renderPanel();
}

// --------------------------------------------------------------- events

els.newTab.addEventListener('click', () => api.invoke('newTab'));
els.back.addEventListener('click', () => api.invoke('back'));
els.forward.addEventListener('click', () => api.invoke('forward'));
els.reload.addEventListener('click', () => api.invoke(activeTab()?.loading ? 'stop' : 'reload'));
els.updates.addEventListener('click', () => api.invoke('updates'));
els.webbrain.addEventListener('click', () => api.invoke('webBrain'));
els.menu.addEventListener('click', () => {
  const r = els.menu.getBoundingClientRect();
  api.invoke('mainMenu', { x: r.right - 4, y: r.bottom + 2 });
});
els.downloads.addEventListener('click', () => {
  const r = els.downloads.getBoundingClientRect();
  api.invoke('downloadsMenu', { x: r.left, y: r.bottom + 2 });
});
$('panel-close').addEventListener('click', () => api.invoke('panelClose'));
els.caption.addEventListener('click', (event) => {
  const control = event.target.closest('button')?.dataset.control;
  if (control) api.invoke('windowControl', control);
});

// Address bar suggestions ---------------------------------------------------
//
// The main process finds the suggestions (app/omnibox.js). The rows are drawn
// by a separate view laid over the page (app/omnibox-popup.js, popup.js),
// because the tab views sit above this page. Typing, keys and which row is
// highlighted stay here.

const omni = {
  userText: '', // what was typed, without the inline completion
  inline: null, // { completion } appended to userText and selected
  items: [],
  itemsFor: null, // the userText the rows were found for
  selected: 0,
  engine: '',
  open: false,
  seq: 0,
  composing: false,
  popupFocused: false, // a click in the list took focus for a moment
};

function caretAtEnd() {
  const a = els.address;
  return a.selectionStart === a.value.length && a.selectionEnd === a.value.length;
}

function omniboxRect() {
  const r = els.omnibox.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function requestSuggestions(allowInline) {
  const text = omni.userText;
  if (!text.trim()) {
    closeSuggestions();
    return;
  }
  const seq = ++omni.seq;
  api.invoke('suggest', text, { seq, allowInline }).then((result) => {
    if (!result || result.seq !== omni.seq || document.activeElement !== els.address) return;
    showSuggestions(result, text, true);
  });
}

function showSuggestions(result, text, fresh) {
  const previousKey = omni.items[omni.selected]?.key;
  omni.items = result.items || [];
  omni.itemsFor = text;
  omni.engine = result.engine || omni.engine;
  if (fresh) {
    omni.selected = 0;
    omni.inline = null;
    if (result.inline && els.address.value === text && caretAtEnd()) {
      omni.inline = result.inline;
      els.address.value = text + result.inline.completion;
      els.address.setSelectionRange(text.length, els.address.value.length);
    }
  } else {
    // Search suggestions arrived: keep the same row highlighted if it is still there.
    const kept = previousKey ? omni.items.findIndex((item) => item.key === previousKey) : 0;
    omni.selected = Math.max(0, kept);
    if (kept < 0) restoreTyped();
  }
  renderSuggestions();
}

function renderSuggestions() {
  if (!omni.items.length) {
    closeSuggestions();
    return;
  }
  omni.open = true;
  els.omnibox.classList.add('open');
  api.invoke('popupRender', {
    items: omni.items,
    selected: omni.selected,
    input: omni.userText,
    engine: omni.engine,
    rect: omniboxRect(),
  });
}

function closeSuggestions() {
  omni.seq += 1; // answers still on their way are no longer wanted
  omni.items = [];
  omni.itemsFor = null;
  omni.selected = 0;
  omni.inline = null;
  if (!omni.open) return;
  omni.open = false;
  els.omnibox.classList.remove('open');
  api.invoke('popupHide');
}

/** Back to what was typed, with the inline completion (if any) selected after it. */
function restoreTyped() {
  const text = omni.userText;
  els.address.value = text + (omni.inline?.completion || '');
  els.address.setSelectionRange(text.length, els.address.value.length);
}

function moveSelection(delta) {
  if (!omni.open || !omni.items.length) return;
  const next = Math.max(0, Math.min(omni.items.length - 1, omni.selected + delta));
  if (next === omni.selected) return;
  omni.selected = next;
  if (next === 0) {
    restoreTyped();
  } else {
    els.address.value = omni.items[next].fill;
    const end = els.address.value.length;
    els.address.setSelectionRange(end, end);
  }
  renderSuggestions();
}

function endEditing() {
  editing = false;
  omni.popupFocused = false;
  closeSuggestions();
  if (document.activeElement === els.address) els.address.blur();
  renderToolbar();
}

/** Enter, or a click in the list: do what the highlighted row (or the text) says. */
function accept({ index = omni.selected, newTab = false, wwwCom = false } = {}) {
  const value = els.address.value.trim();
  const item = omni.open ? omni.items[index] : null;
  // Every row must belong to the current input, including a highlighted row
  // left over while replacement suggestions are still in flight.
  const usable = item && omni.itemsFor === omni.userText ? item : null;

  if (wwwCom) {
    // Ctrl+Enter: "example" → www.example.com
    const word = (omni.userText || value).trim();
    if (/^[\p{L}\p{N}-]+$/u.test(word)) {
      endEditing();
      api.invoke('navigate', `www.${word}.com`, { kind: 'input', newTab });
      return;
    }
  }
  if (usable?.type === 'tab') {
    endEditing();
    api.invoke('switchToTab', usable.tabId);
    return;
  }
  if (usable?.type === 'url') {
    endEditing();
    api.invoke('navigate', usable.url, { kind: 'url', newTab });
    return;
  }
  if (usable && usable.query !== undefined) {
    endEditing();
    api.invoke('navigate', usable.query, { kind: 'search', newTab });
    return;
  }
  if (!value) return;
  endEditing();
  api.invoke('navigate', value, { kind: 'input', newTab });
}

els.address.addEventListener('focus', () => {
  if (omni.popupFocused) {
    // Coming back from a click in the list: carry on where the typing was.
    omni.popupFocused = false;
    return;
  }
  api.invoke('omniboxFocus');
  const tab = activeTab();
  if (tab && !editing) els.address.value = tab.displayUrl || '';
  requestAnimationFrame(() => els.address.select());
});
els.address.addEventListener('compositionstart', () => { omni.composing = true; });
els.address.addEventListener('compositionend', () => { omni.composing = false; });
els.address.addEventListener('input', (event) => {
  editing = true;
  omni.userText = els.address.value;
  // Only complete inline while typing forwards at the end (not after deleting or pasting).
  const allowInline = event.inputType === 'insertText' && !event.isComposing && !omni.composing && caretAtEnd();
  requestSuggestions(allowInline);
});
els.address.addEventListener('blur', () => {
  api.invoke('omniboxBlur').then((keep) => {
    if (keep) {
      omni.popupFocused = true;
      return;
    }
    if (document.hasFocus() && document.activeElement === els.address) return;
    stopEditingAndShowUrl();
  });
});

/** Give up what was typed and show the page's address again. */
function stopEditingAndShowUrl() {
  editing = false;
  omni.popupFocused = false;
  closeSuggestions();
  renderToolbar();
}
els.address.addEventListener('keydown', (event) => {
  if (event.isComposing || omni.composing) return;
  const modified = event.ctrlKey || event.altKey || event.metaKey;
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      if (modified) return;
      event.preventDefault();
      if (omni.open) {
        moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'ArrowDown' && els.address.value.trim()) {
        editing = true;
        omni.userText = els.address.value;
        requestSuggestions(false);
      }
      return;
    case 'Tab':
      if (!omni.open || modified) return;
      event.preventDefault();
      moveSelection(event.shiftKey ? -1 : 1);
      return;
    case 'Enter':
      event.preventDefault();
      accept({ newTab: event.altKey, wwwCom: event.ctrlKey && !event.altKey });
      return;
    case 'Escape': {
      event.preventDefault();
      if (omni.open) {
        // First Esc: close the list and drop the completion or highlighted row.
        els.address.value = omni.userText;
        closeSuggestions();
        return;
      }
      editing = false;
      const tab = activeTab();
      els.address.value = tab?.displayUrl || '';
      els.address.select();
      if (!tab?.isNewTab) api.invoke('focusContent');
      return;
    }
    case 'Delete': {
      // Shift+Delete forgets the highlighted history row.
      const item = omni.open && event.shiftKey ? omni.items[omni.selected] : null;
      if (!item?.removable) return;
      event.preventDefault();
      const target = item.type === 'history-search' ? { query: item.query } : { url: item.url };
      const keep = omni.selected;
      const hadInline = Boolean(omni.inline);
      api.invoke('historyRemove', target).then(() => {
        const seq = ++omni.seq;
        return api.invoke('suggest', omni.userText, { seq, allowInline: hadInline });
      }).then((result) => {
        if (!result || result.seq !== omni.seq) return;
        // Same list minus the forgotten row, with the highlight staying in place.
        omni.items = result.items || [];
        omni.itemsFor = omni.userText;
        omni.inline = result.inline || null;
        omni.selected = Math.min(keep, Math.max(0, omni.items.length - 1));
        if (omni.selected === 0) {
          restoreTyped();
        } else {
          els.address.value = omni.items[omni.selected].fill;
          els.address.setSelectionRange(els.address.value.length, els.address.value.length);
        }
        renderSuggestions();
      });
      return;
    }
    default:
  }
});
els.omnibox.addEventListener('submit', (event) => event.preventDefault());

// Side panel resize
els.splitter.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  els.splitter.setPointerCapture(event.pointerId);
  els.splitter.classList.add('dragging');
  api.invoke('panelResizeStart');
  const move = (e) => api.invoke('panelResize', e.clientX);
  const up = () => {
    els.splitter.classList.remove('dragging');
    els.splitter.removeEventListener('pointermove', move);
    els.splitter.removeEventListener('pointerup', up);
    api.invoke('panelResizeEnd');
  };
  els.splitter.addEventListener('pointermove', move);
  els.splitter.addEventListener('pointerup', up);
});

// Find in page -------------------------------------------------------------

function openFind() {
  els.findbar.hidden = false;
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value) api.invoke('find', els.findInput.value, { findNext: false });
}
function closeFind({ focusContent = true, tabId = null } = {}) {
  els.findbar.hidden = true;
  els.findCount.textContent = '';
  els.findInput.classList.remove('miss');
  api.invoke('findStop', 'clear', { focusContent, tabId });
}
function stepFind(direction) {
  if (els.findbar.hidden) { openFind(); return; }
  if (els.findInput.value) api.invoke('find', els.findInput.value, { forward: direction > 0, findNext: true });
}
els.findInput.addEventListener('input', () => {
  const text = els.findInput.value;
  if (!text) {
    els.findCount.textContent = '';
    els.findInput.classList.remove('miss');
  }
  api.invoke('find', text, { findNext: false });
});
els.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); stepFind(event.shiftKey ? -1 : 1); }
  if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
});
$('find-next').addEventListener('click', () => stepFind(1));
$('find-prev').addEventListener('click', () => stepFind(-1));
$('find-close').addEventListener('click', closeFind);

// ------------------------------------------------------------- main process

api.on('murshid:state', (next) => {
  const previousTabId = state.activeId;
  const switched = next.activeId !== state.activeId;
  state = next;
  if (switched) {
    editing = false;
    els.address.value = activeTab()?.displayUrl || '';
    omni.popupFocused = false;
    closeSuggestions();
    if (!els.findbar.hidden) closeFind({ focusContent: false, tabId: previousTabId });
  }
  render();
  if (switched && document.hasFocus() && document.activeElement === els.address) {
    // Switched tabs with the address bar focused: show the new tab's address.
    els.address.value = activeTab()?.displayUrl || '';
    els.address.select();
  }
});
api.on('murshid:focus-omnibox', () => {
  editing = false;
  omni.popupFocused = false;
  closeSuggestions();
  els.address.focus();
  els.address.select();
});
api.on('murshid:suggest-update', (result) => {
  if (!result || result.seq !== omni.seq || !omni.open) return;
  showSuggestions(result, omni.itemsFor ?? omni.userText, false);
});
api.on('murshid:popup-pick', ({ index, newTab } = {}) => {
  accept({ index: Number(index) || 0, newTab: Boolean(newTab) });
});
api.on('murshid:omnibox-refocus', () => {
  // The main process gave this page focus back; the address bar's focus
  // handler sees popupFocused and leaves the text and caret alone.
  if (document.activeElement !== els.address) els.address.focus();
});
api.on('murshid:omnibox-close', () => {
  if (document.hasFocus() && document.activeElement === els.address) {
    omni.popupFocused = false;
    closeSuggestions();
  } else {
    stopEditingAndShowUrl();
  }
});
api.on('murshid:find-open', openFind);
api.on('murshid:find-step', stepFind);
api.on('murshid:find-result', (result) => {
  if (!result.finalUpdate && result.matches === undefined) return;
  const n = result.matches || 0;
  els.findCount.textContent = els.findInput.value
    ? t('ui.findCount', { current: numberFormat.format(n ? result.activeMatchOrdinal : 0), total: numberFormat.format(n) })
    : '';
  els.findInput.classList.toggle('miss', Boolean(els.findInput.value) && n === 0);
});

// Tell the main process how tall the chrome is (the find bar changes it).
new ResizeObserver(() => {
  api.invoke('layout', els.chrome.getBoundingClientRect().height);
  renderPanel();
}).observe(els.chrome);
window.addEventListener('resize', () => {
  renderTabs();
  if (omni.open) renderSuggestions(); // the list follows the address bar's width
});

api.invoke('ready');
