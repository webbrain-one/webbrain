// Generates the Murshid portrait: an Ottoman sage in profile under a great
// turban, drawn like an engraving (ink lines, hatching, a sunburst of light).
// Original artwork for Murshid. Output: assets/art/murshid-portrait.svg
//
//   node scripts/art/portrait.mjs [--ink=#f4ead6] [--ground=#9e1b2b] [--gold=#d9ae55] [--out=path]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const INK = args.ink || '#f4ead6';
const GROUND = args.ground || '#9e1b2b';
const GOLD = args.gold || '#d9ae55';
const SHADE = args.shade || '#6e0f1d';
const OUT = resolve(here, '..', '..', args.out || 'assets/art/murshid-portrait.svg');
const BG = args.bg === '1';

const W = 800;
const H = 1000;
const f = (n) => Number(n.toFixed(1));
const rad = (d) => (d * Math.PI) / 180;

// --------------------------------------------------------------- the halo

function sunburst(cx, cy) {
  const parts = [];
  // rays: long and short, alternating, like hammered gold behind an icon
  for (let a = 0; a < 360; a += 2.25) {
    const long = Math.round(a / 2.25) % 4 === 0;
    const mid = Math.round(a / 2.25) % 2 === 0;
    const r1 = 352;
    const r2 = long ? 498 : mid ? 452 : 418;
    const x1 = cx + r1 * Math.cos(rad(a));
    const y1 = cy + r1 * Math.sin(rad(a));
    const x2 = cx + r2 * Math.cos(rad(a));
    const y2 = cy + r2 * Math.sin(rad(a));
    parts.push(`M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`);
  }
  return `<path d="${parts.join('')}" stroke="${INK}" stroke-width="1.3" stroke-linecap="round" opacity="0.55"/>`;
}

function starPolygon(cx, cy, r, points, inner, rotate = 0) {
  const pts = [];
  for (let i = 0; i < points * 2; i += 1) {
    const rr = i % 2 === 0 ? r : r * inner;
    const a = rad(rotate + (i * 180) / points);
    pts.push(`${f(cx + rr * Math.cos(a))},${f(cy + rr * Math.sin(a))}`);
  }
  return pts.join(' ');
}

function rosette(cx, cy) {
  const out = [];
  out.push(`<circle cx="${cx}" cy="${cy}" r="346" stroke="${GOLD}" stroke-width="2.2"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="336" stroke="${INK}" stroke-width="0.9" opacity="0.7"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="300" stroke="${INK}" stroke-width="0.8" stroke-dasharray="1.5 6" opacity="0.8"/>`);
  // the Seljuk eight-pointed star, twice
  out.push(`<polygon points="${starPolygon(cx, cy, 330, 8, 0.76, -90)}" stroke="${INK}" stroke-width="1.1" opacity="0.65"/>`);
  out.push(`<polygon points="${starPolygon(cx, cy, 330, 8, 0.76, -67.5)}" stroke="${INK}" stroke-width="0.8" opacity="0.4"/>`);
  // small lattice of petals between the two rings
  for (let i = 0; i < 48; i += 1) {
    const a = rad(i * 7.5);
    const x = cx + 318 * Math.cos(a);
    const y = cy + 318 * Math.sin(a);
    out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${i % 2 ? 1.6 : 3}" fill="${i % 2 ? INK : GOLD}" stroke="none" opacity="${i % 2 ? 0.6 : 0.9}"/>`);
  }
  return out.join('');
}

// -------------------------------------------------------------- the turban

// The turban is a great swollen globe with a crimson cap peeking from the top.
const TURBAN = 'M232 430 C196 360 196 250 248 176 C300 100 382 70 456 76 C544 82 618 136 646 222 C672 302 652 380 610 432 C560 452 520 446 470 452 C400 460 300 466 232 430 Z';
const TURBAN_BAND = 'M246 418 C320 452 420 446 498 440 C548 436 590 432 612 424 C620 448 612 470 596 482 C540 494 470 492 410 494 C350 496 296 488 262 470 C248 458 242 438 246 418 Z';
const CAP = 'M408 92 C410 52 432 30 452 30 C474 30 494 50 496 88 C470 80 436 82 408 92 Z';

