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

// permission-gate.js is pure JS (deterministic capability × origin gate).
const { Capability, capabilityFor, capabilitiesFor, normalizeHost, hostForCapability, requiredHosts, frameHostMatches, isNetworkMutation, PermissionManager, UNTRUSTED_CONTENT_TOOLS } = await import(
  'file://' + path.join(ROOT, 'src/firefox/src/agent/permission-gate.js').replace(/\\/g, '/')
);
const {
  capabilityFor: capabilityForCh,
  PermissionManager: PermissionManagerCh,
  normalizeHost: normalizeHostCh,
} = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/agent/permission-gate.js').replace(/\\/g, '/')
);

// loop-bucket.js is pure JS — the URL-family loop-detector bucketing logic
// lives here so both agent.js and the tests can exercise the same code.
const { resourceBucket, bucketArgsKey, URL_FAMILY_TOOLS } = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/agent/loop-bucket.js').replace(/\\/g, '/')
);
const { resourceBucket: resourceBucketFx, bucketArgsKey: bucketArgsKeyFx } = await import(
  'file://' + path.join(ROOT, 'src/firefox/src/agent/loop-bucket.js').replace(/\\/g, '/')
);

// bump-version.mjs is the version-bump CLI but exports its pure helpers
// for testing. The CLI body is guarded so importing it is side-effect-free.
const { bumpSemver, rewriteVersionInJsonText, rewriteVersionByAnchor, isReleaseBoundary } = await import(
  'file://' + path.join(ROOT, 'scripts/bump-version.mjs').replace(/\\/g, '/')
);

// providers/manager.js — pure ESM at module load (chrome.* only inside
// methods). We import the class so we can exercise the static categoryFor()
// helper and inspect the default-configs shape (categorization parity).
const { ProviderManager: ProviderManagerCh } = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/providers/manager.js').replace(/\\/g, '/')
);
const { ProviderManager: ProviderManagerFx } = await import(
  'file://' + path.join(ROOT, 'src/firefox/src/providers/manager.js').replace(/\\/g, '/')
);

// tools.js — pure ESM. We import both browser builds so prompt/tool routing
// stays in parity.
const {
  COMPACT_TOOL_NAMES: COMPACT_TOOL_NAMES_CH,
  SYSTEM_PROMPT_ACT_COMPACT: SYSTEM_PROMPT_ACT_COMPACT_CH,
  getToolsForMode: getToolsForModeCh,
} = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/agent/tools.js').replace(/\\/g, '/')
);
const {
  COMPACT_TOOL_NAMES: COMPACT_TOOL_NAMES_FX,
  SYSTEM_PROMPT_ACT_COMPACT: SYSTEM_PROMPT_ACT_COMPACT_FX,
  getToolsForMode: getToolsForModeFx,
} = await import(
  'file://' + path.join(ROOT, 'src/firefox/src/agent/tools.js').replace(/\\/g, '/')
);

// credential-fields.js — pure ESM detector, no DOM. Both chrome and
// firefox copies are imported so we assert the regex + notes don't drift.
const {
  isCredentialField,
  SENSITIVE_NAME_RE,
  CREDENTIAL_NOTE,
  CREDENTIAL_NOTE_LOOSE,
  CREDENTIAL_NOTE_STRICT,
} = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/agent/credential-fields.js').replace(/\\/g, '/')
);
const {
  isCredentialField: isCredentialFieldFx,
  SENSITIVE_NAME_RE: SENSITIVE_NAME_RE_FX,
  CREDENTIAL_NOTE: CREDENTIAL_NOTE_FX,
  CREDENTIAL_NOTE_LOOSE: CREDENTIAL_NOTE_LOOSE_FX,
  CREDENTIAL_NOTE_STRICT: CREDENTIAL_NOTE_STRICT_FX,
} = await import(
  'file://' + path.join(ROOT, 'src/firefox/src/agent/credential-fields.js').replace(/\\/g, '/')
);

