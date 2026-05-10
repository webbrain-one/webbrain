/**
 * WebBrain test runner — pure Node, no framework, no chrome.* APIs.
 *
 *   node test/run.js
 *
 * Tests are colocated with the runner. Each test is just an async function
 * that throws on failure. Output is one line per test, then a summary.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ────────────────────────────────────────────────────────────────────────
// Module loading
// ────────────────────────────────────────────────────────────────────────

// adapters.js is pure ESM with no chrome.* deps — import directly.
const { getActiveAdapter, listAdapters } = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/agent/adapters.js').replace(/\\/g, '/')
);

// network-tools.js references chrome.* inside a try/catch at module load, so
// it imports cleanly under Node — the storage init silently no-ops and
// validateFetchUrl / registrableDomain are pure functions.
const { validateFetchUrl, registrableDomain } = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/network/network-tools.js').replace(/\\/g, '/')
);
const { validateFetchUrl: validateFetchUrlFx, registrableDomain: registrableDomainFx } = await import(
  'file://' + path.join(ROOT, 'src/firefox/src/network/network-tools.js').replace(/\\/g, '/')
);

// markdown-link.js is pure JS with no DOM / chrome.* deps.
const { sanitizeLink, sanitizeMarkdownLinks } = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/ui/markdown-link.js').replace(/\\/g, '/')
);
const { sanitizeMarkdownLinks: sanitizeMarkdownLinksFx } = await import(
  'file://' + path.join(ROOT, 'src/firefox/src/ui/markdown-link.js').replace(/\\/g, '/')
);

// agent.js imports tools.js and cdp-client.js (which uses chrome.*). We need
// only the loop-detection helpers, so we extract them via a tiny standalone
// shim that mirrors the relevant Agent methods. Keep this in sync with
// agent.js _recordCall / _detectLoop / _checkLoop.
class LoopDetectorShim {
  constructor() {
    this.recentCalls = new Map();
    this.loopNudges = new Map();
    this.healthyCallsSinceLoop = new Map();
    this.recentCoordClicks = new Map();
  }
  _checkCoordClickLoop(tabId, x, y) {
    const bx = Math.round(x / 5) * 5;
    const by = Math.round(y / 5) * 5;
    const key = `${bx},${by}`;
    const buf = this.recentCoordClicks.get(tabId) || [];
    buf.push({ key, ts: Date.now() });
    if (buf.length > 12) buf.shift();
    this.recentCoordClicks.set(tabId, buf);
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    const n = counts.get(key) || 0;
    if (n >= 8) return { kind: 'stop', x: bx, y: by };
    if (n >= 5) return { kind: 'nudge', x: bx, y: by };
    return { kind: 'none' };
  }
  _recordCall(tabId, name, args, result) {
    const argsHash = JSON.stringify(args || {});
    const errored = !!(result && (result.error || result.success === false));
    const key = `${name}|${argsHash}|${errored ? 'err' : 'ok'}`;
    const buf = this.recentCalls.get(tabId) || [];
    buf.push({ key, name, ts: Date.now() });
    if (buf.length > 6) buf.shift();
    this.recentCalls.set(tabId, buf);
    return buf;
  }
  _detectLoop(buf) {
    if (!buf || buf.length < 3) return null;
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3) return { type: 'repeat', key, name: key.split('|')[0], count: n };
    }
    if (buf.length >= 4) {
      const last4 = buf.slice(-4);
      if (
        last4[0].key === last4[2].key &&
        last4[1].key === last4[3].key &&
        last4[0].key !== last4[1].key
      ) {
        return { type: 'oscillation', a: last4[0].name, b: last4[1].name };
      }
    }
    return null;
  }
  _checkLoop(tabId, name, args, result) {
    const buf = this._recordCall(tabId, name, args, result);
    const loop = this._detectLoop(buf);
    if (!loop) {
      const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
      this.healthyCallsSinceLoop.set(tabId, healthy);
      if (healthy >= 2) {
        this.loopNudges.delete(tabId);
        this.healthyCallsSinceLoop.delete(tabId);
      }
      return { kind: 'none' };
    }
    this.healthyCallsSinceLoop.delete(tabId);
    const nudges = (this.loopNudges.get(tabId) || 0) + 1;
    this.loopNudges.set(tabId, nudges);
    if (nudges >= 8) {
      return { kind: 'stop' };
    }
    return { kind: 'nudge' };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Test framework (one function, no deps)
// ────────────────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${e.message}`);
      if (e.expected !== undefined || e.actual !== undefined) {
        console.log(`      expected: ${JSON.stringify(e.expected)}`);
        console.log(`      actual:   ${JSON.stringify(e.actual)}`);
      }
      failed++;
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed (${tests.length} total)`);
  if (failed > 0) process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────
// Adapter matching tests
// ────────────────────────────────────────────────────────────────────────

console.log('\nadapters');

test('matches github.com', () => {
  const a = getActiveAdapter('https://github.com/esokullu/webbrain');
  assert.equal(a?.name, 'github');
});

test('matches www.github.com', () => {
  const a = getActiveAdapter('https://www.github.com/');
  assert.equal(a?.name, 'github');
});

test('matches gmail.com under mail.google.com', () => {
  const a = getActiveAdapter('https://mail.google.com/mail/u/0/#inbox');
  assert.equal(a?.name, 'gmail');
});

test('matches twitter.com and x.com', () => {
  assert.equal(getActiveAdapter('https://twitter.com/elonmusk')?.name, 'twitter');
  assert.equal(getActiveAdapter('https://x.com/elonmusk')?.name, 'twitter');
});

test('matches stripe dashboard', () => {
  const a = getActiveAdapter('https://dashboard.stripe.com/payments');
  assert.equal(a?.name, 'stripe');
  assert.equal(a?.category, 'finance');
});

test('matches generic finance — coinbase', () => {
  const a = getActiveAdapter('https://www.coinbase.com/dashboard');
  assert.equal(a?.category, 'finance');
});

test('matches generic finance — chase', () => {
  const a = getActiveAdapter('https://secure01a.chase.com/web/auth/dashboard');
  assert.equal(a?.category, 'finance');
});

test('matches generic finance — robinhood', () => {
  const a = getActiveAdapter('https://robinhood.com/account/positions');
  assert.equal(a?.category, 'finance');
});

test('returns null for unknown sites', () => {
  assert.equal(getActiveAdapter('https://example.com/'), null);
  assert.equal(getActiveAdapter('https://random-site-xyz123.io/'), null);
});

test('handles missing url gracefully', () => {
  assert.equal(getActiveAdapter(''), null);
  assert.equal(getActiveAdapter(null), null);
  assert.equal(getActiveAdapter(undefined), null);
});

test('every adapter has the required fields', () => {
  for (const a of listAdapters()) {
    assert.ok(a.name, 'name missing');
    assert.ok(a.category === 'general' || a.category === 'finance', `bad category: ${a.category}`);
  }
});

test('finance adapters take precedence in order — stripe before generic', () => {
  // Stripe URL should match stripe, not the generic finance pattern.
  const a = getActiveAdapter('https://dashboard.stripe.com/');
  assert.equal(a?.name, 'stripe');
});

test('GitHub Enterprise does not match github adapter (strict)', () => {
  // The current matcher is `(www\.)?github\.com` so GHES won't match — that's
  // intentional and this test pins the behavior so a future loosening doesn't
  // accidentally apply github.com selectors to GHES.
  const a = getActiveAdapter('https://github.example-corp.com/foo/bar');
  assert.equal(a, null);
});

// ────────────────────────────────────────────────────────────────────────
// Loop detection tests
// ────────────────────────────────────────────────────────────────────────

console.log('\nloop detection');

test('no loop for distinct calls', () => {
  const d = new LoopDetectorShim();
  const tab = 1;
  assert.equal(d._checkLoop(tab, 'read_page', {}, { ok: true }).kind, 'none');
  assert.equal(d._checkLoop(tab, 'click', { selector: '#a' }, { success: true }).kind, 'none');
  assert.equal(d._checkLoop(tab, 'type_text', { text: 'hello' }, { success: true }).kind, 'none');
});

test('three identical calls trigger nudge', () => {
  const d = new LoopDetectorShim();
  const tab = 2;
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  const result = d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(result.kind, 'nudge');
});

test('three identical errored calls also trigger nudge', () => {
  const d = new LoopDetectorShim();
  const tab = 3;
  d._checkLoop(tab, 'click', { selector: '#missing' }, { success: false });
  d._checkLoop(tab, 'click', { selector: '#missing' }, { success: false });
  const result = d._checkLoop(tab, 'click', { selector: '#missing' }, { success: false });
  assert.equal(result.kind, 'nudge');
});

test('errored vs successful do not collapse together', () => {
  // Two successes + one failure of the same call should NOT trigger.
  const d = new LoopDetectorShim();
  const tab = 4;
  d._checkLoop(tab, 'click', { selector: '#x' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#x' }, { success: true });
  const result = d._checkLoop(tab, 'click', { selector: '#x' }, { success: false });
  assert.equal(result.kind, 'none');
});

test('ABAB oscillation triggers nudge', () => {
  const d = new LoopDetectorShim();
  const tab = 5;
  d._checkLoop(tab, 'click', { selector: '#next' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#prev' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#next' }, { success: true });
  const result = d._checkLoop(tab, 'click', { selector: '#prev' }, { success: true });
  assert.equal(result.kind, 'nudge');
});

test('eighth consecutive loop triggers stop', () => {
  const d = new LoopDetectorShim();
  const tab = 6;
  // First nudge (calls 1-3)
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true }).kind, 'nudge');
  // Nudges 2-7 are still nudges (6 more calls)
  for (let i = 0; i < 6; i++) {
    assert.equal(d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true }).kind, 'nudge');
  }
  // Eighth nudge → stop.
  const result = d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(result.kind, 'stop');
});

test('nudge counter persists across one healthy call (slow loop)', () => {
  const d = new LoopDetectorShim();
  const tab = 7;
  // Get to nudge state
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true }).kind, 'nudge');
  // One healthy interleaved call — must NOT reset nudge state (need 3 to reset).
  d._checkLoop(tab, 'read_page', {}, { ok: true });
  // Resume the loop. The window still has enough #submit entries to detect.
  // loopNudges is still 1 (one healthy call doesn't reset), so this is nudge #2.
  const result = d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(result.kind, 'nudge', `expected nudge, got ${result.kind}`);
});

test('nudge counter resets after a sustained healthy streak', () => {
  const d = new LoopDetectorShim();
  const tab = 8;
  // Get to nudge state
  d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  assert.equal(d._checkLoop(tab, 'click', { selector: '#a' }, { success: true }).kind, 'nudge');
  // Four distinct healthy calls — resets nudge state (threshold is 2) AND
  // pushes old #a entries out of the 6-element buffer window.
  for (let i = 0; i < 4; i++) {
    d._checkLoop(tab, 'read_page', { i }, { ok: true });
  }
  // Now nudges should be cleared and buffer doesn't have 3× #a.
  const result = d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  assert.equal(result.kind, 'none');
});

test('tabs are isolated from each other', () => {
  const d = new LoopDetectorShim();
  // Three identical calls on tab A should NOT affect tab B.
  d._checkLoop(10, 'click', { selector: '#x' }, { success: true });
  d._checkLoop(10, 'click', { selector: '#x' }, { success: true });
  d._checkLoop(10, 'click', { selector: '#x' }, { success: true });
  const result = d._checkLoop(20, 'click', { selector: '#x' }, { success: true });
  assert.equal(result.kind, 'none');
});

// ────────────────────────────────────────────────────────────────────────
// Coordinate-click loop detector tests
// ────────────────────────────────────────────────────────────────────────

test('coord click: first call → none', () => {
  const d = new LoopDetectorShim();
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'none');
});

test('coord click: fourth identical → none (relaxed thresholds)', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'none');
});

test('coord click: fifth identical → nudge', () => {
  const d = new LoopDetectorShim();
  for (let i = 0; i < 4; i++) d._checkCoordClickLoop(1, 100, 200);
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'nudge');
});

test('coord click: eighth identical → stop', () => {
  const d = new LoopDetectorShim();
  for (let i = 0; i < 7; i++) d._checkCoordClickLoop(1, 100, 200);
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'stop');
});

test('coord click: 5px drift collapses to same bucket', () => {
  const d = new LoopDetectorShim();
  for (let i = 0; i < 4; i++) d._checkCoordClickLoop(1, 100, 200);
  // (102, 199) rounds to (100, 200) — fifth identical bucket → nudge
  assert.equal(d._checkCoordClickLoop(1, 102, 199).kind, 'nudge');
});

test('coord click: 10px drift = different bucket', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  // (115, 200) rounds to (115, 200) — different bucket
  assert.equal(d._checkCoordClickLoop(1, 115, 200).kind, 'none');
});

test('coord click: survives interleaved noise (the failure mode this fixes)', () => {
  // Coord clicks accumulate across interleaved noise. Nudge at 5, stop at 8.
  const d = new LoopDetectorShim();
  for (let i = 0; i < 4; i++) d._checkCoordClickLoop(1, 267, 226);
  assert.equal(d._checkCoordClickLoop(1, 267, 226).kind, 'nudge'); // 5th → nudge
  // Interleaved noise doesn't reset the count
  d._checkCoordClickLoop(1, 500, 500);
  d._checkCoordClickLoop(1, 600, 100);
  assert.equal(d._checkCoordClickLoop(1, 267, 226).kind, 'nudge'); // 6th → still nudge
  assert.equal(d._checkCoordClickLoop(1, 267, 226).kind, 'nudge'); // 7th → still nudge
  assert.equal(d._checkCoordClickLoop(1, 267, 226).kind, 'stop');  // 8th → stop
});

test('coord click: tabs are isolated', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  // Same coords on a different tab — should still be 'none'
  assert.equal(d._checkCoordClickLoop(2, 100, 200).kind, 'none');
});

test('coord click: window of 12 — old entries roll out', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200); // first
  // 12 distinct intervening clicks
  for (let i = 0; i < 12; i++) {
    d._checkCoordClickLoop(1, 50 + i * 20, 50);
  }
  // The original (100,200) has been pushed out. Next (100,200) is fresh.
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'none');
});

test('window of 6 means a loop can fall out of the window', () => {
  const d = new LoopDetectorShim();
  const tab = 11;
  // Two #a, then 5 distinct calls — by then the buffer has rolled past #a.
  d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  for (let i = 0; i < 5; i++) {
    d._checkLoop(tab, 'read_page', { i }, { ok: true });
  }
  // The buffer is now: [a, read_page×5] — only one #a remains. Another #a
  // makes it 2× — still under the 3× threshold.
  const result = d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  assert.equal(result.kind, 'none');
});

// ────────────────────────────────────────────────────────────────────────
// Image budget (token-conscious screenshots)
//
// These mirror the static helpers on Agent exactly — keep them in sync
// with src/chrome/src/agent/agent.js `_estimateImageTokens` and
// `_fitImageDimensions`. We shim rather than import because agent.js
// pulls in chrome.* and cdp-client.
// ────────────────────────────────────────────────────────────────────────

const IMAGE_BUDGET_DEFAULT = {
  pxPerToken: 28,
  maxTargetPx: 1568,
  maxTargetTokens: 1568,
};

function estimateImageTokens(w, h, pxPerToken) {
  return Math.ceil((w / pxPerToken) * (h / pxPerToken));
}

function fitImageDimensions(origW, origH, budget = IMAGE_BUDGET_DEFAULT) {
  const { pxPerToken, maxTargetPx, maxTargetTokens } = budget;
  if (origW <= maxTargetPx && origH <= maxTargetPx &&
      estimateImageTokens(origW, origH, pxPerToken) <= maxTargetTokens) {
    return [origW, origH];
  }
  if (origH > origW) {
    const [h, w] = fitImageDimensions(origH, origW, budget);
    return [w, h];
  }
  const aspect = origW / origH;
  let hi = origW, lo = 1;
  while (true) {
    if (lo + 1 >= hi) return [lo, Math.max(Math.round(lo / aspect), 1)];
    const mid = Math.floor((lo + hi) / 2);
    const midH = Math.max(Math.round(mid / aspect), 1);
    if (mid <= maxTargetPx &&
        estimateImageTokens(mid, midH, pxPerToken) <= maxTargetTokens) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
}

console.log('\nimage budget');

test('small viewport passes through unchanged (fast path)', () => {
  // 1280×800 at pxPerToken=28 → 1307 tokens < 1568 — no resize.
  const [w, h] = fitImageDimensions(1280, 800);
  assert.equal(w, 1280);
  assert.equal(h, 800);
});

test('1080p shrinks to fit the token cap', () => {
  // 1920×1080 → 2645 tokens (over). Target keeps aspect at ~1.78.
  const [w, h] = fitImageDimensions(1920, 1080);
  assert.ok(w <= 1568, `width ${w} > 1568`);
  assert.ok(h <= 1568, `height ${h} > 1568`);
  assert.ok(estimateImageTokens(w, h, 28) <= 1568, `tokens over cap: ${estimateImageTokens(w, h, 28)}`);
  // Aspect ratio preserved within 1 pixel (rounding).
  const origAspect = 1920 / 1080;
  const newAspect = w / h;
  assert.ok(Math.abs(origAspect - newAspect) < 0.01, `aspect drift ${newAspect} vs ${origAspect}`);
});

test('4K and 1440p converge to the same max-budget dims', () => {
  // Any input with the same 16:9 aspect ratio should produce the same
  // largest-that-fits output. Catches off-by-one regressions in the
  // binary search.
  const [w1440, h1440] = fitImageDimensions(2560, 1440);
  const [w4k, h4k] = fitImageDimensions(3840, 2160);
  assert.equal(w1440, w4k);
  assert.equal(h1440, h4k);
});

test('tall portrait caps the long side at maxTargetPx', () => {
  // A 1920×8000 full-page capture — the long side here is height.
  const [w, h] = fitImageDimensions(1920, 8000);
  assert.ok(h <= 1568, `height ${h} > 1568`);
  assert.ok(w > 0, 'width should be positive');
  assert.ok(estimateImageTokens(w, h, 28) <= 1568);
});

test('high-DPR 5K viewport stays within budget', () => {
  // 5120×2880 (retina 5K). Should fit token cap after resize.
  const [w, h] = fitImageDimensions(5120, 2880);
  assert.ok(w <= 1568);
  assert.ok(h <= 1568);
  assert.ok(estimateImageTokens(w, h, 28) <= 1568);
});

test('square input returns a square that fits', () => {
  const [w, h] = fitImageDimensions(3000, 3000);
  assert.ok(w <= 1568);
  assert.ok(h <= 1568);
  // Square in, square (within 1 px) out.
  assert.ok(Math.abs(w - h) <= 1);
});

test('pathological 1×100000 strip does not blow up', () => {
  // Edge case: an extremely thin strip. The binary search used to have
  // a termination bug when origH >> origW; this locks in that fix.
  const [w, h] = fitImageDimensions(1, 100000);
  assert.ok(h <= 1568);
  assert.ok(w >= 1);
  assert.ok(estimateImageTokens(w, h, 28) <= 1568);
});

test('custom budget is honored', () => {
  // Shrink to a tight 400 token / 400 px budget — no dimension should exceed.
  const [w, h] = fitImageDimensions(1920, 1080, {
    pxPerToken: 28, maxTargetPx: 400, maxTargetTokens: 400,
  });
  assert.ok(w <= 400);
  assert.ok(h <= 400);
  assert.ok(estimateImageTokens(w, h, 28) <= 400);
});

test('existing dims under caps stay within the monotonic bound', () => {
  // Fuzz a range of common viewport sizes; invariant: output ≤ input on
  // every dimension, and output token count ≤ maxTargetTokens.
  const inputs = [
    [1366, 768], [1440, 900], [1680, 1050], [1600, 900], [1920, 1200],
    [2048, 1152], [2304, 1440], [2560, 1600], [2880, 1800],
  ];
  for (const [iw, ih] of inputs) {
    const [ow, oh] = fitImageDimensions(iw, ih);
    assert.ok(ow <= iw, `w grew: ${iw}→${ow}`);
    assert.ok(oh <= ih, `h grew: ${ih}→${oh}`);
    assert.ok(estimateImageTokens(ow, oh, 28) <= 1568, `tokens over cap for ${iw}×${ih} → ${ow}×${oh}`);
  }
});

// ────────────────────────────────────────────────────────────────────────
// Markdown link sanitizer
// ────────────────────────────────────────────────────────────────────────

console.log('\nmarkdown link sanitizer');

test('safe https link produces an <a> with rel=noopener', () => {
  const out = sanitizeMarkdownLinks('see [example](https://example.com/a?b=c)');
  assert.match(out, /<a href="https:\/\/example\.com\/a\?b=c" target="_blank" rel="noopener noreferrer">example<\/a>/);
});

test('Wikipedia URL with balanced parens round-trips', () => {
  // The bug fix for the [^)]+ pre-existing limitation. URLs with one level
  // of nested parens (Wikipedia disambiguation, MDN, Apple docs, …) must
  // survive the regex without truncation.
  const out = sanitizeMarkdownLinks('[JS](https://en.wikipedia.org/wiki/JavaScript_(programming_language))');
  assert.match(out, /href="https:\/\/en\.wikipedia\.org\/wiki\/JavaScript_\(programming_language\)"/);
});

test('javascript: URL renders as text only (no <a>)', () => {
  const out = sanitizeMarkdownLinks('[click](javascript:alert(document.cookie))');
  assert.ok(!/<a /.test(out), `expected no <a> tag, got: ${out}`);
  assert.ok(out.startsWith('click'), `expected label "click" at start, got: ${out}`);
});

test('data: URL renders as text only (no <a>)', () => {
  const out = sanitizeMarkdownLinks('[x](data:text/html,<script>alert(1)</script>)');
  assert.ok(!/<a /.test(out), `expected no <a> tag, got: ${out}`);
});

test('vbscript: URL renders as text only (no <a>)', () => {
  const out = sanitizeMarkdownLinks('[x](vbscript:msgbox(1))');
  assert.ok(!/<a /.test(out), `expected no <a> tag, got: ${out}`);
});

test('file:// URL renders as text only (no <a>)', () => {
  const out = sanitizeMarkdownLinks('[x](file:///etc/passwd)');
  assert.ok(!/<a /.test(out));
});

test('attribute breakout payload — quote escapes, no extra attributes', () => {
  // The exact payload from the original XSS finding. The trailing `)` ends
  // the markdown link match; the captured href is `" onmouseover="alert(1`
  // which is not http/https/mailto, so it renders as plain text.
  const out = sanitizeMarkdownLinks('[x](" onmouseover="alert(1))');
  assert.ok(!/<a /.test(out), `expected no <a> tag, got: ${out}`);
});

test('https URL with embedded quote is escaped, not broken out of', () => {
  // The href DOES start with https:, so we emit an <a>, but the `"` inside
  // the URL must be entity-escaped so the attribute closes at the right place.
  const out = sanitizeMarkdownLinks('[x](https://x" onerror="alert(1)/)');
  // The whole captured URL stays inside the href attribute as &quot;…
  // No new attribute (onerror=) should appear outside the href value.
  const tagMatch = out.match(/<a\s+href="([^"]*)"\s+([^>]*)>/);
  assert.ok(tagMatch, `expected <a> tag, got: ${out}`);
  assert.ok(!/onerror=/i.test(tagMatch[2]), `injected attribute leaked: ${tagMatch[2]}`);
  assert.match(tagMatch[1], /&quot;/);
});

test('relative URL (anchor) produces an <a>', () => {
  const out = sanitizeMarkdownLinks('[top](#section)');
  assert.match(out, /<a href="#section"/);
});

test('relative URL (path) produces an <a>', () => {
  const out = sanitizeMarkdownLinks('[home](/path)');
  assert.match(out, /<a href="\/path"/);
});

test('mailto: produces an <a>', () => {
  const out = sanitizeMarkdownLinks('[mail me](mailto:a@b.com)');
  assert.match(out, /<a href="mailto:a@b\.com"/);
});

test('schemeless / no-recognized-form renders as text only', () => {
  const out = sanitizeMarkdownLinks('[x](no-scheme-here)');
  assert.ok(!/<a /.test(out));
});

test('sanitizeLink helper handles null/undefined href safely', () => {
  // Defense-in-depth — should never throw.
  assert.equal(sanitizeLink('label', null), 'label');
  assert.equal(sanitizeLink('label', undefined), 'label');
  assert.equal(sanitizeLink('label', ''), 'label');
});

test('firefox port has the same sanitizer behavior', () => {
  // Spot-check the Firefox copy is in sync — it's a literal copy today,
  // but if it ever diverges we want to know.
  const inputs = [
    '[ok](https://example.com)',
    '[bad](javascript:alert(1))',
    '[wiki](https://en.wikipedia.org/wiki/Foo_(bar))',
  ];
  for (const inp of inputs) {
    assert.equal(
      sanitizeMarkdownLinksFx(inp),
      sanitizeMarkdownLinks(inp),
      `firefox sanitizer diverged on input: ${inp}`,
    );
  }
});

// ────────────────────────────────────────────────────────────────────────
// validateFetchUrl — the agent's network gate
// ────────────────────────────────────────────────────────────────────────

console.log('\nfetch URL validator');

// Helper: shorthand expectation.
function expectReject(url, opts) {
  const r = validateFetchUrl(url, opts);
  assert.equal(r.ok, false, `${url} (allowLocal=${!!opts?.allowLocalNetwork}) should reject — got ${JSON.stringify(r)}`);
}
function expectAccept(url, opts) {
  const r = validateFetchUrl(url, opts);
  assert.equal(r.ok, true, `${url} (allowLocal=${!!opts?.allowLocalNetwork}) should accept — got ${JSON.stringify(r)}`);
}

test('rejects non-http schemes (javascript:, data:, file:, ftp:)', () => {
  expectReject('javascript:alert(1)');
  expectReject('data:text/plain,foo');
  expectReject('file:///etc/passwd');
  expectReject('ftp://example.com/');
});

test('rejects cloud metadata hostnames regardless of allowLocal', () => {
  for (const allowLocal of [false, true]) {
    expectReject('http://metadata.google.internal/', { allowLocalNetwork: allowLocal });
    expectReject('http://metadata.aws.internal/', { allowLocalNetwork: allowLocal });
    expectReject('http://metadata.azure.com/', { allowLocalNetwork: allowLocal });
  }
});

test('rejects *.internal and *.local regardless of allowLocal', () => {
  for (const allowLocal of [false, true]) {
    expectReject('http://corp-jenkins.internal/', { allowLocalNetwork: allowLocal });
    expectReject('http://router.local/', { allowLocalNetwork: allowLocal });
  }
});

test('rejects 169.254.169.254 (cloud metadata IP) regardless of allowLocal', () => {
  for (const allowLocal of [false, true]) {
    expectReject('http://169.254.169.254/latest/meta-data/', { allowLocalNetwork: allowLocal });
  }
});

test('rejects CGNAT 100.64/10 regardless of allowLocal', () => {
  expectReject('http://100.64.0.1/');
  expectReject('http://100.127.255.255/');
  expectAccept('http://100.128.0.1/'); // outside CGNAT
});

test('rejects multicast/reserved (≥224) and 0/8', () => {
  expectReject('http://224.0.0.1/');
  expectReject('http://255.255.255.255/');
  expectReject('http://0.0.0.0/');
});

test('localhost / loopback / RFC1918 — relaxable via allowLocalNetwork', () => {
  // Default = blocked.
  expectReject('http://localhost:8080/');
  expectReject('http://127.0.0.1/');
  expectReject('http://10.1.2.3/');
  expectReject('http://172.16.0.1/');
  expectReject('http://172.31.255.255/');
  expectReject('http://192.168.1.1/');
  // 172.32 is outside RFC1918 — accepted.
  expectAccept('http://172.32.0.1/');
  // With the toggle on — accepted.
  expectAccept('http://localhost:8080/', { allowLocalNetwork: true });
  expectAccept('http://127.0.0.1/', { allowLocalNetwork: true });
  expectAccept('http://10.1.2.3/', { allowLocalNetwork: true });
  expectAccept('http://192.168.1.1/', { allowLocalNetwork: true });
  expectAccept('http://172.20.0.1/', { allowLocalNetwork: true });
});

test('IPv6 — link-local always blocked, loopback/unique-local relaxable', () => {
  // Always-blocked: link-local fe80::/10 and unspecified ::
  expectReject('http://[fe80::1]/');
  expectReject('http://[fe80::1]/', { allowLocalNetwork: true });
  expectReject('http://[::]/');
  expectReject('http://[::]/', { allowLocalNetwork: true });
  // Relaxable: ::1 and fc00::/7
  expectReject('http://[::1]/');
  expectAccept('http://[::1]/', { allowLocalNetwork: true });
  expectReject('http://[fc00::1]/');
  expectAccept('http://[fc00::1]/', { allowLocalNetwork: true });
  expectReject('http://[fd12:3456::1]/');
  expectAccept('http://[fd12:3456::1]/', { allowLocalNetwork: true });
  // Public IPv6 always allowed.
  expectAccept('http://[2001:db8::1]/');
});

test('IPv4-mapped IPv6 (::ffff:V4) is decoded and re-validated', () => {
  // The URL parser normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1, so the
  // validator must handle the hex form too.
  expectReject('http://[::ffff:127.0.0.1]/');
  expectAccept('http://[::ffff:127.0.0.1]/', { allowLocalNetwork: true });
  expectReject('http://[::ffff:10.0.0.1]/');
  expectAccept('http://[::ffff:10.0.0.1]/', { allowLocalNetwork: true });
  expectReject('http://[::ffff:169.254.169.254]/'); // metadata even when toggled
  expectReject('http://[::ffff:169.254.169.254]/', { allowLocalNetwork: true });
  expectAccept('http://[::ffff:8.8.8.8]/'); // public v4 mapped
});

test('public hosts always accepted', () => {
  expectAccept('https://example.com/');
  expectAccept('https://api.github.com/repos/');
  expectAccept('http://example.com/');
});

test('invalid URL strings are rejected', () => {
  expectReject('not a url');
  expectReject('://no-scheme');
  expectReject('http://');
});

test('firefox port validator agrees with chrome on a sample of cases', () => {
  // Sanity check that the two ports stay in sync. Pick one case from each
  // category — full coverage runs against the chrome copy above.
  const samples = [
    ['javascript:alert(1)', false, false],
    ['http://169.254.169.254/', false, false],
    ['http://localhost/', false, false],
    ['http://localhost/', true, true],
    ['http://[fe80::1]/', true, false],
    ['https://example.com/', false, true],
  ];
  for (const [url, allowLocal, expectOk] of samples) {
    const opts = { allowLocalNetwork: allowLocal };
    const cr = validateFetchUrl(url, opts);
    const fr = validateFetchUrlFx(url, opts);
    assert.equal(cr.ok, fr.ok, `chrome/firefox disagree on ${url} (allowLocal=${allowLocal})`);
    assert.equal(cr.ok, expectOk, `wrong result for ${url} (allowLocal=${allowLocal})`);
  }
});

// ────────────────────────────────────────────────────────────────────────
// registrableDomain — eTLD+1 extractor for cookie policy
// ────────────────────────────────────────────────────────────────────────

console.log('\nregistrable domain');

test('subdomains collapse to the registrable domain', () => {
  assert.equal(registrableDomain('github.com'), 'github.com');
  assert.equal(registrableDomain('api.github.com'), 'github.com');
  assert.equal(registrableDomain('www.api.github.com'), 'github.com');
  assert.equal(registrableDomain('mail.google.com'), 'google.com');
  assert.equal(registrableDomain('docs.google.com'), 'google.com');
});

test('known multi-label ccTLDs get +1 label', () => {
  assert.equal(registrableDomain('example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('foo.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('foo.bar.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au');
});

test('known multi-tenant hosting suffixes get +1 label', () => {
  // GitHub Pages: each user is a separate registrable domain.
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.equal(registrableDomain('bob.github.io'), 'bob.github.io');
  assert.notEqual(registrableDomain('alice.github.io'), registrableDomain('bob.github.io'));
  // Netlify, Vercel, Cloudflare Pages similarly.
  assert.equal(registrableDomain('my-site.netlify.app'), 'my-site.netlify.app');
  assert.equal(registrableDomain('app.vercel.app'), 'app.vercel.app');
});

test('IP literals returned as-is', () => {
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain('192.168.1.1'), '192.168.1.1');
  assert.equal(registrableDomain('::1'), '::1');
  assert.equal(registrableDomain('fe80::1'), 'fe80::1');
});

test('edge cases (empty / single label)', () => {
  assert.equal(registrableDomain(''), '');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('case-insensitive — same registrable domain', () => {
  assert.equal(registrableDomain('GitHub.com'), 'github.com');
  assert.equal(registrableDomain('API.GitHub.COM'), 'github.com');
});

test('firefox port registrableDomain matches chrome', () => {
  const samples = ['github.com', 'api.github.com', 'foo.example.co.uk', 'alice.github.io', '127.0.0.1'];
  for (const h of samples) {
    assert.equal(registrableDomainFx(h), registrableDomain(h), `mismatch on ${h}`);
  }
});

await run();
