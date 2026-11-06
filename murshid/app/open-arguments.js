'use strict';

const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

function urlsFromArgs(argv) {
  return argv.slice(1).flatMap((arg) => {
    if (arg.startsWith('--') || arg === '.' || /electron(\.exe)?$/i.test(arg)) return [];
    if (/^(https?|file|murshid):/i.test(arg)) return [arg];
    try {
      if (/\.(html?|pdf|svg|txt|png|jpe?g|gif|webp)$/i.test(arg) && fs.statSync(arg).isFile()) return [pathToFileURL(arg).href];
    } catch {}
    return [];
  });
}

module.exports = { urlsFromArgs };