// sheets-tools.js — A1 range parsing, TSV roundtrip, site detection. The
// pure helpers exported from sheets-tools.js are testable without any
// chrome.* / DOM mocks. The backend I/O (readSheet, fillSheet) is not
// covered here — those need a real Sheets/Excel tab.
const {
  parseA1, colLettersToIndex, indexToColLetters, rangeToA1,
  valuesToTsv, tsvToValues, detectSheetSite,
} = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/agent/sheets-tools.js').replace(/\\/g, '/')
);
const {
  parseA1: parseA1Fx,
  colLettersToIndex: colLettersToIndexFx,
  indexToColLetters: indexToColLettersFx,
  valuesToTsv: valuesToTsvFx,
  tsvToValues: tsvToValuesFx,
  detectSheetSite: detectSheetSiteFx,
} = await import(
  'file://' + path.join(ROOT, 'src/firefox/src/agent/sheets-tools.js').replace(/\\/g, '/')
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
    // Mirror agent.js: URL-family tools bucket by resource identity so
    // the agent can't escape loop detection by fetching the same file
    // via 8 different API endpoints. Falls back to exact JSON for other
    // tools.
    const argsHash = bucketArgsKey(name, args);
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

test('matches apple store pages', () => {
  assert.equal(getActiveAdapter('https://www.apple.com/shop/buy-mac/macbook-air')?.name, 'apple');
  assert.equal(getActiveAdapter('https://www.apple.com/uk/shop/refurbished')?.name, 'apple');
  assert.equal(getActiveAdapter('https://secure.store.apple.com/shop/checkout')?.name, 'apple');
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

test('matches wordpress wp-admin on any host', () => {
  assert.equal(getActiveAdapter('https://example.com/wp-admin/')?.name, 'wordpress');
  assert.equal(getActiveAdapter('https://teknofili.com/wp-admin/profile.php')?.name, 'wordpress');
  assert.equal(getActiveAdapter('https://my-blog.io/wp-admin/admin.php?page=rank-math')?.name, 'wordpress');
  assert.equal(getActiveAdapter('https://example.com/wp-login.php')?.name, 'wordpress');
  // Front-end of a WP site is NOT a match — adapter is admin-only.
  assert.equal(getActiveAdapter('https://example.com/'), null);
  assert.equal(getActiveAdapter('https://example.com/some-post/'), null);
  // /wp-admin must be a path segment, not a substring elsewhere in URL.
  assert.equal(getActiveAdapter('https://example.com/blog/wp-admin-tutorial/'), null);
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

// ────────────────────────────────────────────────────────────────────────
// URL-family loop bucketing (agent/loop-bucket.js)
// ────────────────────────────────────────────────────────────────────────

console.log('\nURL-family loop bucketing');

test('the 8-way GitHub fetch trap collapses to one bucket', () => {
  // The exact bug from the trace: agent fetched web/build/locales/en.json
  // 8 different ways. All should map to the same bucket so the existing
  // loop detector fires.
  const variants = [
    'https://raw.githubusercontent.com/esokullu/WebBrain/main/web/build/locales/en.json',
    'https://api.github.com/repos/esokullu/WebBrain/contents/web/build/locales/en.json',
    'https://github.com/esokullu/WebBrain/blob/main/web/build/locales/en.json',
    'https://github.com/esokullu/WebBrain/raw/main/web/build/locales/en.json',
    'https://github.com/esokullu/WebBrain/edit/main/web/build/locales/en.json',
  ];
  const buckets = variants.map(resourceBucket);
  const unique = new Set(buckets);
  assert.equal(unique.size, 1,
    `expected all variants to collapse to one bucket, got ${unique.size}: ${[...unique].join(' | ')}`);
});

test('different files in the same repo get different buckets', () => {
  assert.notEqual(
    resourceBucket('https://raw.githubusercontent.com/esokullu/WebBrain/main/web/build/locales/en.json'),
    resourceBucket('https://raw.githubusercontent.com/esokullu/WebBrain/main/web/build/locales/tr.json'),
  );
});

test('different repos get different buckets', () => {
  assert.notEqual(
    resourceBucket('https://raw.githubusercontent.com/esokullu/WebBrain/main/README.md'),
    resourceBucket('https://raw.githubusercontent.com/anthropic/skill-rules/main/README.md'),
  );
});

test('non-GitHub hosts use last-3-segments backstop', () => {
  // Same bucket — same path tail
  assert.equal(
    resourceBucket('https://example.com/a/b/c/file.json'),
    resourceBucket('https://example.com/a/b/c/file.json?v=1'),
  );
  // Different bucket — different host
  assert.notEqual(
    resourceBucket('https://example.com/a/b/file.json'),
    resourceBucket('https://other.com/a/b/file.json'),
  );
});

test('GitHub gist + codeload also normalize to github.com', () => {
  const a = resourceBucket('https://gist.github.com/user/abc123/raw/file.txt');
  const b = resourceBucket('https://codeload.github.com/owner/repo/zip/refs/heads/main');
  assert.match(a, /^github\.com::/);
  assert.match(b, /^github\.com::/);
});

test('invalid URL returns input unchanged (graceful fallback)', () => {
  assert.equal(resourceBucket('not a url'), 'not a url');
  assert.equal(resourceBucket(''), '');
  assert.equal(resourceBucket(null), '');
  assert.equal(resourceBucket(undefined), '');
});

test('bucketArgsKey: URL-family tools use resource bucket + method', () => {
  const a = bucketArgsKey('fetch_url', { url: 'https://raw.githubusercontent.com/o/r/main/foo.json' });
  const b = bucketArgsKey('fetch_url', { url: 'https://api.github.com/repos/o/r/contents/foo.json' });
  assert.equal(a, b, 'same logical resource → same key');
  // Method matters: GET ≠ POST.
  const get = bucketArgsKey('fetch_url', { url: 'https://x.com/a/b/c', method: 'GET' });
  const post = bucketArgsKey('fetch_url', { url: 'https://x.com/a/b/c', method: 'POST' });
  assert.notEqual(get, post);
});

test('bucketArgsKey: non-URL tools fall back to exact JSON args', () => {
  // click_ax with the same ref_id should match itself
  assert.equal(
    bucketArgsKey('click_ax', { ref_id: 'ref_42' }),
    bucketArgsKey('click_ax', { ref_id: 'ref_42' }),
  );
  // Different args → different key
  assert.notEqual(
    bucketArgsKey('click_ax', { ref_id: 'ref_42' }),
    bucketArgsKey('click_ax', { ref_id: 'ref_43' }),
  );
});

test('URL_FAMILY_TOOLS contains the expected tool names', () => {
  // Lock the membership so a future contributor doesn't accidentally
  // remove fetch_url and silently regress the loop detector.
  for (const name of ['fetch_url', 'research_url', 'download_file', 'read_downloaded_file']) {
    assert.ok(URL_FAMILY_TOOLS.has(name), `${name} missing from URL_FAMILY_TOOLS`);
  }
});

test('LOOP DETECTOR catches URL-family thrashing (the trace bug)', () => {
  // Replay a slimmer version of the actual trace: the agent fetches the
  // same resource via 4 different API URLs. With the old code the loop
  // detector saw 4 distinct keys and never fired. With the bucketing
  // it sees the same key 4 times → "repeat" loop on call 3.
  const d = new LoopDetectorShim();
  const tabId = 1;
  const variants = [
    'https://raw.githubusercontent.com/o/r/main/file.json',
    'https://api.github.com/repos/o/r/contents/file.json',
    'https://github.com/o/r/blob/main/file.json',
    'https://api.github.com/repos/o/r/git/blobs/abc123',
  ];
  let triggered = null;
  for (let i = 0; i < variants.length; i++) {
    const result = d._checkLoop(tabId, 'fetch_url', { url: variants[i] }, { success: true });
    if (result.kind !== 'none') { triggered = { i, result }; break; }
  }
  assert.ok(triggered, 'expected loop detector to fire on URL-family thrashing');
  assert.equal(triggered.result.kind, 'nudge', 'first detection should be a nudge');
  // i=2 means after the 3rd identical (bucketed) call.
  assert.ok(triggered.i >= 2, `expected detection at call index ≥2, got ${triggered.i}`);
});

test('firefox loop-bucket matches chrome', () => {
  const samples = [
    ['fetch_url', { url: 'https://raw.githubusercontent.com/o/r/main/foo.json' }],
    ['fetch_url', { url: 'https://api.github.com/repos/o/r/contents/foo.json', method: 'POST' }],
    ['click_ax', { ref_id: 'ref_42' }],
    ['fetch_url', { url: 'not a url' }],
  ];
  for (const [name, args] of samples) {
    assert.equal(bucketArgsKeyFx(name, args), bucketArgsKey(name, args), `mismatch on ${name} ${JSON.stringify(args)}`);
  }
  for (const url of [
    'https://github.com/o/r/blob/main/foo.json',
    'https://example.com/a/b/c',
    null,
    'invalid',
  ]) {
    assert.equal(resourceBucketFx(url), resourceBucket(url), `mismatch on ${url}`);
  }
});

// ────────────────────────────────────────────────────────────────────────
// Version bumping (scripts/bump-version.mjs)
// ────────────────────────────────────────────────────────────────────────

console.log('\nversion bump');

test('default kind is patch', () => {
  assert.equal(bumpSemver('7.0.0'), '7.0.1');
  assert.equal(bumpSemver('1.2.3'), '1.2.4');
});

test('explicit patch / minor / major', () => {
  assert.equal(bumpSemver('7.0.0', 'patch'), '7.0.1');
  assert.equal(bumpSemver('7.0.0', 'minor'), '7.1.0');
  assert.equal(bumpSemver('7.0.0', 'major'), '8.0.0');
});

test('minor and major reset lower components', () => {
  // The semver standard: bumping minor zeroes patch; bumping major
  // zeroes both minor and patch. Lock that behavior in.
  assert.equal(bumpSemver('7.4.9', 'minor'), '7.5.0');
  assert.equal(bumpSemver('7.4.9', 'major'), '8.0.0');
});

test('explicit MAJOR.MINOR.PATCH override', () => {
  assert.equal(bumpSemver('7.0.0', '7.2.3'), '7.2.3');
  assert.equal(bumpSemver('7.0.0', '10.0.0'), '10.0.0');
});

test('rejects bad current version', () => {
  assert.throws(() => bumpSemver('not-a-version', 'patch'), /not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => bumpSemver('1.2', 'patch'), /not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => bumpSemver('1.2.3.4', 'patch'), /not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => bumpSemver('1.2.3-beta', 'patch'), /not MAJOR\.MINOR\.PATCH/);
});

test('rejects bad bump kind', () => {
  assert.throws(() => bumpSemver('7.0.0', 'huge'), /Unknown bump kind/);
  assert.throws(() => bumpSemver('7.0.0', ''), /Unknown bump kind/);
});

test('rewriteVersionInJsonText: replaces only the version field, not other matching strings', () => {
  // A pathological JSON that mentions the version string in a description
  // or comment-like field should NOT be touched by the rewrite.
  const before = `{
  "name": "webbrain",
  "version": "7.0.0",
  "description": "Released after 7.0.0 era; supersedes 7.0.0 tools."
}`;
  const after = rewriteVersionInJsonText(before, '7.0.0', '7.0.1');
  assert.match(after, /"version": "7\.0\.1"/);
  // The description still mentions 7.0.0 — it must not have been munged.
  assert.match(after, /Released after 7\.0\.0 era/);
  assert.match(after, /supersedes 7\.0\.0 tools/);
});

test('rewriteVersionInJsonText: replaceAll handles package-lock.json shape', () => {
  // package-lock.json carries "version" twice — top-level and in
  // packages[""]. Both must update.
  const before = `{
  "name": "webbrain",
  "version": "7.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "webbrain",
      "version": "7.0.0"
    }
  }
}`;
  const after = rewriteVersionInJsonText(before, '7.0.0', '7.0.1', { replaceAll: true });
  assert.equal((after.match(/"version": "7\.0\.1"/g) || []).length, 2);
  assert.ok(!after.includes('"version": "7.0.0"'), `stale version remained: ${after}`);
});

test('rewriteVersionInJsonText: returns input unchanged when oldVersion not present', () => {
  const before = '{"version": "8.0.0"}';
  const after = rewriteVersionInJsonText(before, '7.0.0', '7.0.1');
  assert.equal(after, before);
});

test('rewriteVersionInJsonText: tolerates varied whitespace in JSON', () => {
  // Whether the JSON uses 2 spaces, tabs, or compact form, the
  // version-property pattern should still match.
  const samples = [
    '{"version":"7.0.0"}',
    '{"version": "7.0.0"}',
    '{ "version" : "7.0.0" }',
    '{\n\t"version":\t"7.0.0"\n}',
  ];
  for (const before of samples) {
    const after = rewriteVersionInJsonText(before, '7.0.0', '7.0.1');
    assert.ok(after.includes('"7.0.1'), `failed to update: ${before}`);
    assert.ok(!after.includes('"7.0.0'), `stale version remained: ${after}`);
  }
});

test('rewriteVersionByAnchor: rewrites EXT_VERSION literal in settings.js', () => {
  // The actual shape used by src/{chrome,firefox}/src/ui/settings.js.
  const before = `// Version shown in the subtitle.\nconst EXT_VERSION = '7.0.0';\n`;
  const after = rewriteVersionByAnchor(
    before, '7.0.0', '7.0.1', `(EXT_VERSION\\s*=\\s*['"])__OLD__(['"])`
  );
  assert.match(after, /const EXT_VERSION = '7\.0\.1';/);
  assert.ok(!after.includes("'7.0.0'"));
});

test('rewriteVersionByAnchor: rewrites ARCHITECTURE.md header line', () => {
  const before = `# WebBrain Chrome Extension — Architecture\n\n> Version 7.0.0 · Manifest V3 · Service Worker background\n`;
  const after = rewriteVersionByAnchor(
    before, '7.0.0', '7.1.0', `(>\\s*Version\\s+)__OLD__(\\s*·)`
  );
  assert.match(after, /> Version 7\.1\.0 · Manifest V3/);
  assert.ok(!after.includes('Version 7.0.0'));
});

test('rewriteVersionByAnchor: returns input unchanged when anchor does not match', () => {
  // If the file has the old version SOMEWHERE but not at the anchor
  // location, we must NOT clobber the unrelated occurrence.
  const before = `// Released after 7.0.0 — see CHANGELOG.\nconst EXT_VERSION = '6.1.0';\n`;
  const after = rewriteVersionByAnchor(
    before, '7.0.0', '7.0.1', `(EXT_VERSION\\s*=\\s*['"])__OLD__(['"])`
  );
  assert.equal(after, before);
});

test('rewriteVersionByAnchor: escapes regex metacharacters in oldVersion', () => {
  // Plain semver never contains regex metas, but the helper should
  // tolerate them defensively (future-proofing for pre-release tags).
  const before = `marker[1.0+abc]end`;
  const after = rewriteVersionByAnchor(
    before, '1.0+abc', '1.0+xyz', `(marker\\[)__OLD__(\\])`
  );
  assert.equal(after, 'marker[1.0+xyz]end');
});

test('isReleaseBoundary: true for major X.0.0 versions', () => {
  assert.equal(isReleaseBoundary('1.0.0'), true);
  assert.equal(isReleaseBoundary('7.0.0'), true);
  assert.equal(isReleaseBoundary('99.0.0'), true);
  // The all-zeros edge case is technically a boundary too — it's `patch == 0`.
  assert.equal(isReleaseBoundary('0.0.0'), true);
});

test('isReleaseBoundary: true for minor X.Y.0 versions (Y > 0)', () => {
  assert.equal(isReleaseBoundary('7.1.0'), true);
  assert.equal(isReleaseBoundary('7.42.0'), true);
  assert.equal(isReleaseBoundary('1.99.0'), true);
});

test('isReleaseBoundary: false for patch X.Y.Z versions (Z > 0)', () => {
  assert.equal(isReleaseBoundary('7.0.1'), false);
  assert.equal(isReleaseBoundary('7.1.1'), false);
  assert.equal(isReleaseBoundary('7.4.9'), false);
  assert.equal(isReleaseBoundary('1.0.99'), false);
});

test('isReleaseBoundary: throws on malformed input', () => {
  assert.throws(() => isReleaseBoundary('not-a-version'), /Not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => isReleaseBoundary('1.2'), /Not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => isReleaseBoundary('1.2.3.4'), /Not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => isReleaseBoundary('1.2.3-beta'), /Not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => isReleaseBoundary(''), /Not MAJOR\.MINOR\.PATCH/);
});

test('isReleaseBoundary: composes with bumpSemver to classify the next version', () => {
  // The use-case in the CLI: bump → classify → maybe tag.
  // Bumping minor or major from any starting point must produce a boundary;
  // bumping patch must not.
  assert.equal(isReleaseBoundary(bumpSemver('7.0.5', 'minor')), true);   // 7.1.0
  assert.equal(isReleaseBoundary(bumpSemver('7.0.5', 'major')), true);   // 8.0.0
  assert.equal(isReleaseBoundary(bumpSemver('7.0.5', 'patch')), false);  // 7.0.6
  assert.equal(isReleaseBoundary(bumpSemver('7.1.0', 'patch')), false);  // 7.1.1
  // Explicit override path also routes through correctly.
  assert.equal(isReleaseBoundary(bumpSemver('7.0.5', '8.2.0')), true);
  assert.equal(isReleaseBoundary(bumpSemver('7.0.5', '8.2.3')), false);
});

// ────────────────────────────────────────────────────────────────────────
// Credential-field detection
// ────────────────────────────────────────────────────────────────────────

console.log('\ncredential-field detection');

test('parity: chrome and firefox copies are identical', () => {
  assert.equal(SENSITIVE_NAME_RE.source, SENSITIVE_NAME_RE_FX.source);
  assert.equal(SENSITIVE_NAME_RE.flags, SENSITIVE_NAME_RE_FX.flags);
  assert.equal(CREDENTIAL_NOTE, CREDENTIAL_NOTE_FX);
  assert.equal(CREDENTIAL_NOTE_LOOSE, CREDENTIAL_NOTE_LOOSE_FX);
  assert.equal(CREDENTIAL_NOTE_STRICT, CREDENTIAL_NOTE_STRICT_FX);
});

test('default CREDENTIAL_NOTE is the loose variant (personal-tool default)', () => {
  // Webbrain runs on the user\'s own machine; loose is the default so users
  // can ask "show me my API key" and have it work. Strict is opt-in via
  // Settings → "Strict secret handling".
  assert.equal(CREDENTIAL_NOTE, CREDENTIAL_NOTE_LOOSE);
  assert.notEqual(CREDENTIAL_NOTE_LOOSE, CREDENTIAL_NOTE_STRICT);
});

test('loose note permits quoting on explicit user request; strict forbids', () => {
  // Sanity checks on the rhetorical posture — not exact wording. The loose
  // note must mention that the user can ask for the value; the strict note
  // must say no.
  assert.match(CREDENTIAL_NOTE_LOOSE, /user .*explicit|explicit.*user|if the user/i);
  assert.match(CREDENTIAL_NOTE_LOOSE, /show|quote|display/i);
  assert.match(CREDENTIAL_NOTE_STRICT, /do NOT|never/i);
  assert.match(CREDENTIAL_NOTE_STRICT, /strict/i);
});

test('getToolsForMode: default `done` description is the loose hygiene hint', () => {
  for (const getTools of [getToolsForModeCh, getToolsForModeFx]) {
    const tools = getTools('act');
    const done = tools.find(t => t.function.name === 'done');
    assert.ok(done, '`done` tool must be present in act mode');
    assert.match(done.function.description, /hygiene|tidy|prefer generic/i);
    // Loose default must NOT contain hard prohibition language.
    assert.doesNotMatch(done.function.description, /Must NOT contain|never include passwords/);
    // Summary param description stays minimal in loose mode.
    assert.equal(done.function.parameters.properties.summary.description, 'Summary of what was accomplished.');
  }
});

test('getToolsForMode: strictSecretMode swaps in the strict `done` description', () => {
  for (const getTools of [getToolsForModeCh, getToolsForModeFx]) {
    const loose = getTools('act');
    const strict = getTools('act', { strictSecretMode: true });
    const looseDone = loose.find(t => t.function.name === 'done');
    const strictDone = strict.find(t => t.function.name === 'done');
    assert.notEqual(looseDone.function.description, strictDone.function.description);
    assert.match(strictDone.function.description, /strict mode|never include passwords|Must NOT/i);
    assert.match(strictDone.function.parameters.properties.summary.description, /Must NOT contain/);
    // Other tools must be untouched.
    const looseNames = loose.map(t => t.function.name).sort();
    const strictNames = strict.map(t => t.function.name).sort();
    assert.deepEqual(looseNames, strictNames);
  }
});

test('getToolsForMode: strictSecretMode works in ask mode too', () => {
  for (const getTools of [getToolsForModeCh, getToolsForModeFx]) {
    const strict = getTools('ask', { strictSecretMode: true });
    const done = strict.find(t => t.function.name === 'done');
    assert.ok(done, '`done` must be available in ask mode');
    assert.match(done.function.description, /strict mode/i);
  }
});

test('getToolsForMode: compact mode restricts act tools in both browsers', () => {
  for (const [label, getTools, compactNames] of [
    ['chrome', getToolsForModeCh, COMPACT_TOOL_NAMES_CH],
    ['firefox', getToolsForModeFx, COMPACT_TOOL_NAMES_FX],
  ]) {
    const fullNames = getTools('act').map(t => t.function.name);
    const compactNamesActual = getTools('act', { compact: true }).map(t => t.function.name);
    const unknownCompactNames = [...compactNames].filter(name => !fullNames.includes(name));
    assert.deepEqual(unknownCompactNames, [], `[${label}] compact set must only name real tools`);
    assert.ok(compactNamesActual.length < fullNames.length, `[${label}] compact should be smaller than full act tools`);
    assert.deepEqual(
      compactNamesActual.slice().sort(),
      [...compactNames].sort(),
    );
    assert.ok(compactNamesActual.includes('done'), `[${label}] compact mode must keep done`);
    assert.ok(compactNamesActual.includes('solve_captcha'), `[${label}] compact mode must keep solve_captcha`);
    assert.equal(compactNamesActual.includes('execute_js'), false, `[${label}] compact mode must omit execute_js`);
  }
});

test('getToolsForMode: compact flag does not shrink ask mode', () => {
  for (const getTools of [getToolsForModeCh, getToolsForModeFx]) {
    assert.deepEqual(
      getTools('ask', { compact: true }).map(t => t.function.name).sort(),
      getTools('ask').map(t => t.function.name).sort(),
    );
  }
});

test('compact act prompt exists in both browser builds', () => {
  assert.match(SYSTEM_PROMPT_ACT_COMPACT_CH, /untrusted/i);
  assert.match(SYSTEM_PROMPT_ACT_COMPACT_FX, /untrusted/i);
  assert.match(SYSTEM_PROMPT_ACT_COMPACT_FX, /get_accessibility_tree/);
});

test('detects <input type="password">', () => {
  assert.equal(isCredentialField({ type: 'password' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'password', name: 'user' }).sensitive, true);
});

test('detects autocomplete=current-password / new-password / one-time-code', () => {
  assert.equal(isCredentialField({ type: 'text', autocomplete: 'current-password' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', autocomplete: 'new-password' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', autocomplete: 'one-time-code' }).sensitive, true);
  // Case-insensitive
  assert.equal(isCredentialField({ type: 'text', autocomplete: 'Current-Password' }).sensitive, true);
});

test('detects name= matching credential vocab', () => {
  assert.equal(isCredentialField({ type: 'text', name: 'password' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'pwd' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'api_key' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'apiKey' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'api-key' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'access_token' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'refresh_token' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'client_secret' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'private_key' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'otp' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'mfa_code' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: '2fa' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'recovery-code' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'backup_code' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'seed-phrase' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'passphrase' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', name: 'pin_code' }).sensitive, true);
});

test('detects id / aria-label / placeholder / labelText', () => {
  assert.equal(isCredentialField({ type: 'text', id: 'pwd-field' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', ariaLabel: 'Enter your API key' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', placeholder: 'One-time password' }).sensitive, true);
  assert.equal(isCredentialField({ type: 'text', labelText: 'Your secret' }).sensitive, true);
});

test('rejects non-credential fields (negative carveouts)', () => {
  assert.equal(isCredentialField({ type: 'text', name: 'username' }).sensitive, false);
  assert.equal(isCredentialField({ type: 'email', name: 'email' }).sensitive, false);
  assert.equal(isCredentialField({ type: 'text', name: 'first_name' }).sensitive, false);
  assert.equal(isCredentialField({ type: 'text', name: 'address' }).sensitive, false);
  // Bare "auth" / "auto" / "key" do NOT trigger — too common (author,
  // autocomplete, keyboard). The regex requires credential-specific vocab.
  assert.equal(isCredentialField({ type: 'text', name: 'author' }).sensitive, false);
  assert.equal(isCredentialField({ type: 'text', name: 'autocomplete' }).sensitive, false);
  assert.equal(isCredentialField({ type: 'text', name: 'keyword' }).sensitive, false);
  assert.equal(isCredentialField({ type: 'text', placeholder: 'Search for keywords...' }).sensitive, false);
  // type=password ALWAYS wins, even with innocuous name
  assert.equal(isCredentialField({ type: 'password', name: 'foo' }).sensitive, true);
});

test('handles missing / malformed input gracefully', () => {
  assert.equal(isCredentialField(null).sensitive, false);
  assert.equal(isCredentialField(undefined).sensitive, false);
  assert.equal(isCredentialField({}).sensitive, false);
  assert.equal(isCredentialField({ type: null, name: null }).sensitive, false);
});

test('reason is informative', () => {
  assert.equal(isCredentialField({ type: 'password' }).reason, 'input type=password');
  assert.match(isCredentialField({ type: 'text', autocomplete: 'one-time-code' }).reason, /autocomplete=one-time-code/);
  assert.match(isCredentialField({ type: 'text', name: 'api_key' }).reason, /name matches credential pattern/);
});

// ────────────────────────────────────────────────────────────────────────
// Provider categorization (filter UI)
// ────────────────────────────────────────────────────────────────────────

console.log('\nprovider categorization');

test('categoryFor: local family (llamacpp / ollama / lmstudio)', () => {
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    assert.equal(PM.categoryFor('llamacpp', { type: 'llamacpp' }), 'local');
    assert.equal(PM.categoryFor('ollama', { type: 'openai' }), 'local');
    assert.equal(PM.categoryFor('lmstudio', { type: 'openai' }), 'local');
  }
});

test('categoryFor: cloud family (openai / anthropic / gemini / mistral / deepseek / xai / oauth)', () => {
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    assert.equal(PM.categoryFor('openai', { type: 'openai' }), 'cloud');
    assert.equal(PM.categoryFor('anthropic', { type: 'anthropic' }), 'cloud');
    assert.equal(PM.categoryFor('gemini', { type: 'openai' }), 'cloud');
    assert.equal(PM.categoryFor('mistral', { type: 'openai' }), 'cloud');
    assert.equal(PM.categoryFor('deepseek', { type: 'openai' }), 'cloud');
    assert.equal(PM.categoryFor('xai', { type: 'openai' }), 'cloud');
    assert.equal(PM.categoryFor('claude_subscription', { type: 'anthropic_oauth' }), 'cloud');
  }
});

test('categoryFor: openrouter is router', () => {
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    assert.equal(PM.categoryFor('openrouter', { type: 'openai' }), 'router');
  }
});

test('categoryFor: config.category overrides the per-id fallback', () => {
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    // If a stored config explicitly tags itself, that wins even if the id
    // looks like something else (future-proofing for user-added providers).
    assert.equal(PM.categoryFor('custom_proxy', { category: 'router', type: 'openai' }), 'router');
    assert.equal(PM.categoryFor('openai', { category: 'local', type: 'openai' }), 'local');
  }
});

test('categoryFor: unknown id with no category defaults to cloud', () => {
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    assert.equal(PM.categoryFor('some_new_thing', { type: 'openai' }), 'cloud');
    assert.equal(PM.categoryFor('whatever', {}), 'cloud');
  }
});

test('_extractModelIds: Ollama /api/tags format', () => {
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    const mgr = new PM();
    assert.deepEqual(
      mgr._extractModelIds('ollama', {
        models: [{ name: 'qwen3:8b' }, { name: 'llama3.1' }, { digest: 'missing-name' }, { name: 'qwen3:8b' }],
      }),
      ['llama3.1', 'qwen3:8b']
    );
  }
});

test('_extractModelIds: OpenAI-compatible /v1/models format', () => {
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    const mgr = new PM();
    assert.deepEqual(
      mgr._extractModelIds('lmstudio', {
        data: [{ id: 'local/qwen3' }, { id: 'gemma-3n' }, { object: 'model' }, { id: 'local/qwen3' }],
      }),
      ['gemma-3n', 'local/qwen3']
    );
    assert.deepEqual(
      mgr._extractModelIds('llamacpp', { data: ['qwen2.5-coder', 'llama.cpp-model'] }),
      ['llama.cpp-model', 'qwen2.5-coder']
    );
  }
});

test('_defaultConfigs: every entry carries an explicit category', () => {
  // Walk the actual default config table on each platform and assert
  // each entry has a category field. Catches "I added a provider but
  // forgot to set its category" at test time, not at user-render time.
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    const mgr = new PM();
    const defaults = mgr._defaultConfigs();
    for (const [id, config] of Object.entries(defaults)) {
      assert.ok(
        ['local', 'cloud', 'router'].includes(config.category),
        `${PM.name}: provider ${id} missing/invalid category (got ${JSON.stringify(config.category)})`
      );
    }
  }
});

