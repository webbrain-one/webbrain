#!/usr/bin/env node
/**
 * Builds the WebBrain for websites widget into embed/dist/:
 *
 *   embed.js      the script site owners add with <script src=".../embed.js">
 *   tools.json    prompts and tool definitions for the server that answers it
 *   icon48.png, icon128.png
 *   VERSION.json  widget version and the WebBrain commit it was built from
 *   SHA256SUMS    checksums of the files above, for servers that pin a release
 *
 * The bundle is assembled from the extension's own code in src/chrome, so a
 * change there reaches the widget on the next build.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, REPO_ROOT, EXTENSION_PATHS } from '../src/webbrain.js';
import { buildEmbedBundle } from '../src/bundle.js';
import { buildAgentSpec } from '../src/agent-spec.js';

const distDir = path.resolve(PROJECT_ROOT, 'dist');
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const write = (name, contents) => fs.writeFileSync(path.join(distDir, name), contents);

const bundle = buildEmbedBundle();
// Parse with the grammar of a classic <script>, the way sites load embed.js.
// (`node --check` would parse it as an ES module, since this package is "type": "module".)
new vm.Script(bundle, { filename: 'embed.js' });
write('embed.js', bundle);

write('tools.json', `${JSON.stringify(buildAgentSpec(), null, 2)}\n`);
fs.copyFileSync(EXTENSION_PATHS.icon48, path.join(distDir, 'icon48.png'));
fs.copyFileSync(EXTENSION_PATHS.icon128, path.join(distDir, 'icon128.png'));

const pkg = JSON.parse(fs.readFileSync(path.resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
let commit = process.env.GITHUB_SHA || '';
if (!commit) {
  try {
    commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    commit = 'unknown';
  }
}
write('VERSION.json', `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  commit,
  source: `https://github.com/webbrain-one/webbrain/tree/${commit === 'unknown' ? 'main' : commit}/embed`,
  license: pkg.license,
}, null, 2)}\n`);

const files = ['embed.js', 'tools.json', 'icon48.png', 'icon128.png', 'VERSION.json'];
const sums = files.map((name) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(distDir, name))).digest('hex');
  return `${hash}  ${name}`;
});
write('SHA256SUMS', `${sums.join('\n')}\n`);

console.log(`✓ Built embed/dist/embed.js (${(Buffer.byteLength(bundle) / 1024).toFixed(1)} KB), tools.json, icons, VERSION.json and SHA256SUMS`);
