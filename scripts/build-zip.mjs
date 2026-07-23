#!/usr/bin/env node
/**
 * Build extension submission zips from the current HEAD commit.
 *
 *   node scripts/build-zip.mjs
 *
 * Or via npm:  npm run build:zip
 *
 * Uses `git archive --format=zip` so the output is POSIX-style with
 * forward-slash paths, which AMO's automated validator requires (it
 * silently rejects zips made by PowerShell's Compress-Archive because
 * those carry Windows backslash separators inside the central directory).
 *
 * Source-of-truth is the HEAD commit, NOT the working tree — uncommitted
 * local artifacts (.test-profile, .claude, dist/, etc.) won't leak into
 * the submission zip. If you need to ship something, commit it first.
 *
 * Output:
 *   dist/webbrain-chrome-<version>.zip
 *   dist/webbrain-edge-<version>.zip
 *   dist/webbrain-firefox-<version>.zip
 *
 * <version> is read from package.json at HEAD, and every archived manifest
 * must match it. An uncommitted version bump is rejected instead of creating
 * a new-looking filename around an old manifest.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const targets = [
  { packageName: 'chrome', sourceDir: 'chrome' },
  // Microsoft Edge uses the same Chromium-compatible MV3 source tree.
  { packageName: 'edge', sourceDir: 'chrome' },
  { packageName: 'firefox', sourceDir: 'firefox' },
];

export function assertMatchingArchiveVersion(expected, actual, label) {
  if (actual !== expected) {
    throw new Error(`${label} is ${actual}, but the release package version is ${expected}.`);
  }
}

const FLAG_LICENSE_PATH = 'icons/flags/LICENSE.flag-icons.txt';
const REJECTED_FLAG_LICENSE_PATH = 'icons/flags/LICENSE.flag-icons';

export function listZipEntryNames(filePath) {
  const archive = readFileSync(filePath);
  const eocdSignature = 0x06054b50;
  const centralHeaderSignature = 0x02014b50;
  const earliestEocd = Math.max(0, archive.length - 0xffff - 22);
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= earliestEocd; offset -= 1) {
    if (
      archive.readUInt32LE(offset) === eocdSignature
      && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`${filePath} has no ZIP end-of-central-directory record.`);

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  let offset = archive.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== centralHeaderSignature) {
      throw new Error(`${filePath} has an invalid ZIP central-directory entry at index ${index}.`);
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > archive.length) {
      throw new Error(`${filePath} has a truncated ZIP filename at index ${index}.`);
    }
    entries.push(archive.toString('utf8', nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

export function assertStoreSafeFlagLicenseEntries(entries, label) {
  if (!entries.includes(FLAG_LICENSE_PATH)) {
    throw new Error(`${label} is missing ${FLAG_LICENSE_PATH}.`);
  }
  if (entries.includes(REJECTED_FLAG_LICENSE_PATH)) {
    throw new Error(`${label} still contains Opera-rejected ${REJECTED_FLAG_LICENSE_PATH}.`);
  }
}

function readJsonAtHead(relativePath) {
  const json = execFileSync('git', ['show', `HEAD:${relativePath}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(json);
}

function listTreeEntryNamesAtHead(relativePath) {
  return execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', `HEAD:${relativePath}`],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  ).split(/\r?\n/).filter(Boolean);
}

function runCli() {
  const workingPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const headPackage = readJsonAtHead('package.json');
  assertMatchingArchiveVersion(
    headPackage.version,
    workingPackage.version,
    'Working-tree package.json version'
  );

  const version = headPackage.version;
  for (const { sourceDir } of targets) {
    const manifest = readJsonAtHead(`src/${sourceDir}/manifest.json`);
    assertMatchingArchiveVersion(version, manifest.version, `HEAD src/${sourceDir}/manifest.json version`);
    assertStoreSafeFlagLicenseEntries(
      listTreeEntryNamesAtHead(`src/${sourceDir}`),
      `HEAD src/${sourceDir}`
    );
  }

  const distDir = path.join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  console.log(`Building extension zips for v${version} from HEAD …`);

  for (const { packageName, sourceDir } of targets) {
    const out = path.join(distDir, `webbrain-${packageName}-${version}.zip`);
    // -o writes directly to the file; avoids needing shell redirection,
    // so this runs identically on bash, zsh, cmd, and PowerShell.
    execFileSync(
      'git',
      ['archive', '--format=zip', '-o', out, `HEAD:src/${sourceDir}`],
      { stdio: 'inherit', cwd: root }
    );
    assertStoreSafeFlagLicenseEntries(
      listZipEntryNames(out),
      `dist/webbrain-${packageName}-${version}.zip`
    );
    console.log(`  ✓ dist/webbrain-${packageName}-${version}.zip`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(`build-zip: ${error.message}`);
    process.exit(1);
  }
}
