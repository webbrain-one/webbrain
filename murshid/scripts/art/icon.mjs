// Murshid app icon: the guide in profile, built from simple geometry so it
// holds up from 1024 px down to 16 px — a great round turban with its wraps cut
// out of it, a gold band and plume, an aquiline profile and a pointed beard,
// set on a Seljuk eight-pointed star inside a gold halo, on Ottoman crimson.
//
// Writes assets/icons/murshid.svg (full colour) and murshid-mono.svg (one
// colour, for the tray and template images).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', '..', 'assets', 'icons');
mkdirSync(outDir, { recursive: true });

const C = {
  top: '#b01f2e',
  bottom: '#650d1b',
  star: '#c42a38',
  robe: '#4a0912',
  ink: '#f7eedb',
  gold: '#e3b55b',
  goldDeep: '#b9842c',
  cut: '#8e1626',
};

const f = (n) => Number(n.toFixed(1));
const rad = (d) => (d * Math.PI) / 180;

// ------------------------------------------------------------- geometry

const TURBAN = { cx: 278, cy: 182, r: 106 };
const HALO = { cx: 270, cy: 214, r: 168 };

const CAP = 'M252 86 C254 58 265 46 278 46 C291 46 302 58 304 86 Z';
const BAND = 'M176 262 C226 294 332 294 382 258 L388 282 C336 320 222 320 170 288 Z';
const PLUME = 'M206 246 C186 212 180 164 194 120 C203 152 210 178 214 202 C220 176 232 154 252 138 C240 172 233 208 224 246 Z';
const FACE = [
  'M192 300',
  'C188 312 186 322 186 330', // brow
  'C178 344 168 357 158 369', // the long aquiline nose
  'C153 375 154 380 161 381', // nose tip
  'C168 382 174 384 176 390', // under the nose
  'L170 397', // upper lip
  'C174 401 177 402 181 403', // mouth
  'L175 409', // lower lip
  'C179 415 184 419 189 421', // into the beard
  'C184 440 191 457 205 469', // beard front
  'C214 477 220 482 225 490', // beard point
  'C233 474 245 463 259 454', // beard back
  'C271 446 282 440 292 436',
  'L342 444', // neck to the shoulder
  'C338 418 342 376 352 300', // back of the neck and head, up under the band
  'Z',
].join(' ');
const ROBE = 'M24 540 L24 478 C76 454 136 446 198 448 L292 436 C364 438 432 452 492 484 L492 540 Z';

function star(cx, cy, r, inner, rotate) {
  const pts = [];
  for (let i = 0; i < 16; i += 1) {
    const rr = i % 2 === 0 ? r : r * inner;
    const a = rad(rotate + i * 22.5);
    pts.push(`${f(cx + rr * Math.cos(a))},${f(cy + rr * Math.sin(a))}`);
  }
  return pts.join(' ');
}

function rays() {
  const parts = [];
  for (let a = 0; a < 360; a += 7.5) {
    const long = Math.round(a / 7.5) % 2 === 0;
    const r1 = HALO.r + 14;
    const r2 = HALO.r + (long ? 120 : 62);
    parts.push(`M${f(HALO.cx + r1 * Math.cos(rad(a)))} ${f(HALO.cy + r1 * Math.sin(rad(a)))}L${f(HALO.cx + r2 * Math.cos(rad(a)))} ${f(HALO.cy + r2 * Math.sin(rad(a)))}`);
  }
  return parts.join('');
}

// Wraps: arcs of big circles centred above-left of the turban, so they rise
// toward the back of the head and sag toward the viewer, like cloth round a globe.
function wraps() {
  const ox = 100;
  const oy = -300;
  const parts = [];
  for (const R of [412, 456, 500, 544, 588]) {
    const a0 = rad(52);
    const a1 = rad(88);
    const x0 = ox + R * Math.cos(a0);
    const y0 = oy + R * Math.sin(a0);
    const x1 = ox + R * Math.cos(a1);
    const y1 = oy + R * Math.sin(a1);
    // sweep from the back (right) to the front (left)
    parts.push(`M${f(x0)} ${f(y0)} A${R} ${R} 0 0 1 ${f(x1)} ${f(y1)}`);
  }
  return parts.join(' ');
}

// ----------------------------------------------------------------- full

