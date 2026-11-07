// The shared time budgets of the browser suites, and the per-file browsers
// they lease from. No real browser is launched here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { BROWSER_CASE_MS, SUITE_FIXED_MS, parseTimeoutScale, scaled, suiteTimeout, within } from './lib/time-budget.mjs';

const budgetModule = new URL('./lib/time-budget.mjs', import.meta.url).href;

test('WEBBRAIN_TEST_TIMEOUT_SCALE defaults to 1 and accepts only a positive number', () => {
  assert.equal(parseTimeoutScale(undefined), 1);
  assert.equal(parseTimeoutScale(''), 1);
  assert.equal(parseTimeoutScale(' '), 1);
  assert.equal(parseTimeoutScale('2'), 2);
  assert.equal(parseTimeoutScale('1.5'), 1.5);
  assert.equal(parseTimeoutScale('0.5'), 0.5);
  for (const value of ['0', '-1', 'two', 'Infinity', 'NaN', '2x'])
    assert.throws(() => parseTimeoutScale(value), /WEBBRAIN_TEST_TIMEOUT_SCALE must be a positive number/, value);
});

test('the scale reaches every budget through the environment, and a typo fails loudly', () => {
  const read = scale => execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(budgetModule)}); console.log(JSON.stringify([m.TIMEOUT_SCALE, m.scaled(1000), m.suiteTimeout(2)]));`],
  { env: { ...process.env, WEBBRAIN_TEST_TIMEOUT_SCALE: scale }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(read('3')), [3, 3000, 3 * (SUITE_FIXED_MS + 2 * BROWSER_CASE_MS)]);
  assert.deepEqual(JSON.parse(read('')), [1, 1000, SUITE_FIXED_MS + 2 * BROWSER_CASE_MS]);
  assert.throws(() => read('fast'), error => /must be a positive number, not "fast"/.test(String(error.stderr)));
});

test('scaled budgets round up to whole milliseconds and refuse a missing budget', () => {
  assert.equal(scaled(1000, 2), 2000);
  assert.equal(scaled(1000, 1.0005), 1001);
  for (const ms of [0, -5, NaN, undefined]) assert.throws(() => scaled(ms, 1), RangeError);
});

test('a parent budget grows with its number of subtests', () => {
  assert.equal(suiteTimeout(1, { scale: 1 }), SUITE_FIXED_MS + BROWSER_CASE_MS);
  assert.equal(suiteTimeout(49, { scale: 1 }) - suiteTimeout(48, { scale: 1 }), BROWSER_CASE_MS);
  assert.equal(suiteTimeout(10, { perCase: 1000, fixed: 5000, scale: 2 }), 30000);
  // The 49 Firefox upload-release cases used 112 s of a fixed 120 s under load.
  assert.ok(suiteTimeout(49, { scale: 1 }) >= 2 * 112000);
  for (const cases of [0, -1, 1.5, NaN]) assert.throws(() => suiteTimeout(cases), RangeError);
});

test('diagnostic reads settle instead of hanging on a page that stopped answering', async () => {
  assert.equal(await within(() => 'value', 1000), 'value');
  assert.deepEqual(await within(() => new Promise(() => {}), 20), { unavailable: 'no answer within 20 ms' });
  assert.deepEqual(await within(async () => { throw new Error('page closed'); }, 1000), { unavailable: 'page closed' });
});

// A Playwright-shaped engine whose browsers record what is opened and closed.
function fakeEngine(name) {
  const engine = { name: () => name, browsers: [] };
  engine.launch = async options => {
    const browser = { options, closed: 0, contexts: [], async close() { this.closed++; } };
    const open = () => {
      const context = Object.assign(new EventEmitter(), { browser, closed: false,
        async close() { if (!this.closed) { this.closed = true; this.emit('close'); } } });
      browser.contexts.push(context);
      return context;
    };
    browser.newContext = async () => open();
    browser.newPage = async () => { const context = open(); return { context: () => context }; };
    engine.browsers.push(browser);
    return browser;
  };
  return engine;
}
const fake = fakeEngine('fake'), rotating = fakeEngine('rotating');
const browsers = sharedBrowsers([fake]);
const rotatingBrowsers = sharedBrowsers([rotating], { headless: true }, { contextsPerBrowser: 2 });

test('leases share the browser launched before the first test', async () => {
  await browsers.lease(fake); await browsers.lease(fake);
  assert.equal(fake.browsers.length, 1);
  assert.deepEqual(fake.browsers[0].options, { headless: true });
  await assert.rejects(browsers.lease(fakeEngine('other')), /No shared other is running/);
});

test("a lease's close closes the contexts opened through it, and only those", async () => {
  const first = await browsers.lease(fake), second = await browsers.lease(fake);
  const a = await first.newContext(), page = await first.newPage(), b = await second.newContext();
  const closedEarly = await first.newContext(); await closedEarly.close();
  await first.close();
  assert.deepEqual([a.closed, page.context().closed, b.closed, closedEarly.closed], [true, true, false, true]);
  await first.close(); // closing twice is harmless
  await second.close();
  assert.equal(b.closed, true);
  assert.ok(fake.browsers[0].contexts.every(context => context.closed));
  assert.equal(fake.browsers[0].closed, 0, 'The shared browser stays up for the next test');
});

test('a browser that has served its contexts is replaced, and closes after its last lease', async () => {
  const held = await rotatingBrowsers.lease(rotating);
  await held.newContext(); await held.newContext();
  const next = await rotatingBrowsers.lease(rotating);
  assert.equal(rotating.browsers.length, 2, 'The next lease gets a fresh browser');
  assert.equal((await next.newContext()).browser, rotating.browsers[1]);
  assert.equal(rotating.browsers[0].closed, 0, 'A browser still leased is not closed under its test');
  await held.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rotating.browsers[0].closed, 1, 'The replaced browser closes once its last lease is done');
  await next.close();
  assert.equal(rotating.browsers[1].closed, 0);
});
