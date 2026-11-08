'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const APP = path.join(__dirname, '..', 'app');
const i18n = require('../app/i18n');
const LOCALES = Object.fromEntries(i18n.SUPPORTED.map((code) => [code, require(`../app/locales/${code}`)]));
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const emphasis = (text) => (text.match(/\*/g) || []).length;

afterEach(() => i18n.setLocale('en'));

test('every language has exactly the English keys, with the same placeholders', () => {
  assert.deepEqual(i18n.SUPPORTED, ['en', 'tr', 'ar', 'fa', 'hi', 'az', 'he', 'el', 'ru', 'uk']);
  const english = LOCALES.en;
  for (const [code, dict] of Object.entries(LOCALES)) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(english).sort(), `${code} keys`);
    for (const [key, text] of Object.entries(dict)) {
      assert.equal(typeof text, 'string', `${code} ${key}`);
      assert.ok(text.trim(), `${code} ${key} is empty`);
      assert.deepEqual(placeholders(text), placeholders(english[key]), `${code} ${key} placeholders`);
      assert.equal(emphasis(text), emphasis(english[key]), `${code} ${key} *emphasis*`);
    }
  }
});

test('Persian uses Persian letters, and the other languages use no Arabic script', () => {
  for (const [key, text] of Object.entries(LOCALES.fa)) {
    assert.doesNotMatch(text, /[يكى]/, `fa ${key} has an Arabic yeh or kaf`);
    assert.doesNotMatch(text, /(^|[\s«(])می (?=[؀-ۿ])/, `fa ${key} needs a half space after می`);
  }
  for (const code of ['en', 'tr', 'hi', 'az', 'he', 'el', 'ru', 'uk']) {
    for (const [key, text] of Object.entries(LOCALES[code])) {
      if (key === 'page.about.word') continue;
      assert.doesNotMatch(text, /[؀-ۿ]/, `${code} ${key}`);
    }
  }
  // Arabic-script strings are written in that script, apart from product names.
  for (const code of ['ar', 'fa']) {
    assert.match(LOCALES[code]['menu.newTab'], /^[؀-ۿ\s‌]+$/);
  }
  // Hebrew strings are written in Hebrew.
  assert.match(LOCALES.he['menu.newTab'], /^[\u0590-\u05FF\s\u200f\u200e]+$/);
});

test('the interface language follows Settings, then the system, then English', () => {
  assert.equal(i18n.resolve('tr', 'en-US'), 'tr');
  assert.equal(i18n.resolve('auto', 'ar-EG'), 'ar');
  assert.equal(i18n.resolve('auto', 'fa_IR'), 'fa');
  assert.equal(i18n.resolve('auto', 'de-DE', ['fa-IR', 'en-US']), 'fa');
  assert.equal(i18n.resolve('auto', 'he-IL'), 'he');
  assert.equal(i18n.resolve('auto', 'ru-RU', ['uk-UA']), 'ru');
  assert.equal(i18n.resolve('az', 'en-US'), 'az');
  assert.equal(i18n.resolve('auto', 'de-DE', ['de-DE', 'tr-TR']), 'en');
  assert.equal(i18n.resolve('klingon', 'xx'), 'en');
  assert.equal(i18n.match('constructor'), null);
  assert.equal(i18n.dir('ar'), 'rtl');
  assert.equal(i18n.dir('fa'), 'rtl');
  assert.equal(i18n.dir('he'), 'rtl');
  assert.equal(i18n.dir('ru'), 'ltr');
  assert.equal(i18n.dir('tr'), 'ltr');
});

test('the window frame direction follows Chromium\'s locale, not the interface language', () => {
  try {
    assert.equal(i18n.setFrameLocale('he-IL'), 'rtl');
    assert.equal(i18n.bundle('en').frameDir, 'rtl');
    assert.equal(i18n.bundle('en').dir, 'ltr');
    assert.equal(i18n.setFrameLocale('fa'), 'rtl');
    assert.equal(i18n.setFrameLocale('en-US'), 'ltr');
    assert.equal(i18n.bundle('ar').frameDir, 'ltr');
    assert.equal(i18n.bundle('ar').dir, 'rtl');
  } finally {
    i18n.setFrameLocale('en-US');
  }
});

test('the language picked in Settings is read before the app is ready', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-i18n-'));
  try {
    assert.equal(i18n.savedLanguage(dir), null);
    fs.writeFileSync(path.join(dir, i18n.SETTINGS_FILE), JSON.stringify({ language: 'fa' }));
    assert.equal(i18n.savedLanguage(dir), 'fa');
    fs.writeFileSync(path.join(dir, i18n.SETTINGS_FILE), JSON.stringify({ language: 'auto' }));
    assert.equal(i18n.savedLanguage(dir), null);
    fs.writeFileSync(path.join(dir, i18n.SETTINGS_FILE), '{not json');
    assert.equal(i18n.savedLanguage(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strings, numbers and percentages follow the language', () => {
  i18n.setLocale('tr');
  assert.equal(i18n.t('menu.newTab'), 'Yeni sekme');
  assert.equal(i18n.t('permission.camera', { host: 'example.com' }), 'example.com kameranızı kullanmak istiyor');
  assert.equal(i18n.percent(110), '%110');
  i18n.setLocale('fa');
  assert.equal(i18n.percent(110), '۱۱۰٪');
  assert.equal(i18n.number(9), '۹');
  i18n.setLocale('en');
  assert.equal(i18n.percent(110), '110%');
  assert.equal(i18n.t('no.such.key'), 'no.such.key');
  assert.equal(i18n.bundle('ar').dir, 'rtl');
  assert.equal(i18n.bundle('ar').strings['menu.newTab'], LOCALES.ar['menu.newTab']);
});

test('murshid:// pages are filled in for every language, escaped and with direction', () => {
  const pages = ['settings', 'about', 'error', 'newtab'];
  for (const code of i18n.SUPPORTED) {
    for (const page of pages) {
      const html = i18n.renderTemplate(fs.readFileSync(path.join(APP, 'pages', `${page}.html`), 'utf8'), code);
      assert.doesNotMatch(html, /\{\{|\}\}/, `${code} ${page} has an unfilled placeholder`);
      assert.match(html, new RegExp(`<html lang="${code}" dir="${i18n.dir(code)}">`));
      assert.match(html, /<h1>[^<]*<em>[^<]+<\/em>[^<]*<\/h1>|<h1>[^<*]+<\/h1>/, `${code} ${page} heading`);
    }
  }
  const newtab = i18n.renderTemplate(fs.readFileSync(path.join(APP, 'pages', 'newtab.html'), 'utf8'), 'tr');
  assert.match(newtab, /<h1>Nereye, <em>yolcu\?<\/em><\/h1>/);
  const settings = i18n.renderTemplate(fs.readFileSync(path.join(APP, 'pages', 'settings.html'), 'utf8'), 'tr');
  assert.match(settings, /WebBrain Companion&#39;ı Murshid ile başlat/);
  const about = i18n.renderTemplate(fs.readFileSync(path.join(APP, 'pages', 'about.html'), 'utf8'), 'ar');
  assert.match(about, /<span lang="ar">مُرشِد<\/span>/);
  const error = i18n.renderTemplate(fs.readFileSync(path.join(APP, 'pages', 'error.html'), 'utf8'), 'fa');
  assert.match(error, /<strong id="host" dir="auto">صفحه<\/strong> بار نشد\./);
});

test('every string the app asks for exists', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['locales', 'crx'].includes(entry.name)) walk(full); } else if (/\.(js|html)$/.test(entry.name)) files.push(full);
    }
  };
  walk(APP);
  const used = new Set();
  for (const file of files) {
    if (file === path.join(APP, 'i18n.js')) continue; // the library itself, whose comments show the syntax
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
    for (const m of source.matchAll(/data-t-(?:title|aria-label|placeholder)="([\w.]+)"/g)) used.add(m[1]);
    for (const m of source.matchAll(/\{\{(?:t|rich):([\w.]+)\}\}/g)) used.add(m[1]);
  }
  assert.ok(used.size > 100, `found only ${used.size} strings`);
  for (const key of used) assert.ok(Object.hasOwn(LOCALES.en, key), `missing string ${key}`);
});