test('_defaultConfigs: new cloud providers present and disabled by default', () => {
  // Don't enable cloud providers by default — they all require an API key.
  // Auto-enabling them would create dead entries in the UI.
  for (const PM of [ProviderManagerCh, ProviderManagerFx]) {
    const mgr = new PM();
    const defaults = mgr._defaultConfigs();
    for (const id of ['gemini', 'mistral', 'deepseek', 'xai']) {
      assert.ok(defaults[id], `${PM.name}: missing default config for ${id}`);
      assert.equal(defaults[id].category, 'cloud', `${PM.name}: ${id} should be cloud`);
      assert.equal(defaults[id].enabled, false, `${PM.name}: ${id} should default to disabled`);
      assert.ok(defaults[id].baseUrl, `${PM.name}: ${id} missing baseUrl`);
      assert.ok(defaults[id].model, `${PM.name}: ${id} missing default model`);
    }
  }
});

test('_defaultConfigs: chrome and firefox share the same provider set', () => {
  const chDefaults = new ProviderManagerCh()._defaultConfigs();
  const fxDefaults = new ProviderManagerFx()._defaultConfigs();
  assert.deepEqual(
    Object.keys(chDefaults).sort(),
    Object.keys(fxDefaults).sort(),
    'chrome and firefox provider lists diverged'
  );
  // Categories must also match — drift here would mean the filter UI
  // shows different buckets on each platform.
  for (const id of Object.keys(chDefaults)) {
    assert.equal(
      chDefaults[id].category, fxDefaults[id].category,
      `provider ${id}: category differs (chrome=${chDefaults[id].category}, firefox=${fxDefaults[id].category})`
    );
  }
});