function turbanFolds() {
  // Wraps of cloth sweeping diagonally round the globe. Each wrap is a band
  // between two edges; every other band is shaded with hatching.
  const out = [];
  const bands = 11;
  const edge = (k, lift) => {
    const t = k / bands; // 0 at the crown, 1 at the brim
    const yL = 150 + t * 300 + lift; // where the edge meets the left rim
    const yR = 22 + t * 352 + lift; // the right rim: the wrap climbs as it goes round
    const sag = 74 - Math.abs(t - 0.45) * 74; // fuller across the middle of the globe
    return [[186, yL], [292, yL + sag * 0.9], [500, yR + sag + 46], [684, yR - 4]];
  };
  const d = ([a, b, c, e]) => `M${f(a[0])} ${f(a[1])} C${f(b[0])} ${f(b[1])} ${f(c[0])} ${f(c[1])} ${f(e[0])} ${f(e[1])}`;
  for (let k = 0; k < bands; k += 1) {
    if (k % 2 === 1) {
      const top = edge(k, 7);
      const bot = edge(k + 1, 0);
      const fill = `${d(top)} L${f(bot[3][0])} ${f(bot[3][1])} C${f(bot[2][0])} ${f(bot[2][1])} ${f(bot[1][0])} ${f(bot[1][1])} ${f(bot[0][0])} ${f(bot[0][1])} Z`;
      out.push(`<path d="${fill}" fill="url(#hatch-b)" stroke="none" opacity="0.5"/>`);
    }
  }
  for (let k = 0; k <= bands; k += 1) {
    out.push(`<path d="${d(edge(k, 0))}" stroke="${INK}" stroke-width="2.2" opacity="0.95"/>`);
    out.push(`<path d="${d(edge(k, 7))}" stroke="${INK}" stroke-width="0.9" opacity="0.7"/>`);
  }
  // the crown: short folds gathered under the cap
  for (let i = 0; i < 9; i += 1) {
    const a = rad(198 + i * 18);
    out.push(`<path d="M452 90 Q${f(452 + 80 * Math.cos(a))} ${f(120 + 26 * Math.sin(a))} ${f(452 + 160 * Math.cos(a))} ${f(176 + 60 * Math.sin(a))}" stroke="${INK}" stroke-width="1" opacity="0.55"/>`);
  }
  return out.join('');
}

// ---------------------------------------------------------- face and beard

const FACE = [
  'M262 470', // forehead under the band
  'C258 482 254 494 252 506', // brow
  'C251 512 256 518 258 524', // brow ridge to bridge
  'C252 546 238 566 226 586', // nose bridge, aquiline
  'C222 594 224 600 232 602', // nose tip
  'C240 604 248 604 254 610', // nostril underside
  'C252 616 250 620 252 626', // philtrum
  'L244 634', // upper lip
  'C250 640 254 642 258 644', // mouth
  'L250 652', // lower lip
  'C252 660 256 664 262 668', // under lip into beard
].join(' ');

const BEARD = 'M262 668 C252 690 248 716 256 742 C264 770 282 798 306 820 C318 832 330 846 336 862 C344 840 360 822 384 806 C420 782 444 752 452 712 C458 680 456 650 448 624 C430 640 404 650 376 652 C340 654 300 650 270 640 Z';
const MUSTACHE = 'M252 612 C266 616 286 620 304 632 C318 642 330 656 336 670 C318 664 300 656 284 648 C270 642 258 636 252 628 Z';
const HEAD_BACK = 'M598 482 C604 520 600 560 586 594 C572 628 548 650 520 668 C500 680 470 690 452 696 C456 660 456 640 448 620 C468 600 480 570 486 540 C490 516 488 498 484 492 C520 492 562 492 598 482 Z';
const NECK = 'M452 700 C480 692 512 680 536 664 C546 700 560 730 578 752 C540 770 480 780 420 784 C430 760 444 730 452 700 Z';

const EAR = 'M486 528 C500 520 516 528 516 546 C516 566 502 582 488 584 C482 584 478 578 480 572 C486 566 494 560 494 548 C494 540 490 534 486 528 Z';

