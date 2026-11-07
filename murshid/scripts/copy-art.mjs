// Copies the app icon into the website (web/ deploys on its own). The
// homepage's pictures are written straight into web/art by scripts/art.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const art = resolve(root, 'web', 'art');
mkdirSync(art, { recursive: true });
copyFileSync(resolve(root, 'assets', 'icons', 'murshid.svg'), resolve(art, 'murshid-icon.svg'));
console.log('icon copied to web/art');