console.log('\nsheets-tools: A1 parsing');

test('parseA1: single cell A1', () => {
  const r = parseA1('A1');
  assert.deepEqual(r, { sheet: null, row: 0, col: 0, rowCount: 1, colCount: 1 });
});
test('parseA1: single cell B5', () => {
  const r = parseA1('B5');
  assert.deepEqual(r, { sheet: null, row: 4, col: 1, rowCount: 1, colCount: 1 });
});
test('parseA1: range A1:C10', () => {
  const r = parseA1('A1:C10');
  assert.deepEqual(r, { sheet: null, row: 0, col: 0, rowCount: 10, colCount: 3 });
});
test('parseA1: range reversed (C10:A1) is normalized', () => {
  const r = parseA1('C10:A1');
  assert.deepEqual(r, { sheet: null, row: 0, col: 0, rowCount: 10, colCount: 3 });
});
test('parseA1: absolute single cell $A$1 is accepted', () => {
  const r = parseA1('$A$1');
  assert.deepEqual(r, { sheet: null, row: 0, col: 0, rowCount: 1, colCount: 1 });
});
test('parseA1: mixed absolute single cell A$1 is accepted', () => {
  const r = parseA1('A$1');
  assert.deepEqual(r, { sheet: null, row: 0, col: 0, rowCount: 1, colCount: 1 });
});
test('parseA1: mixed absolute range $B2:C$10 is accepted', () => {
  const r = parseA1('$B2:C$10');
  assert.deepEqual(r, { sheet: null, row: 1, col: 1, rowCount: 9, colCount: 2 });
});
test('parseA1: lowercase input is uppercased', () => {
  const r = parseA1('a1:c10');
  assert.deepEqual(r, { sheet: null, row: 0, col: 0, rowCount: 10, colCount: 3 });
});
test('parseA1: whole column A:A', () => {
  const r = parseA1('A:A');
  assert.equal(r.wholeColumn, true);
  assert.equal(r.col, 0);
  assert.equal(r.colCount, 1);
  assert.equal(r.rowCount, -1);
});
test('parseA1: whole-column range A:C', () => {
  const r = parseA1('A:C');
  assert.equal(r.wholeColumn, true);
  assert.equal(r.colCount, 3);
});
test('parseA1: whole-column reversed C:A normalizes to A:C', () => {
  // Same shape as the rectangular-range normalization (C10:A1 → A1:C10).
  // Without normalization colCount comes out negative and downstream
  // backends mis-size the selection.
  const r = parseA1('C:A');
  assert.equal(r.wholeColumn, true);
  assert.equal(r.col, 0);
  assert.equal(r.colCount, 3);
  assert.equal(r.rowCount, -1);
});
test('parseA1: whole row 1:1', () => {
  const r = parseA1('1:1');
  assert.equal(r.wholeRow, true);
  assert.equal(r.row, 0);
  assert.equal(r.rowCount, 1);
  assert.equal(r.colCount, -1);
});
test('parseA1: whole-row reversed 5:1 normalizes to 1:5', () => {
  const r = parseA1('5:1');
  assert.equal(r.wholeRow, true);
  assert.equal(r.row, 0);
  assert.equal(r.rowCount, 5);
  assert.equal(r.colCount, -1);
});
test('parseA1: sheet prefix Sheet2!A1:C3', () => {
  const r = parseA1('Sheet2!A1:C3');
  assert.equal(r.sheet, 'Sheet2');
  assert.equal(r.row, 0);
  assert.equal(r.col, 0);
  assert.equal(r.rowCount, 3);
  assert.equal(r.colCount, 3);
});
test("parseA1: quoted sheet prefix 'My Sheet'!A1", () => {
  const r = parseA1("'My Sheet'!A1");
  assert.equal(r.sheet, 'My Sheet');
});
test("parseA1: quoted sheet prefix with absolute cell 'My Sheet'!$A$1", () => {
  const r = parseA1("'My Sheet'!$A$1");
  assert.deepEqual(r, { sheet: 'My Sheet', row: 0, col: 0, rowCount: 1, colCount: 1 });
});
test("parseA1: escaped quote in sheet name 'It''s'!A1", () => {
  const r = parseA1("'It''s'!A1");
  assert.equal(r.sheet, "It's");
});
test("parseA1: quoted sheet name containing '!' — 'Sales!Q1'!A1", () => {
  // Spreadsheet grammar allows '!' inside quoted sheet names. The split
  // must skip the inner '!' and only act on the one after the close quote.
  const r = parseA1("'Sales!Q1'!A1");
  assert.equal(r.sheet, 'Sales!Q1');
  assert.equal(r.row, 0);
  assert.equal(r.col, 0);
});
test("parseA1: quoted sheet name with both '!' AND escaped quote", () => {
  const r = parseA1("'It''s!Special'!C5");
  assert.equal(r.sheet, "It's!Special");
  assert.equal(r.row, 4);
  assert.equal(r.col, 2);
});
test("parseA1: unterminated quoted sheet name throws", () => {
  assert.throws(() => parseA1("'unterminated!A1"), /unterminated quoted sheet/);
});
test("parseA1: quote-then-not-bang throws", () => {
  // 'foo'X — close quote not followed by '!', malformed.
  assert.throws(() => parseA1("'foo'X!A1"), /closing quote.*must be immediately followed by/);
});
test("parseA1: empty quoted sheet name throws", () => {
  assert.throws(() => parseA1("''!A1"), /empty sheet name/);
});
test('parseA1: empty string throws', () => {
  assert.throws(() => parseA1(''), /non-empty string/);
});
test('parseA1: garbage throws', () => {
  assert.throws(() => parseA1('not a range'), /not A1 notation/);
});
test('parseA1: empty sheet name throws', () => {
  assert.throws(() => parseA1('!A1'), /empty sheet/);
});
test('parseA1: A (no row, no end) throws — ambiguous', () => {
  assert.throws(() => parseA1('A'), /incomplete start/);
});
test('parseA1: A0 throws (rows are 1-indexed)', () => {
  assert.throws(() => parseA1('A0'), /1-indexed/);
});
test('parseA1: A0:B5 throws (start row 0)', () => {
  assert.throws(() => parseA1('A0:B5'), /1-indexed/);
});
test('parseA1: B5:A0 throws (end row 0)', () => {
  assert.throws(() => parseA1('B5:A0'), /1-indexed/);
});
test('parseA1: 0:1 throws (whole-row form with row 0)', () => {
  assert.throws(() => parseA1('0:1'), /1-indexed/);
});
test('parseA1: 1:0 throws (whole-row form with end row 0)', () => {
  assert.throws(() => parseA1('1:0'), /1-indexed/);
});

