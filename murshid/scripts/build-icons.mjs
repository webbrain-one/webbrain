// Rasterizes the Murshid icon SVGs into the PNG/ICO files Electron and the
// installers need.   node scripts/build-icons.mjs
// (Run scripts/art/icon.mjs first if you changed the drawing.)

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icons = resolve(root, 'assets', 'icons');
const full = readFileSync(resolve(icons, 'murshid.svg'), 'utf8');
const mono = readFileSync(resolve(icons, 'murshid-mono.svg'), 'utf8');

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();

const pngs = {};
for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]) {
  pngs[size] = render(full, size);
  writeFileSync(resolve(icons, `murshid-${size}.png`), pngs[size]);
}

// Windows .ico with PNG-compressed entries (Vista and later read these).
function ico(sizes) {
  const entries = sizes.map((s) => ({ size: s, data: pngs[s] }));
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const at = 6 + i * 16;
    header.writeUInt8(e.size >= 256 ? 0 : e.size, at);
    header.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(e.data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}
writeFileSync(resolve(icons, 'murshid.ico'), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));

// macOS menu bar template image (black + alpha) and the 1024 master for .icns.
writeFileSync(resolve(icons, 'murshidTemplate.png'), render(mono, 16));
writeFileSync(resolve(icons, 'murshidTemplate@2x.png'), render(mono, 32));
copyFileSync(resolve(icons, 'murshid-1024.png'), resolve(icons, 'icon.png'));

// The website's favicons.
const web = resolve(root, 'web');
writeFileSync(resolve(web, 'favicon.png'), pngs[64]);
writeFileSync(resolve(web, 'apple-touch-icon.png'), render(full, 180));
copyFileSync(resolve(icons, 'murshid.svg'), resolve(web, 'favicon.svg'));
console.log('icons written to', icons);
