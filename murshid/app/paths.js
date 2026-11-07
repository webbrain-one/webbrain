'use strict';

// Where Murshid finds the things it ships with. In a packaged build everything
// bundled lives under process.resourcesPath (see "build.extraResources" in
// package.json); from a checkout it is read straight from the repository, so
// `npm start` always runs the WebBrain extension and new tab page at HEAD.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const MURSHID_DIR = path.resolve(APP_DIR, '..');
const REPO_DIR = path.resolve(MURSHID_DIR, '..');

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The unpacked WebBrain extension (MV3). */
function webBrainExtensionDir() {
  return firstExisting([
    process.env.MURSHID_WEBBRAIN_DIR,
    app.isPackaged ? path.join(process.resourcesPath, 'extensions', 'webbrain') : null,
    path.join(REPO_DIR, 'src', 'chrome'),
  ]);
}

/** Folder holding a bundled WebBrain Companion build, if this package has one. */
function bundledCompanionDir() {
  return firstExisting([
    app.isPackaged ? path.join(process.resourcesPath, 'companion') : null,
    path.join(MURSHID_DIR, 'vendor', 'companion', `${process.platform}-${process.arch}`),
  ]);
}

function asset(...parts) {
  return path.join(MURSHID_DIR, 'assets', ...parts);
}

function appIcon() {
  if (process.platform === 'win32') return asset('icons', 'murshid.ico');
  return asset('icons', 'murshid-512.png');
}

module.exports = {
  APP_DIR,
  MURSHID_DIR,
  REPO_DIR,
  appIcon,
  asset,
  bundledCompanionDir,
  pagesDir: () => path.join(APP_DIR, 'pages'),
  uiDir: () => path.join(APP_DIR, 'ui'),
  webBrainExtensionDir,
};
