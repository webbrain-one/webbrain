import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSafeBuildPlan,
  buildUnpacked,
  resolveBuildPlan,
} from '../scripts/build-unpacked.mjs';

function makeFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'webbrain-build-unpacked-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const browser of ['chrome', 'firefox']) {
    const source = path.join(root, 'src', browser);
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(path.join(source, 'source-marker.txt'), browser);
  }
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  return root;
}

test('buildUnpacked rejects a destination equal to a source before deleting it', (t) => {
  const root = makeFixture(t);
  const marker = path.join(root, 'src', 'chrome', 'source-marker.txt');

  assert.throws(
    () => buildUnpacked({ browser: 'chrome', outDir: 'src', rootDir: root, log() {} }),
    /unsafe output directory.*overlaps chrome source/,
  );
  assert.equal(readFileSync(marker, 'utf8'), 'chrome');
});

test('build-plan safety rejects ancestors or descendants of sources and protected directories', (t) => {
  const root = makeFixture(t);
  for (const outDir of ['src/chrome/dev', 'src/firefox/dev', 'src/build', '.git/dev', 'scripts/dev']) {
    assert.throws(
      () => assertSafeBuildPlan(resolveBuildPlan({ browser: 'chrome', outDir }), root),
      /unsafe output directory/,
      outDir,
    );
  }
  assert.throws(
    () => assertSafeBuildPlan([{
      browser: 'chrome',
      sourceDir: 'src/chrome',
      outDir: 'src',
    }], root),
    /unsafe output directory.*overlaps chrome source/,
  );
});

test('build-plan safety resolves an existing symlinked parent before comparison', (t) => {
  const root = makeFixture(t);
  const alias = path.join(root, 'source-alias');
  symlinkSync(path.join(root, 'src'), alias, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => assertSafeBuildPlan(resolveBuildPlan({ browser: 'chrome', outDir: 'source-alias' }), root),
    /unsafe output directory.*overlaps chrome source/,
  );
});

test('buildUnpacked still copies safe Chrome and Firefox output directories', (t) => {
  const root = makeFixture(t);
  const { plan } = buildUnpacked({ rootDir: root, log() {} });

  assert.equal(plan.length, 2);
  for (const browser of ['chrome', 'firefox']) {
    const marker = path.join(root, 'build', browser, 'source-marker.txt');
    assert.equal(existsSync(marker), true);
    assert.equal(readFileSync(marker, 'utf8'), browser);
  }
});
