// Minimal i18n for WebBrain extension pages (sidepanel, settings, traces).
// Sync reads from localStorage so translations apply before first paint.
// Works identically in Chrome MV3 and Firefox MV2.

import en from './locales/en.js';
import es from './locales/es.js';
import fr from './locales/fr.js';
import tr from './locales/tr.js';
import zh from './locales/zh.js';
import ru from './locales/ru.js';
import uk from './locales/uk.js';
import ar from './locales/ar.js';
import ja from './locales/ja.js';
import ko from './locales/ko.js';
import id from './locales/id.js';
import th from './locales/th.js';
import ms from './locales/ms.js';
import tl from './locales/tl.js';
import pl from './locales/pl.js';
import he from './locales/he.js';

const DICTS = { en, es, fr, tr, zh, ru, uk, ar, ja, ko, id, th, ms, tl, pl, he };
const LS_KEY = 'wbLocale';
const RTL_LOCALES = new Set(['ar', 'he']);

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'zh', label: '中文' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'ar', label: 'العربية' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'th', label: 'ไทย' },
  { code: 'ms', label: 'Bahasa Melayu' },
  { code: 'tl', label: 'Filipino' },
  { code: 'pl', label: 'Polski' },
  { code: 'he', label: 'עברית' },
];

function detect() {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && DICTS[saved]) return saved;
  } catch { /* storage denied */ }
  const nav = (globalThis.navigator?.language || 'en').slice(0, 2).toLowerCase();
  return DICTS[nav] ? nav : 'en';
}

let currentLocale = detect();

export function getLocale() {
  return currentLocale;
}

export async function setLocale(code) {
  if (!DICTS[code] || code === currentLocale) return;
  currentLocale = code;
  try { localStorage.setItem(LS_KEY, code); } catch { /* ignore */ }
  // Mirror to browser storage so other extension pages pick it up.
  try {
    const api = (typeof browser !== 'undefined' && browser?.storage) ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    await api?.storage?.local?.set?.({ wbLocale: code });
  } catch { /* ignore */ }
  applyDOMTranslations(document);
  document.dispatchEvent(new CustomEvent('wb-locale-changed', { detail: { code } }));
}

export function t(key, params) {
  const dict = DICTS[currentLocale] || DICTS.en;
  let s = dict[key];
  if (s == null) s = DICTS.en[key];
  if (s == null) return key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
  }
  return s;
}

export function applyDOMTranslations(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
  document.documentElement.lang = currentLocale;
  document.documentElement.dir = RTL_LOCALES.has(currentLocale) ? 'rtl' : 'ltr';
}

// Cross-page sync: if another page changes the locale, reflect it here too.
try {
  const api = (typeof browser !== 'undefined' && browser?.storage) ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  api?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local' || !changes.wbLocale) return;
    const code = changes.wbLocale.newValue;
    if (code && DICTS[code] && code !== currentLocale) {
      currentLocale = code;
      try { localStorage.setItem(LS_KEY, code); } catch { /* ignore */ }
      applyDOMTranslations(document);
      document.dispatchEvent(new CustomEvent('wb-locale-changed', { detail: { code } }));
    }
  });
} catch { /* ignore */ }

// Apply on first load. If the DOM isn't ready yet, wait for it.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyDOMTranslations(document));
  } else {
    applyDOMTranslations(document);
  }
}
