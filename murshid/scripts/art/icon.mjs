// Murshid app icon: one object that reads from 1024 px down to 16 px, a
// crimson fez with its black silk tassel, on a parchment tile.
//
// Writes assets/icons/murshid.svg (full colour) and murshid-mono.svg (one
// colour, for the tray and the macOS template images).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', '..', 'assets', 'icons');
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------- geometry

// The fez: a truncated cone with a flat top, seen a little from above.
const BODY = 'M168 132 L124 396 Q256 436 388 396 L344 132 Z';
const TOP = { cx: 256, cy: 132, rx: 88, ry: 19 };
const TOP_FRONT = 'M168 132 A88 19 0 0 0 344 132'; // the near rim of the crown
// The tassel's cord runs from the button over the crown and down the right side.
const CORD = 'M256 131 C300 124 340 128 356 146 C366 160 370 188 371 222';
const CAP = { x: 360, y: 216, w: 22, h: 16 };
const TASSEL = 'M360 230 C356 268 350 304 342 340 C356 348 386 348 400 340 C392 304 386 268 382 230 Z';
const STRANDS = 'M364 246 L356 334 M371 246 L371 338 M378 246 L386 334';

// --------------------------------------------------------- full colour

const full = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>Murshid</title>
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbf4e4"/>
      <stop offset="1" stop-color="#e6d3ad"/>
    </linearGradient>
    <linearGradient id="felt" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8e1626"/>
      <stop offset="0.3" stop-color="#d0343f"/>
      <stop offset="0.62" stop-color="#b3202f"/>
      <stop offset="1" stop-color="#650d1b"/>
    </linearGradient>
    <linearGradient id="silk" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2a1a14"/>
      <stop offset="0.5" stop-color="#140d0a"/>
      <stop offset="1" stop-color="#2a1a14"/>
    </linearGradient>
    <clipPath id="tile"><rect x="16" y="16" width="480" height="480" rx="114"/></clipPath>
  </defs>

  <g clip-path="url(#tile)">
    <rect x="16" y="16" width="480" height="480" fill="url(#paper)"/>
    <ellipse cx="258" cy="426" rx="168" ry="26" fill="#4a0912" opacity="0.16"/>
    <g transform="translate(256 262) scale(1.16) translate(-256 -262)">
      <path d="${BODY}" fill="url(#felt)"/>
      <ellipse cx="${TOP.cx}" cy="${TOP.cy}" rx="${TOP.rx}" ry="${TOP.ry}" fill="#7a1220"/>
      <path d="${CORD}" fill="none" stroke="#140d0a" stroke-width="10" stroke-linecap="round"/>
      <circle cx="${TOP.cx}" cy="131" r="10" fill="#140d0a"/>
      <rect x="${CAP.x}" y="${CAP.y}" width="${CAP.w}" height="${CAP.h}" rx="5" fill="#d9ae55"/>
      <path d="${TASSEL}" fill="url(#silk)"/>
      <path d="${STRANDS}" stroke="#4a3a32" stroke-width="3" stroke-linecap="round" opacity="0.8"/>
    </g>
  </g>
  <rect x="16.5" y="16.5" width="479" height="479" rx="113.5" fill="none" stroke="#4a0912" stroke-opacity="0.2"/>
</svg>
`;

// ----------------------------------------------------------------- mono

// One colour on transparency: the fez fills the canvas, and thin gaps keep the
// crown's rim and the tassel apart from the body.
const mono = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>Murshid</title>
  <defs>
    <mask id="cut">
      <rect width="512" height="512" fill="#fff"/>
      <path d="${TOP_FRONT}" fill="none" stroke="#000" stroke-width="12" stroke-linecap="round"/>
      <path d="${CORD}" fill="none" stroke="#000" stroke-width="22" stroke-linecap="round"/>
      <path d="${TASSEL}" fill="#000" stroke="#000" stroke-width="14" stroke-linejoin="round"/>
    </mask>
  </defs>
  <g fill="#000" transform="translate(256 276) scale(1.3) translate(-256 -276)">
    <g mask="url(#cut)">
      <path d="${BODY}"/>
      <ellipse cx="${TOP.cx}" cy="${TOP.cy}" rx="${TOP.rx}" ry="${TOP.ry}"/>
    </g>
    <path d="${CORD}" fill="none" stroke="#000" stroke-width="12" stroke-linecap="round"/>
    <circle cx="${TOP.cx}" cy="131" r="13"/>
    <path d="${TASSEL}"/>
  </g>
</svg>
`;

writeFileSync(resolve(outDir, 'murshid.svg'), full);
writeFileSync(resolve(outDir, 'murshid-mono.svg'), mono);
console.log('wrote murshid.svg, murshid-mono.svg');