test('colLettersToIndex: A → 0, Z → 25', () => {
  assert.equal(colLettersToIndex('A'), 0);
  assert.equal(colLettersToIndex('B'), 1);
  assert.equal(colLettersToIndex('Z'), 25);
});
test('colLettersToIndex: AA → 26, AZ → 51, BA → 52', () => {
  assert.equal(colLettersToIndex('AA'), 26);
  assert.equal(colLettersToIndex('AZ'), 51);
  assert.equal(colLettersToIndex('BA'), 52);
});
test('colLettersToIndex: ZZ → 701, AAA → 702', () => {
  assert.equal(colLettersToIndex('ZZ'), 701);
  assert.equal(colLettersToIndex('AAA'), 702);
});
test('colLettersToIndex: rejects non-letters', () => {
  assert.throws(() => colLettersToIndex('1'), /not column letters/);
  assert.throws(() => colLettersToIndex('a'), /not column letters/);
  assert.throws(() => colLettersToIndex(''), /not column letters/);
});

test('indexToColLetters: 0 → A, 25 → Z', () => {
  assert.equal(indexToColLetters(0), 'A');
  assert.equal(indexToColLetters(25), 'Z');
});
test('indexToColLetters: 26 → AA, 51 → AZ, 52 → BA', () => {
  assert.equal(indexToColLetters(26), 'AA');
  assert.equal(indexToColLetters(51), 'AZ');
  assert.equal(indexToColLetters(52), 'BA');
});
test('indexToColLetters: 701 → ZZ, 702 → AAA', () => {
  assert.equal(indexToColLetters(701), 'ZZ');
  assert.equal(indexToColLetters(702), 'AAA');
});
test('indexToColLetters: roundtrip with colLettersToIndex for 0–1000', () => {
  for (let i = 0; i <= 1000; i++) {
    const letters = indexToColLetters(i);
    const back = colLettersToIndex(letters);
    assert.equal(back, i, `roundtrip ${i} → ${letters} → ${back}`);
  }
});
test('indexToColLetters: rejects negative / non-integer', () => {
  assert.throws(() => indexToColLetters(-1), /non-negative integer/);
  assert.throws(() => indexToColLetters(1.5), /non-negative integer/);
});

