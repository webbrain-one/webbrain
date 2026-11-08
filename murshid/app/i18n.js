'use strict';

// Murshid's own interface text: menus, dialogs, the browser chrome and the
// murshid:// pages. WebBrain and its new tab page translate themselves.
//
// Strings live in app/locales/<code>.js. {name} is a placeholder; in page
// templates, *text* becomes <em>text</em>.

const fs = require('node:fs');
const path = require('node:path');

const DICTIONARIES = {
  en: require('./locales/en'),
  tr: require('./locales/tr'),
  ar: require('./locales/ar'),
  fa: require('./locales/fa'),
  hi: require('./locales/hi'),
  az: require('./locales/az'),
  he: require('./locales/he'),
  el: require('./locales/el'),
  ru: require('./locales/ru'),
  uk: require('./locales/uk'),
};
const SUPPORTED = Object.keys(DICTIONARIES);
const RTL = new Set(['ar', 'fa', 'he']);
/** Each language in its own name, for the language menu in Settings. */
const NATIVE_NAMES = {
  en: 'English', tr: 'Türkçe', ar: 'العربية', fa: 'فارسی', hi: 'हिन्दी',
  az: 'Azərbaycanca', he: 'עברית', el: 'Ελληνικά', ru: 'Русский', uk: 'Українська',
};
const SETTINGS_FILE = 'murshid-settings.json';

// Languages Chromium lays out right to left. When its own locale is one of these,
// it mirrors the window: caption buttons and child view positions flip sides.
const RTL_LOCALES = new Set(['ar', 'fa', 'he', 'iw', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);

let current = 'en';
let frame = 'ltr';

const primaryTag = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];

/** 'tr-TR', 'tr_TR' and 'tr' all give 'tr'; anything unsupported gives null. */
function match(tag) {
  const primary = primaryTag(tag);
  return Object.hasOwn(DICTIONARIES, primary) ? primary : null;
}

/**
 * Records which way Chromium draws the window frame, from its locale
 * (app.getLocale()). It can differ from the interface language: "Automatic"
 * on a Hebrew system shows English in a mirrored frame, and on macOS the
 * system language decides the frame whatever is picked in Settings.
 */
function setFrameLocale(tag) {
  frame = RTL_LOCALES.has(primaryTag(tag)) ? 'rtl' : 'ltr';
  return frame;
}

function frameDir() {
  return frame;
}

/**
 * The language picked in Settings ('auto' gives null). Read straight from the
 * settings file, because Chromium's locale has to be set before the app is ready.
 */
function savedLanguage(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, SETTINGS_FILE), 'utf8'));
    return match(raw?.language);
  } catch {
    return null;
  }
}

/**
 * The interface language: the one picked in Settings, else the language
 * Chromium chose for the app (which follows the system), else English.
 */
function resolve(preference, appLocale, systemLanguages = []) {
  return match(preference) || match(appLocale) || match(systemLanguages[0]) || 'en';
}

function setLocale(code) {
  current = match(code) || 'en';
  return current;
}

function locale() {
  return current;
}

function dir(code = current) {
  return RTL.has(code) ? 'rtl' : 'ltr';
}

function format(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
}

function t(key, vars, code = current) {
  const text = DICTIONARIES[code]?.[key] ?? DICTIONARIES.en[key] ?? key;
  return format(text, vars);
}

function number(value, code = current) {
  try { return new Intl.NumberFormat(code).format(value); } catch { return String(value); }
}

/** 110 gives "110%" in English, "%110" in Turkish and "۱۱۰٪" in Persian. */
function percent(value, code = current) {
  try {
    return new Intl.NumberFormat(code, { style: 'percent', maximumFractionDigits: 0 }).format(value / 100);
  } catch {
    return `${value}%`;
  }
}

/** Every string for one language, English filling any gap. */
function strings(code = current) {
  return { ...DICTIONARIES.en, ...DICTIONARIES[code] };
}

/** What the browser chrome and murshid:// pages get from their preloads. */
function bundle(code = current) {
  return { locale: code, dir: dir(code), frameDir: frame, strings: strings(code) };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fills a murshid:// page template before it is served, so the page arrives
 * already in the right language and direction:
 *   {{lang}} {{dir}}   the interface language and its direction
 *   {{t:key}}          the string, escaped (safe in attributes)
 *   {{rich:key}}       the string, escaped, with *text* as <em>text</em> and
 *                      {word} / {host} as the markup the pages expect
 */
function renderTemplate(html, code = current) {
  const richVars = {
    word: `<span lang="${escapeHtml(t('page.about.wordLang', null, code))}">${escapeHtml(t('page.about.word', null, code))}</span>`,
    host: `<strong id="host" dir="auto">${escapeHtml(t('page.error.thePage', null, code))}</strong>`,
  };
  return html
    .replace(/\{\{lang\}\}/g, code)
    .replace(/\{\{dir\}\}/g, dir(code))
    .replace(/\{\{t:([\w.]+)\}\}/g, (_m, key) => escapeHtml(t(key, null, code)))
    .replace(/\{\{rich:([\w.]+)\}\}/g, (_m, key) => escapeHtml(t(key, null, code))
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\{(\w+)\}/g, (whole, name) => richVars[name] || whole));
}

module.exports = {
  SUPPORTED,
  NATIVE_NAMES,
  SETTINGS_FILE,
  match,
  savedLanguage,
  resolve,
  setLocale,
  locale,
  dir,
  setFrameLocale,
  frameDir,
  format,
  t,
  number,
  percent,
  strings,
  bundle,
  renderTemplate,
};