const full = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>Murshid</title>
  <defs>
    <linearGradient id="ground" x1="0.2" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${C.top}"/>
      <stop offset="1" stop-color="${C.bottom}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${HALO.cx / 512}" cy="${HALO.cy / 512}" r="0.42">
      <stop offset="0" stop-color="#ffcf7a" stop-opacity="0.32"/>
      <stop offset="0.7" stop-color="#ffcf7a" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gilt" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f3cf7e"/>
      <stop offset="0.55" stop-color="${C.gold}"/>
      <stop offset="1" stop-color="${C.goldDeep}"/>
    </linearGradient>
    <clipPath id="tile"><rect x="16" y="16" width="480" height="480" rx="114"/></clipPath>
    <clipPath id="turban"><circle cx="${TURBAN.cx}" cy="${TURBAN.cy}" r="${TURBAN.r}"/></clipPath>
  </defs>

  <g clip-path="url(#tile)">
    <rect x="16" y="16" width="480" height="480" fill="url(#ground)"/>
    <polygon points="${star(HALO.cx, HALO.cy, 236, 0.78, -90)}" fill="${C.star}" opacity="0.45"/>
    <polygon points="${star(HALO.cx, HALO.cy, 236, 0.78, -90)}" fill="none" stroke="${C.gold}" stroke-width="2" opacity="0.45"/>
    <circle cx="${HALO.cx}" cy="${HALO.cy}" r="250" fill="url(#glow)"/>
    <path d="${rays()}" stroke="${C.ink}" stroke-width="3" stroke-linecap="round" opacity="0.22"/>
    <circle cx="${HALO.cx}" cy="${HALO.cy}" r="${HALO.r}" fill="none" stroke="url(#gilt)" stroke-width="7"/>

    <path d="${ROBE}" fill="${C.robe}"/>
    <path d="M24 478 C76 454 136 446 198 448 M292 436 C364 438 432 452 492 484" fill="none" stroke="url(#gilt)" stroke-width="8" stroke-linecap="round"/>
    <path d="M96 474 l9 -7 l9 7 l-9 7 z M412 474 l9 -7 l9 7 l-9 7 z" fill="${C.gold}"/>

    <path d="${FACE}" fill="${C.ink}"/>
    <g fill="none" stroke="${C.cut}" stroke-linecap="round" stroke-linejoin="round">
      <path d="M176 330 C188 322 203 322 215 327" stroke-width="5.5"/>
      <path d="M181 344 C189 338 199 338 207 342" stroke-width="4.5"/>
      <path d="M171 392 C189 394 205 401 218 414" stroke-width="5"/>
      <path d="M196 432 C200 448 208 461 219 472 M218 428 C224 444 230 456 236 466 M242 424 C248 436 252 446 252 456" stroke-width="3.2" opacity="0.7"/>
      <path d="M300 352 C312 352 318 362 314 374 C311 382 304 386 298 384" stroke-width="3.6" opacity="0.8"/>
    </g>

    <path d="${CAP}" fill="url(#gilt)"/>
    <circle cx="${TURBAN.cx}" cy="${TURBAN.cy}" r="${TURBAN.r}" fill="${C.ink}"/>
    <path d="${wraps()}" fill="none" stroke="${C.cut}" stroke-width="8.5" stroke-linecap="round" clip-path="url(#turban)" opacity="0.62"/>
    <path d="M${TURBAN.cx - 70} ${TURBAN.cy - 74} A${TURBAN.r - 14} ${TURBAN.r - 14} 0 0 0 ${TURBAN.cx - 92} ${TURBAN.cy + 22}" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.5"/>
    <path d="${BAND}" fill="url(#gilt)"/>
    <circle cx="232" cy="296" r="5.5" fill="${C.cut}"/><circle cx="279" cy="300" r="6.5" fill="${C.cut}"/><circle cx="326" cy="294" r="5.5" fill="${C.cut}"/>
    <path d="${PLUME}" fill="url(#gilt)"/>
    <path d="M210 236 C200 206 198 170 204 138" fill="none" stroke="${C.goldDeep}" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="215" cy="252" r="16" fill="url(#gilt)"/>
    <circle cx="215" cy="252" r="7" fill="${C.cut}"/>
  </g>
  <rect x="16.5" y="16.5" width="479" height="479" rx="113.5" fill="none" stroke="#000" stroke-opacity="0.14"/>
</svg>
`;

// ----------------------------------------------------------------- mono

const mono = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>Murshid</title>
  <defs>
    <mask id="cut">
      <rect width="512" height="512" fill="#fff"/>
      <path d="${wraps()}" fill="none" stroke="#000" stroke-width="16" stroke-linecap="round"/>
      <path d="M170 290 C222 322 336 322 388 284" fill="none" stroke="#000" stroke-width="14" stroke-linecap="round"/>
      <path d="M171 392 C189 394 205 401 218 414" fill="none" stroke="#000" stroke-width="12" stroke-linecap="round"/>
    </mask>
  </defs>
  <g fill="#000" mask="url(#cut)">
    <path d="${CAP}"/>
    <circle cx="${TURBAN.cx}" cy="${TURBAN.cy}" r="${TURBAN.r}"/>
    <path d="${BAND}"/>
    <path d="${FACE}"/>
    <path d="M24 512 L24 478 C76 454 136 446 198 448 L225 490 L292 436 C364 438 432 452 492 484 L492 512 Z"/>
  </g>
</svg>
`;

writeFileSync(resolve(outDir, 'murshid.svg'), full);
writeFileSync(resolve(outDir, 'murshid-mono.svg'), mono);
console.log('wrote murshid.svg, murshid-mono.svg');