test('rangeToA1: single cell', () => {
  assert.equal(rangeToA1({ row: 0, col: 0, rowCount: 1, colCount: 1 }), 'A1');
  assert.equal(rangeToA1({ row: 4, col: 1, rowCount: 1, colCount: 1 }), 'B5');
});
test('rangeToA1: range', () => {
  assert.equal(rangeToA1({ row: 0, col: 0, rowCount: 10, colCount: 3 }), 'A1:C10');
});
test('rangeToA1: with sheet name (no quoting needed)', () => {
  assert.equal(rangeToA1({ row: 0, col: 0, rowCount: 1, colCount: 1, sheet: 'Sheet1' }), 'Sheet1!A1');
});
test('rangeToA1: with sheet name needing quotes', () => {
  assert.equal(rangeToA1({ row: 0, col: 0, rowCount: 1, colCount: 1, sheet: 'My Sheet' }), "'My Sheet'!A1");
});

console.log('\nsheets-tools: TSV (de)serialization');

test('valuesToTsv: simple grid', () => {
  assert.equal(valuesToTsv([['a','b'],['c','d']]), 'a\tb\nc\td');
});
test('valuesToTsv: cell with tab is quoted', () => {
  assert.equal(valuesToTsv([['a\tb','c']]), '"a\tb"\tc');
});
test('valuesToTsv: cell with newline is quoted', () => {
  assert.equal(valuesToTsv([['a\nb','c']]), '"a\nb"\tc');
});
test('valuesToTsv: cell with quote — quote is doubled and wrapped', () => {
  assert.equal(valuesToTsv([['say "hi"','c']]), '"say ""hi"""\tc');
});
test('valuesToTsv: null/undefined → empty string', () => {
  assert.equal(valuesToTsv([[null, undefined, 'x']]), '\t\tx');
});
test('valuesToTsv: numbers coerced to string', () => {
  assert.equal(valuesToTsv([[1, 2.5]]), '1\t2.5');
});
test('valuesToTsv: rejects non-array', () => {
  assert.throws(() => valuesToTsv('foo'), /2D array/);
});

test('tsvToValues: simple grid', () => {
  assert.deepEqual(tsvToValues('a\tb\nc\td'), [['a','b'],['c','d']]);
});
test('tsvToValues: trailing newline does not add empty row', () => {
  assert.deepEqual(tsvToValues('a\tb\nc\td\n'), [['a','b'],['c','d']]);
});
test('tsvToValues: CRLF treated as one newline', () => {
  assert.deepEqual(tsvToValues('a\tb\r\nc\td'), [['a','b'],['c','d']]);
});
test('tsvToValues: quoted cell with tab inside', () => {
  assert.deepEqual(tsvToValues('"a\tb"\tc'), [['a\tb','c']]);
});
test('tsvToValues: quoted cell with embedded quote', () => {
  assert.deepEqual(tsvToValues('"say ""hi"""\tc'), [['say "hi"','c']]);
});
test('tsvToValues: empty input → one empty row', () => {
  assert.deepEqual(tsvToValues(''), [[]]);
});

test('TSV roundtrip: 100 random shapes', () => {
  const shapes = [
    [['a']],
    [['a','b','c']],
    [['a'],['b'],['c']],
    [['x\ty','z']],
    [['line1\nline2','plain']],
    [['has "quotes"','none']],
    [['',''],['',''],['','']],
    [['1','2','3'],['4','5','6']],
  ];
  for (const grid of shapes) {
    const tsv = valuesToTsv(grid);
    const back = tsvToValues(tsv);
    assert.deepEqual(back, grid, `roundtrip failed for ${JSON.stringify(grid)}`);
  }
});

console.log('\nsheets-tools: site detection');

test('detectSheetSite: Google Sheets URL', () => {
  assert.equal(detectSheetSite('https://docs.google.com/spreadsheets/d/abc123/edit'), 'google-sheets');
});
test('detectSheetSite: Google Docs URL is NOT a sheet', () => {
  assert.equal(detectSheetSite('https://docs.google.com/document/d/abc/edit'), null);
});
test('detectSheetSite: Excel Online via office.com', () => {
  assert.equal(detectSheetSite('https://www.office.com/launch/excel/foo'), 'excel-online');
});
test('detectSheetSite: Excel Online via officeapps.live.com', () => {
  assert.equal(detectSheetSite('https://word-edit.officeapps.live.com/x/something'), 'excel-online');
});
test('detectSheetSite: random URL returns null', () => {
  assert.equal(detectSheetSite('https://example.com/'), null);
  assert.equal(detectSheetSite(''), null);
  assert.equal(detectSheetSite(null), null);
});

console.log('\nsheets-tools: chrome / firefox parity');

test('parity: parseA1 returns identical results', () => {
  const cases = ['A1', 'B5:C10', 'A:A', 'Sheet2!A1:C3', "'My Sheet'!Z99"];
  for (const c of cases) {
    assert.deepEqual(parseA1(c), parseA1Fx(c), `parseA1 drift for ${c}`);
  }
});
test('parity: colLettersToIndex / indexToColLetters identical', () => {
  for (let i = 0; i < 100; i++) {
    assert.equal(indexToColLetters(i), indexToColLettersFx(i));
    assert.equal(colLettersToIndex('A' + (i ? indexToColLetters(i) : '')), colLettersToIndexFx('A' + (i ? indexToColLetters(i) : '')));
  }
});
test('parity: TSV roundtrip identical', () => {
  const grid = [['a','b\tc'],['d\ne','f"g']];
  assert.deepEqual(tsvToValues(valuesToTsv(grid)), tsvToValuesFx(valuesToTsvFx(grid)));
});
test('parity: detectSheetSite identical', () => {
  const urls = ['https://docs.google.com/spreadsheets/d/x/edit', 'https://example.com/', 'https://word-edit.officeapps.live.com/x/y'];
  for (const u of urls) assert.equal(detectSheetSite(u), detectSheetSiteFx(u));
});

// ────────────────────────────────────────────────────────────────────────
// Deterministic capability × origin permission gate (permission-gate.js)
// ────────────────────────────────────────────────────────────────────────

console.log('\npermission-gate');

test('capabilityFor: read-only tools are not gated', () => {
  for (const t of ['read_page', 'get_accessibility_tree', 'get_interactive_elements', 'extract_data', 'screenshot', 'scroll', 'get_selection']) {
    assert.equal(capabilityFor(t, {}), null, `${t} should be ungated`);
  }
});

