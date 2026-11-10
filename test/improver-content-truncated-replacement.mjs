import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';

// A field value reaches the model only as a shortened preview (a tree line
// shows 60 characters plus "...", trimmed context gets a truncation marker).
// Writing that preview back as the replacement must be refused before any
// dispatch, in both builds. Firefox's content scripts run in Chromium here
// (the only installed engine); no external page is contacted.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILDS = ['chrome', 'firefox'];
const contentSource = build => fs.readFileSync(path.join(ROOT, 'src', build, 'src/content/content.js'), 'utf8');

function helperBlock(source) {
  const start = source.indexOf('  const TRUNCATED_PREVIEW_MIN_PREFIX');
  const end = source.indexOf('\n  }\n', source.indexOf('function _truncatedPreviewValueFailure(', start)) + 4;
  assert.ok(start >= 0 && end > start, 'the truncated-preview helpers should remain independently testable');
  return source.slice(start, end);
}

function pureHelper(build) {
  const source = contentSource(build);
  const start = source.indexOf('  const TRUNCATED_PREVIEW_MIN_PREFIX');
  const end = source.indexOf('  // Checked before anything is typed', start);
  return vm.runInNewContext(`(() => { ${source.slice(start, end)}; return _truncatedPreviewReplacement; })()`);
}

// The runtime's own cut markers, as content.js lists them.
function listedMarkers(build) {
  const source = contentSource(build);
  const start = source.indexOf('const TRUNCATED_PREVIEW_MARKERS');
  return [...source.slice(start, source.indexOf(']);', start)).matchAll(/^ {4}'([^']+)',$/gm)].map(match => match[1]);
}

// Every bracketed "truncated" marker a runtime string literal appends, with
// an ellipsis the runtime puts in front of it and ${} for a computed part.
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : entry.name.endsWith('.js') ? [full] : [];
});
function runtimeMarkers({ withContentScript }) {
  const found = new Set();
  for (const build of BUILDS) {
    for (const file of walk(path.join(ROOT, 'src', build, 'src'))) {
      let text = fs.readFileSync(file, 'utf8');
      if (file.endsWith(path.join('content', 'content.js'))) {
        if (!withContentScript) continue;
        // The list itself is not a source of markers.
        const start = text.indexOf('const TRUNCATED_PREVIEW_MARKERS');
        text = text.slice(0, start) + text.slice(text.indexOf(']);', start));
      }
      for (const match of text.matchAll(/(?<=['"`]|\\n| )(\[[^\][\n'"`]*\btruncated\b[^\][\n'"`]*\])(?=['"`$\\])/g)) {
        const ellipsis = text.slice(match.index - 2, match.index) === '… ' ? '… ' : '';
        found.add(ellipsis + match[1].replace(/\$\{[^}]*\}/g, '${}'));
      }
    }
  }
  return found;
}

const LONG = 'Quarterly report draft. '
  + 'Revenue grew in every region; churn fell; hiring stays flat until the third quarter. '.repeat(5)
  + 'Final paragraph with the conclusions the reviewer asked for.';

test('both builds share one truncated-preview helper', () => {
  assert.equal(helperBlock(contentSource('firefox')), helperBlock(contentSource('chrome')));
});

