'use strict';

// Murshid browser chrome: renders the state the main process pushes and sends
// user actions back. All browsing happens in the tab views, never here.

const api = window.murshidUI;
const $ = (id) => document.getElementById(id);
const platform = new URLSearchParams(location.search).get('platform') || 'win32';
document.body.classList.add(platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : 'win');

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
    <span class="title"></span>
    <button class="audio" hidden tabindex="-1"></button>
    <button class="close" tabindex="-1" aria-label="Close tab"><svg><use href="#i-close"/></svg></button>`;
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
  requestAnimationFrame(() => {
    for (const el of tabEls.values()) el.classList.toggle('narrow', el.getBoundingClientRect().width < 72);
  });
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
  let index = children.findIndex((c) => {
    const r = c.getBoundingClientRect();
    return center < r.left + r.width / 2;
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
  els.reload.title = loading ? 'Stop loading' : 'Reload (Ctrl+R)';
  els.reload.setAttribute('aria-label', loading ? 'Stop' : 'Reload');

  if (!editing && document.activeElement !== els.address) {
    els.address.value = tab ? prettyUrl(tab.displayUrl) : '';
  }
  const isWeb = tab && tab.displayUrl;
  els.site.className = tab?.secure && isWeb ? 'secure' : '';
  els.site.querySelector('use')?.setAttribute('href', !isWeb ? '#i-search' : tab.secure ? '#i-lock' : '#i-globe');
  if (!els.site.querySelector('use')) els.site.innerHTML = '<svg><use href="#i-search"/></svg>';
  els.zoom.hidden = !tab || tab.zoom === 100;
  if (tab) els.zoom.textContent = `${tab.zoom}%`;

  const webBrainLoaded = state.webBrain?.loaded;
  els.webbrain.disabled = !webBrainLoaded;
  els.webbrain.title = webBrainLoaded ? 'WebBrain (Alt+Shift+W)' : 'WebBrain is not installed in this build';
  if (state.webBrain?.icon && els.webbrainIcon.dataset.src !== state.webBrain.icon) {
    els.webbrainIcon.dataset.src = state.webBrain.icon;
    els.webbrainIcon.src = state.webBrain.icon;
    els.panelHeader.querySelector('img').src = state.webBrain.icon;
  }
  els.webbrain.classList.toggle('open', Boolean(state.panel));

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
  els.splitter.style.right = `${p.width}px`;
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

els.address.addEventListener('focus', () => {
  const tab = activeTab();
  if (tab && !editing) els.address.value = tab.displayUrl || '';
  requestAnimationFrame(() => els.address.select());
});
els.address.addEventListener('input', () => { editing = true; });
els.address.addEventListener('blur', () => {
  editing = false;
  renderToolbar();
});
els.address.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    editing = false;
    const tab = activeTab();
    els.address.value = tab?.displayUrl || '';
    els.address.select();
    if (!tab?.isNewTab) api.invoke('focusContent');
  }
});
els.omnibox.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.address.value.trim();
  if (!text) return;
  editing = false;
  els.address.blur();
  api.invoke('navigate', text);
});

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
function closeFind() {
  els.findbar.hidden = true;
  els.findCount.textContent = '';
  els.findInput.classList.remove('miss');
  api.invoke('findStop');
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
  const switched = next.activeId !== state.activeId;
  state = next;
  if (switched) {
    editing = false;
    if (!els.findbar.hidden) closeFind();
  }
  render();
});
api.on('murshid:focus-omnibox', () => {
  editing = false;
  els.address.focus();
  els.address.select();
});
api.on('murshid:find-open', openFind);
api.on('murshid:find-step', stepFind);
api.on('murshid:find-result', (result) => {
  if (!result.finalUpdate && result.matches === undefined) return;
  const n = result.matches || 0;
  els.findCount.textContent = els.findInput.value ? `${n ? result.activeMatchOrdinal : 0}/${n}` : '';
  els.findInput.classList.toggle('miss', Boolean(els.findInput.value) && n === 0);
});

// Tell the main process how tall the chrome is (the find bar changes it).
new ResizeObserver(() => {
  api.invoke('layout', els.chrome.getBoundingClientRect().height);
  renderPanel();
}).observe(els.chrome);
window.addEventListener('resize', () => renderTabs());

api.invoke('ready');
