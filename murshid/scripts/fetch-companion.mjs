#!/usr/bin/env node
'use strict';

// Downloads WebBrain Companion builds into vendor/companion/<platform>-<arch>/
// so Murshid installers embed the companion: installing Murshid installs the
// tray app with it, and Murshid starts it from resources/companion.
//
//   node scripts/fetch-companion.mjs                  # the build for this machine
//   node scripts/fetch-companion.mjs win32-x64 linux-x64
//   MURSHID_COMPANION_RELEASE=systray-v0.1.5 node scripts/fetch-companion.mjs
//
// The Windows release is one setup.exe holding both architectures; 7-Zip (or
// any `7z` on PATH) takes the executable out of it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'companion');
const RELEASE = process.env.MURSHID_COMPANION_RELEASE || 'systray-v0.1.5';
const VERSION = RELEASE.replace(/^systray-v/, '');
const BASE = `https://github.com/webbrain-one/webbrain/releases/download/${RELEASE}`;

// What `npm run dist` builds on this machine: both Windows architectures,
// both macOS ones (the same universal app), the host architecture on Linux.
const DEFAULT_TARGETS = {
  win32: ['win32-x64', 'win32-arm64'],
  darwin: ['darwin-x64', 'darwin-arm64'],
  linux: [`linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`],
};
const current = `${process.platform}-${process.arch}`;
const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const explicit = targets.length > 0;
if (!targets.length) targets.push(...(DEFAULT_TARGETS[process.platform] || [current]));
const force = process.argv.includes('--force');

function log(...parts) { console.log('[fetch-companion]', ...parts); }

if (process.env.MURSHID_COMPANION_SKIP === '1') {
  log('skipped (MURSHID_COMPANION_SKIP=1)');
  process.exit(0);
}

async function download(url, dest) {
  log('GET', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
  return dest;
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function runQuiet(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** 'amd64' or 'arm64' from a PE's machine field; '' when it is not a PE. */
function peMachine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    fs.readSync(fd, dos, 0, 64, 0);
    if (dos.readUInt16LE(0) !== 0x5A4D) return '';
    const peOff = dos.readUInt32LE(0x3C);
    const head = Buffer.alloc(6);
    fs.readSync(fd, head, 0, 6, peOff);
    if (head.readUInt32LE(0) !== 0x00004550) return '';
    const machine = head.readUInt16LE(4);
    return machine === 0x8664 ? 'amd64' : machine === 0xAA64 ? 'arm64' : '';
  } finally {
    fs.closeSync(fd);
  }
}

function find7z() {
  const names = os.platform() === 'win32' ? ['7z.exe', '7z'] : ['7z'];
  const guesses = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const name of names) {
    try {
      const which = execFileSync(os.platform() === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
      const hit = which.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (hit) return hit;
    } catch {}
  }
  return guesses.find((g) => fs.existsSync(g)) || null;
}

/** The binary name the running Murshid looks for in resources/companion. */
function expectedBinary(target) {
  if (target.startsWith('win32')) return 'WebBrainCompanion.exe';
  if (target.startsWith('darwin')) return path.join('WebBrain Companion.app', 'Contents', 'MacOS', 'WebBrain Companion');
  return 'webbrain-companion';
}

async function fetchTarget(target, tmp) {
  const dest = path.join(VENDOR, target);
  const [platform, arch] = target.split('-');
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`unknown target ${target} (want <win32|darwin|linux>-<x64|arm64>)`);
  }
  const binary = expectedBinary(target);
  if (!force && fs.existsSync(path.join(dest, binary))) {
    log(`${target}: already in vendor/companion (use --force to refresh)`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });

  if (platform === 'linux') {
    const file = await download(`${BASE}/WebBrain-Companion-${VERSION}-linux-${arch}.tar.gz`, path.join(tmp, `linux-${arch}.tar.gz`));
    const out = path.join(tmp, `linux-${arch}`);
    fs.mkdirSync(out, { recursive: true });
    run('tar', ['-xzf', file, '-C', out]);
    fs.copyFileSync(path.join(out, 'webbrain-companion', 'webbrain-companion'), path.join(dest, 'webbrain-companion'));
    fs.chmodSync(path.join(dest, 'webbrain-companion'), 0o755);
  } else if (platform === 'darwin') {
    // One universal app serves both architectures.
    const file = await download(`${BASE}/WebBrain-Companion-${VERSION}-macos-universal.zip`, path.join(tmp, 'macos.zip'));
    const out = path.join(tmp, 'macos');
    fs.mkdirSync(out, { recursive: true });
    try {
      run('unzip', ['-q', file, '-d', out]);
    } catch {
      run('tar', ['-xf', file, '-C', out]); // bsdtar (macOS, Windows 10+) reads zips
    }
    const app = path.join(out, 'WebBrain Companion.app');
    fs.rmSync(path.join(dest, 'WebBrain Companion.app'), { recursive: true, force: true });
    fs.cpSync(app, path.join(dest, 'WebBrain Companion.app'), { recursive: true });
  } else {
    const file = await download(`${BASE}/WebBrain-Companion-${VERSION}-windows-setup.exe`, path.join(tmp, 'windows-setup.exe'));
    const sevenZip = find7z();
    if (!sevenZip) {
      throw new Error('7-Zip (7z) is needed to take WebBrainCompanion.exe out of the Windows setup; install it or place the exe in vendor/companion/' + target + ' by hand');
    }
    const out = path.join(tmp, `win-${arch}`);
    fs.mkdirSync(out, { recursive: true });
    // Releases after 0.1.5 keep the two builds under distinct names; older
    // ones store both as WebBrainCompanion.exe and 7z can only give the last.
    const wanted = arch === 'x64' ? 'WebBrainCompanion-x64.tmp' : 'WebBrainCompanion-arm64.tmp';
    const legacy = arch === 'x64' ? 'amd64' : 'arm64';
    let src;
    if (runQuiet(sevenZip, ['x', file, `-o${out}`, wanted]) && fs.existsSync(path.join(out, wanted))) {
      src = path.join(out, wanted);
    } else if (runQuiet(sevenZip, ['x', '-y', file, `-o${out}`, 'WebBrainCompanion.exe'])) {
      src = path.join(out, 'WebBrainCompanion.exe');
      if (peMachine(src) !== legacy) {
        throw new Error(`the setup of release ${RELEASE} only carries the other Windows build inside; build the companion from ../webbrain-systray for ${target}`);
      }
    } else {
      throw new Error(`WebBrainCompanion.exe not found inside the setup (release ${RELEASE}?)`);
    }
    fs.copyFileSync(src, path.join(dest, 'WebBrainCompanion.exe'));
  }
  log(`${target}: WebBrain Companion ${VERSION} ready in vendor/companion/${target}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-companion-'));
  let hostFailed = false;
  try {
    for (const target of targets) {
      try {
        await fetchTarget(target, tmp);
      } catch (error) {
        // With default targets the build for this machine must be there; the
        // other architectures' are warnings only (older releases may not
        // carry them extractably). Explicit targets are all required.
        if (explicit || target === current) hostFailed = true;
        log(`warning: ${target}: ${error.message || error}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (hostFailed) process.exit(1);
}

main().catch((error) => {
  console.error('[fetch-companion]', error.message || error);
  process.exit(1);
});
