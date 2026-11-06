// A whirling dervish (semazen) mid-turn: tall felt sikke, head tilted, right
// palm raised to receive, left palm lowered to give, the white tennure flaring.
// Engraved line style to match the portrait. Output: assets/art/semazen.svg
//
//   node scripts/art/semazen.mjs [--ink=#f4ead6] [--ground=#140f0d] [--gold=#d9ae55]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const INK = args.ink || '#f4ead6';
const GROUND = args.ground || '#140f0d';
const GOLD = args.gold || '#d9ae55';
const OUT = resolve(here, '..', '..', args.out || 'assets/art/semazen.svg');

const f = (n) => Number(n.toFixed(1));
const rad = (d) => (d * Math.PI) / 180;

// Hem of the skirt: a tilted ellipse, the skirt lifted by the turn.
const HEM = { cx: 300, cy: 668, rx: 262, ry: 64, tilt: -7 };
const hemPoint = (t) => {
  const a = rad(t);
  const x = HEM.rx * Math.cos(a);
  const y = HEM.ry * Math.sin(a);
  const c = Math.cos(rad(HEM.tilt));
  const s = Math.sin(rad(HEM.tilt));
  return [HEM.cx + x * c - y * s, HEM.cy + x * s + y * c];
};

function skirtOutline() {
  // waist → left flare → front hem → right flare → waist
  const front = [];
  for (let t = 180; t >= 0; t -= 6) front.push(hemPoint(t));
  const [lx, ly] = hemPoint(180);
  const [rx, ry] = hemPoint(0);
  const hem = front.map(([x, y]) => `L${f(x)} ${f(y)}`).join('');
  return `M268 392 C238 470 120 560 ${f(lx)} ${f(ly)} ${hem} C500 560 360 470 332 392 Z`;
}

function pleats() {
  const out = [];
  for (let i = 0; i <= 34; i += 1) {
    const t = 180 - (i * 180) / 34;
    const [x, y] = hemPoint(t);
    const wx = 270 + (i / 34) * 60;
    // pleats twist with the turn: an S-curve from waist to hem
    const mx = wx + (x - wx) * 0.5 + 18 * Math.sin((i / 34) * Math.PI);
    const my = 392 + (y - 392) * 0.5;
    out.push(`<path d="M${f(wx)} 394 Q${f(mx - 14)} ${f(my - 40)} ${f(mx)} ${f(my)} T${f(x)} ${f(y)}" stroke="${INK}" stroke-width="${i % 3 === 0 ? 1.6 : 0.9}" opacity="${i % 3 === 0 ? 0.9 : 0.6}"/>`);
  }
  return out.join('');
}

function hemFolds() {
  // the hem's back edge, seen through the lifted skirt
  const back = [];
  for (let t = 180; t <= 360; t += 6) back.push(hemPoint(t));
  const d = back.map(([x, y], k) => `${k ? 'L' : 'M'}${f(x)} ${f(y)}`).join('');
  return `<path d="${d}" stroke="${INK}" stroke-width="1.2" opacity="0.55"/>`;
}