// The markers that never end a cut copy of model-visible text a field could
// hold, and why. Every other marker the runtime appends must be listed.
const NOT_A_PREVIEW_ENDING = [
  [/^\[nested value truncated\]$/, 'replaces a whole nested WebMCP value'],
  [/^\[recorder-truncated, /, 'trace export files only'],
  [/^\[truncated \$\{\} chars for cloud persistence\]$/, 'the cloud bridge copy of a run, not model context'],
  [/^\[truncated in compare view\]$/, 'a trace compare-view label'],
  [/^\[tree truncated: /, 'follows whole tree lines; a field value in a tree is cut with "..."'],
];

test('the listed truncation markers are exactly the runtime\'s model-visible ones', () => {
  const listed = listedMarkers('chrome');
  assert.deepEqual(listedMarkers('firefox'), listed);
  assert.ok(listed.includes('[tool arguments truncated for session recovery]'));
  const excluded = marker => NOT_A_PREVIEW_ENDING.some(([pattern]) => pattern.test(marker));
  for (const marker of runtimeMarkers({ withContentScript: true })) {
    assert.ok(listed.includes(marker) !== excluded(marker), `${marker}: list it, or say why it never ends a cut copy`);
  }
  const appended = runtimeMarkers({ withContentScript: false });
  for (const marker of listed) assert.ok(appended.has(marker), `${marker} is not appended by the runtime`);
});

for (const build of BUILDS) {
  test(`${build}: a marked preview of the field's own value is recognized`, () => {
    const preview = pureHelper(build);
    const ax = LONG.slice(0, 60) + '...';
    assert.deepEqual({ ...preview(LONG, ax) }, { currentValueLength: LONG.length, previewLength: LONG.slice(0, 60).trim().length });
    assert.ok(preview(LONG, LONG.slice(0, 60) + '…'), 'a Unicode ellipsis is the same preview');
    assert.ok(preview(LONG, LONG.slice(0, 60) + ' ...  \n'), 'trailing whitespace after the ellipsis');
    assert.ok(preview(LONG, LONG.slice(0, 120) + '\n[...truncated to fit context]'), 'context-trimming marker');
    assert.ok(preview(LONG, LONG.slice(0, 120) + '\n[...result truncated]'), 'tool-result marker');
    assert.ok(preview(LONG.replace(/; /g, ';\r\n  '), LONG.slice(0, 90) + '...'), 'CRLF and whitespace runs normalize');
    assert.ok(preview('Ｆｕｌｌｗｉｄｔｈ value text that keeps going for a while longer', 'Fullwidth value text...'), 'NFKC');
    assert.ok(preview('Zero\u200bwidth joiners stay invisible in a long field value here', 'Zerowidth joiners stay invisible...'));

    assert.equal(preview(LONG, LONG), null, 'the complete value is not a preview');
    assert.equal(preview(LONG, LONG.slice(0, 60)), null, 'an unmarked prefix is not flagged');
    assert.equal(preview(LONG, 'Quarterly report...'), null, 'a prefix under 20 characters is too weak');
    assert.equal(preview(LONG, 'A different summary of the whole report...'), null, 'not the start of the value');
    assert.equal(preview(LONG, LONG.slice(0, LONG.length - 6) + '...'), null, 'only a few hidden characters');
    assert.equal(preview(LONG + '...', LONG + '...'), null, 'rewriting a value that itself ends in an ellipsis');
    assert.equal(preview('', LONG.slice(0, 60) + '...'), null, 'an empty field loses nothing');
    assert.equal(preview(LONG, ''), null);
  });

  test(`${build}: only the runtime's own markers at the end mark a preview`, () => {
    const preview = pureHelper(build);
    // A pasted log keeps its own truncation note; rewriting the field around
    // it is an ordinary edit, as is an edit after it.
    const body = 'Steps to reproduce: run the build on CI.\nLog:\n```\nnpm ERR! code 1\n[... 312 lines truncated ...]\n'
      + 'npm ERR! exit status 1\n```\nExpected: build passes.';
    assert.equal(preview(body, body + '\n\nUpdate: fixed in #42.'), null);
    assert.equal(preview(body, body.replace('Expected: build passes.', 'Expected: the build passes on Node 22.')), null);
    assert.equal(preview(body, body.slice(0, body.indexOf('[...')) + '[... 312 lines truncated ...]'), null,
      'a note that is not one of the runtime markers');
    // A runtime marker that is not at the end is ordinary text too.
    const notes = 'Output of the job:\nline 1\nline 2\n[...result truncated]\nfooter text written by the user here';
    assert.equal(preview(notes, notes + '\nnew line'), null);
    // The same marker at the same place in the field is the field's own text.
    assert.equal(preview(notes, notes.slice(0, notes.indexOf('\nfooter'))), null);
    // Each exact runtime marker at the end of a cut copy is a preview.
    const markers = listedMarkers(build);
    for (const marker of markers) {
      assert.ok(preview(LONG, LONG.slice(0, 90) + '\n' + marker), marker);
      assert.equal(preview(LONG, LONG.slice(0, 90) + '\n' + marker + ' and more'), null, `${marker} not at the end`);
    }
    // A tool-call argument cut by session recovery and sent again.
    assert.ok(preview(LONG, LONG.slice(0, 120) + '[tool arguments truncated for session recovery]'));
  });

  test(`${build}: a preview copied with the tree's escapes is still a preview`, () => {
    const preview = pureHelper(build);
    const quoted = 'He said "please ship the release candidate today" and then left the meeting early.';
    assert.ok(preview(quoted, 'He said \\"please ship the release candidate today\\" and then...'), 'escaped quotes');
    const windowsPath = 'Copy C:\\Users\\jane\\report.docx to the shared drive before the review on Friday.';
    assert.ok(preview(windowsPath, 'Copy C:\\\\Users\\\\jane\\\\report.docx to the...'), 'escaped backslashes');
    // A value that really holds the escapes is compared as written.
    const literal = 'Use \\"quoted\\" strings in the JSON payload for every request you send.';
    assert.ok(preview(literal, 'Use \\"quoted\\" strings in the JSON...'));
    assert.equal(preview(literal, literal), null);
  });

  test(`${build}: the preview check runs before every clearing write`, () => {
    const source = contentSource(build);
    const between = (from, to) => {
      const start = source.indexOf(from);
      const end = source.indexOf(to, start + from.length);
      assert.ok(start >= 0 && end > start, `${build}: ${from} … ${to}`);
      return source.slice(start, end);
    };
    const before = (body, first, ...laters) => {
      const index = body.indexOf(first);
      assert.ok(index >= 0, `${build}: missing ${first}`);
      for (const later of laters) {
        const laterIndex = body.indexOf(later);
        assert.ok(laterIndex > index, `${build}: ${first} must precede ${later}`);
      }
    };
    const setField = between("'set_field': async () => {", build === 'chrome' ? "'ax_resolve_rect':" : "'hover':");
    before(setField, 'const truncatedPreview = clear && !recoveringDraft', 'window.__wbPageMonitor?.beforeLocalDispatch();',
      'setter.call(el, newVal)', '_insertContentEditableText(el, text, clear',
      ...(build === 'chrome' ? ["'set_field_contenteditable_trusted'"] : ['msg.params?._bidiPrepare']));
    const typeAx = between("'type_ax': async () => {", "'set_field': async () => {");
    before(typeAx, 'const truncatedPreview = clear && msg.enforceActionGuards !== false ?', 'window.__wbPageMonitor?.beforeLocalDispatch();',
      'setter.call(el, newVal)', '_insertContentEditableText(el, text, !!clear',
      ...(build === 'chrome' ? ["'type_ax_contenteditable_trusted'"] : ['msg.params?._bidiPrepare']));
    const typeText = between('async function _typeTextInner(', '\n  function findText(');
    before(typeText, "const truncatedPreview = params.clear && enforceActionGuards ?", "_withTypingPreparation('focus', el, () => el.focus());",
      'withLocalPageDispatch(', '_insertContentEditableText(el, typedText',
      ...(build === 'firefox' ? ['params._bidiPrepare && !(el instanceof HTMLSelectElement)'] : []));
  });
}

test('chrome: trusted type_text asks the page before select-all clears the field', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/chrome/src/agent/agent.js'), 'utf8');
  const start = source.indexOf("    trustedTypeText: if (name === 'type_text') {\n      try {\n        await cdpClient.attach(tabId);");
  const end = source.indexOf('type_text: internal — no branch matched', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const check = block.indexOf("action: 'check_truncated_replacement'");
  assert.ok(check > 0);
  for (const dispatch of ["sendFocusedTarget('prepare_focused_type_dispatch'", 'cdpClient.typeText(', "commands: ['selectAll']", "'Input.insertText'"]) {
    assert.ok(block.indexOf(dispatch) > check, `the check must precede ${dispatch}`);
  }
  assert.match(contentSource('chrome'), /'check_truncated_replacement': \(\) => _checkTruncatedReplacement\(msg\.params \|\| \{\}\)/);
});

// ── Live pages with both builds' real content scripts ─────────────────────
const call = (page, action, params = {}, enforceActionGuards = true) => page.evaluate(message => new Promise(resolve => {
  for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
}), { target: 'content', action, params, enforceActionGuards });

async function fixture(build) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('https://owned-truncated-preview.invalid/edit');
  await page.setContent(`<!doctype html><style>textarea,input,#rich{display:block;width:700px}textarea{height:160px}#rich{min-height:80px}</style>
    <form id="form" onsubmit="return false"><label for="notes">Notes</label><textarea id="notes" name="notes"></textarea>
    <label for="title">Title</label><input id="title" name="title">
    <div id="rich" contenteditable="true" role="textbox" aria-label="Body"></div></form>`);
  await page.evaluate(long => {
    document.getElementById('notes').value = long;
    document.getElementById('title').value = long.slice(0, 150);
    document.getElementById('rich').textContent = long;
    window.fixtureHandlers = [];
    const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
    window.chrome = { runtime }; window.browser = { runtime };
    window.inputs = 0;
    document.addEventListener('input', () => window.inputs++, true);
    document.addEventListener('beforeinput', () => window.inputs++, true);
  }, LONG);
  for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
    await page.addScriptTag({ content: await readFile(path.join(ROOT, 'src', build, 'src/content', file), 'utf8') });
  }
  const tree = await page.evaluate(() => __generateAccessibilityTree('all', 15, 6000).pageContent);
  const line = id => tree.split('\n').find(text => text.includes(`dom_id="${id}"`)) || '';
  const ref = id => line(id).match(/\[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
  const shown = id => line(id).match(/ value="((?:[^"\\]|\\.)*)"/)?.[1].replace(/\\(.)/g, '$1');
  const values = () => page.evaluate(() => ({
    notes: document.getElementById('notes').value,
    title: document.getElementById('title').value,
    rich: document.getElementById('rich').textContent,
    inputs: window.inputs,
  }));
  return { browser, page, ref, shown, values };
}

