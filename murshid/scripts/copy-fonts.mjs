// Copies the self-hosted web fonts (all SIL OFL 1.1) from @fontsource into web/fonts.
//   node scripts/copy-fonts.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'web', 'fonts');
mkdirSync(out, { recursive: true });
const files = [
  ...['300', '400', '500', '600'].flatMap((w) => ['normal', 'italic'].flatMap((s) => ['latin', 'latin-ext'].map((sub) => ['cormorant-garamond', `cormorant-garamond-${sub}-${w}-${s}.woff2`]))),
  // latin-ext carries Turkish (ğ ş İ) and the rest of the Latin alphabets
  ...['400', '500', '600'].flatMap((w) => ['latin', 'latin-ext'].map((sub) => ['ibm-plex-sans', `ibm-plex-sans-${sub}-${w}-normal.woff2`])),
  ...['400', '500'].flatMap((w) => ['latin', 'latin-ext'].map((sub) => ['ibm-plex-mono', `ibm-plex-mono-${sub}-${w}-normal.woff2`])),
  // the Arabic and Persian pages: IBM Plex Sans Arabic for text, Amiri for headings
  ...['400', '500', '600'].map((w) => ['ibm-plex-sans-arabic', `ibm-plex-sans-arabic-arabic-${w}-normal.woff2`]),
  ['amiri', 'amiri-arabic-400-normal.woff2'],
  ['aref-ruqaa', 'aref-ruqaa-arabic-400-normal.woff2'],
  ['aref-ruqaa', 'aref-ruqaa-arabic-700-normal.woff2'],
];
for (const [pkg, file] of files) copyFileSync(resolve(root, 'node_modules', '@fontsource', pkg, 'files', file), resolve(out, file));
const license = readFileSync(resolve(root, 'node_modules', '@fontsource', 'cormorant-garamond', 'LICENSE'), 'utf8');
writeFileSync(resolve(out, 'LICENSE.txt'), `Cormorant Garamond, IBM Plex Sans, IBM Plex Mono, IBM Plex Sans Arabic, Amiri and Aref Ruqaa are licensed under the SIL Open Font License 1.1.\nFiles copied from the @fontsource packages.\n\n${license}`);
console.log(`copied ${files.length} fonts to ${out}`);
