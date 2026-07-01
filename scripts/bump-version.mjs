#!/usr/bin/env node
/**
 * Bump the WebBrain version across every file that carries it.
 *
 *   node scripts/bump-version.mjs              # patch:  7.0.0 → 7.0.1
 *   node scripts/bump-version.mjs patch        # explicit patch
 *   node scripts/bump-version.mjs minor        # 7.0.0 → 7.1.0
 *   node scripts/bump-version.mjs major        # 7.0.0 → 8.0.0
 *   node scripts/bump-version.mjs 7.2.3        # set to an explicit version
 *
 *   node scripts/bump-version.mjs minor --release   # bump + commit + tag (X.Y.0 / X.0.0)
 *   node scripts/bump-version.mjs patch --release   # bump + commit (no tag — patches aren't tagged)
 *
 * Or via npm:  npm run bump  ·  npm run bump -- minor  ·  npm run bump -- 7.2.3
 *              npm run release -- minor              # alias for `bump -- minor --release`
 *
 * Updates (in lockstep):
 *   package.json                       "version"
 *   package-lock.json                  top-level "version" + packages[""].version
 *   src/chrome/manifest.json           "version"     (Chrome MV3)
 *   src/firefox/manifest.json          "version"     (Firefox MV2)
 *   src/chrome/src/ui/settings.js      const EXT_VERSION = '...'   (settings UI)
 *   src/firefox/src/ui/settings.js     const EXT_VERSION = '...'   (settings UI)
 *   src/chrome/ARCHITECTURE.md         "> Version X.Y.Z · ..."     (doc header)
 *   src/firefox/ARCHITECTURE.md        "> Version X.Y.Z · ..."     (doc header)
 *
 * Default mode: just edits files. The script prints suggested next steps
 * so the operator decides whether to ship.
 *
 * `--release` mode: requires a clean working tree, runs the bump, stages
 * the touched files, creates a `chore: bump …` commit, and if the new
 * version is a release boundary (X.0.0 or X.Y.0 — `patch == 0`) also
 * creates an annotated `vX.Y.Z` tag at that commit. Push is NEVER
 * automatic — the operator runs `git push --follow-tags origin <branch>`.
 *
 * The pure helpers `bumpSemver`, `rewriteVersionInJsonText`,
 * `rewriteVersionByAnchor`, `isReleaseBoundary`, `submissionZipPaths`, and
 * `submissionZipRemoveCommand` are exported for unit tests — the CLI side is
 * guarded by an `import.meta.url` check so importing this file doesn't
 * trigger filesystem writes or git calls.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// ─── Pure helper (exported for tests) ────────────────────────────────────

/**
 * Compute the next version from a current version + bump kind.
 *
 *   bumpSemver('7.0.0', 'patch')  → '7.0.1'
 *   bumpSemver('7.0.0', 'minor')  → '7.1.0'
 *   bumpSemver('7.0.0', 'major')  → '8.0.0'
 *   bumpSemver('7.0.0', '7.2.3')  → '7.2.3'   (explicit override)
 *
 * Accepts plain MAJOR.MINOR.PATCH only — no pre-release / build tags.
 * Throws on a malformed input so the operator sees a clear failure
 * instead of writing nonsense like "NaN.0.0" into the manifests.
 */
export function bumpSemver(current, kind = 'patch') {
  const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`Current version is not MAJOR.MINOR.PATCH: ${current}`);
  const [major, minor, patch] = match.slice(1, 4).map((n) => parseInt(n, 10));

  // Explicit-version override: anything that itself looks like semver.
  if (SEMVER.test(kind)) return kind;

  switch (kind) {
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'major': return `${major + 1}.0.0`;
    default:
      throw new Error(
        `Unknown bump kind: "${kind}". Expected one of: patch, minor, major, or an explicit MAJOR.MINOR.PATCH version.`
      );
  }
}

/**
 * In-place version replacement on a JSON file. Edits the textual JSON
 * (not the parsed object) so trailing whitespace, key order, and any
 * stylistic quirks in the file are preserved bit-for-bit. Only the FIRST
 * occurrence is changed unless `replaceAll` is set — relevant for
 * package-lock.json, which carries the version twice.
 *
 * Returns the new file content so the caller can audit / decide whether
 * to write it.
 */
export function rewriteVersionInJsonText(text, oldVersion, newVersion, { replaceAll = false } = {}) {
  // Match: `  "version": "<oldVersion>"` exactly, in any indentation.
  // The negative-lookbehind isn't supported everywhere — instead, anchor
  // on the JSON-property pattern and require the value to match oldVersion.
  const escapedOld = oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`("version"\\s*:\\s*")${escapedOld}(")`, replaceAll ? 'g' : '');
  return text.replace(pattern, `$1${newVersion}$2`);
}

