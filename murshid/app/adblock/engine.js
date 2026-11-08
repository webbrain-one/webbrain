'use strict';

// The filter lists and how an engine is built from them, shared by the browser
// (app/adblock/index.js), its list refresh (app/adblock/build-worker.js) and
// `npm run adblock` (scripts/build-adblock.mjs). No Electron here.
//
// The engine is Ghostery's adblocker (@ghostery/adblocker, MPL-2.0). A built
// engine is stored serialized and gzipped; a serialized engine only loads
// with the library version that wrote it (ENGINE_VERSION), which lists.json
// records.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { FiltersEngine, ENGINE_VERSION } = require('@ghostery/adblocker');

// The lists, in the order they are merged. Each keeps its own licence; see the
// README ("Ad and tracker blocking").
const LISTS = [
  {
    name: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    homepage: 'https://easylist.to/',
    license: 'GPL-3.0-or-later OR CC-BY-SA-3.0',
  },
  {
    name: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    homepage: 'https://easylist.to/',
    license: 'GPL-3.0-or-later OR CC-BY-SA-3.0',
  },
  {
    name: 'uBlock filters – Unbreak',
    url: 'https://ublockorigin.github.io/uAssets/filters/unbreak.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    license: 'GPL-3.0-only',
  },
];

// Network blocking, CSP injection and element hiding. Not loaded: extended
// (procedural) selectors and HTML filtering, which Murshid does not apply.
// Scriptlets (+js) need uBlock's resources, which are not bundled, so none run.
const OPTIONS = {
  loadNetworkFilters: true,
  loadCSPFilters: true,
  loadCosmeticFilters: true,
  loadGenericCosmeticsFilters: true,
  loadExtendedSelectors: false,
  enableHtmlFiltering: false,
  enableCompression: true,
};

// A refreshed engine smaller than this is treated as a broken download, and the
// one already in use is kept. (EasyList and EasyPrivacy together are ~100,000.)
const MIN_NETWORK_FILTERS = 20000;

/** Whether `text` looks like an Adblock Plus-style filter list (not an error page). */
function looksLikeList(text) {
  return typeof text === 'string' && text.length > 1000
    && /^﻿?\s*(\[Adblock[^\]]*\]|!)/.test(text) && !/^\s*<(!doctype|html)/i.test(text);
}

/** The "! Version:" (or "! Last modified:") line of a list's header, if any. */
function listVersion(text) {
  const head = String(text).slice(0, 4000);
  const m = /^!\s*Version:\s*(.+)$/mi.exec(head) || /^!\s*Last modified:\s*(.+)$/mi.exec(head);
  return m ? m[1].trim() : null;
}

/** Parse the lists' texts (in LISTS order) into one engine. */
function buildEngine(texts) {
  if (texts.length !== LISTS.length) throw new Error(`expected ${LISTS.length} lists, got ${texts.length}`);
  texts.forEach((text, i) => {
    if (!looksLikeList(text)) throw new Error(`${LISTS[i].name} does not look like a filter list`);
  });
  const engine = FiltersEngine.parse(texts.join('\n'), OPTIONS);
  const count = engine.getFilters().networkFilters.length;
  if (count < MIN_NETWORK_FILTERS) throw new Error(`only ${count} network filters`);
  return engine;
}

/** What lists.json says about an engine built now from `texts`. */
function describe(texts, updated = Date.now()) {
  return {
    engineVersion: ENGINE_VERSION,
    updated,
    lists: LISTS.map((list, i) => ({ ...list, version: listVersion(texts[i]) })),
  };
}

/** Gzip a serialized engine for storage. */
function pack(serialized) {
  return zlib.gzipSync(Buffer.from(serialized.buffer, serialized.byteOffset, serialized.byteLength), { level: 9 });
}

/** Load a stored engine: `file` (gzipped) and the lists.json beside it. Throws if it can't. */
function readEngine(file, metaFile) {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (meta.engineVersion !== ENGINE_VERSION) {
    throw new Error(`engine version ${meta.engineVersion}, library wants ${ENGINE_VERSION}`);
  }
  const engine = FiltersEngine.deserialize(new Uint8Array(zlib.gunzipSync(fs.readFileSync(file))));
  return { engine, meta };
}

/** Write a stored engine and its lists.json atomically (temp files, then rename). */
function writeEngine(file, metaFile, packed, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, packed);
  fs.writeFileSync(`${metaFile}.tmp`, `${JSON.stringify(meta, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  fs.renameSync(`${metaFile}.tmp`, metaFile);
}

module.exports = {
  LISTS, OPTIONS, ENGINE_VERSION, MIN_NETWORK_FILTERS,
  looksLikeList, listVersion, buildEngine, describe, pack, readEngine, writeEngine,
};