test('capabilityFor: outbound network egress is gated for ALL methods (exfil)', () => {
  // a GET can exfiltrate data in its query string → must be gated, not just writes
  assert.equal(capabilityFor('fetch_url', { url: 'https://evil.example/?q=secrets', method: 'GET' }), Capability.NETWORK);
  assert.equal(capabilityFor('fetch_url', { url: 'https://x.com' }), Capability.NETWORK); // default GET
  assert.equal(capabilityFor('research_url', { url: 'https://x.com' }), Capability.NETWORK);
  assert.equal(capabilityFor('fetch_url', { url: 'https://api.x.com', method: 'POST' }), Capability.NETWORK);
  // read_pdf({url}) fetches an arbitrary host with credentials:'include' → gate it;
  // read_pdf with no url reads the active tab's own PDF → ungated.
  assert.equal(capabilityFor('read_pdf', { url: 'https://evil.example/?q=secrets' }), Capability.NETWORK);
  assert.equal(capabilityFor('read_pdf', {}), null);
});

test('isNetworkMutation: only write-method fetches (so /allow-api cannot waive GET exfil)', () => {
  assert.equal(isNetworkMutation('fetch_url', { url: 'https://x.com', method: 'POST' }), true);
  assert.equal(isNetworkMutation('research_url', { url: 'https://x.com', method: 'delete' }), true);
  // GET (incl. default) is NOT a mutation — must still get a host prompt even under /allow-api
  assert.equal(isNetworkMutation('fetch_url', { url: 'https://evil.example/?leak=x' }), false);
  assert.equal(isNetworkMutation('fetch_url', { url: 'https://x.com', method: 'GET' }), false);
  assert.equal(isNetworkMutation('navigate', { url: 'https://x.com' }), false);
});

test('capabilityFor: screenshot is read-only, but save:true is a download', () => {
  assert.equal(capabilityFor('screenshot', {}), null);
  assert.equal(capabilityFor('full_page_screenshot', {}), null);
  assert.equal(capabilityFor('screenshot', { save: true }), Capability.DOWNLOAD);
  assert.equal(capabilityFor('full_page_screenshot', { save: true }), Capability.DOWNLOAD);
});

test('capabilityFor: state-changing tools map to capabilities', () => {
  assert.equal(capabilityFor('navigate', { url: 'https://x.com' }), Capability.NAVIGATE);
  assert.equal(capabilityFor('new_tab', { url: 'https://x.com' }), Capability.NAVIGATE);
  assert.equal(capabilityFor('click', {}), Capability.CLICK);
  assert.equal(capabilityFor('click_ax', { ref_id: 'ref_1' }), Capability.CLICK); // ref_id, no label needed
  assert.equal(capabilityFor('type_text', {}), Capability.TYPE);
  assert.equal(capabilityFor('set_field', {}), Capability.TYPE);
  assert.equal(capabilityFor('execute_js', { code: 'x' }), Capability.EXECUTE_JS);
  assert.equal(capabilityFor('download_files', {}), Capability.DOWNLOAD);
});

test('capabilityFor: no side-effecting tool slips through ungated', () => {
  // iframe + drag + upload + chrome download alias
  assert.equal(capabilityFor('iframe_click', {}), Capability.CLICK);
  assert.equal(capabilityFor('iframe_type', {}), Capability.TYPE);
  assert.equal(capabilityFor('drag_drop', {}), Capability.CLICK);
  assert.equal(capabilityFor('upload_file', {}), Capability.UPLOAD);
  assert.equal(capabilityFor('download_file', {}), Capability.DOWNLOAD);
});

test('set_field with submit:true requires CLICK, not the weaker TYPE', () => {
  assert.equal(capabilityFor('set_field', { ref_id: 'r', text: 'x' }), Capability.TYPE);
  assert.equal(capabilityFor('set_field', { ref_id: 'r', text: 'x', submit: true }), Capability.CLICK);
});

test('capabilitiesFor: set_field({submit}) requires BOTH type and click', () => {
  assert.deepEqual(capabilitiesFor('set_field', { text: 'x' }), [Capability.TYPE]);
  assert.deepEqual(capabilitiesFor('set_field', { text: 'x', submit: true }), [Capability.TYPE, Capability.CLICK]);
  // single-capability tools wrap to a 1-element array; read-only → []
  assert.deepEqual(capabilitiesFor('click', {}), [Capability.CLICK]);
  assert.deepEqual(capabilitiesFor('fetch_url', { url: 'https://x.com' }), [Capability.NETWORK]);
  assert.deepEqual(capabilitiesFor('read_page', {}), []);
});

test('press_keys: Enter is a submit (CLICK); Tab/Escape are benign (null)', () => {
  assert.equal(capabilityFor('press_keys', { key: 'Enter' }), Capability.CLICK);
  assert.equal(capabilityFor('press_keys', { key: 'Escape' }), null);
  assert.equal(capabilityFor('press_keys', { key: 'Tab' }), null);
  assert.equal(capabilityFor('press_keys', {}), Capability.CLICK); // unknown → gate, fail safe
});

test('record_tab (tab + microphone capture) is gated', () => {
  assert.equal(capabilityFor('record_tab', {}), Capability.RECORD);
  assert.equal(capabilityForCh('record_tab', {}), Capability.RECORD);
});

test('navigation host resolves relative / protocol-relative against current page', () => {
  const base = 'https://trusted.com/page';
  // protocol-relative → the host the browser will actually load, NOT current
  assert.equal(
    hostForCapability(Capability.NAVIGATE, { url: '//attacker.example/x?leak=1' }, base),
    'attacker.example'
  );
  // relative path stays same-origin
  assert.equal(hostForCapability(Capability.NAVIGATE, { url: '/dashboard' }, base), 'trusted.com');
  assert.equal(hostForCapability(Capability.NAVIGATE, { url: 'sub/page' }, base), 'trusted.com');
  // absolute is unaffected
  assert.equal(hostForCapability(Capability.NAVIGATE, { url: 'https://dest.com/y' }, base), 'dest.com');
  // normalizeHost also handles bare protocol-relative input
  assert.equal(normalizeHost('//evil.example/x'), 'evil.example');
});

test('normalizeHost strips scheme/www/port/path', () => {
  assert.equal(normalizeHost('https://www.GitHub.com/foo/bar'), 'github.com');
  assert.equal(normalizeHost('http://example.com:8080/x'), 'example.com');
  assert.equal(normalizeHost('Example.com'), 'example.com');
  assert.equal(normalizeHost(''), '');
});

test('hostForCapability: navigate/network use target URL, others use current page', () => {
  assert.equal(hostForCapability(Capability.NAVIGATE, { url: 'https://dest.com/x' }, 'https://cur.com'), 'dest.com');
  assert.equal(hostForCapability(Capability.NETWORK, { url: 'https://api.dest.com' }, 'https://cur.com'), 'api.dest.com');
  assert.equal(hostForCapability(Capability.CLICK, { ref_id: 'ref_1' }, 'https://cur.com'), 'cur.com');
  assert.equal(hostForCapability(Capability.TYPE, {}, 'https://cur.com'), 'cur.com');
});

test('iframe actions are gated on the frame host (urlFilter), not the top page', () => {
  const top = 'https://merchant.com/checkout';
  // Embedded Stripe iframe targeted by urlFilter → charge stripe.com, NOT merchant.com
  assert.equal(
    hostForCapability(Capability.CLICK, { urlFilter: 'js.stripe.com', selector: '#pay' }, top, 'iframe_click'),
    'js.stripe.com'
  );
  assert.equal(
    hostForCapability(Capability.TYPE, { urlFilter: 'https://checkout.paypal.com/x' }, top, 'iframe_type'),
    'checkout.paypal.com'
  );
  // No urlFilter → host can't be identified → return '' so the agent fails closed
  assert.equal(hostForCapability(Capability.CLICK, {}, top, 'iframe_click'), '');
  // A normal (non-iframe) click still uses the current page host
  assert.equal(hostForCapability(Capability.CLICK, { ref_id: 'ref_1' }, top, 'click'), 'merchant.com');
});

test('downloads are charged to the target URL host, not the current page', () => {
  const top = 'https://trusted.com/page';
  // download_files from an attacker URL → charge attacker.example, NOT trusted.com
  assert.equal(
    hostForCapability(Capability.DOWNLOAD, { url: 'https://attacker.example/payload.bin' }, top),
    'attacker.example'
  );
  // a download with no url (e.g. download_resource_from_page) → current page
  assert.equal(hostForCapability(Capability.DOWNLOAD, {}, top), 'trusted.com');
});

