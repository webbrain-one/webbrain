// The extension ships its sources as they are: pages, the background and the
// workers load ES modules straight from the build's tree, with no bundler in
// between. An import of a file the build does not ship, or of a name that file
// does not export, fails the whole module graph at link time, so nothing in
// the page runs while its static HTML still looks normal. The Firefox build is
// a separate tree with fewer files (no in-browser WebGPU provider, no
// offscreen document), and a page copied over from Chrome can import a path
// only Chrome has: in 48.1.1 Firefox's Apocalypse Mode page imported
// ../providers/webgpu.js, and its Enabled switch and every other control on it
// were dead. esbuild links each build here (nothing is written) and fails on
// any such import; the pages' own <script src> and <link href> are checked
// against the tree the same way.
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILDS = ['chrome', 'firefox'];
// Third-party bundles: linked when the extension's own code imports them, but
// not entry points of their own (some carry Node-only branches).
const SKIP_DIRS = new Set(['node_modules', 'vendor']);

function filesUnder(directory, pattern) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : filesUnder(full, pattern);
    return pattern.test(entry.name) ? [full] : [];
  });
}

const relative = file => path.relative(ROOT, file).split(path.sep).join('/');

// Links every module of one build and returns the unresolvable imports.
async function linkProblems(sourceDir) {
  const entryPoints = filesUnder(sourceDir, /\.m?js$/);
  try {
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints,
      bundle: true,
      write: false,
      outdir: path.join(ROOT, '.extension-module-imports-out'),
      format: 'esm',
      platform: 'browser',
      splitting: true,
      // Only the build's own files are under test; a bare specifier would
      // already fail in the browser and is not something this tree uses.
      packages: 'external',
      logLevel: 'silent',
    });
    // A named import from a file with no exports at all is only a warning in
    // esbuild, but a link-time SyntaxError in the browser.
    return result.warnings
      .filter(warning => warning.id === 'import-is-undefined')
      .map(warning => `${warning.location?.file}:${warning.location?.line}: ${warning.text}`);
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error;
    return error.errors.map(item => `${item.location?.file}:${item.location?.line}: ${item.text}`);
  }
}

for (const browser of BUILDS) {
  const sourceDir = path.join(ROOT, 'src', browser);

  test(`${browser}: every module import resolves to a shipped file and export`, async () => {
    assert.ok(filesUnder(sourceDir, /\.m?js$/).length > 100, `${browser}: the build's modules were found`);
    assert.deepEqual(await linkProblems(sourceDir), [], `${browser}: unresolved module imports`);
  });

  test(`${browser}: every page's scripts and stylesheets are shipped`, () => {
    const missing = [];
    for (const page of filesUnder(sourceDir, /\.html$/)) {
      const html = readFileSync(page, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      for (const match of html.matchAll(/<(script|link)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        const reference = match[2].split(/[?#]/)[0];
        if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) continue;
        const target = reference.startsWith('/')
          ? path.join(sourceDir, reference)
          : path.resolve(path.dirname(page), reference);
        if (!existsSync(target)) missing.push(`${relative(page)} -> ${match[2]}`);
      }
    }
    assert.deepEqual(missing, [], `${browser}: pages reference files the build does not ship`);
  });
}

test('esbuild reports a missing module, a missing export and an import from a module without exports', async (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'webbrain-module-imports-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(path.join(fixture, 'ui'));
  writeFileSync(path.join(fixture, 'ui', 'page.js'), [
    "import { MISSING_FILE } from '../providers/absent.js';",
    "import { MISSING_NAME } from './exports.js';",
    "import { NO_EXPORTS } from './plain.js';",
    'console.log(MISSING_FILE, MISSING_NAME, NO_EXPORTS);',
    '',
  ].join('\n'));
  writeFileSync(path.join(fixture, 'ui', 'exports.js'), 'export const PRESENT = 1;\n');
  writeFileSync(path.join(fixture, 'ui', 'plain.js'), 'const local = 1;\n');
  const problems = await linkProblems(fixture);
  assert.ok(problems.some(line => /Could not resolve "\.\.\/providers\/absent\.js"/.test(line)), problems.join('\n'));
  // esbuild stops at an unresolved file before linking names; drop it and link again.
  writeFileSync(path.join(fixture, 'ui', 'page.js'), [
    "import { MISSING_NAME } from './exports.js';",
    "import { NO_EXPORTS } from './plain.js';",
    'console.log(MISSING_NAME, NO_EXPORTS);',
    '',
  ].join('\n'));
  const linked = await linkProblems(fixture);
  assert.ok(linked.some(line => /No matching export .* for import "MISSING_NAME"/.test(line)), linked.join('\n'));
  // The no-exports case is a warning, which esbuild reports only once the errors are gone.
  writeFileSync(path.join(fixture, 'ui', 'page.js'), "import { NO_EXPORTS } from './plain.js';\nconsole.log(NO_EXPORTS);\n");
  const warned = await linkProblems(fixture);
  assert.ok(warned.some(line => /Import "NO_EXPORTS" will always be undefined/.test(line)), warned.join('\n'));
});
