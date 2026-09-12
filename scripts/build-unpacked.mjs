#!/usr/bin/env node
/**
 * Build unpacked development directories for loading the extension from source.
 *
 *   node scripts/build-unpacked.mjs [--browser chrome|firefox|all] [--out-dir build] [--dry-run] [--clean]
 *
 * Or via npm: npm run build:chrome | build:firefox | build:all
 *
 * Why this exists (TODOs.md #5): the release path (`npm run build:zip`) builds
 * store-submission zips from the HEAD commit, which is correct for releases but
 * awkward for day-to-day development. Developers iterating on a dirty working
 * tree need a deterministic unpacked directory they can point
 * chrome://extensions ("Load unpacked") or about:debugging ("Load Temporary
 * Add-on") at, without guessing whether to load `src/chrome/` directly or a
 * stale copy. This script copies the working-tree `src/<browser>/` directories
 * into `<out-dir>/chrome` and `<out-dir>/firefox`, validates that both
 * manifests parse and their versions match `package.json`, and prints the exact
 * load paths.
 *
 * Source-of-truth is the WORKING TREE (unlike build-zip.mjs, which archives
 * HEAD). That is intentional: dev builds must include uncommitted edits under
 * test. Never publish these directories to stores; use `npm run build:zip`.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export const DEV_BUILD_BROWSERS = ['chrome', 'firefox'];

export const DEV_BUILD_SOURCE_DIRS = {
  chrome: 'src/chrome',
  firefox: 'src/firefox',
};

const DEV_BUILD_PROTECTED_DIRS = ['.git', 'src', 'scripts'];

/**
 * Resolve which browsers to build and where they land.
 * Pure helper so tests and CLIs share one source of truth.
 */
export function resolveBuildPlan({ browser = 'all', outDir = 'build' } = {}) {
  const wanted =
    browser === 'all' ? [...DEV_BUILD_BROWSERS] : [String(browser).toLowerCase()];
  for (const name of wanted) {
    if (!DEV_BUILD_BROWSERS.includes(name)) {
      throw new Error(`unknown browser "${name}" (expected chrome, firefox, or all)`);
    }
  }
  return wanted.map((name) => ({
    browser: name,
    sourceDir: DEV_BUILD_SOURCE_DIRS[name],
    outDir: path.join(outDir, name === 'chrome' ? 'chrome' : 'firefox'),
  }));
}

