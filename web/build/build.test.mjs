import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WEBSITES_LAUNCHED } from './site-footer.mjs';

const runFile = promisify(execFile);
const locale = { code: 'en', bcp47: 'en-US', dir: 'ltr', isDefault: true };
const exportNames = [
  'applyLaunchBlocks', 'applyTemplate', 'buildFaqJsonLd', 'buildFaqLanguageRoutes',
  'buildSoftwareJsonLd', 'escJson', 'htmlToPlain', 'serializeScriptJson',
].sort();
const scriptTemplate = [
  '<script type="application/ld+json" id="faq">{{faq_jsonld}}</script>',
  '<script type="application/ld+json" id="software">{{software_jsonld}}</script>',
  '<script type="application/json" id="inline">{"value":"{{j:value}}"}</script>',
].join('\n');
let builder;
let sandbox;
let isolatedExports;

before(async () => {
  // Test the actual module in a directory with no templates/assets first.
  // An accidental main() call fails there before importing the real builder.
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'webbrain-build-import-'));
  await copyFile(new URL('./build.mjs', import.meta.url), path.join(sandbox, 'build.mjs'));
  await copyFile(new URL('./plausible.mjs', import.meta.url), path.join(sandbox, 'plausible.mjs'));
  await copyFile(new URL('./site-footer.mjs', import.meta.url), path.join(sandbox, 'site-footer.mjs'));
  await copyFile(new URL('./research.mjs', import.meta.url), path.join(sandbox, 'research.mjs'));
  await copyFile(new URL('./languages.json', import.meta.url), path.join(sandbox, 'languages.json'));
  const script = 'const module = await import(' +
    JSON.stringify(pathToFileURL(path.join(sandbox, 'build.mjs')).href) +
    '); process.stdout.write(JSON.stringify(Object.keys(module).sort()));';
  const result = await runFile(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: sandbox, timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.stderr, '');
  isolatedExports = JSON.parse(result.stdout);
  assert.deepEqual(isolatedExports, exportNames);
  assert.deepEqual((await readdir(sandbox)).sort(), ['build.mjs', 'languages.json', 'plausible.mjs', 'research.mjs', 'site-footer.mjs']);
  builder = await import('./build.mjs');
});

after(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

function dictFor(value, answerHtml = '<p>Ordinary answer.</p>') {
  return {
    'faq.alt_claude.q': value,
    'faq.alt_claude.a_html': answerHtml,
    'meta.description': value,
    'meta.software_version': '40.0.8',
    value,
  };
}

function scriptsFrom(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  assert.equal(scripts.length, 3, 'only the three authored script boundaries remain');
  return scripts.map((match) => {
    assert.doesNotMatch(match[1], /[<>&]/, 'JSON data cannot create HTML syntax');
    return JSON.parse(match[1]);
  });
}

test('import exposes the actual pure functions without running the website build', () => {
  assert.deepEqual(isolatedExports, exportNames);
  for (const name of exportNames) assert.equal(typeof builder[name], 'function');
});

test('JSON serializer preserves nested values while closing-script syntax stays data', () => {
  const value = {
    text: '</ScRiPt><img src=x onerror="window.injected=true">&',
    nested: ['quotes " and \\', '\n\t', '\\u003c is literal text'],
  };
  const serialized = builder.serializeScriptJson(value, 2);
  assert.doesNotMatch(serialized, /[<>&]/);
  assert.deepEqual(JSON.parse(serialized), value);
});

test('FAQ question closing tags remain a single JSON-LD script', () => {
  const value = '</script><script>window.injected=true</script>';
  const [faq, software, inline] = scriptsFrom(builder.applyTemplate(
    scriptTemplate, dictFor(value), locale,
  ).html);
  assert.equal(faq.mainEntity[0].name, value);
  assert.equal(software.description, value);
  assert.equal(inline.value, value);
});

test('FAQ decoded markup is preserved as plain JSON data after existing HTML stripping', () => {
  const answer = '<p>Use &lt;/script&gt;&lt;img src=x onerror=&quot;bad()&quot;&gt; ' +
    '&amp; &#39;quoted&#39;<br>then <strong>continue</strong>.</p>';
  const expected = 'Use </script><img src=x onerror="bad()"> & \'quoted\' then continue.';
  assert.equal(builder.htmlToPlain(answer), expected);
  const payload = builder.buildFaqJsonLd(dictFor('Question', answer), 'en-US');
  assert.doesNotMatch(payload, /[<>&]/);
  assert.equal(JSON.parse(payload).mainEntity[0].acceptedAnswer.text, expected);
});

test('software description and version cannot escape their JSON-LD script', () => {
  const value = '</script><img src=x onerror="bad()">';
  const dict = { ...dictFor(value), 'meta.software_version': '1"</script>&' };
  const payload = builder.buildSoftwareJsonLd(dict, locale);
  assert.doesNotMatch(payload, /[<>&]/);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.description, value);
  assert.equal(parsed.softwareVersion, dict['meta.software_version']);
});

