// Rebuilds the filter engine Murshid ships with (app/adblock/engine.bin.gz and
// lists.json): downloads EasyList, EasyPrivacy and uBlock's Unbreak list and
// serializes them with the installed @ghostery/adblocker. Run it after
// upgrading @ghostery/adblocker (a stored engine only loads with the library
// version that wrote it) and before a release, so new installs start with
// recent lists.
//   npm run adblock
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { LISTS, buildEngine, describe, pack, writeEngine } = require(resolve(root, 'app', 'adblock', 'engine.js'));

const texts = [];
for (const list of LISTS) {
  const response = await fetch(list.url, { headers: { 'User-Agent': 'Murshid filter list build' } });
  if (!response.ok) throw new Error(`${list.url}: HTTP ${response.status}`);
  texts.push(await response.text());
  console.log(`${list.name}: ${texts.at(-1).length.toLocaleString('en')} bytes`);
}
const engine = buildEngine(texts);
const packed = pack(engine.serialize());
const meta = describe(texts);
writeEngine(resolve(root, 'app', 'adblock', 'engine.bin.gz'), resolve(root, 'app', 'adblock', 'lists.json'), packed, meta);
const { networkFilters, cosmeticFilters } = engine.getFilters();
console.log(`engine ${meta.engineVersion}: ${networkFilters.length.toLocaleString('en')} network and ${cosmeticFilters.length.toLocaleString('en')} cosmetic filters, ${packed.length.toLocaleString('en')} bytes gzipped`);
