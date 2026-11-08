// Writes the translated homepages (web/tr/, web/ar/, web/fa/, web/hi/, web/az/,
// web/he/, web/el/, web/ru/ and web/uk/) from the English one (web/index.html)
// and the translations beside this script.
//
//   node scripts/i18n/build.mjs            write the pages (or: npm run web:i18n)
//   node scripts/i18n/build.mjs --check    write nothing; fail if a page is out of date
//   node scripts/i18n/build.mjs --sync     add new English strings to the translation
//                                          files (empty, to be translated) and drop gone ones
//   node scripts/i18n/build.mjs --accept   record the current English beside every
//                                          translation, once the stale ones are updated
//
// The English page is the template. An element with data-i18n="key" gets the
// translation of `key` as its content, and data-i18n-<attribute>="key" sets
// that attribute; the markers are left out of the pages written. Every
// translation keeps the English it was made from ("en"), so when the English
// page changes, the build names the strings to look at again. Links to the
// site's own files gain "../", and lang, dir, the locale, the canonical link,
// the preloaded font and the language menu are set for each page.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..', '..', 'web');
const LANGS = ['tr', 'ar', 'fa', 'hi', 'az', 'he', 'el', 'ru', 'uk'];
const SITE = 'https://murshid.one/';
const mode = process.argv[2] || 'write';
if (!['write', '--check', '--sync', '--accept'].includes(mode)) {
  console.error(`unknown option ${mode}`);
  process.exit(2);
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const OPEN = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)(\s*\/?)>/y;
const ATTR = /\s+([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

function parseAttrs(text) {
  const attrs = [];
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(text))) attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] });
  return attrs;
}
const serializeAttrs = (attrs) => attrs.map(({ name, value }) => (value === undefined ? ` ${name}` : ` ${name}="${value}"`)).join('');

const attr = (tag, name) => tag.attrs.find((a) => a.name === name);

// Where the element whose opening tag ends at `from` closes.
function closeOf(html, name, from) {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start: m.index, end: re.lastIndex };
  }
  throw new Error(`<${name}> opened before offset ${from} never closes`);
}

// Calls visit(tag) for every opening tag, in order. visit may change
// tag.attrs, and may set tag.content to replace what the element holds.
function walk(html, visit) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt) + 3;
      out += html.slice(lt, end);
      i = end;
      continue;
    }
    OPEN.lastIndex = lt;
    const m = OPEN.exec(html);
    if (!m) { out += '<'; i = lt + 1; continue; }
    const name = m[1].toLowerCase();
    const tag = { name, attrs: parseAttrs(m[2]), content: undefined };
    const raw = name === 'script' || name === 'style';
    const hasBody = !VOID.has(name) && !m[3].includes('/');
    let close = hasBody && (raw || attr(tag, 'data-i18n')) ? closeOf(html, name, OPEN.lastIndex) : null;
    tag.inner = close ? html.slice(OPEN.lastIndex, close.start) : undefined;
    visit(tag);
    out += `<${m[1]}${serializeAttrs(tag.attrs)}${m[3]}>`;
    if (hasBody && (raw || tag.content !== undefined)) {
      close ??= closeOf(html, name, OPEN.lastIndex);
      out += (tag.content ?? html.slice(OPEN.lastIndex, close.start)) + html.slice(close.start, close.end);
      i = close.end;
    } else {
      i = OPEN.lastIndex;
    }
  }
  return out;
}

// The English strings, by key, in the order the page uses them.
function english(html) {
  const strings = new Map();
  const add = (key, text) => {
    if (strings.has(key) && strings.get(key) !== text) throw new Error(`"${key}" is used for two different English strings`);
    strings.set(key, text);
  };
  walk(html, (tag) => {
    for (const { name, value } of tag.attrs) {
      if (name === 'data-i18n') add(value, tag.inner);
      else if (name.startsWith('data-i18n-')) {
        const target = name.slice('data-i18n-'.length);
        const original = attr(tag, target);
        if (!original) throw new Error(`${name}="${value}" has no ${target} attribute to translate`);
        add(value, original.value);
      }
    }
  });
  return strings;
}

const own = (url) => url && !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url);
const up = (url) => (url === './' ? '../' : own(url) ? `../${url}` : url);
const tagsIn = (html) => (html.match(/<\/?([a-z][\w-]*)/gi) || []).map((t) => t.replace(/[</]/g, '').toLowerCase()).filter((t) => !['br', 'bdi', 'span'].includes(t)).sort().join(' ');

