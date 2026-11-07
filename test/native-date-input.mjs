// Native <input type=date|time|datetime-local|month|week> fields and
// type_text, in both builds. Such a field draws its value in the browser's
// locale (20.11.2026 in Turkish, 11/20/2026 in US English) as segments that
// take keys in that order, and ignores inserted text: a vision run's
// type_text("20112026") into a Turkish-locale date field came back
// readback_mismatch six times and the booking never happened. type_text now
// reads the text as one ISO value (or a common written form) and sets it the
// way the browser's picker does, verifies the settled value, and refuses
// text it cannot read before touching the field.
//
// Real Chromium runs the Chrome build's content script and agent; real
// Firefox runs the Firefox build's content script, whose type action is the
// only type_text path in that build (with or without trusted BiDi input).
// Each runs under a Turkish and a US English locale. No external page is
// contacted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILDS = ['chrome', 'firefox'];
const contentSource = build => fs.readFileSync(path.join(ROOT, 'src', build, 'src/content/content.js'), 'utf8');

function helperBlock(source) {
  const start = source.indexOf('  // ── Native date and time fields');
  const end = source.indexOf('\n  }\n', source.indexOf('async function _fillNativeDateInput(', start)) + 4;
  assert.ok(start >= 0 && end > start, 'the native date helpers should stay one block');
  return source.slice(start, end);
}

function parser(build) {
  const source = contentSource(build);
  const start = source.indexOf('  const _NATIVE_DATE_INPUT_FORMATS');
  const end = source.indexOf('  // The native date or time type of an <input>', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`(() => { ${source.slice(start, end)}; return _parseNativeDateInputValue; })()`);
}

test('both builds share one native date helper block', () => {
  assert.equal(helperBlock(contentSource('firefox')), helperBlock(contentSource('chrome')));
  for (const build of BUILDS) {
    const source = contentSource(build);
    const typeStart = source.indexOf('async function _typeTextInner(');
    const hook = source.indexOf('if (nativeDateType) return _fillNativeDateInput(el, nativeDateType, typedText, actionDeadlineExpired);', typeStart);
    assert.ok(hook > typeStart, `${build}: type_text routes native date fields to the value path`);
    if (build === 'firefox') {
      assert.ok(hook < source.indexOf('if (params._bidiPrepare && !(el instanceof HTMLSelectElement))', typeStart),
        'Firefox: before the field is handed to trusted typing');
    }
    for (const write of ['nativeInputValueSetter', '_insertContentEditableText(el, typedText']) {
      assert.ok(hook < source.indexOf(write, typeStart), `${build}: before ${write}`);
    }
  }
});

const ACCEPTED = [
  ['date', '2026-11-20', '2026-11-20'],
  ['date', '2026/11/20', '2026-11-20'],
  ['date', 'November 20, 2026', '2026-11-20'],
  ['date', 'Nov. 20 2026', '2026-11-20'],
  ['date', 'Friday, November 20, 2026', '2026-11-20'],
  ['date', '20 November 2026', '2026-11-20'],
  ['date', 'the 20th of November, 2026', '2026-11-20'],
  ['date', '20-Nov-2026', '2026-11-20'],
  ['date', '20.11.2026', '2026-11-20'],
  ['date', '11/20/2026', '2026-11-20'],
  ['date', '5/5/2026', '2026-05-05'],
  ['date', 'Sept 3, 2026', '2026-09-03'],
  ['date', '2024-02-29', '2024-02-29'],
  ['date', '  ', ''],
  ['time', '14:30', '14:30'],
  ['time', '9:05', '09:05'],
  ['time', '2 pm', '14:00'],
  ['time', '2:30 P.M.', '14:30'],
  ['time', '12 am', '00:00'],
  ['time', '12pm', '12:00'],
  ['time', '14:30:00', '14:30'],
  ['time', '14:30:15.5', '14:30:15.500'],
  ['datetime-local', '2026-11-20T14:30', '2026-11-20T14:30'],
  ['datetime-local', '2026-11-20 14:30', '2026-11-20T14:30'],
  ['datetime-local', 'November 20, 2026 at 2:00 PM', '2026-11-20T14:00'],
  ['datetime-local', '20.11.2026 14:00', '2026-11-20T14:00'],
  ['month', '2026-11', '2026-11'],
  ['month', 'November 2026', '2026-11'],
  ['month', '11/2026', '2026-11'],
  ['week', '2026-W47', '2026-W47'],
  ['week', '2026w47', '2026-W47'],
  ['week', 'Week 47, 2026', '2026-W47'],
  ['week', '2026-W53', '2026-W53'],
  ['week', '2020-W53', '2020-W53'],
];

