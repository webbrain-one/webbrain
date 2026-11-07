// Compare the Companion's Go port of Compass VLD v6 2B with the extension's
// JavaScript on the same fixtures: prompts, tokens, image layouts, pixel
// values, image features, continuation logits and decision_hidden (SHA-256),
// margins, decisions and probabilities. Lossy screenshots (JPEG, WebP) are
// reported apart: Go's decoders do not reproduce Chrome's pixels exactly.
//
//   cd webbrain-systray && go run ./tools/d1check -engine compass -model <bundle dir> \
//     -ort <onnxruntime library> -cases <fixtures>/cases.json -trace -threads 8 -out go.json
//   node scripts/models/compass-vld/parity-compare.mjs go.json ref.json <fixtures>/case-images.json
import fs from 'node:fs';

const [goFile, refFile, imagesFile] = process.argv.slice(2);
const go = JSON.parse(fs.readFileSync(goFile, 'utf8'));
const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
const images = imagesFile ? JSON.parse(fs.readFileSync(imagesFile, 'utf8')) : go.map(() => []);

const totals = { cases: 0, prompt: 0, ids: 0, layouts: 0, pixels: 0, features: 0, continuations: 0, continuationIds: 0, logits: 0, hidden: 0, margins: 0, decisions: 0 };
const maxProb = { exact: 0, lossy: 0 };
const maxMargin = { exact: 0, lossy: 0 };
const probs = a => (a.type === 'noul' ? [a.noul] : [...Object.values(a.probabilities), ...(a.type === 'score' ? [a.score] : [])]);
const pick = a => (a.type === 'noul' ? a.noul > 0.5 : a.type === 'score' ? Math.round(a.score) : a.choice);
const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
const layout = t => (t.images || []).map(m => [m.width, m.height, m.grid_h, m.grid_w, m.tokens]);

go.forEach((g, i) => {
  const r = ref[i];
  if (!r) return;
  totals.cases++;
  if (!g.ok || !r.ok) { console.log(i, 'error', g.error, r.error); return; }
  const kind = (images[i] || []).some(f => !f.endsWith('.png')) ? 'lossy' : 'exact';
  const gt = g.trace, rt = r.trace;
  const checks = {
    prompt: gt.prefix === rt.prefix, ids: same(gt.prefix_ids, rt.prefix_ids), layouts: same(layout(gt), layout(rt)),
    pixels: same(gt.pixel_sha256, rt.pixel_sha256), features: same(gt.feature_sha256, rt.feature_sha256),
  };
  for (const [k, v] of Object.entries(checks)) totals[k] += v;
  gt.continuations.forEach((a, j) => {
    const b = rt.continuations[j];
    totals.continuations++;
    totals.continuationIds += a.text === b.text && same(a.ids, b.ids);
    totals.logits += a.logits_sha256 === b.logits_sha256;
    totals.hidden += a.hidden_sha256 === b.hidden_sha256;
    totals.margins += a.margin === b.margin;
    maxMargin[kind] = Math.max(maxMargin[kind], Math.abs(a.margin - b.margin));
  });
  const ga = g.result.answers, ra = r.result.answers;
  const agree = same(Object.keys(ga), Object.keys(ra)) && Object.keys(ga).every(k => pick(ga[k]) === pick(ra[k]));
  totals.decisions += agree;
  for (const k of Object.keys(ga)) probs(ga[k]).forEach((x, j) => { maxProb[kind] = Math.max(maxProb[kind], Math.abs(x - probs(ra[k])[j])); });
  console.log([i, (images[i] || []).join(',') || 'text', Object.values(checks).every(Boolean) ? 'identical' : 'differs', agree ? 'same decisions' : 'DIFFERENT DECISIONS', kind].join(' | '));
});
console.log(JSON.stringify(totals));
console.log('max |probability difference|', JSON.stringify(maxProb), 'max |margin difference|', JSON.stringify(maxMargin));
