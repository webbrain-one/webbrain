// The rule for WebBrain's guards (docs/guards.md, AGENT.md → Safety): only
// the hard list may refuse outright; every other check leaves a note for the
// model or asks the user, and Settings → "Strict checks" restores blocking.
// A guard added after the registry was introduced names a test of a
// legitimate task it must let through (mustNotBlock). This file enforces the
// registry's shape, that the code only uses registered guard ids, and a
// ceiling on completion refusals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const BUILDS = ['chrome', 'firefox'];
const policy = await import('../src/chrome/src/agent/guard-policy.js');
const { GUARDS, HARD_GUARD_CLASSES, NON_GUARD_CLASSES, GUARD_CLASSES, GUARD_OUTCOMES, GRANDFATHERED_GUARD_COUNT, guardOutcome } = policy;
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// The guards that existed when the registry was introduced. This list only
// shrinks: remove an id when its guard is removed, and lower
// GRANDFATHERED_GUARD_COUNT with it. A new guard is never added here; it
// declares mustNotBlock instead.
const GRANDFATHERED = new Set([
  'action-no-progress-classification', 'api-mutation-permission', 'auto-progress-resume', 'bot-memory-reservation',
  'bot-memory-uncertain-done', 'browser-batch-fresh-turn-interrupt', 'browser-control-handoff-stale-batch',
  'capability-host-permission', 'captcha-gate-action-block', 'captcha-gate-manual-required',
  'captcha-paid-solve-protection', 'captcha-solution-binding', 'captcha-solve-detection-binding',
  'carousel-traversal-guards', 'chat-send-evidence-unavailable', 'chat-send-preconditions',
  'chat-send-recipient-guards', 'chat-user-input-required', 'chrome-protected-page',
  'clarify-timeout-not-authorization', 'click-coordinate-intent', 'click-duplicate-submit', 'click-native-os-ui',
  'click-text-ambiguous', 'clickax-native-button-preparation', 'clickax-task-click-lock',
  'clickax-trusted-retry-vetoes', 'completion-evidence-freshness', 'completion-failure-only-done',
  'completion-page-warning', 'completion-recovery-forced-turns', 'completion-verifier-advisory-outputs',
  'completion-verifier-not-done', 'consequential-durability-checkpoint', 'content-action-outcome-unknown',
  'coordinate-click-provenance', 'deletion-confirm-card', 'deletion-guard-refusal', 'delivery-observation-checkpoint',
  'done-iframe-form-unverified', 'done-invariant-shape-checks', 'done-rich-text-toolbar-obligation',
  'done-summary-meta-only', 'done-verification-debt', 'downloaded-file-task-changed', 'exact-table-done',
  'form-validation-unchanged-repeat', 'generate-image-config-invalid', 'github-commit-evidence-binding',
  'github-commit-split-write-required', 'github-committed-file-verification', 'github-conditional-commit-rearm',
  'github-conditional-commit-unbound', 'grouped-search-card', 'iframe-target-binding', 'iframe-urlfilter-required',
  'incomplete-task-check-stale', 'incomplete-task-redirect', 'jev-target-changed', 'loop-failed-action-target',
  'loop-observation-stop', 'loop-repeat-stop', 'loop-unavailable-tool', 'loop-verification-dialog-reopen',
  'media-download-target-binding', 'native-chat-receipt-not-durable', 'navigation-scheme-and-internal-pages',
  'network-url-safety', 'otp-mailbox-scope', 'otp-open-message-gate', 'owned-native-chat-read-repair',
  'page-blocker-wall', 'page-feedback-ask-answer-superseded', 'page-feedback-dispatch-fence',
  'page-feedback-supersession-stop', 'page-feedback-target-binding', 'pdf-viewer-dom-tools',
  'permission-host-unidentified', 'plain-final-done-protocol', 'plain-final-rejected-text-compaction',
  'plain-final-two-strike-partial', 'plain-final-unusable-output', 'plan-done-summary-shape',
  'plan-execution-evidence-missing', 'plan-plain-final-protocol', 'plan-publication-evidence-missing',
  'plan-required-evidence-missing', 'plan-submission-evidence-missing', 'plan-task-drifted',
  'plan-unauthorized-mutation-recorded', 'preparation-timeout-action-pipeline',
  'preparation-timeout-captcha-preflight', 'preparation-timeout-generic', 'preparation-timeout-permission-detection',
  'preparation-timeout-recipient-preflight', 'preparation-timeout-submit-preflight', 'progress-ledger-unresolved',
  'progress-success-claim-checks', 'promote-iframe-ambiguous', 'pure-calculation-done-checks',
  'pure-calculation-stale-authority', 'pure-calculation-tool-scope', 'read-coverage-ask-limitation',
  'read-coverage-incomplete', 'recipient-active-conversation-pin', 'recipient-clarify-cannot-repair-technical',
  'recipient-dispatch-binding-revalidate', 'recipient-draft-evidence-unavailable', 'recipient-guard-refusal',
  'recipient-guard-target-preparation', 'recipient-guard-unrequested-send', 'recipient-mismatch-confirm-card',
  'research-escalation-authorization', 'resource-mutation-task-authority-changed',
  'rich-text-toolbar-recovery-obligation', 'rich-text-toolbar-target-unresolved', 'rich-text-toolbar-wrong-target',
  'sched-reconciliation-required', 'sched-systemone-downgrade', 'schedule-owner-changed',
  'schedule-resume-chat-state-not-durable', 'set-field-bundled-submit-outcome', 'social-api-publication-route',
  'social-preflight-context-mismatch', 'social-publication-audit', 'social-publication-authorization-guard',
  'social-publication-draft-quality', 'social-publication-host-checks', 'stale-ax-ref',
  'steer-post-correction-commit-guard', 'steer-prior-submission-target-unresolved',
  'steer-prior-submission-unreconciled', 'steering-and-page-feedback-call-fence', 'step-limit',
  'strict-secret-credential-handling', 'structured-cloud-output-contract', 'submit-confirmation-card',
  'terminal-recovery-no-success', 'text-write-debt-arm', 'text-write-debt-block', 'text-write-preinsert-unproven',
  'text-write-readback-unverified', 'tool-call-malformed', 'tool-feature-availability-gates', 'tool-not-advertised',
  'tool-routing-redirects', 'truncated-preview-replacement', 'trusted-field-retry-guards', 'typing-target-identity',
  'unsaved-changes-data-loss', 'upload-compact-tier-sources', 'upload-selector-ambiguity', 'upload-source-validation',
  'user-stop-or-card-cancel', 'viewport-inspection-budget', 'webmcp-frame-binding', 'webmcp-mode-and-setting-gate',
  'webmcp-tool-id-invalid',
]);
const GRANDFATHERED_CEILING = 158;