const assertRefused = (result, length, label) => {
  assert.equal(result.success, false, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.noDispatch, true, label);
  assert.equal(result.dispatched, false, label);
  assert.equal(result.errorCode, 'truncated_value_replacement', label);
  assert.equal(result.recoveryRequired, 'read_full_value', label);
  assert.equal(result.currentValueLength, length, label);
  assert.match(result.error, /shortened preview/, label);
  assert.equal(result.bidiPrepared, undefined, label);
};

for (const build of BUILDS) {
  test(`${build}: set_field, type_ax and typing refuse the tree's own preview and keep the field`, async () => {
    const f = await fixture(build);
    try {
      const before = await f.values();
      const notesPreview = f.shown('notes');
      assert.equal(notesPreview, LONG.slice(0, 60) + '...', 'the tree shows a 60-character preview');
      assertRefused(await call(f.page, 'set_field', { ref_id: f.ref('notes'), text: notesPreview }), LONG.length, 'set_field');
      assertRefused(await call(f.page, 'set_field', { ref_id: f.ref('notes'), text: notesPreview, submit: true }), LONG.length, 'set_field submit');
      assertRefused(await call(f.page, 'set_field', {
        ref_id: f.ref('notes'), text: LONG.slice(0, 200) + '\n[...truncated to fit context]',
      }), LONG.length, 'set_field with a context marker');
      assertRefused(await call(f.page, 'type_ax', { ref_id: f.ref('title'), text: f.shown('title'), clear: true }), 150, 'type_ax');
      assertRefused(await call(f.page, 'type', { selector: '#notes', text: notesPreview, clear: true }), LONG.length, 'type_text');
      assertRefused(await call(f.page, 'set_field', { ref_id: f.ref('rich'), text: f.shown('rich') }), LONG.length, 'contenteditable');
      if (build === 'firefox') {
        // Trusted (BiDi) input is prepared by the same handlers; a refusal
        // must come before the target is handed over.
        assertRefused(await call(f.page, 'set_field', { ref_id: f.ref('notes'), text: notesPreview, _bidiPrepare: randomUUID() }), LONG.length, 'bidi set_field');
        assertRefused(await call(f.page, 'type_ax', { ref_id: f.ref('notes'), text: notesPreview, clear: true, _bidiPrepare: randomUUID() }), LONG.length, 'bidi type_ax');
        assertRefused(await call(f.page, 'type', { selector: '#notes', text: notesPreview, clear: true, _bidiPrepare: randomUUID() }), LONG.length, 'bidi type_text');
        const prepared = await call(f.page, 'set_field', { ref_id: f.ref('notes'), text: 'A complete replacement text for the notes.', _bidiPrepare: randomUUID() });
        assert.equal(prepared.bidiPrepared, true, JSON.stringify(prepared));
      } else {
        assertRefused(await call(f.page, 'check_truncated_replacement', { selector: '#notes', text: notesPreview }), LONG.length, 'chrome trusted type_text check');
        assert.deepEqual(await call(f.page, 'check_truncated_replacement', { selector: '#notes', text: LONG + ' Approved.' }), { success: true });
      }
      assert.deepEqual(await f.values(), before, 'nothing was typed and no input event fired');

      // Appending is not a replacement, and a complete new value still goes in.
      const appended = await call(f.page, 'type_ax', { ref_id: f.ref('title'), text: ' (v2)', clear: false });
      assert.equal(appended.success, true, JSON.stringify(appended));
      const replaced = await call(f.page, 'set_field', { ref_id: f.ref('notes'), text: LONG + ' Approved.' });
      assert.equal(replaced.success, true, JSON.stringify(replaced));
      assert.equal(replaced.verified, true);
      const after = await f.values();
      assert.equal(after.title, LONG.slice(0, 150) + ' (v2)');
      assert.equal(after.notes, LONG + ' Approved.');
      const args = { ref_id: f.ref('notes'), text: notesPreview, enforceActionGuards: false };
      assertRefused(await call(f.page, 'set_field', args), after.notes.length, 'a model tool argument cannot disable the guard');
      assert.equal((await call(f.page, 'set_field', args, false)).success, true);
      assert.equal((await f.values()).notes, notesPreview);
    } finally { await f.browser.close(); }
  });
}