function pathContains(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

// Resolve symlinks in the existing portion of a path. This catches an output
// parent that aliases src/ even when the final build directory does not exist.
function resolveExistingPath(absPath) {
  let existing = path.resolve(absPath);
  const missing = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const resolvedParent = existsSync(existing) ? realpathSync(existing) : existing;
  return path.resolve(resolvedParent, ...missing);
}

/**
 * Resolve and validate the complete plan before any destination is removed.
 * Outputs must not contain the repository, overlap either browser source, or
 * enter repository metadata/build-script directories.
 */
export function assertSafeBuildPlan(plan, rootDir = root) {
  const rootPath = resolveExistingPath(rootDir);
  const sourcePaths = Object.entries(DEV_BUILD_SOURCE_DIRS).map(([name, sourceDir]) => ({
    label: `${name} source`,
    path: resolveExistingPath(path.resolve(rootPath, sourceDir)),
  }));
  const protectedPaths = DEV_BUILD_PROTECTED_DIRS.map((protectedDir) => ({
    label: `protected repository directory ${protectedDir}`,
    path: resolveExistingPath(path.resolve(rootPath, protectedDir)),
  }));
  const resolvedPlan = plan.map((step) => ({
    ...step,
    sourcePath: path.resolve(rootPath, step.sourceDir),
    outputPath: path.resolve(rootPath, step.outDir),
    outputSafetyPath: resolveExistingPath(path.resolve(rootPath, step.outDir)),
  }));

  for (const step of resolvedPlan) {
    if (pathContains(step.outputSafetyPath, rootPath)) {
      throw new Error(
        `unsafe output directory for ${step.browser}: ${step.outputPath} contains repository root ${rootPath}`,
      );
    }
    for (const protectedPath of [...sourcePaths, ...protectedPaths]) {
      if (pathsOverlap(step.outputSafetyPath, protectedPath.path)) {
        throw new Error(
          `unsafe output directory for ${step.browser}: ${step.outputPath} overlaps ${protectedPath.label} ${protectedPath.path}`,
        );
      }
    }
  }

  for (let i = 0; i < resolvedPlan.length; i += 1) {
    for (let j = i + 1; j < resolvedPlan.length; j += 1) {
      if (pathsOverlap(resolvedPlan[i].outputSafetyPath, resolvedPlan[j].outputSafetyPath)) {
        throw new Error(
          `unsafe output directories overlap: ${resolvedPlan[i].outputPath} and ${resolvedPlan[j].outputPath}`,
        );
      }
    }
  }

  return resolvedPlan;
}

/** Read + parse JSON, throwing a path-annotated error. */
export function readJsonFile(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON at ${absPath}: ${error.message}`);
  }
}

/**
 * Validate the dev-build inputs before copying.
 * Returns { version, manifests } or throws with a human-readable reason.
 */
export function assertDevBuildInputs(rootDir = root) {
  const pkg = readJsonFile(path.join(rootDir, 'package.json'));
  const manifests = {};
  for (const name of DEV_BUILD_BROWSERS) {
    const manifestPath = path.join(rootDir, DEV_BUILD_SOURCE_DIRS[name], 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`missing manifest: ${manifestPath}`);
    }
    manifests[name] = readJsonFile(manifestPath);
  }
  const versions = new Set([
    String(pkg.version),
    String(manifests.chrome.version),
    String(manifests.firefox.version),
  ]);
  if (versions.size !== 1) {
    throw new Error(
      `version mismatch: package.json=${pkg.version} chrome=${manifests.chrome.version} firefox=${manifests.firefox.version}`,
    );
  }
  return { version: String(pkg.version), manifests };
}

function parseArgs(argv) {
  const args = { browser: 'all', outDir: 'build', dryRun: false, clean: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--browser') args.browser = argv[(i += 1)] ?? 'all';
    else if (token.startsWith('--browser=')) args.browser = token.slice('--browser='.length);
    else if (token === '--out-dir') args.outDir = argv[(i += 1)] ?? 'build';
    else if (token.startsWith('--out-dir=')) args.outDir = token.slice('--out-dir='.length);
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--clean') args.clean = true;
    else if (token === '--help' || token === '-h') {
      console.log(
        'Usage: node scripts/build-unpacked.mjs [--browser chrome|firefox|all] [--out-dir build] [--dry-run] [--clean]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

export function buildUnpacked({
  browser = 'all',
  outDir = 'build',
  dryRun = false,
  clean = false,
  rootDir = root,
  log = console.log,
} = {}) {
  const { version } = assertDevBuildInputs(rootDir);
  const plan = assertSafeBuildPlan(resolveBuildPlan({ browser, outDir }), rootDir);

  if (clean && !dryRun) {
    for (const step of plan) {
      rmSync(step.outputPath, { recursive: true, force: true });
    }
  }

  for (const step of plan) {
    const from = step.sourcePath;
    const to = step.outputPath;
    if (!existsSync(from)) throw new Error(`missing source directory: ${from}`);
    if (dryRun) {
      log(`[dry-run] ${step.browser}: ${step.sourceDir}/ -> ${step.outDir}/ (v${version})`);
      continue;
    }
    mkdirSync(path.dirname(to), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    log(`built ${step.browser} v${version}: ${step.sourceDir}/ -> ${step.outDir}/`);
  }

  if (!dryRun) {
    log('Load paths:');
    for (const step of plan) {
      if (step.browser === 'chrome') {
        log(`  Chrome: chrome://extensions/ -> Load unpacked -> ${step.outDir}/`);
      } else {
        log(
          `  Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> ${step.outDir}/manifest.json`,
        );
      }
    }
  }

  return { version, plan };
}

function runCli() {
  buildUnpacked(parseArgs(process.argv.slice(2)));
}

const invokedAsCli =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    runCli();
  } catch (error) {
    console.error(`build-unpacked: ${error.message}`);
    process.exit(1);
  }
}