const REFUSED = [
  ['date', '20112026', /could not be read as one date/],
  ['date', '03/04/2026', /could be read day-first or month-first/],
  ['date', '2026-02-29', /is not a real date/],
  ['date', '2026-13-01', /is not a real date/],
  ['date', '31.04.2026', /is not a real date/],
  ['date', 'Monday, November 20, 2026', /weekday that date does not fall on/],
  ['date', '2026-11-20T14:30', /could not be read as one date/],
  ['date', 'next Friday', /could not be read as one date/],
  ['date', '20/11/26', /could not be read as one date/],
  ['time', '14', /could not be read as one time/],
  ['time', '24:00', /could not be read as one time/],
  ['time', '13 pm', /could not be read as one time/],
  ['datetime-local', '2026-11-20', /has no time of day/],
  ['datetime-local', 'Nov 20 2026 14', /could not be read as one date and time/],
  ['datetime-local', '03/04/2026 10:00', /could be read day-first or month-first/],
  ['month', '2026-13', /is not a real month/],
  ['month', 'Smarch 2026', /could not be read as one month/],
  ['week', '2025-W53', /is not a real week \(2025 has 52\)/],
  ['week', '2026-W00', /is not a real week/],
];

const FORMATS = { date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-Www' };

for (const build of BUILDS) {
  test(`${build}: the ISO value and common written forms read as one value`, () => {
    const parse = parser(build);
    for (const [type, text, value] of ACCEPTED) {
      assert.deepEqual({ ...parse(type, text) }, { value }, `${type} ${JSON.stringify(text)}`);
    }
  });

  test(`${build}: text that is not exactly one value is refused with the ISO format to use`, () => {
    const parse = parser(build);
    for (const [type, text, reason] of REFUSED) {
      const result = parse(type, text);
      assert.equal(result.value, undefined, `${type} ${JSON.stringify(text)} must not be guessed`);
      assert.match(result.error, reason, `${type} ${JSON.stringify(text)}`);
      assert.ok(result.error.includes(`Pass it as ${FORMATS[type]}`), result.error);
      assert.match(result.error, new RegExp(`<input type="${type}">`));
      assert.match(result.error, /Nothing was typed\.$/);
    }
  });
}

// ── Real browsers, real content scripts ──────────────────────────────────
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>Book a product demo</title>
<style>input{display:block;margin:6px 0}</style>
<form id="booking" onsubmit="return false">
  <label for="name">Your name</label><input id="name" name="name">
  <label for="date">Demo date</label><input id="date" name="date" type="date" required value="2026-01-05">
  <label for="time">Time</label><input id="time" name="time" type="time">
  <label for="when">Date and time</label><input id="when" name="when" type="datetime-local">
  <label for="month">Month</label><input id="month" name="month" type="month">
  <label for="week">Week</label><input id="week" name="week" type="week">
  <label for="early">Earliest date</label><input id="early" name="early" type="date" min="2027-01-01">
  <label for="locked">Locked date</label><input id="locked" name="locked" type="date">
  <label for="reverting">Reverting date</label><input id="reverting" name="reverting" type="date">
</form>`;

const call = (page, message) => page.evaluate(message => new Promise(resolve => {
  for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
}), message);
const type = (page, params) => call(page, { target: 'content', action: 'type', params });

async function fixture(launcher, build, locale) {
  const browser = await launcher.launch({ headless: true });
  const context = await browser.newContext({ locale, viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
  await page.goto('https://owned-native-date.invalid/booking');
  await page.evaluate(() => {
    window.fixtureHandlers = [];
    const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
    window.chrome = { runtime }; window.browser = { runtime };
    window.events = [];
    for (const el of document.querySelectorAll('input')) {
      for (const kind of ['input', 'change']) el.addEventListener(kind, () => events.push(`${el.id}:${kind}:${el.value}`));
    }
    // A controlled field whose page puts its own value back on input.
    const reverting = document.getElementById('reverting');
    reverting.addEventListener('input', () => setTimeout(() => { reverting.value = '2026-01-01'; }, 0));
    document.getElementById('locked').readOnly = true;
  });
  for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
    await page.addScriptTag({ content: await readFile(path.join(ROOT, 'src', build, 'src/content', file), 'utf8') });
  }
  const value = id => page.evaluate(id => document.getElementById(id).value, id);
  const events = () => page.evaluate(() => window.events.splice(0));
  return { browser, page, value, events };
}

const assertSet = (result, value, label) => {
  assert.equal(result.success, true, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.verified, true, label);
  assert.equal(result.dispatched, true, label);
  assert.equal(result.method, 'native-date-value', label);
  assert.equal(result.value, value, label);
  assert.equal(result.bidiPrepared, undefined, label);
};

const assertRefused = (result, pattern, label) => {
  assert.equal(result.success, false, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.noDispatch, true, label);
  assert.equal(result.dispatched, false, label);
  assert.match(result.error, pattern, label);
  assert.match(result.error, /Nothing was typed\./, label);
};

const ENGINES = [['chromium', chromium, 'chrome'], ['firefox', firefox, 'firefox']];

for (const [engine, launcher, build] of ENGINES) {
  for (const locale of ['tr-TR', 'en-US']) {
    test(`${engine} (${build} content script, ${locale}): type_text sets a native date field from ISO or written text`, async () => {
      const f = await fixture(launcher, build, locale);
      try {
        assert.equal(await f.page.evaluate(() => navigator.language), locale);
        assert.equal(await f.page.evaluate(() => document.getElementById('date').type), 'date');

        // Focused, as in vision mode: click the field, then type_text({text}).
        await f.page.locator('#date').focus();
        assertSet(await type(f.page, { text: '2026-11-20' }), '2026-11-20', 'ISO');
        assert.equal(await f.value('date'), '2026-11-20');
        assert.deepEqual(await f.events(), ['date:input:2026-11-20', 'date:change:2026-11-20'],
          'one input and one change, as the browser picker sends them');

        // The answer a user gives in words, and the order this locale shows.
        assertSet(await type(f.page, { text: 'December 3, 2026' }), '2026-12-03', 'written');
        assertSet(await type(f.page, { text: '20.11.2026', clear: true }), '2026-11-20', 'day-first');
        assert.equal(await f.value('date'), '2026-11-20');
        await f.events();

        // Text that is not one date leaves the field and fires nothing.
        for (const [text, pattern] of [['20112026', /could not be read as one date/], ['03/04/2026', /day-first or month-first/]]) {
          assertRefused(await type(f.page, { text }), pattern, text);
          assert.equal(await f.value('date'), '2026-11-20', `${text}: the field keeps its value`);
        }
        assert.deepEqual(await f.events(), [], 'no event for a refused value');

        // By selector, and clearing.
        assertSet(await type(f.page, { selector: '#date', text: 'Nov 21 2026', clear: true }), '2026-11-21', 'selector');
        assertSet(await type(f.page, { text: '', clear: true }), '', 'cleared');
        assert.equal(await f.value('date'), '');
        const cleared = await type(f.page, { selector: '#date', text: '', clear: true });
        assert.match(cleared.warning, /holds no value, but the page reports/, 'a required field left empty is flagged');

        // The other native types this browser supports.
        await f.page.locator('#time').focus();
        assertSet(await type(f.page, { text: '2 pm' }), '14:00', 'time');
        assert.equal(await f.value('time'), '14:00');
        await f.page.locator('#when').focus();
        assertSet(await type(f.page, { text: 'November 20, 2026 at 2:30 PM' }), '2026-11-20T14:30', 'datetime-local');
        assert.equal(await f.value('when'), '2026-11-20T14:30');
        for (const [id, text, expected] of [['month', 'November 2026', '2026-11'], ['week', '2026-W47', '2026-W47']]) {
          await f.page.locator(`#${id}`).focus();
          const supported = await f.page.evaluate(id => document.getElementById(id).type === id, id);
          const result = await type(f.page, { text, clear: true });
          if (supported) {
            assertSet(result, expected, id);
            assert.equal(await f.value(id), expected);
          } else {
            // A type the browser lacks is a text field: typed as text.
            assert.equal(result.success, true, JSON.stringify(result));
            assert.notEqual(result.method, 'native-date-value');
            assert.equal(await f.value(id), text);
          }
        }

        // Read back: a value outside the page's range is set and flagged; a
        // page that puts its own value back is reported as a mismatch.
        await f.page.locator('#early').focus();
        const early = await type(f.page, { text: '2026-11-20' });
        assertSet(early, '2026-11-20', 'out of range');
        assert.ok(early.pageValidation, JSON.stringify(early));
        await f.page.locator('#reverting').focus();
        const reverted = await type(f.page, { text: '2026-11-20' });
        assert.equal(reverted.success, false, JSON.stringify(reverted));
        assert.equal(reverted.dispatched, true);
        assert.equal(reverted.verified, false);
        assert.deepEqual(reverted.unverified, { reason: 'readback_mismatch', reader: 'exact' });
        assert.equal(reverted.actual, '2026-01-01');
        assert.equal(reverted.expectedValue, '2026-11-20');
        assert.equal(await f.value('reverting'), '2026-01-01');
        // (Firefox does not focus a read-only date field, so by selector.)
        assertRefused(await type(f.page, { selector: '#locked', text: '2026-11-20' }), /read-only/, 'read-only');
        assert.equal(await f.value('locked'), '');

        if (build === 'firefox') {
          // Trusted (BiDi) typing would send keys into the locale-ordered
          // segments: the field is set here and never handed over.
          await f.page.locator('#date').focus();
          assertSet(await type(f.page, { text: '2026-11-22', _bidiPrepare: randomUUID() }), '2026-11-22', 'BiDi run');
          assert.equal(await f.page.evaluate(() => document.querySelector('[data-webbrain-bidi]')), null);
          assertRefused(await type(f.page, { text: '22112026', _bidiPrepare: randomUUID() }), /YYYY-MM-DD/, 'BiDi refused');
          assert.equal(await f.value('date'), '2026-11-22');
          // An ordinary text field still goes to trusted typing.
          await f.page.locator('#name').focus();
          assert.equal((await type(f.page, { text: 'test account A', _bidiPrepare: randomUUID() })).bidiPrepared, true);
        }
      } finally { await f.browser.close(); }
    });
  }
}

