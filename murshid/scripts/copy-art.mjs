// Copies the app icon into the website (web/ deploys on its own). The
// homepage's pictures are written straight into web/art by scripts/art.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const art = resolve(root, 'web', 'art');
mkdirSync(art, { recursive: true });
copyFileSync(resolve(root, 'assets', 'icons', 'murshid.svg'), resolve(art, 'murshid-icon.svg'));

// Social crawlers such as Mastodon accept PNG, but not our SVG app icon.
// Keep the fez in the middle so it also survives square thumbnail crops.
const icon = readFileSync(resolve(art, 'murshid-icon.svg'), 'utf8')
  .replace('<svg ', '<svg x="328" y="43" width="544" height="544" ');
const social = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f6efdf"/>
  ${icon}
</svg>`;
writeFileSync(resolve(art, 'murshid-social.png'), new Resvg(social).render().asPng());
console.log('icon and social preview written to web/art');