function beardStrands() {
  const out = [];
  // flowing strands from the jaw and chin down to the point of the beard
  for (let i = 0; i < 26; i += 1) {
    const t = i / 25;
    const sx = 268 + t * 176; // along the jaw
    const sy = 650 + Math.sin(t * Math.PI) * 6 - t * 24;
    const ex = 310 + t * 52 - Math.sin(t * Math.PI) * 6;
    const ey = 808 + Math.sin(t * Math.PI) * 44 - t * 12;
    const c1x = sx - 18 + t * 10;
    const c1y = sy + 70;
    const c2x = ex - 10 + t * 30;
    const c2y = ey - 60;
    const w = i % 4 === 0 ? 1.8 : 1.05;
    out.push(`<path d="M${f(sx)} ${f(sy)} C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(ex)} ${f(ey)}" stroke="${INK}" stroke-width="${w}" opacity="${i % 4 === 0 ? 0.95 : 0.7}"/>`);
  }
  // curls at the tip
  out.push(`<path d="M318 826 C326 840 334 848 336 862 M350 836 C352 846 346 856 338 864 M300 812 C306 826 318 836 330 846" stroke="${INK}" stroke-width="1.4"/>`);
  return out.join('');
}

function moustacheStrands() {
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    const o = i * 3;
    out.push(`<path d="M${256 + o} ${614 + o * 0.4} C${276 + o} ${620 + o * 0.6} ${304 + o * 0.4} ${636 + o * 0.6} ${330 - o * 0.6} ${666 - o}" stroke="${INK}" stroke-width="${i % 3 ? 0.9 : 1.5}" opacity="0.85"/>`);
  }
  return out.join('');
}

// ----------------------------------------------------------------- the robe

// One solid shape behind the figure so the halo never shows through gaps.
const SILHOUETTE = 'M262 472 L258 524 L238 588 L252 626 L262 668 L256 742 L306 820 L336 860 L300 842 L214 840 L120 960 L96 1000 L800 1000 L790 920 L742 828 L624 770 L578 752 L548 704 L586 594 L600 520 L600 470 Z';

const ROBE = 'M96 1000 C112 930 150 872 214 836 C262 810 318 800 380 794 C470 786 560 776 624 768 C694 760 742 804 770 868 C790 914 800 960 800 1000 Z';
const FUR = 'M196 846 C260 812 330 800 400 798 C480 796 560 784 626 772 C682 762 722 790 742 830 C700 818 660 820 620 832 C540 856 450 866 360 872 C300 876 250 872 196 846 Z';
const ROBE_OPENING = 'M300 1000 C318 952 340 910 370 874 C396 910 410 954 414 1000 Z';

function cintamani() {
  // three pearls over twin wave-lines: the Ottoman çintamani, scattered on the caftan
  const out = [];
  const cells = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const x = 150 + col * 96 + (row % 2) * 48;
      const y = 906 + row * 46;
      cells.push([x, y]);
    }
  }
  for (const [x, y] of cells) {
    out.push(`<circle cx="${x}" cy="${y - 9}" r="5.5"/><circle cx="${x - 9}" cy="${y + 6}" r="5.5"/><circle cx="${x + 9}" cy="${y + 6}" r="5.5"/>`);
    out.push(`<path d="M${x + 18} ${y + 10} q8 -6 16 0 t16 0 M${x + 18} ${y + 18} q8 -6 16 0 t16 0" fill="none"/>`);
  }
  return `<g stroke="${GOLD}" stroke-width="1.3" fill="none" opacity="0.9">${out.join('')}</g>`;
}

function furTufts() {
  const out = [];
  for (let i = 0; i < 60; i += 1) {
    const t = i / 59;
    const x = 204 + t * 532;
    const yTop = 846 - Math.sin(t * Math.PI) * 44 - t * 34;
    const len = 14 + (i % 3) * 7;
    out.push(`M${f(x)} ${f(yTop + 6)} q${f(4 - (i % 2) * 8)} ${f(len / 2)} ${f(-2 + (i % 3))} ${len}`);
  }
  return `<path d="${out.join('')}" stroke="${INK}" stroke-width="1.1" opacity="0.8"/>`;
}

// --------------------------------------------------------------- jewellery

