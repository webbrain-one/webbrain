// Build the public update feed from verified, locally staged release assets.
// node scripts/build-update-feed.mjs [download-directory] [output-json]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { compareVersions, selectRelease } = require('../app/updates.js');
const downloads = resolve(process.argv[2] || resolve(root, 'web/download'));
const output = resolve(process.argv[3] || resolve(root, 'web/updates/stable.json'));
const sums = new Map(readFileSync(resolve(downloads, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').map(line => {
  const match = line.match(/^([a-f0-9]{64})  (Murshid-[A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error('Invalid checksum entry');
  return [match[2], match[1]];
}));
const asset = name => {
  const bytes = readFileSync(resolve(downloads, name));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sums.get(name) !== sha256) throw new Error(`Checksum mismatch: ${name}`);
  return { url: `https://murshid.one/download/${name}`, size: bytes.length, sha256 };
};
const latest = suffix => [...sums.keys()].map(name => ({ name, match: name.match(new RegExp('^Murshid-(\\d+\\.\\d+\\.\\d+)-' + suffix.replaceAll('.', '\\.') + '$')) }))
  .filter(item => item.match).sort((a, b) => compareVersions(b.match[1], a.match[1]))[0];
const platforms = {};
for (const [key, suffix] of [['darwin-universal', 'macos-universal.dmg'], ['win32-x64', 'windows-x64-setup.exe'], ['linux-x64', 'linux-x86_64.AppImage']]) {
  const found = latest(suffix);
  if (found) platforms[key] = { version: found.match[1], installer: asset(found.name) };
}
const current = platforms['darwin-universal']?.version;
if (!current) throw new Error('Missing macOS installer');
platforms['darwin-universal'].update = asset(`Murshid-${current}-macos-universal.zip`);
const feed = { schema: 'murshid-updates/1', currentRelease: current, platforms,
  releases: [{ version: current, updateTo: { version: current, name: current,
    notes: 'Murshid browser update.', pub_date: new Date().toISOString(), ...platforms['darwin-universal'].update } }] };
for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']]) selectRelease(feed, platform, arch);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(feed, null, 2) + '\n');
console.log(`Wrote ${output}: macOS ${current}; Windows ${platforms['win32-x64']?.version || 'unpublished'}; Linux ${platforms['linux-x64']?.version || 'unpublished'}`);