// ── The Chrome agent's type_text ─────────────────────────────────────────
// Chrome types type_text with trusted CDP input (Input.insertText), which a
// native date field ignores. On all three of its paths (the focused field,
// a focused field bound by the toolbar check, a selector) a date field now
// goes to the content script's value path and no text input is sent.
test('chrome agent: type_text fills a native date field without inserting text, in a Turkish locale', async () => {
  const f = await fixture(chromium, 'chrome', 'tr-TR');
  const originals = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
  const originalChrome = globalThis.chrome;
  const commands = [];
  try {
    const session = await f.page.context().newCDPSession(f.page);
    cdpClient.attach = async () => ({ attached: true });
    cdpClient.sendCommand = async (_tab, method, params, _sessionId, options) => {
      options?.beforeSend?.();
      if (method.startsWith('Input.')) commands.push(method);
      return session.send(method, params);
    };
    const messages = [];
    globalThis.chrome = { tabs: { sendMessage: (_tabId, message) => {
      messages.push(message.action);
      return call(f.page, message);
    } } };
    const agent = new ChromeAgent({});
    agent._showAgentTarget = () => {};

    // The vision path: the field was clicked, the user said "November 20, 2026".
    await f.page.locator('#date').focus();
    const focused = await agent.executeTool(10, 'type_text', { text: 'November 20, 2026' });
    assertSet(focused, '2026-11-20', 'focused');
    assert.equal(await f.value('date'), '2026-11-20');
    assert.ok(messages.includes('type'), 'the content script set the value');

    // What the model typed in the failing run, reading the screen's order.
    const refused = await agent.executeTool(10, 'type_text', { text: '20112026' });
    assert.equal(refused.success, false, JSON.stringify(refused));
    assert.equal(refused.noDispatch, true);
    assert.match(refused.error, /YYYY-MM-DD/);
    assert.equal(await f.value('date'), '2026-11-20');

    // A focused field bound by the rich-text toolbar check.
    const probe = await call(f.page, { target: 'content', action: 'probe_rich_text_toolbar_retry_target',
      params: { toolName: 'type_text', args: { text: '2026-11-21' } } });
    assert.ok(probe.dispatchBinding?.token, JSON.stringify(probe));
    const bound = await agent.executeTool(10, 'type_text', { text: '2026-11-21', clear: true }, null,
      { dispatchBinding: { token: probe.dispatchBinding.token, frameId: 0 } });
    assertSet(bound, '2026-11-21', 'bound');
    assert.equal(await f.value('date'), '2026-11-21');

    // By selector, with the field not focused.
    await f.page.locator('#name').focus();
    const selector = await agent.executeTool(10, 'type_text', { selector: '#date', text: '2026-11-22', clear: true });
    assertSet(selector, '2026-11-22', 'selector');
    assert.equal(await f.value('date'), '2026-11-22');
    assert.equal(await f.page.evaluate(() => document.querySelector('[data-webbrain-dispatch-binding]')), null,
      'the selector marker is cleaned up');

    assert.deepEqual(commands.filter(method => method === 'Input.insertText' || method === 'Input.dispatchKeyEvent'), [],
      'no trusted text or key reached a date field');

    // An ordinary text field still gets trusted typing.
    await f.page.locator('#name').focus();
    const name = await agent.executeTool(10, 'type_text', { text: 'test account A' });
    assert.equal(name.success, true, JSON.stringify(name));
    assert.ok(commands.includes('Input.insertText'));
    assert.equal(await f.value('name'), 'test account A');
    await session.detach();
  } finally {
    Object.assign(cdpClient, originals);
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    await f.browser.close();
  }
});

test('the type_text descriptions name the ISO forms in both builds', async () => {
  for (const build of BUILDS) {
    const tools = await import(`../src/${build}/src/agent/tools.js`);
    const visionTools = await import(`../src/${build}/src/agent/vision-tools.js`);
    const base = tools.getToolsForMode('act', { tier: 'full' }).find(tool => tool.function.name === 'type_text');
    const vision = visionTools.buildVisionToolSet([base]).find(tool => tool.function.name === 'type_text');
    for (const description of [base.function.description, vision.function.description]) {
      assert.match(description, /native date or time field/, build);
      for (const format of ['YYYY-MM-DD', 'HH:MM (24-hour)', 'YYYY-MM-DDTHH:MM', 'YYYY-MM', 'YYYY-Www']) {
        assert.ok(description.includes(format), `${build}: ${format}`);
      }
    }
  }
});