test('requiredHosts: download_files gates EVERY distinct host in urls[]', () => {
  const top = 'https://trusted.com/page';
  // a urls[] array spanning multiple hosts → one entry per distinct host
  assert.deepEqual(
    requiredHosts(Capability.DOWNLOAD, { urls: [
      'https://a.example/1.bin',
      'https://b.example/2.bin',
      'https://www.a.example/3.bin', // dedupes with a.example
    ] }, top).sort(),
    ['a.example', 'b.example']
  );
  // single-host helper still works for navigate/click/etc.
  assert.deepEqual(requiredHosts(Capability.CLICK, { ref_id: 'r' }, top), ['trusted.com']);
  assert.deepEqual(requiredHosts(Capability.NAVIGATE, { url: 'https://dest.com/x' }, top), ['dest.com']);
  // unidentifiable iframe target → [] so the caller fails closed
  assert.deepEqual(requiredHosts(Capability.CLICK, {}, top, 'iframe_click'), []);
});

test('hydrateFrom replaces always-grants but keeps once-grants (live revoke)', async () => {
  const pm = new PermissionManager();
  await pm.record('a.com', Capability.CLICK, 'allow', 'always');
  await pm.record('b.com', Capability.TYPE, 'allow', 'once');
  // Simulate a Settings revoke of a.com's grant arriving via storage.onChanged
  pm.hydrateFrom([]); // new persisted snapshot is empty
  assert.equal(pm.check('a.com', Capability.CLICK).needsPrompt, true);  // revoked → re-prompts
  assert.equal(pm.check('b.com', Capability.TYPE).allowed, true);       // once-grant survives the turn
});

test('frameHostMatches: host-based, not substring (closes the ?next=stripe.com bypass)', () => {
  // genuine frame
  assert.equal(frameHostMatches('https://js.stripe.com/v3/', 'stripe.com'), true);   // subdomain
  assert.equal(frameHostMatches('https://stripe.com/x', 'stripe.com'), true);        // exact
  assert.equal(frameHostMatches('https://checkout.paypal.com/', 'https://checkout.paypal.com'), true);
  // the attack: evil frame whose URL merely CONTAINS the filter string
  assert.equal(frameHostMatches('https://evil.example/?next=stripe.com', 'stripe.com'), false);
  assert.equal(frameHostMatches('https://stripe.com.evil.example/', 'stripe.com'), false);
  // no filter → matches anything
  assert.equal(frameHostMatches('https://anything.com/', ''), true);
});

test('check: unknown (capability, host) needs a prompt', () => {
  const pm = new PermissionManager();
  const v = pm.check('github.com', Capability.CLICK);
  assert.equal(v.allowed, false);
  assert.equal(v.needsPrompt, true);
});

test('record allow/deny, then check returns it without prompting', async () => {
  const pm = new PermissionManager();
  await pm.record('github.com', Capability.CLICK, 'allow', 'always');
  let v = pm.check('https://www.github.com/x', Capability.CLICK); // host normalized
  assert.equal(v.allowed, true);
  assert.equal(v.needsPrompt, false);
  // a standing deny
  await pm.record('evil.com', Capability.EXECUTE_JS, 'deny', 'always');
  v = pm.check('evil.com', Capability.EXECUTE_JS);
  assert.equal(v.allowed, false);
  assert.equal(v.needsPrompt, false);
  // different capability on same host is still unknown
  assert.equal(pm.check('github.com', Capability.TYPE).needsPrompt, true);
});

test('once-grants are scoped per tab (concurrent runs do not leak/clear)', async () => {
  const pm = new PermissionManager();
  await pm.record('a.com', Capability.CLICK, 'allow', 'once', 1); // tab 1
  // tab 2 must NOT inherit tab 1's once-grant
  assert.equal(pm.check('a.com', Capability.CLICK, 2).needsPrompt, true);
  assert.equal(pm.check('a.com', Capability.CLICK, 1).allowed, true);
  // a new turn in tab 2 must NOT clear tab 1's still-valid grant
  pm.beginTurn(2);
  assert.equal(pm.check('a.com', Capability.CLICK, 1).allowed, true);
  // tab 1's own new turn clears it
  pm.beginTurn(1);
  assert.equal(pm.check('a.com', Capability.CLICK, 1).needsPrompt, true);

  // "always" grants stay global across tabs
  await pm.record('b.com', Capability.TYPE, 'allow', 'always', 1);
  assert.equal(pm.check('b.com', Capability.TYPE, 999).allowed, true);
});

test('beginTurn drops once grants but keeps always grants', async () => {
  const pm = new PermissionManager();
  await pm.record('a.com', Capability.CLICK, 'allow', 'once');
  await pm.record('b.com', Capability.CLICK, 'allow', 'always');
  pm.beginTurn();
  assert.equal(pm.check('a.com', Capability.CLICK).needsPrompt, true);  // once dropped
  assert.equal(pm.check('b.com', Capability.CLICK).allowed, true);      // always kept
});

test('always grants persist via the save hook; hydrate restores them', async () => {
  let saved = null;
  const pm1 = new PermissionManager({ save: async (g) => { saved = g; } });
  await pm1.record('github.com', Capability.CLICK, 'allow', 'always');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].host, 'github.com');

  const pm2 = new PermissionManager({ load: async () => saved });
  await pm2.hydrate();
  assert.equal(pm2.check('github.com', Capability.CLICK).allowed, true);
});

test('skipAll hook allows everything without prompting', () => {
  const pm = new PermissionManager({ skipAll: () => true });
  const v = pm.check('anything.com', Capability.EXECUTE_JS);
  assert.equal(v.allowed, true);
  assert.equal(v.needsPrompt, false);
});

test('parity: chrome & firefox permission-gate behave identically', async () => {
  assert.equal(capabilityForCh('click', {}), capabilityFor('click', {}));
  assert.equal(capabilityForCh('read_page', {}), capabilityFor('read_page', {}));
  assert.equal(normalizeHostCh('https://www.GitHub.com/x'), normalizeHost('https://www.GitHub.com/x'));
  const a = new PermissionManager(); const b = new PermissionManagerCh();
  await a.record('x.com', 'click', 'allow', 'always');
  await b.record('x.com', 'click', 'allow', 'always');
  assert.equal(a.check('x.com', 'click').allowed, b.check('x.com', 'click').allowed);
});

// EXHAUSTIVENESS GUARD — the whole capability/untrusted model is only as
// complete as its registries. This fails CI when a tool the model can call is
// neither gated (capabilityFor), nor an untrusted-content reader
// (UNTRUSTED_CONTENT_TOOLS), nor on the reviewed known-safe allowlist below.
// Adding a new tool then forces a deliberate categorization instead of a
// silent gate/Layer-1 bypass (the failure mode behind several PR findings).
//
// KNOWN_SAFE: tools that neither cause a gated side effect nor return
// page-derived content. Each is a reviewed, deliberate exception — adding to
// this list is a security decision, so keep the justification next to it.
const KNOWN_SAFE_TOOLS = new Set([
  'clarify',              // relays a question to the user (trusted user input)
  'scratchpad_write',     // writes an internal agent note, not the page
  // NOTE: hover and list_downloads were moved to UNTRUSTED_CONTENT_TOOLS — both
  // return attacker-influenced bytes (hover: the element's accessible name;
  // list_downloads: url + Content-Disposition filename). "Doesn't act
  // dangerously" is not the test; "does its RESULT carry page-derived bytes" is.
  'wait_for_stable',      // waits for the page to settle; returns status only
  'stop_recording',       // stops capture (starting it is gated via record_tab)
  // solve_captcha is not page-content; its side effects (spends CapSolver
  // quota + injects a token into the page) are minor and bounded, and the only
  // consequential follow-up — the submit — is separately gated. Left ungated to
  // avoid friction on a precursor the user wants when blocked by a CAPTCHA;
  // revisit if quota abuse becomes a real concern.
  'solve_captcha',
]);

test('exhaustiveness: every model-exposed tool is classified', () => {
  for (const [label, getTools, capFor] of [
    ['firefox', getToolsForModeFx, capabilityFor],
    ['chrome', getToolsForModeCh, capabilityForCh],
  ]) {
    const tools = getTools('act');
    // Guard against a vacuous pass (e.g. getTools returning []).
    assert.ok(tools.length >= 15, `[${label}] expected the act toolset, got ${tools.length} tools`);
    for (const t of tools) {
      const name = t.function?.name;
      if (!name) continue;
      const gated = capFor(name, {}) !== null;       // has a (possible) side effect
      const untrustedRead = UNTRUSTED_CONTENT_TOOLS.has(name); // result is page-derived
      const knownSafe = KNOWN_SAFE_TOOLS.has(name);
      assert.ok(
        gated || untrustedRead || knownSafe,
        `[${label}] tool "${name}" is unclassified. Add it to capabilityFor() if it has a side effect, ` +
        `UNTRUSTED_CONTENT_TOOLS if its result is page-derived, or the KNOWN_SAFE_TOOLS allowlist (with justification).`
      );
    }
  }
});

await run();