function aigrette() {
  // sorguç: a jewelled clasp at the front of the turban with a plume
  const out = [];
  out.push(`<path d="M300 236 C282 200 278 150 296 104 C300 140 310 170 318 196 C322 164 332 136 352 116 C342 156 340 196 330 236 Z" fill="${GROUND}" stroke="${GOLD}" stroke-width="2"/>`);
  for (let i = 0; i < 9; i += 1) {
    out.push(`<path d="M${312 + i * 0.6} ${230 - i * 2} C${300 + i * 0.4} ${200 - i * 8} ${298} ${150 - i * 3} ${296 + i * 0.6} ${108 + i * 6}" stroke="${GOLD}" stroke-width="0.8" opacity="0.8"/>`);
  }
  out.push(`<ellipse cx="316" cy="250" rx="20" ry="24" fill="${GROUND}" stroke="${GOLD}" stroke-width="2.4"/>`);
  out.push(`<ellipse cx="316" cy="250" rx="10" ry="13" fill="${GOLD}"/>`);
  out.push(`<circle cx="312" cy="245" r="3" fill="${INK}"/>`);
  for (let i = 0; i < 10; i += 1) {
    const a = rad(i * 36);
    out.push(`<circle cx="${f(316 + 27 * Math.cos(a))}" cy="${f(250 + 31 * Math.sin(a))}" r="2.6" fill="${GOLD}"/>`);
  }
  out.push(`<path d="M316 280 C314 292 318 302 316 314" stroke="${GOLD}" stroke-width="2"/><circle cx="316" cy="320" r="6" fill="${GOLD}"/>`);
  return out.join('');
}

// -------------------------------------------------------------- assemble

