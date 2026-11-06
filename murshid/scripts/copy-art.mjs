// Copies the generated artwork into the website (web/ deploys on its own).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const art = resolve(root, 'web', 'art');
mkdirSync(art, { recursive: true });
copyFileSync(resolve(root, 'assets', 'art', 'murshid-portrait.svg'), resolve(art, 'murshid-portrait.svg'));
copyFileSync(resolve(root, 'assets', 'art', 'semazen.svg'), resolve(art, 'semazen.svg'));
copyFileSync(resolve(root, 'assets', 'icons', 'murshid.svg'), resolve(art, 'murshid-icon.svg'));
console.log('art copied to web/art');