function motion() {
  const out = [];
  for (let k = 0; k < 4; k += 1) {
    const rx = HEM.rx + 30 + k * 26;
    const ry = HEM.ry + 14 + k * 8;
    out.push(`<ellipse cx="${HEM.cx}" cy="${HEM.cy + 4}" rx="${rx}" ry="${ry}" transform="rotate(${HEM.tilt} ${HEM.cx} ${HEM.cy})" stroke="${GOLD}" stroke-width="${k === 0 ? 1.6 : 1}" stroke-dasharray="${k === 0 ? '0' : `${2 + k} ${8 + k * 3}`}" opacity="${0.8 - k * 0.15}"/>`);
  }
  // streaks of the turn
  for (let i = 0; i < 9; i += 1) {
    const t0 = 200 + i * 16;
    const pts = [];
    for (let t = t0; t <= t0 + 26; t += 4) {
      const a = rad(t);
      const r = 1.18 + (i % 3) * 0.05;
      pts.push([HEM.cx + HEM.rx * r * Math.cos(a), HEM.cy - 150 + HEM.ry * 2.4 * r * Math.sin(a)]);
    }
    out.push(`<path d="${pts.map(([x, y], k) => `${k ? 'L' : 'M'}${f(x)} ${f(y)}`).join('')}" stroke="${INK}" stroke-width="1" opacity="0.35"/>`);
  }
  return out.join('');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <title>Semazen — the turn</title>
  ${args.bg === '1' ? `<rect width="600" height="800" fill="${GROUND}"/>` : ''}
  <g id="turn">${motion()}</g>

  <g id="skirt">
    <path d="${skirtOutline()}" fill="${GROUND}" stroke="${INK}" stroke-width="2.2"/>
    ${hemFolds()}
    ${pleats()}
    <path d="M268 392 C290 400 312 400 332 392" stroke="${GOLD}" stroke-width="2"/>
  </g>

  <g id="body">
    <!-- destegül: the short white jacket -->
    <path d="M244 282 C258 272 280 268 300 268 C322 268 344 274 356 284 C352 320 344 360 334 394 C312 400 288 400 266 394 C256 360 248 322 244 282 Z" fill="${GROUND}" stroke="${INK}" stroke-width="2"/>
    <path d="M300 272 L300 396 M276 300 C284 340 288 370 290 396 M326 300 C318 340 314 370 312 396" stroke="${INK}" stroke-width="0.9" opacity="0.6"/>
    <!-- raised right arm, palm up to the sky -->
    <path d="M248 288 C222 262 200 232 186 196 C178 176 172 156 170 138 C180 140 188 148 192 160 C200 186 214 214 236 240 C246 252 256 262 262 272 Z" fill="${GROUND}" stroke="${INK}" stroke-width="1.8"/>
    <path d="M170 138 C160 130 150 128 140 130 C146 122 160 120 172 124 C178 118 186 118 190 124 C188 130 184 134 178 136" fill="${GROUND}" stroke="${INK}" stroke-width="1.6"/>
    <path d="M226 252 C214 236 204 218 196 198 M236 244 C222 226 212 206 204 186" stroke="${INK}" stroke-width="0.8" opacity="0.6"/>
    <!-- lowered left arm, palm to the earth -->
    <path d="M352 290 C380 304 410 320 436 340 C452 352 466 364 476 376 C466 380 456 378 448 370 C428 352 404 336 376 322 C364 316 354 310 346 304 Z" fill="${GROUND}" stroke="${INK}" stroke-width="1.8"/>
    <path d="M476 376 C488 384 494 394 496 404 C488 400 480 396 472 390 C468 396 462 398 456 396 C458 388 462 382 468 378" fill="${GROUND}" stroke="${INK}" stroke-width="1.6"/>
    <path d="M380 312 C404 324 426 338 444 354 M372 318 C396 330 418 346 436 362" stroke="${INK}" stroke-width="0.8" opacity="0.6"/>
    <!-- head, tilted toward the raised hand -->
    <ellipse cx="290" cy="232" rx="27" ry="32" transform="rotate(-16 290 232)" fill="${GROUND}" stroke="${INK}" stroke-width="2"/>
    <path d="M278 236 C282 240 288 240 292 236 M300 232 C304 236 308 236 312 232" stroke="${INK}" stroke-width="1.2" opacity="0.8"/>
    <path d="M286 252 C290 254 294 254 298 252" stroke="${INK}" stroke-width="1" opacity="0.7"/>
    <!-- sikke: the tall felt hat -->
    <path d="M262 212 C254 168 252 120 262 78 C268 56 284 46 298 50 C314 54 322 70 322 92 C324 132 318 172 314 212 C298 220 278 220 262 212 Z" transform="rotate(-16 290 140)" fill="${GROUND}" stroke="${INK}" stroke-width="2"/>
    <path d="M268 200 C266 160 266 120 272 84 M284 206 C282 164 284 122 288 78 M300 206 C300 166 304 124 306 84" transform="rotate(-16 290 140)" stroke="${INK}" stroke-width="0.8" opacity="0.5"/>
    <path d="M264 204 C282 212 300 212 316 204" transform="rotate(-16 290 140)" stroke="${GOLD}" stroke-width="1.6"/>
  </g>

  <g id="feet" stroke="${INK}" stroke-width="1.6">
    <path d="M284 706 C282 716 290 720 300 718" />
    <path d="M318 702 C322 712 316 718 306 718" />
  </g>
</svg>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}`);
