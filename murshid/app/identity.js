'use strict';

// How Murshid introduces itself to sites.
//
// By default it does what Brave does: the user agent string is plain Chrome's
// (reduced, Chrome/156.0.0.0, like every Chromium browser's), and the client
// hints name the browser next to Chromium ("Murshid";v="156"), with version
// numbers cut to the major. Settings > "Identify as Google Chrome" does what
// Vivaldi does instead: the hints say "Google Chrome", with the full build.
//
// Electron sends no Sec-CH-UA headers at all, and its navigator.userAgentData
// knows only Chromium. So install() adds the headers to the session's requests
// and registers identity-preload.js, which gives pages the same brands.
//
// Not covered: Workers and subframes still see Electron's own
// navigator.userAgentData, because preloads run only in main frames. Hints that
// a site asks for with Accept-CH are kept in memory until Murshid quits.
// Critical-CH retries are not done.

const { execFile } = require('node:child_process');
const path = require('node:path');
const { ipcMain } = require('electron');

const FULL_VERSION = process.versions.chrome;
const MAJOR = FULL_VERSION.split('.')[0];
const MAJOR_ONLY = `${MAJOR}.0.0.0`;

const PLATFORM = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || 'Unknown';
const ARCH = /^(arm|arm64)$/.test(process.arch) ? 'arm' : 'x86';
const BITNESS = /64/.test(process.arch) ? '64' : '32';

/** Chrome's reduced user agent string: no Electron or app token, Chrome/<major>.0.0.0. */
function userAgent(fallback) {
  return fallback
    .replace(/\sElectron\/\S+/, '')
    .replace(/\smurshid\/\S+/i, '')
    .replace(/Chrome\/[\d.]+/, `Chrome/${MAJOR_ONLY}`);
}

// The brand list exactly as Chromium builds it (GenerateBrandVersionList in
// components/embedder_support/user_agent_utils.cc): a "GREASE" brand, Chromium
// and the browser's own brand, in an order and spelling seeded by the major
// version, so Murshid's list looks like Chrome's and Brave's of the same version.
const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];

function brandList(brand, version, full) {
  const seed = Number(MAJOR);
  const order = ORDERS[seed % ORDERS.length];
  const greaseVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.length];
  const list = [];
  list[order[0]] = {
    brand: `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`,
    version: full ? `${greaseVersion}.0.0.0` : greaseVersion,
  };
  list[order[1]] = { brand: 'Chromium', version };
  list[order[2]] = { brand, version };
  return list;
}

/** What Murshid says it is, under the current setting. */
function identity(asChrome) {
  const brand = asChrome ? 'Google Chrome' : 'Murshid';
  const fullVersion = asChrome ? FULL_VERSION : MAJOR_ONLY;
  return {
    asChrome,
    brands: brandList(brand, MAJOR, false),
    fullVersionList: brandList(brand, fullVersion, true),
    uaFullVersion: fullVersion,
  };
}

// Structured-header forms, as Chrome writes them.
const sfString = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;
const sfBrands = (list) => list.map((b) => `${sfString(b.brand)};v=${sfString(b.version)}`).join(', ');

// The platform version the way Chrome reports it: on Windows the
// UniversalApiContract version from the registry (19.0.0 on Windows 11 24H2),
// elsewhere the OS version.
let platformVersion = '';
function readPlatformVersion() {
  if (process.platform !== 'win32') {
    platformVersion = (process.getSystemVersion().match(/^\d+(\.\d+){0,2}/) || [''])[0];
    while (platformVersion && platformVersion.split('.').length < 3) platformVersion += '.0';
    return;
  }
  execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\WindowsRuntime\\WellKnownContracts', '/v', 'Windows.Foundation.UniversalApiContract'],
    { windowsHide: true }, (error, stdout) => {
      const hex = !error && /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
      if (!hex) return;
      const value = parseInt(hex[1], 16);
      platformVersion = `${value >>> 16}.${value & 0xffff}.0`;
    });
}