test('chrome: agent type_text refuses the preview before any trusted input', async () => {
  const f = await fixture('chrome');
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
    globalThis.chrome = { tabs: { sendMessage: (_tabId, message) => call(f.page, message.action, message.params) } };
    const agent = new ChromeAgent({});
    agent._showAgentTarget = () => {};
    const preview = f.shown('notes');
    assertRefused(await agent.executeTool(10, 'type_text', { selector: '#notes', text: preview, clear: true }), LONG.length, 'selector');
    await f.page.locator('#notes').focus();
    assertRefused(await agent.executeTool(10, 'type_text', { text: preview, clear: true }), LONG.length, 'focused');
    assert.deepEqual(commands, [], 'no key or text reached the page');
    assert.equal((await f.values()).notes, LONG);

    // A complete replacement still goes through the trusted path.
    const result = await agent.executeTool(10, 'type_text', { text: 'A complete replacement text for the notes.', clear: true });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(commands.includes('Input.insertText'));
    assert.equal((await f.values()).notes, 'A complete replacement text for the notes.');
    await session.detach();
  } finally {
    Object.assign(cdpClient, originals);
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    await f.browser.close();
  }
});

for (const build of BUILDS) {
  test(`${build}: set_field refuses a preview copied from the tree with its escapes`, async () => {
    const f = await fixture(build);
    try {
      const quoted = 'He said "ship the \\ release candidate today" and then the meeting ended early, without a plan.';
      await f.page.evaluate(value => { document.getElementById('notes').value = value; }, quoted);
      const tree = await f.page.evaluate(() => __generateAccessibilityTree('all', 15, 6000).pageContent);
      const line = tree.split('\n').find(text => text.includes('dom_id="notes"')) || '';
      const escaped = line.match(/ value="((?:[^"\\]|\\.)*)"/)?.[1];
      assert.equal(escaped, 'He said \\"ship the \\\\ release candidate today\\" and then the me...', line);
      assertRefused(await call(f.page, 'set_field', { ref_id: f.ref('notes'), text: escaped }), quoted.length, 'escaped preview');
      assert.equal((await f.values()).notes, quoted);
    } finally { await f.browser.close(); }
  });

  // The legacy iframe_type fallback writes through executeScript in a frame
  // that has no content script; it asks the top frame's content script with
  // the value it read there, before its dispatch fence.
  test(`${build}: legacy iframe typing refuses a preview of the iframe field's value`, async () => {
    const browserInstance = await chromium.launch({ headless: true });
    const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
    try {
      const page = await browserInstance.newPage();
      await page.route('https://**.fixture.invalid/**', async route => {
        const host = new URL(route.request().url()).hostname;
        await route.fulfill({ contentType: 'text/html', body: host === 'top.fixture.invalid'
          ? '<!doctype html><iframe src="https://editor.fixture.invalid/" style="width:800px;height:300px"></iframe>'
          : '<!doctype html><textarea id="notes" style="width:700px;height:200px"></textarea>' });
      });
      await page.goto('https://top.fixture.invalid/');
      await page.waitForFunction(() => document.querySelector('iframe').contentWindow !== null);
      await page.waitForTimeout(100);
      const editor = page.frames().find(frame => frame.url().startsWith('https://editor.fixture.invalid/'));
      assert.ok(editor);
      await editor.evaluate(long => { document.getElementById('notes').value = long; }, LONG);
      await page.evaluate(() => {
        window.fixtureHandlers = [];
        const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
        window.chrome = { runtime }; window.browser = { runtime };
      });
      for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
        await page.addScriptTag({ content: await readFile(path.join(ROOT, 'src', build, 'src/content', file), 'utf8') });
      }
      const frames = new Map(page.frames().map((frame, index) => [index, frame]));
      assert.equal(frames.get(0), page.mainFrame());
      const evaluate = async (frame, func, args) => frame.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: String(func), args });
      const messages = [];
      const api = {
        webNavigation: { getAllFrames: async () => [...frames].map(([frameId, frame]) => ({ frameId, url: frame.url() })) },
        scripting: { executeScript: async ({ target, func, args = [] }) => Promise.all(
          [...frames].filter(([id]) => target.allFrames || target.frameIds?.includes(id))
            .map(async ([frameId, frame]) => ({ frameId, result: await evaluate(frame, func, args) }))) },
        tabs: {
          executeScript: async (_id, { allFrames, frameId, code }) => Promise.all(
            [...frames].filter(([id]) => allFrames || id === frameId).map(([, frame]) => frame.evaluate(code))),
          sendMessage: async (_id, message, options) => {
            messages.push({ action: message.action, frameId: options?.frameId });
            return call(page, message.action, message.params);
          },
        },
      };
      globalThis.chrome = api; globalThis.browser = api;
      const { RichTextToolbarProbe } = await import(`../src/${build}/src/agent/rich-text-toolbar-probe.js?truncated-preview=${build}`);
      const probe = new RichTextToolbarProbe({});
      const args = { selector: '#notes', clear: true, urlFilter: 'editor.fixture.invalid', matchIndex: 0 };
      let fences = 0;
      const beforeDispatch = async () => { fences++; };
      const refused = await probe.legacyIframeTypeAllFrames(1, { ...args, text: LONG.slice(0, 60) + '...' }, { beforeDispatch });
      assertRefused(refused, LONG.length, 'legacy iframe_type');
      assert.equal(refused.frameId, [...frames].find(([, frame]) => frame === editor)[0]);
      assert.deepEqual(messages, [{ action: 'check_truncated_replacement', frameId: 0 }]);
      assert.equal(fences, 0, 'no dispatch fence or write after the refusal');
      assert.equal(await editor.locator('#notes').inputValue(), LONG);
      await page.waitForTimeout(50);
      assert.equal(await editor.evaluate(() => [...document.getElementById('notes').attributes]
        .some(attribute => attribute.name.startsWith('data-webbrain-legacy-iframe-type-'))), false, 'the marker is cleaned up');

      // An append is not a replacement, and a complete new value still goes in.
      const appended = await probe.legacyIframeTypeAllFrames(1, { ...args, clear: false, text: ' Approved.' }, { beforeDispatch });
      assert.equal(appended.success, true, JSON.stringify(appended));
      const replaced = await probe.legacyIframeTypeAllFrames(1, { ...args, text: 'A complete replacement text for the notes.' }, { beforeDispatch });
      assert.equal(replaced.success, true, JSON.stringify(replaced));
      assert.equal(fences, 2);
      assert.equal(await editor.locator('#notes').inputValue(), 'A complete replacement text for the notes.');
    } finally {
      globalThis.chrome = originalChrome; globalThis.browser = originalBrowser;
      await browserInstance.close();
    }
  });
}

test('both builds ask before legacy iframe typing writes', () => {
  for (const build of BUILDS) {
    const source = fs.readFileSync(path.join(ROOT, 'src', build, 'src/agent/rich-text-toolbar-probe.js'), 'utf8');
    const start = source.indexOf('async legacyIframeTypeAllFrames(');
    const block = source.slice(start, source.indexOf('\n  async ', start + 10));
    const check = block.indexOf("action: 'check_truncated_replacement'");
    assert.ok(check > 0, build);
    assert.ok(block.indexOf("if (typeof beforeDispatch === 'function') await beforeDispatch(selected.frameId);") > check, build);
    assert.match(contentSource(build), /'check_truncated_replacement': \(\) => _checkTruncatedReplacement\(msg\.params \|\| \{\}\)/);
  }
});