function hatchPattern(id, angle, gap, width, color = INK, opacity = 1) {
  return `<pattern id="${id}" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><line x1="0" y1="0" x2="0" y2="${gap}" stroke="${color}" stroke-width="${width}" opacity="${opacity}"/></pattern>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <title>Murshid — the guide</title>
  ${BG ? `<rect width="${W}" height="${H}" fill="${GROUND}"/>` : ''}
  <defs>
    ${hatchPattern('hatch-a', 35, 5, 1.1)}
    ${hatchPattern('hatch-b', -40, 4.2, 0.9)}
    ${hatchPattern('hatch-c', 80, 6, 1)}
    ${hatchPattern('hatch-gold', 45, 5, 1, GOLD)}
    <clipPath id="clip-turban"><path d="${TURBAN}"/></clipPath>
    <clipPath id="clip-robe"><path d="${ROBE}"/></clipPath>
    <clipPath id="clip-beard"><path d="${BEARD}"/></clipPath>
    <radialGradient id="glow" cx="0.54" cy="0.38" r="0.5">
      <stop offset="0" stop-color="${INK}" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="${INK}" stop-opacity="0.06"/>
      <stop offset="1" stop-color="${INK}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <g id="halo">
    <circle cx="430" cy="400" r="520" fill="url(#glow)" stroke="none"/>
    ${sunburst(430, 400)}
    ${rosette(430, 400)}
  </g>

  <path d="${SILHOUETTE}" fill="${GROUND}" stroke="none"/>

  <g id="robe">
    <path d="${ROBE}" fill="${GROUND}" stroke="${INK}" stroke-width="2.4"/>
    <g clip-path="url(#clip-robe)">
      ${cintamani()}
      <path d="M560 790 C640 800 720 860 790 1000 L800 1000 L800 780 Z" fill="url(#hatch-b)" stroke="none" opacity="0.8"/>
    </g>
    <path d="${ROBE_OPENING}" fill="${SHADE}" stroke="${INK}" stroke-width="1.8"/>
    <path d="M370 874 C352 912 334 956 322 1000 M370 874 C388 914 400 956 404 1000" stroke="${GOLD}" stroke-width="1.6" stroke-dasharray="2 7"/>
  </g>

  <g id="neck">
    <path d="${NECK}" fill="${GROUND}" stroke="${INK}" stroke-width="2"/>
    <path d="${NECK}" fill="url(#hatch-a)" stroke="none" opacity="0.7"/>
  </g>

  <g id="fur">
    <path d="${FUR}" fill="${SHADE}" stroke="${INK}" stroke-width="2"/>
    ${furTufts()}
  </g>

  <g id="head">
    <path d="${HEAD_BACK}" fill="${GROUND}" stroke="${INK}" stroke-width="2.2"/>
    <path d="M520 500 C540 560 530 620 486 660 L452 696 C470 660 470 600 486 560 Z" fill="url(#hatch-c)" stroke="none" opacity="0.7"/>
    <path d="${FACE} L448 624 L486 492 L262 470 Z" fill="${GROUND}" stroke="none"/>
    <path d="${FACE}" stroke="${INK}" stroke-width="2.6"/>
    <path d="M300 560 C320 600 360 620 410 624 C440 626 460 600 470 560 C430 586 360 590 300 560 Z" fill="url(#hatch-a)" stroke="none" opacity="0.65"/>
    <path d="M262 470 C300 486 330 492 360 494" stroke="${INK}" stroke-width="1" opacity="0.6"/>
    <!-- the eye, lowered in contemplation -->
    <path d="M276 528 C286 520 300 520 312 526 C302 536 288 538 276 528 Z" fill="${SHADE}" stroke="${INK}" stroke-width="1.8"/>
    <path d="M274 527 C288 532 302 532 314 525" stroke="${INK}" stroke-width="2.4"/>
    <path d="M270 512 C284 500 304 498 326 506" stroke="${INK}" stroke-width="3"/>
    <path d="M300 540 C304 552 314 560 326 562" stroke="${INK}" stroke-width="1" opacity="0.7"/>
    <path d="M232 602 C240 594 250 592 256 598" stroke="${INK}" stroke-width="1.4"/>
    <path d="M246 596 C250 590 256 590 258 596" stroke="${INK}" stroke-width="1.6"/>
    <path d="M330 540 C360 560 400 566 440 560 C420 590 380 600 340 590 C330 574 328 556 330 540 Z" fill="url(#hatch-b)" stroke="none" opacity="0.45"/>
    <path d="M262 470 C264 488 266 500 270 508" stroke="${INK}" stroke-width="1" opacity="0.5"/>
    ${'' /* ear */}
    <path d="${EAR}" fill="${GROUND}" stroke="${INK}" stroke-width="1.8"/>
    <path d="M492 540 C500 546 500 560 492 568" stroke="${INK}" stroke-width="1.2"/>
  </g>

  <g id="beard">
    <path d="${BEARD}" fill="${GROUND}" stroke="${INK}" stroke-width="2.4"/>
    <g clip-path="url(#clip-beard)">
      ${beardStrands()}
      <path d="M380 660 C420 700 430 760 380 810 L460 820 L470 640 Z" fill="url(#hatch-b)" stroke="none" opacity="0.7"/>
    </g>
    <path d="${MUSTACHE}" fill="${GROUND}" stroke="${INK}" stroke-width="2"/>
    ${moustacheStrands()}
  </g>

  <g id="turban">
    <path d="${CAP}" fill="${SHADE}" stroke="${GOLD}" stroke-width="2.4"/>
    <path d="M430 84 C432 60 442 44 452 40 M452 82 C454 58 460 46 466 42 M474 84 C476 66 478 54 482 48" stroke="${GOLD}" stroke-width="1.2" opacity="0.9"/>
    <path d="${TURBAN}" fill="${GROUND}" stroke="${INK}" stroke-width="3"/>
    <g clip-path="url(#clip-turban)">
      ${turbanFolds()}
      <path d="M520 100 C640 160 680 300 620 440 L700 460 L700 80 Z" fill="url(#hatch-a)" stroke="none" opacity="0.75"/>
      <path d="M200 380 C260 440 420 460 620 420 L620 470 L200 470 Z" fill="url(#hatch-c)" stroke="none" opacity="0.5"/>
    </g>
    <path d="${TURBAN_BAND}" fill="${GROUND}" stroke="${INK}" stroke-width="2.4"/>
    <path d="M256 440 C330 470 470 470 604 446 M262 458 C340 484 470 482 598 466" stroke="${INK}" stroke-width="1.2" opacity="0.8"/>
    <path d="M300 470 C330 480 360 482 400 482" stroke="${GOLD}" stroke-width="1.2" stroke-dasharray="1 5"/>
    ${aigrette()}
  </g>
</svg>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${svg.length} bytes)`);