function page(html, lang, config, strings, problems) {
  const t = (key) => {
    const entry = config.strings[key];
    const text = typeof entry === 'string' ? entry : entry?.[lang];
    if (!text) { problems.push(`${lang}: "${key}" has no translation`); return strings.get(key); }
    return text;
  };
  const visit = (tag) => {
    const kept = [];
    for (const a of tag.attrs) {
      if (a.name === 'data-i18n') tag.content = walk(t(a.value), visit);
      else if (a.name.startsWith('data-i18n-')) {
        const text = t(a.value);
        if (text.includes('"')) problems.push(`${lang}: "${a.value}" goes in an attribute and can't hold a raw "`);
        attr(tag, a.name.slice('data-i18n-'.length)).value = text;
      } else kept.push(a);
    }
    tag.attrs = kept;
    for (const a of tag.attrs) {
      if (['href', 'src', 'data-yellow', 'data-red'].includes(a.name)) a.value = up(a.value);
      else if (a.name === 'srcset') a.value = a.value.replace(/(^|,\s*)(\S+)/g, (_, sep, url) => sep + up(url));
    }
    const is = (name, value) => attr(tag, name)?.value === value;
    if (tag.name === 'html') {
      attr(tag, 'lang').value = lang;
      if (config.dir === 'rtl') tag.attrs.splice(1, 0, { name: 'dir', value: 'rtl' });
    }
    if (tag.name === 'meta' && is('property', 'og:image')) attr(tag, 'content').value = up(attr(tag, 'content').value);
    if (tag.name === 'meta' && is('property', 'og:locale')) attr(tag, 'content').value = config.locale;
    if (tag.name === 'link' && is('rel', 'canonical')) attr(tag, 'href').value = `${SITE}${lang}/`;
    if (tag.name === 'link' && is('rel', 'preload') && config.preload) attr(tag, 'href').value = `../${config.preload}`;
    if (attr(tag, 'data-lang-code')) tag.content = lang.toUpperCase();
    const link = attr(tag, 'data-lang-link');
    if (link) {
      tag.attrs = tag.attrs.filter((a) => a.name !== 'aria-current');
      if (link.value === lang) tag.attrs.push({ name: 'aria-current', value: 'page' });
    }
  };
  const body = walk(html, visit);
  const note = `<!-- Written by scripts/i18n/build.mjs from web/index.html and scripts/i18n/${lang}.json: edit those, then run npm run web:i18n. -->`;
  return body.replace(/^<!doctype html>\n/i, (doctype) => `${doctype}${note}\n`);
}

// Characters that belong to one of the two languages and not the other.
const SCRIPT_CHECKS = {
  fa: [[/[يك]/, 'Arabic ي or ك (Persian uses ی and ک)'], [/[٠-٩]/, 'Arabic-Indic digits (Persian uses ۰–۹)'], [/(^|[\s>«(])ن?می [؀-ۿ]/, '"می" followed by a space (use a zero-width non-joiner)']],
  ar: [[/[یک]/, 'Persian ی or ک (Arabic uses ي and ك)'], [/[۰-۹]/, 'Persian digits']],
  tr: [],
  he: [[/[؀-ۿ]/, 'Arabic script (Hebrew uses Hebrew letters)']],
  hi: [], az: [], el: [], ru: [], uk: [],
};

const html = readFileSync(resolve(web, 'index.html'), 'utf8');
const strings = english(html);
const problems = [];
const stale = [];
let outdated = 0;

for (const lang of LANGS) {
  const file = resolve(here, `${lang}.json`);
  const config = JSON.parse(readFileSync(file, 'utf8'));

  if (mode === '--sync' || mode === '--accept') {
    const next = {};
    for (const [key, en] of strings) {
      const entry = config.strings[key];
      const text = typeof entry === 'string' ? entry : entry?.[lang] ?? '';
      const before = typeof entry === 'object' ? entry.en : undefined;
      next[key] = { en: mode === '--accept' || before === undefined ? en : before, [lang]: text };
    }
    const dropped = Object.keys(config.strings).filter((key) => !strings.has(key));
    config.strings = next;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`${lang}.json: ${strings.size} strings${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}`);
    continue;
  }

  for (const [key, en] of strings) {
    const entry = config.strings[key];
    const text = typeof entry === 'string' ? entry : entry?.[lang];
    if (!text) continue;
    if (typeof entry !== 'object' || entry.en !== en) stale.push(`${lang}: "${key}"`);
    if (tagsIn(text) !== tagsIn(en)) problems.push(`${lang}: "${key}" has different markup from the English (${tagsIn(text) || 'none'} vs ${tagsIn(en) || 'none'})`);
    for (const [re, what] of SCRIPT_CHECKS[lang]) if (re.test(text)) problems.push(`${lang}: "${key}" has ${what}`);
  }
  for (const key of Object.keys(config.strings)) if (!strings.has(key)) problems.push(`${lang}: "${key}" is no longer on the English page (run --sync)`);

  const out = page(html, lang, config, strings, problems);
  const target = resolve(web, lang, 'index.html');
  let current = null;
  try { current = readFileSync(target, 'utf8'); } catch {}
  if (current !== out) {
    outdated++;
    if (mode === '--check') console.error(`web/${lang}/index.html is out of date`);
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, out);
      console.log(`wrote web/${lang}/index.html`);
    }
  }
}

if (mode === '--sync' || mode === '--accept') process.exit(0);
if (stale.length) console.warn(`The English changed since these were translated (update them, then run --accept):\n  ${stale.join('\n  ')}`);
if (problems.length) console.error(problems.join('\n'));
if (!outdated && mode !== '--check') console.log('pages up to date');
process.exit(problems.length || (mode === '--check' && (outdated || stale.length)) ? 1 : 0);