/** The Sec-CH-UA headers for one request; `asked` holds the hints its site asked for. */
function hintHeaders(id, asked) {
  const headers = {
    'Sec-CH-UA': sfBrands(id.brands),
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': sfString(PLATFORM),
  };
  if (!asked) return headers;
  const high = [
    ['Sec-CH-UA-Arch', sfString(ARCH)],
    ['Sec-CH-UA-Bitness', sfString(BITNESS)],
    ['Sec-CH-UA-Full-Version', sfString(id.uaFullVersion)],
    ['Sec-CH-UA-Full-Version-List', sfBrands(id.fullVersionList)],
    ['Sec-CH-UA-Model', '""'],
    ['Sec-CH-UA-Platform-Version', sfString(platformVersion)],
    ['Sec-CH-UA-WoW64', '?0'],
    ['Sec-CH-UA-Form-Factors', '"Desktop"'],
  ];
  for (const [name, value] of high) {
    if (asked.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

// Chrome sends client hints only over secure connections (and to localhost).
const secureHintUrl = (url) => /^(https:|wss:|http:\/\/(?:localhost|127\.0\.0\.1)(?=[:/]|$))/i.test(url);

/**
 * Make `ses` identify itself as the setting says, now and whenever it changes.
 * Uses the session's onBeforeSendHeaders and onHeadersReceived, which Electron
 * allows one listener each for: anything else that needs them must go here.
 * The same goes for onBeforeRequest, so the listeners here also forward the
 * events to WebBrain (ctx.crx) and ask the ad blocker (ctx.adblock,
 * app/adblock) what to cancel and which Content-Security-Policy to add.
 */
function install(ses, settings, ctx) {
  readPlatformVersion();
  const current = () => identity(Boolean(settings.get('identifyAsChrome')));
  let id = current();
  settings.on('changed', (key) => {
    if (key === 'identifyAsChrome') id = current();
  });

  // Origin -> the high-entropy hints its last top-level page asked for (Accept-CH).
  const asked = new Map();

  ses.webRequest.onBeforeRequest((details, callback) => {
    // WebBrain still sees a blocked request, then its onErrorOccurred
    // (net::ERR_BLOCKED_BY_CLIENT), as Chrome extensions do.
    const response = ctx.adblock?.blockRequest(details) || {};
    Promise.resolve(ctx.crx?.forwardWebRequest('onBeforeRequest', details)).catch(() => {}).finally(() => callback(response));
  });
  ses.webRequest.onBeforeRedirect((details) => { Promise.resolve(ctx.crx?.forwardWebRequest('onBeforeRedirect', details)).catch(() => {}); });
  ses.webRequest.onResponseStarted((details) => { Promise.resolve(ctx.crx?.forwardWebRequest('onResponseStarted', details)).catch(() => {}); });
  ses.webRequest.onErrorOccurred((details) => {
    Promise.resolve(ctx.crx?.forwardWebRequest('onErrorOccurred', details)).catch(() => {});
    ctx.crx?.discardOffscreenRequest(details.id);
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = ctx.adblock?.responseHeaders(details);
    Promise.resolve(ctx.crx?.forwardWebRequest('onHeadersReceived', details)).catch(() => {})
      .finally(() => callback(responseHeaders ? { responseHeaders } : {}));
    if (details.resourceType !== 'mainFrame') return;
    if (!secureHintUrl(details.url)) return;
    const header = Object.entries(details.responseHeaders || {}).find(([k]) => k.toLowerCase() === 'accept-ch');
    if (!header) return;
    const names = [].concat(header[1]).join(',').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    try { asked.set(new URL(details.url).origin, new Set(names)); } catch {}
  });

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    let origin = '';
    try { origin = new URL(details.url).origin; } catch {}
    const requestHeaders = {};
    for (const [name, value] of Object.entries(details.requestHeaders)) {
      if (!secureHintUrl(details.url) || !/^sec-ch-ua/i.test(name)) requestHeaders[name] = value;
    }
    if (secureHintUrl(details.url)) Object.assign(requestHeaders, hintHeaders(id, asked.get(origin)));
    Promise.resolve(ctx.crx?.forwardWebRequest('onBeforeSendHeaders', { ...details, requestHeaders }))
      .catch(() => {}).finally(() => callback({ requestHeaders }));
  });

  ipcMain.on('murshid-identity', (event) => {
    event.returnValue = id;
  });
  ses.registerPreloadScript({ id: 'murshid-identity', type: 'frame', filePath: path.join(__dirname, 'identity-preload.js') });
}

module.exports = { userAgent, install, identity };