/**
 * Is this version a release boundary that warrants a git tag?
 *
 *   isReleaseBoundary('7.0.0')  → true   (major)
 *   isReleaseBoundary('7.1.0')  → true   (minor)
 *   isReleaseBoundary('7.0.1')  → false  (patch)
 *   isReleaseBoundary('7.4.9')  → false  (patch)
 *
 * Definition: patch === 0. That covers both X.0.0 (major release) and
 * X.Y.0 (minor release) — the conventional "milestone" boundaries that
 * deserve a `vX.Y.Z` tag. Patches share their predecessor's tag and don't
 * need their own.
 *
 * Throws on malformed input so a typo doesn't silently skip the tag.
 */
export function isReleaseBoundary(version) {
  const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Not MAJOR.MINOR.PATCH: ${version}`);
  return parseInt(match[3], 10) === 0;
}

export const SUBMISSION_ZIP_PACKAGES = Object.freeze(['chrome', 'edge', 'firefox']);

export function submissionZipPaths(version) {
  return SUBMISSION_ZIP_PACKAGES.map((browser) => `dist/webbrain-${browser}-${version}.zip`);
}

export function submissionZipRemoveCommand(version) {
  return `git rm --ignore-unmatch ${submissionZipPaths(version).join(' ')}`;
}

/**
 * Generic version replacement for non-JSON files where the version lives
 * between two known surrounding strings (a JS literal, a Markdown badge,
 * a comment marker, etc.). The caller supplies a regex template string
 * with `__OLD__` as the placeholder for the current version. The template
 * MUST have exactly two capture groups — one before `__OLD__` and one
 * after — and the replacement preserves both groups verbatim.
 *
 * Examples of useful templates:
 *   `(EXT_VERSION\\s*=\\s*['"])__OLD__(['"])`     # JS literal
 *   `(>\\s*Version\\s+)__OLD__(\\s*·)`            # Markdown header
 *   `(badge/version-)__OLD__(-)`                   # shields.io badge URL
 *
 * Returns the input unchanged if the anchor doesn't match — callers
 * (like the CLI) treat that as a sync error and abort.
 */
export function rewriteVersionByAnchor(text, oldVersion, newVersion, anchorTemplate, flags = '') {
  const escapedOld = oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(anchorTemplate.replace('__OLD__', escapedOld), flags);
  return text.replace(re, `$1${newVersion}$2`);
}

// ─── CLI ────────────────────────────────────────────────────────────────

const FILES_TO_UPDATE = [
  // JSON files — version is matched via the `"version": "X"` pattern.
  // replaceAll matters for package-lock.json because it carries "version"
  // twice (top-level + packages[""]).
  { path: 'package.json', kind: 'json' },
  { path: 'package-lock.json', kind: 'json', replaceAll: true },
  { path: 'src/chrome/manifest.json', kind: 'json' },
  { path: 'src/firefox/manifest.json', kind: 'json' },
  // Settings UI subtitle constant. The settings panel shows the version
  // to the user; if this drifts from the manifest, the UI lies about
  // which version is installed even when the manifest is correct.
  { path: 'src/chrome/src/ui/settings.js', kind: 'anchor',
    anchor: `(EXT_VERSION\\s*=\\s*['"])__OLD__(['"])` },
  { path: 'src/firefox/src/ui/settings.js', kind: 'anchor',
    anchor: `(EXT_VERSION\\s*=\\s*['"])__OLD__(['"])` },
  // ARCHITECTURE.md header line — `> Version X.Y.Z · Manifest V_ · ...`.
  // Documentation rots if it doesn't track releases.
  { path: 'src/chrome/ARCHITECTURE.md', kind: 'anchor',
    anchor: `(>\\s*Version\\s+)__OLD__(\\s*·)` },
  { path: 'src/firefox/ARCHITECTURE.md', kind: 'anchor',
    anchor: `(>\\s*Version\\s+)__OLD__(\\s*·)` },
];

// Tiny helper: run a git command and return its stdout. Throws on
// non-zero exit so the caller can surface a clear error. Stderr is
// captured into the thrown message so a "not a git repo" or "nothing
// to commit" failure tells you what actually happened.
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Returns true if the working tree has uncommitted MODIFIED or STAGED
// changes. Untracked files (`??`) are ignored — `.claude/`, scratch
// notes, etc. shouldn't block a release bump.
function workingTreeHasModifications(root) {
  const out = git(root, 'status', '--porcelain');
  if (!out) return false;
  return out.split('\n').some(line => line && !line.startsWith('??'));
}

function runCli() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, '..');

  // Parse positional bump kind + flags. `--release` triggers the commit
  // + tag-on-release-boundary flow; otherwise the script just edits files.
  const argv = process.argv.slice(2);
  const release = argv.includes('--release');
  const positional = argv.filter(a => !a.startsWith('--'));
  const arg = (positional[0] || 'patch').trim();

  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const oldVersion = pkg.version;
  let newVersion;
  try {
    newVersion = bumpSemver(oldVersion, arg);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  if (newVersion === oldVersion) {
    console.error(`✗ New version (${newVersion}) equals current version. Nothing to do.`);
    process.exit(1);
  }

  // Release mode pre-checks. We refuse to run on a dirty tree because
  // the commit we're about to create would otherwise sweep in unrelated
  // changes — and an unrelated bug-fix shouldn't ride along inside a
  // "chore: bump version" commit.
  if (release) {
    try {
      if (workingTreeHasModifications(root)) {
        console.error('✗ --release: working tree has uncommitted modifications.');
        console.error('  Commit or stash them first; the release commit should ONLY contain the bump.');
        process.exit(1);
      }
    } catch (e) {
      console.error(`✗ --release: ${e.message.split('\n')[0]}`);
      console.error('  Is this a git repository? --release needs git available on PATH.');
      process.exit(1);
    }
  }

  console.log(`Bumping version ${oldVersion} → ${newVersion}${release ? ' (release mode)' : ''}`);

  for (const entry of FILES_TO_UPDATE) {
    const abs = path.join(root, entry.path);
    const before = readFileSync(abs, 'utf8');
    let after;
    if (entry.kind === 'json') {
      after = rewriteVersionInJsonText(before, oldVersion, newVersion,
        { replaceAll: !!entry.replaceAll });
    } else if (entry.kind === 'anchor') {
      after = rewriteVersionByAnchor(before, oldVersion, newVersion, entry.anchor);
    } else {
      console.error(`✗ ${entry.path}: unknown kind "${entry.kind}" in FILES_TO_UPDATE.`);
      process.exit(1);
    }
    if (before === after) {
      const where = entry.kind === 'json'
        ? `no "version": "${oldVersion}" found`
        : `no match for anchor (current version literal "${oldVersion}" not at the expected location)`;
      console.error(`✗ ${entry.path}: ${where} — file may be out of sync. ` +
        `Patch it manually to "${oldVersion}" first, then re-run the bump.`);
      process.exit(1);
    }
    writeFileSync(abs, after);
    console.log(`  ✓ ${entry.path}`);
  }

  if (release) {
    const paths = FILES_TO_UPDATE.map(f => f.path);
    const isBoundary = isReleaseBoundary(newVersion);
    console.log('');
    console.log('Committing release…');
    try {
      git(root, 'add', '--', ...paths);
      git(root, 'commit', '-m', `chore: bump version ${oldVersion} → ${newVersion}`);
      const sha = git(root, 'rev-parse', '--short', 'HEAD');
      console.log(`  ✓ committed ${sha}`);
    } catch (e) {
      console.error(`✗ commit failed: ${e.message.split('\n').slice(0, 3).join(' ')}`);
      console.error('  Files were already edited — run `git status` to inspect.');
      process.exit(1);
    }
    if (isBoundary) {
      const tag = `v${newVersion}`;
      try {
        git(root, 'tag', '-a', tag, '-m', `Release ${tag}`);
        console.log(`  ✓ tagged ${tag} (release boundary: patch == 0)`);
      } catch (e) {
        console.error(`✗ tag failed: ${e.message.split('\n').slice(0, 3).join(' ')}`);
        console.error('  The commit is in place — you can tag manually:');
        console.error(`    git tag -a ${tag} -m "Release ${tag}"`);
        process.exit(1);
      }
    } else {
      console.log(`  (no tag — ${newVersion} is a patch release, shares the previous tag)`);
    }
    console.log('');
    console.log('Push when ready:');
    console.log(`  git push --follow-tags origin $(git rev-parse --abbrev-ref HEAD)`);
    return;
  }

  console.log('');
  console.log('Next steps (or re-run with --release to commit + tag in one shot):');
  console.log(`  git add ${FILES_TO_UPDATE.map(f => f.path).join(' ')}`);
  console.log(`  git commit -m "chore: bump version ${oldVersion} → ${newVersion}"`);
  if (isReleaseBoundary(newVersion)) {
    console.log(`  git tag -a v${newVersion} -m "Release v${newVersion}"   # ${newVersion} is a release boundary`);
  }
  console.log('  npm run build:zip       # rebuild ' + submissionZipPaths(newVersion).join(', '));
  console.log('  ' + submissionZipRemoveCommand(oldVersion));
  console.log('  git add ' + submissionZipPaths(newVersion).join(' '));
  console.log('  git commit -m "dist: rebuild submission zips for v' + newVersion + '"');
}

// Guarded entry point — only run the CLI when this file is invoked
// directly (e.g. `node scripts/bump-version.mjs`), NOT when it's imported
// by the test runner.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
