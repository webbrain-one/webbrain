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
 * <version> is read from package.json so a single npm-version bump
 * cascades into the right filenames.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const distDir = path.join(root, 'dist');
mkdirSync(distDir, { recursive: true });

console.log(`Building extension zips for v${version} …`);

const targets = [
  { packageName: 'chrome', sourceDir: 'chrome' },
  // Microsoft Edge uses the same Chromium-compatible MV3 source tree.
  { packageName: 'edge', sourceDir: 'chrome' },
  { packageName: 'firefox', sourceDir: 'firefox' },
];

for (const { packageName, sourceDir } of targets) {
  const out = path.join(distDir, `webbrain-${packageName}-${version}.zip`);
  // -o writes directly to the file; avoids needing shell redirection,
  // so this runs identically on bash, zsh, cmd, and PowerShell.
  execFileSync(
    'git',
    ['archive', '--format=zip', '-o', out, `HEAD:src/${sourceDir}`],
    { stdio: 'inherit', cwd: root }
  );
  console.log(`  ✓ dist/webbrain-${packageName}-${version}.zip`);
}