test('Unicode, quotes, backslashes and line separators round-trip without data loss', () => {
  const value = 'Türkçe 中文 العربية עברית 🧠 \u2028\u2029 "\' \\ \n \t <>&';
  assert.equal(JSON.parse(builder.serializeScriptJson(value)), value);
  const [faq, software, inline] = scriptsFrom(builder.applyTemplate(
    scriptTemplate, dictFor(value), locale,
  ).html);
  assert.equal(faq.mainEntity[0].name, value);
  assert.equal(software.description, value);
  assert.equal(inline.value, value);
});

test('literal replacement dollar sequences survive FAQ, software and inline JSON placeholders', () => {
  const value = ['$&', "$'", '$' + String.fromCharCode(96), '$$', '</script>&'].join(' | ');
  const answer = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const [faq, software, inline] = scriptsFrom(builder.applyTemplate(
    scriptTemplate, dictFor(value, '<p>' + answer + '</p>'), locale,
  ).html);
  assert.equal(faq.mainEntity[0].name, value);
  assert.equal(faq.mainEntity[0].acceptedAnswer.text, value);
  assert.equal(software.description, value);
  assert.equal(inline.value, value);
});

test('JSON string placeholders preserve null, false, zero and already escaped literal data', () => {
  for (const value of [null, false, 0, '\\u003c/script\\u003e', '"\\\n</script>']) {
    const html = builder.applyTemplate(
      '<script type="application/json">{"value":"{{j:value}}"}</script>',
      { value }, locale,
    ).html;
    const match = html.match(/^<script\b[^>]*>([\s\S]*)<\/script>$/);
    assert.ok(match);
    assert.doesNotMatch(match[1], /[<>&]/);
    assert.equal(JSON.parse(match[1]).value, value == null ? '' : String(value));
  }
});

test('route-map placeholders remain parseable with their existing locale paths', () => {
  const { html } = builder.applyTemplate(
    '{"routes":{{faq_language_routes}},"flags":{{language_flag_codes}}}', {}, locale,
  );
  const parsed = JSON.parse(html);
  assert.deepEqual(parsed.routes, JSON.parse(builder.buildFaqLanguageRoutes()));
  assert.equal(parsed.routes.en, '/docs/faq/');
  assert.equal(parsed.routes.tr, '/docs/tr/faq/');
  assert.equal(parsed.routes.zh, '/docs/zh/faq/');
  assert.equal(parsed.flags.en, 'us');
  assert.equal(parsed.flags.tr, 'tr');
});

test('websites launch blocks keep one side of the switch', () => {
  const source = 'a<!-- if websites -->ON<!-- else websites -->OFF<!-- end websites -->b<!-- if websites -->X<!-- end websites -->c';
  assert.equal(builder.applyLaunchBlocks(source, true), 'aONbXc');
  assert.equal(builder.applyLaunchBlocks(source, false), 'aOFFbc');
  assert.equal(builder.applyTemplate(source, {}, locale).html, WEBSITES_LAUNCHED ? 'aONbXc' : 'aOFFbc');
});
