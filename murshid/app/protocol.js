'use strict';

// murshid:// — Murshid's own pages (newtab fallback, settings, about, error)
// and assets. Served from app/pages and assets/, nothing else.

const { net, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const paths = require('./paths');

const PAGES = {
  newtab: 'newtab.html',
  settings: 'settings.html',
  about: 'about.html',
  error: 'error.html',
};

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'murshid', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function handleProtocol(ses) {
  const pagesDir = paths.pagesDir();
  const assetsDir = paths.asset();
  ses.protocol.handle('murshid', (request) => {
    const url = new URL(request.url);
    const host = url.hostname;
    let file = null;
    if (PAGES[host] && (url.pathname === '/' || url.pathname === '')) {
      file = path.join(pagesDir, PAGES[host]);
    } else if (PAGES[host] || host === 'pages') {
      const candidate = path.join(pagesDir, decodeURIComponent(url.pathname));
      if (inside(pagesDir, candidate)) file = candidate;
    } else if (host === 'assets') {
      const candidate = path.join(assetsDir, decodeURIComponent(url.pathname));
      if (inside(assetsDir, candidate)) file = candidate;
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return net.fetch(pathToFileURL(file).href);
  });
}

module.exports = { registerSchemes, handleProtocol };