// Hard guards that ask the user on WebBrain's card even when they know the
// action is wrong, because a wrong refusal would leave the run stuck where
// one click settles it, and the card still keeps the action from going out
// unasked. Each is the owner's decision; the list only grows with one.
// credential-not-provided: a password the guard does not see the user give
// (a test form, a password from a place it does not read) costs a click,
// while a guessed one is still never typed silently.
const HARD_ASKS_WHEN_DECIDED = new Set(['credential-not-provided']);

// Completion refusals (`blockedDone: true`) per build. A new one must be a
// registered guard routed through _guardRefusesOnce (or a hard-class guard);
// raise the ceiling only in the change that registers it. Lean mode's done
// keeps one hard check (native-chat-receipt-not-durable) in its own path
// (_leanDoneResult over _leanChatReceiptBlock).
const BLOCKED_DONE_CEILING = { chrome: 19, firefox: 18 };

function walk(dir) {
  return fs.readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'vendor' || entry.name === 'lib' ? [] : walk(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

// Guard ids the code names: the agent's guard helpers, guardAdvisory, the
// completion-invariant and plan-guard tables, and *_GUARDS id lists.
function guardIdsInSource(source) {
  const ids = new Map();
  const note = (id, where) => { if (!ids.has(id)) ids.set(id, where); };
  const kebab = /'([a-z0-9]+(?:-[a-z0-9]+)+)'/g;
  for (const match of source.matchAll(/\b_guard(?:Outcome|Advises|AdvisesFor|RefusesOnce)\(|\bguardAdvisory\(/g)) {
    // This call's arguments, up to its closing parenthesis.
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < source.length && depth > 0 && end - match.index < 600) {
      const ch = source[end++];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    for (const literal of source.slice(match.index + match[0].length, end).matchAll(kebab)) note(literal[1], match[0]);
  }
  for (const match of source.matchAll(/\bid: '([a-z0-9]+(?:-[a-z0-9]+)+)',\s*decided:/g)) note(match[1], 'completion invariant');
  const findings = source.indexOf('  _planGuardFindings(');
  if (findings >= 0) {
    const body = source.slice(findings, source.indexOf('\n  }\n', findings));
    for (const match of body.matchAll(/\badd\('([a-z0-9]+(?:-[a-z0-9]+)+)'/g)) note(match[1], '_planGuardFindings');
  }
  for (const match of source.matchAll(/\b[A-Z][A-Z_]*_GUARDS\s*=\s*(?:Object\.freeze\()?(?:new Set\()?\[([^\]]*)\]/g)) {
    for (const literal of match[1].matchAll(kebab)) note(literal[1], 'id list');
  }
  return ids;
}

test('guard-policy.js is shared verbatim by both builds', () => {
  assert.equal(read('src/firefox/src/agent/guard-policy.js'), read('src/chrome/src/agent/guard-policy.js'));
});

test('every guard entry is well formed', () => {
  const families = new Set(['completion', 'content-write', 'loop', 'predispatch', 'scheduler', 'tool']);
  for (const [id, entry] of Object.entries(GUARDS)) {
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)+$/, `${id}: ids are kebab-case`);
    assert.ok(GUARD_CLASSES.includes(entry.class), `${id}: unknown class ${entry.class}`);
    assert.ok(families.has(entry.family), `${id}: unknown family ${entry.family}`);
    assert.ok(['knows', 'no-evidence', 'mixed', 'protocol'].includes(entry.decides), `${id}: unknown decides ${entry.decides}`);
    assert.ok(GUARD_OUTCOMES.includes(entry.onDecided), `${id}: onDecided`);
    assert.ok(GUARD_OUTCOMES.includes(entry.onCannotDecide), `${id}: onCannotDecide must be declared`);
    assert.ok(typeof entry.summary === 'string' && entry.summary.trim().length >= 20, `${id}: summary`);
    const allowed = new Set(['class', 'family', 'decides', 'onDecided', 'onCannotDecide', 'summary', 'mustNotBlock']);
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `${id}: unexpected field ${key}`);
  }
});

test('only the hard list refuses outright', () => {
  for (const [id, entry] of Object.entries(GUARDS)) {
    if (entry.class === 'quality') {
      assert.notEqual(entry.onDecided, 'block', `${id}: a quality guard advises or asks; it never refuses by default`);
      assert.notEqual(entry.onCannotDecide, 'block', `${id}: a quality guard that cannot decide advises or asks`);
    } else if (HARD_GUARD_CLASSES.includes(entry.class)) {
      if (HARD_ASKS_WHEN_DECIDED.has(id)) {
        assert.equal(entry.onDecided, 'ask', `${id}: listed as a hard guard that asks on its card when it knows`);
        assert.equal(entry.onCannotDecide, 'ask', `${id}: a hard guard that asks when it knows asks when it cannot tell`);
      } else {
        assert.equal(entry.onDecided, 'block', `${id}: a hard guard that knows the action is wrong refuses it`);
      }
      assert.ok(['block', 'ask'].includes(entry.onCannotDecide), `${id}: a hard guard that cannot decide asks or refuses`);
    } else {
      assert.ok(NON_GUARD_CLASSES.includes(entry.class));
      assert.equal(entry.onDecided, 'block', `${id}: ${entry.class} keeps its behavior`);
      assert.equal(entry.onCannotDecide, 'block', `${id}: ${entry.class} keeps its behavior`);
    }
    for (const decided of [true, false]) {
      const byDefault = guardOutcome(id, { decided });
      const strict = guardOutcome(id, { decided, strict: true });
      assert.equal(byDefault, decided ? entry.onDecided : entry.onCannotDecide, `${id}: default outcome`);
      assert.equal(strict, entry.class === 'quality' ? 'block' : byDefault, `${id}: Strict checks changes only quality guards`);
    }
  }
  assert.equal(guardOutcome('an-unregistered-guard'), 'block', 'an unregistered refusal is never silently relaxed');
  assert.deepEqual([...HARD_GUARD_CLASSES], ['recipient', 'deletion', 'money', 'credentials', 'unrequested_publication']);
});

for (const build of BUILDS) {
  test(`${build}: every guard id the code names is registered`, () => {
    const unknown = [];
    let seen = 0;
    for (const path of walk(`src/${build}/src`)) {
      for (const [id, where] of guardIdsInSource(read(path))) {
        seen += 1;
        if (!Object.hasOwn(GUARDS, id)) unknown.push(`${path}: ${id} (${where})`);
      }
    }
    assert.ok(seen >= 40, `${build}: the scan found only ${seen} guard ids; did the helper names change?`);
    assert.deepEqual(unknown, [], 'Register these ids in guard-policy.js (docs/guards.md, "Adding a guard")');
  });

  test(`${build}: completion refusals stay under their ceiling`, () => {
    const count = (read(`src/${build}/src/agent/agent.js`).match(/blockedDone: true/g) || []).length;
    assert.ok(count <= BLOCKED_DONE_CEILING[build],
      `${build}: ${count} completion refusals (ceiling ${BLOCKED_DONE_CEILING[build]}). A new one must be a registered guard `
      + 'routed through _guardRefusesOnce, with mustNotBlock; raise the ceiling only in that change.');
  });
}

test('guards added after the registry name a test they must not block', () => {
  assert.ok(GRANDFATHERED_GUARD_COUNT <= GRANDFATHERED_CEILING, 'the grandfathered count only shrinks');
  assert.equal(GRANDFATHERED.size, GRANDFATHERED_GUARD_COUNT, 'GRANDFATHERED_GUARD_COUNT matches the grandfathered list');
  for (const id of GRANDFATHERED) {
    assert.ok(Object.hasOwn(GUARDS, id), `${id} was removed from guard-policy.js; remove it from GRANDFATHERED and lower the count`);
  }
  for (const [id, entry] of Object.entries(GUARDS)) {
    if (GRANDFATHERED.has(id) && entry.mustNotBlock === undefined) continue;
    assert.equal(typeof entry.mustNotBlock, 'string',
      `${id}: a new guard declares mustNotBlock: 'test/<file>.mjs#<test name>', a legitimate task it must let through`);
    const [file, name, extra] = entry.mustNotBlock.split('#');
    assert.ok(file && name && extra === undefined, `${id}: mustNotBlock is 'test/<file>.mjs#<test name>'`);
    assert.match(file, /^test\/[\w./-]+\.(?:mjs|js)$/, `${id}: mustNotBlock names a file under test/`);
    assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), `${id}: ${file} does not exist`);
    assert.ok(read(file).includes(name.trim()), `${id}: ${file} has no test named "${name}"`);
  }
});

test('the scan recognizes each way the code names a guard', () => {
  const ids = guardIdsInSource(`
    this._guardAdvisesFor(advisories, 'alpha-guard', 'A note (with parentheses).');
    if (this._guardRefusesOnce(tabId, flag ? 'beta-guard' : 'gamma-guard', { caveat: 'x' })) {}
    this._guardOutcome('delta-guard', { decided: false });
    guardAdvisory('epsilon-guard', note);
    return { id: 'zeta-guard', decided: true, caveat: 'y' };
    const OUTCOME_DOWNGRADING_GUARDS = new Set(['eta-guard', 'theta-guard']);
  _planGuardFindings(tabId) {
    add('iota-guard', true, 'z');
  }
`);
  assert.deepEqual([...ids.keys()].sort(), ['alpha-guard', 'beta-guard', 'delta-guard', 'epsilon-guard', 'eta-guard',
    'gamma-guard', 'iota-guard', 'theta-guard', 'zeta-guard']);
});
