// Time budgets for browser suites.
//
// Browser suites launch Chromium or Firefox and drive real pages, so their
// wall-clock time grows with the load on the machine. In the 2026-11-07 QA
// run, parallel sweeps ran them 1.5-3.7x slower than on an idle machine, and
// tests with fixed budgets timed out after every one of their subtests had
// passed.
//
// The budgets written in the suites leave room for that kind of load. On a
// slower or busier runner, WEBBRAIN_TEST_TIMEOUT_SCALE multiplies all of them
// at once, without editing any test:
//
//   WEBBRAIN_TEST_TIMEOUT_SCALE=2 node --test test/page-monitor-dialog.mjs
//
// Apply scaled() only to a wait for something that must happen: a test's
// budget, a waitForFunction for an event the page must deliver. Never apply
// it to a wait whose expiry is the expected result, or to a bound that is
// itself the behaviour under test (such as "capture stays under 3 s"): those
// must not stretch with the machine.

export const TIMEOUT_SCALE_VARIABLE = 'WEBBRAIN_TEST_TIMEOUT_SCALE';

// Unset or empty means 1. Anything else must be a positive number; a typo
// fails loudly instead of silently running with the default budgets.
export function parseTimeoutScale(value) {
  if (value === undefined || String(value).trim() === '') return 1;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new RangeError(`${TIMEOUT_SCALE_VARIABLE} must be a positive number, not ${JSON.stringify(value)}.`);
  return scale;
}

export const TIMEOUT_SCALE = parseTimeoutScale(process.env[TIMEOUT_SCALE_VARIABLE]);

export function scaled(ms, scale = TIMEOUT_SCALE) {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`A time budget must be a positive number of milliseconds, not ${ms}.`);
  return Math.ceil(ms * scale);
}

// One browser subtest, which may open its own context and page:
// about 1-2.5 s on an idle machine, up to 5.4 s seen under load.
export const BROWSER_CASE_MS = 6000;
// The parent's own work between its subtests.
export const SUITE_FIXED_MS = 15000;

// A parent test's budget grows with its number of subtests, so adding cases
// to a long suite does not quietly eat the headroom of the ones already there.
export function suiteTimeout(cases, { perCase = BROWSER_CASE_MS, fixed = SUITE_FIXED_MS, scale = TIMEOUT_SCALE } = {}) {
  if (!Number.isInteger(cases) || cases < 1) throw new RangeError(`A suite budget needs a positive whole number of cases, not ${cases}.`);
  return scaled(fixed + cases * perCase, scale);
}

// Waits at most ms for work whose result is only diagnostic, such as evidence
// gathered before an abort. A page that has stopped answering must not hang
// the harness that is reporting on it: on a timeout or an error this settles
// with { unavailable: reason } instead.
export async function within(work, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: `no answer within ${ms} ms` }), ms); }),
    ]);
  } catch (error) {
    return { unavailable: error?.message || String(error) };
  } finally { clearTimeout(timer); }
}
