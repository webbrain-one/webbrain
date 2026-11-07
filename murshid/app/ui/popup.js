'use strict';

// Draws the address bar's suggestion rows. The rows and the highlighted one
// come from the address bar (ui.js) through the main process; this page only
// renders them and reports mouse picks. Titles and URLs come from web pages,
// so all text goes in with textContent, never as HTML.

const api = window.murshidUI;
const card = document.getElementById('card');
const WORD_CHAR = /[\p{L}\p{N}]/u;
const SVG_NS = 'http://www.w3.org/2000/svg';

let current = { items: [], selected: 0, input: '', engine: '' };
let downIndex = -1;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function glyph(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Text split into runs, with marked runs in bold. */
function runs(text, marks) {
  const frag = document.createDocumentFragment();
  let start = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i < text.length && marks[i] === marks[start]) continue;
    const piece = text.slice(start, i);
    frag.append(marks[start] ? el('b', '', piece) : document.createTextNode(piece));
    start = i;
  }
  return frag;
}

/** `text` with every word-start match of the typed terms in bold. */
function highlighted(text, terms) {
  const lower = text.toLowerCase();
  if (!text || lower.length !== text.length) return document.createTextNode(text || '');
  const marks = new Array(text.length).fill(false);
  for (const term of terms) {
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + 1)) {
      if (i === 0 || !WORD_CHAR.test(lower[i - 1])) marks.fill(true, i, i + term.length);
    }
  }
  return runs(text, marks);
}

/** A search suggestion: the part that was typed in normal weight, the rest in bold. */
function completed(query, input) {
  const typed = input.trimStart().toLowerCase();
  const frag = document.createDocumentFragment();
  if (typed && query.length > typed.length && query.toLowerCase().startsWith(typed)) {
    frag.append(document.createTextNode(query.slice(0, typed.length)), el('b', '', query.slice(typed.length)));
  } else {
    frag.append(document.createTextNode(query));
  }
  return frag;
}

const GLYPHS = { search: 'search', suggest: 'search', 'history-search': 'history', tab: 'tab' };

function rowFor(item, index, terms) {
  const selected = index === current.selected;
  const row = el('div', selected ? 'row sel' : 'row');
  row.dataset.index = String(index);
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(selected));

  const ico = el('span', 'ico');
  const name = GLYPHS[item.type] || 'globe';
  if (item.favicon && (item.type === 'url' || item.type === 'tab')) {
    const img = el('img');
    img.alt = '';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(glyph(name)), { once: true });
    img.src = item.favicon;
    ico.append(img);
  } else {
    ico.append(glyph(name));
  }
  row.append(ico);

  const main = el('span', 'main');
  let sub = null;
  switch (item.type) {
    case 'url':
      if (item.title && !item.default) {
        main.append(highlighted(item.title, terms));
        sub = el('span', 'sub');
        sub.append(highlighted(item.display, terms));
      } else {
        main.append(highlighted(item.display, terms));
        if (item.title) sub = el('span', 'sub note', item.title);
      }
      break;
    case 'tab':
      main.append(highlighted(item.title || item.display, terms));
      sub = el('span', 'sub');
      sub.append(highlighted(item.display, terms));
      break;
    case 'search':
      main.textContent = item.query;
      sub = el('span', 'sub note', current.engine ? `Search with ${current.engine}` : 'Search');
      break;
    case 'suggest':
      main.append(completed(item.query, current.input));
      break;
    case 'history-search':
      main.append(highlighted(item.query, terms));
      break;
    default:
      main.textContent = item.fill || '';
  }
  row.append(main);
  if (sub) row.append(el('span', 'sep', '—'), sub);
  if (item.type === 'tab') row.append(el('span', 'badge', 'Switch to this tab'));
  return row;
}

function render() {
  const terms = current.input.toLowerCase().split(/\s+/).filter(Boolean);
  card.replaceChildren(...current.items.map((item, i) => rowFor(item, i, terms)));
}

api.on('murshid:popup', (payload) => {
  if (!payload || !Array.isArray(payload.items)) return;
  current = payload;
  render();
});

card.addEventListener('pointerdown', (event) => {
  const row = event.target instanceof Element ? event.target.closest('.row') : null;
  downIndex = row ? Number(row.dataset.index) : -1;
  if (event.button === 1) event.preventDefault(); // no autoscroll on middle click
});

// A press and release on the same row picks it (a middle click or Ctrl-click
// opens it in a new tab); anything else hands the keyboard back to the address bar.
window.addEventListener('pointerup', (event) => {
  const row = event.target instanceof Element ? event.target.closest('.row') : null;
  const index = row ? Number(row.dataset.index) : -1;
  const picked = index >= 0 && index === downIndex && (event.button === 0 || event.button === 1);
  downIndex = -1;
  if (picked) api.invoke('popupPick', index, { newTab: event.button === 1 || event.ctrlKey || event.metaKey });
  else api.invoke('popupRefocus');
});

window.addEventListener('contextmenu', (event) => event.preventDefault());