test('permission prompts are asked in the interface language', async () => {
  const original = Module._load;
  const prompts = [];
  let request;
  const electron = {
    dialog: { showMessageBox(_parent, opts) { prompts.push(opts); return Promise.resolve({ response: 0 }); } },
    desktopCapturer: { getSources: async () => [] },
    webContents: { fromFrame: () => ({}) },
  };
  Module._load = function (name, ...args) { return name === 'electron' ? electron : original.call(this, name, ...args); };
  try {
    delete require.cache[require.resolve('../app/permissions')];
    const { installPermissions } = require('../app/permissions');
    installPermissions({
      webBrainId: 'a'.repeat(32),
      ses: { setPermissionCheckHandler() {}, setPermissionRequestHandler(fn) { request = fn; }, setDisplayMediaRequestHandler() {} },
      windowForContents() {}, lastFocusedWindow() {},
    });
  } finally {
    Module._load = original;
  }
  const ask = (url, permission, mediaTypes) => new Promise((resolve) => request({ getURL: () => url }, permission, resolve, { requestingUrl: url, mediaTypes }));
  i18n.setLocale('tr');
  await ask('https://example.com/', 'media', ['audio', 'video']);
  assert.equal(prompts.at(-1).message, 'example.com kameranızı ve mikrofonunuzu kullanmak istiyor');
  assert.deepEqual(prompts.at(-1).buttons, ['İzin ver', 'Engelle']);
  i18n.setLocale('ar');
  await ask('https://example.org/', 'geolocation');
  assert.equal(prompts.at(-1).message, 'يريد example.org معرفة موقعك الجغرافي');
  i18n.setLocale('en');
  await ask('https://example.net/', 'notifications');
  assert.equal(prompts.at(-1).message, 'example.net wants to show notifications');
});
