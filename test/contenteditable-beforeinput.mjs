import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: a cancelled beforeinput reports page-handled changes without duplicating text`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route('https://owned-beforeinput.invalid/**', route => route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><h1>Owned app-handled editor</h1><div id="editor" role="textbox" aria-label="Owned editor" contenteditable="true" style="white-space:pre-wrap"></div>' }));
      await page.goto('https://owned-beforeinput.invalid/editor');
      await page.evaluate(build => {
        window[build === 'firefox' ? 'browser' : 'chrome'] = { runtime: { getURL: value => value, onMessage: { addListener: handler => { window.qaHandler = handler; } } } };
        window.qaCall = (action, params, actionDeadlineAt = 0) => new Promise(resolve => qaHandler({ target: 'content', action, params, actionDeadlineAt }, {}, resolve));
        window.qaMode = 'unchanged'; window.qaModel = ''; window.qaCommands = [];
        const nativeCommand = document.execCommand.bind(document);
        document.execCommand = (...args) => { qaCommands.push(args[0]); return nativeCommand(...args); };
        window.qaReset = () => { history.replaceState(null, '', '/editor'); const editor = document.querySelector('#editor'); editor.textContent = 'Owned original draft'; qaModel = editor.textContent; qaCommands = []; };
        document.addEventListener('beforeinput', event => {
          if (event.target.id !== 'editor') return;
          event.preventDefault();
          if (qaMode === 'unchanged') return;
          const apply = () => {
            qaModel = event.data + (qaMode === 'mismatch' ? ' unexpected suffix' : '');
            const target = qaMode === 'replacement' ? event.target.cloneNode(false) : event.target;
            target.textContent = qaModel;
            if (qaMode === 'replacement') event.target.replaceWith(target);
            if (qaMode === 'route-change') history.replaceState(null, '', '/another-editor');
          };
          if (qaMode === 'microtask') queueMicrotask(apply);
          else if (qaMode === 'timer') setTimeout(apply, 15);
          else apply();
        });
        qaReset();
      }, build);
      for (const file of ['accessibility-tree.js', 'rich-text-toolbar-heuristic.js', 'content.js']) {
        await page.addScriptTag({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
      }
      const body = 'App-handled literal <b>text</b> & 🧠 ıİşŞğĞüÜöÖçÇ.\n\nExact final line.';
      for (const mode of ['unchanged', 'sync', 'microtask', 'timer', 'mismatch', 'replacement', 'route-change', 'deadline']) await t.test(mode, async () => {
        await page.evaluate(mode => { qaMode = mode; qaReset(); }, mode);
        const tree = await page.evaluate(() => qaCall('get_accessibility_tree', { filter: 'all' }));
        const ref = tree.pageContent.match(/textbox "Owned editor" \[(ref_\d+)\]/)?.[1]; assert.ok(ref);
        const result = await page.evaluate(({ ref, body, mode }) => qaCall('set_field', { ref_id: ref, text: body, clear: true }, mode === 'deadline' ? Date.now() + 40 : 0), { ref, body, mode });
        assert.deepEqual(await page.evaluate(() => qaCommands), [], 'A page-handled/cancelled edit must never issue another native insertion.');
        if (mode === 'unchanged') {
          assert.equal(result.success, false); assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false); assert.equal(result.outcomeUnknown, false);
          assert.equal(await page.evaluate(() => qaModel), 'Owned original draft');
        } else if (['sync', 'microtask', 'timer'].includes(mode)) {
          assert.equal(await page.evaluate(() => qaModel), body, 'The real application handled the complete requested text.');
          assert.equal(result.noDispatch, undefined, 'An actual page-handled change cannot be labelled no dispatch.');
          assert.equal(result.dispatched, true); assert.equal(result.success, true); assert.equal(result.verified, true); assert.notEqual(result.outcomeUnknown, true);
          assert.equal(result.pageHandledBeforeInput, true);
        } else {
          assert.equal(result.success, false); assert.equal(result.dispatched, true); assert.equal(result.outcomeUnknown, true);
          assert.notEqual(result.noDispatch, true); assert.equal(result.retryable, false);
          if (mode === 'deadline') assert.equal(result.deadlineExpired, true);
        }
      });
    } finally { await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: page-handled cancelled native chat text verifies without preparing another dispatch`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.route('https://web.whatsapp.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>
body{font:16px sans-serif}#main{width:900px}header{height:60px}[data-testid="conversation-panel-messages"]{height:200px}
[contenteditable]{height:40px;white-space:pre-wrap;border:1px solid black}</style>
<div id="main" data-testid="conversation-panel-wrapper" role="dialog" aria-modal="true"><header data-testid="conversation-header"><div role="button" data-testid="conversation-info-header">
<span data-testid="conversation-info-header-chat-title">Owned QA</span><span data-testid="you-label">(You)</span></div></header>
<div data-testid="conversation-panel-body"><div data-testid="conversation-panel-messages"></div></div><footer>
<div id="editor" aria-label="Message" data-testid="conversation-compose-box-input" contenteditable="true" role="textbox" data-tab="10"></div>
<div id="composer-action-wrap"><button id="composer-action" type="button" aria-label="Voice message">Voice</button></div></footer></div><aside id="owned-sidebar">Owned list</aside>` }));
      await page.addInitScript(() => {
        window.qaListeners = []; window.qaFeedback = []; window.qaMode = 'value'; window.qaCommands = []; window.qaClicks = 0;
        const runtime = { getURL: value => value,
          onMessage: { addListener: listener => qaListeners.push(listener), removeListener: listener => { qaListeners = qaListeners.filter(item => item !== listener); } },
          sendMessage: async message => message.action === 'get_page_monitor_state'
            ? { active: true, runToken: 'owned-beforeinput-run', documentToken: message.documentToken }
            : (message.action === 'page_feedback' ? (qaFeedback.push(message.feedback), { accepted: true }) : {}) };
        window.chrome = window.browser = { runtime };
        window.qaSend = (action, params = {}, extra = {}) => new Promise(resolve => {
          let answered = false;
          const respond = result => { answered = true; resolve(result); };
          for (const listener of qaListeners) {
            const asynchronous = listener({ target: 'content', action, params: { runToken: 'owned-beforeinput-run', ...params }, ...extra }, {}, respond);
            if (answered || asynchronous === true) break;
          }
        });
        document.addEventListener('click', event => { if (event.target.closest?.('#composer-action')) qaClicks++; });
        document.addEventListener('beforeinput', event => {
          if (event.target.id !== 'editor') return;
          event.preventDefault(); event.target.textContent = event.data; window.qaModel = event.data;
          if (qaMode === 'controls') document.querySelector('#composer-action').outerHTML = '<button id="composer-action" type="button" aria-label="Send">Send</button>';
          if (qaMode === 'async-controls') setTimeout(() => { document.querySelector('#composer-action-wrap').innerHTML = '<button id="composer-action" type="button" aria-label="Send">Send</button>'; }, 15);
          if (qaMode === 'sidebar') setTimeout(() => { document.querySelector('#owned-sidebar').append(document.createTextNode('Owned draft marker')); }, 15);
          const cloneSelector = {
            'header-clone': '[data-testid="conversation-header"]',
            'carrier-clone': '[data-testid="conversation-info-header"]',
            'title-clone': '[data-testid="conversation-info-header-chat-title"]',
            'self-marker-clone': '[data-testid="you-label"]',
            'transcript-clone': '[data-testid="conversation-panel-messages"]',
          }[qaMode];
          if (cloneSelector) setTimeout(() => { const node = document.querySelector(cloneSelector); node.replaceWith(node.cloneNode(true)); }, 15);
          if (qaMode === 'peer') document.querySelector('[data-testid="conversation-info-header-chat-title"]').textContent = 'Different owned QA';
          if (qaMode === 'stop') void qaSend('page_monitor_state', {}, { active: false, runToken: 'owned-beforeinput-run' });
          if (qaMode === 'restart') void qaSend('page_monitor_state', {}, { active: false, runToken: 'owned-beforeinput-run' })
            .then(() => qaSend('page_monitor_state', {}, { active: true, runToken: 'owned-beforeinput-run' }));
          if (qaMode === 'selection') {
            const range = document.createRange(); range.selectNodeContents(document.querySelector('header'));
            const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          }
          if (qaMode === 'focus') { const button = document.querySelector('#composer-action'); button.focus(); }
          if (qaMode === 'independent') setTimeout(() => { document.body.append(document.createTextNode('Independent page change')); }, 15);
          if (qaMode === 'document-root') document.querySelector('#main').replaceWith(document.querySelector('#main').cloneNode(true));
          if (qaMode === 'expired') { const clock = Date.now.bind(Date); Date.now = () => clock() + 2000; }
        });
      });
      for (const file of ['page-monitor-shadow.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'whatsapp-phone.js', 'chat-observation.js', 'page-monitor.js', 'content.js']) {
        await page.addInitScript({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
      }
      const body = 'Owned native beforeinput: ıİşŞğĞüÜöÖçÇ 🧠 exact draft';
      for (const mode of ['value', 'controls', 'async-controls', 'sidebar', 'header-clone', 'carrier-clone', 'title-clone', 'self-marker-clone', 'transcript-clone', 'peer', 'stop', 'restart', 'selection', 'focus', 'independent', 'document-root', 'expired']) await t.test(mode, async () => {
        await page.goto('https://web.whatsapp.com/');
        await page.waitForFunction(() => window.__wbPageMonitor?.active);
        await page.evaluate(mode => {
          qaMode = mode; qaFeedback = []; qaCommands = []; qaClicks = 0;
          const native = document.execCommand.bind(document);
          document.execCommand = (...args) => { qaCommands.push(args[0]); return native(...args); };
        }, mode);
        const snapshot = await page.evaluate(() => qaSend('page_monitor_capture_model', { includeTree: true }));
        assert.equal(snapshot.ready, true);
        const ref = snapshot.page.pageContent.match(/textbox "Message" \[(ref_\d+)\]/)?.[1]; assert.ok(ref);
        const oldActionRef = snapshot.page.pageContent.match(/button "Voice message" \[(ref_\d+)\]/)?.[1]; assert.ok(oldActionRef);
        const initial = await page.evaluate(() => {
          const context = __wb_get_native_chat_context(document.querySelector('#editor'));
          return { context: !!context, header: !!context?.header, carrier: !!context?.carrier, title: !!context?.title, selfMarker: !!context?.selfMarker };
        });
        assert.equal(initial.context, true, 'The production native self-chat reader must bind the actual owned peer.');
        for (const key of ['header', 'carrier', 'title', 'selfMarker']) assert.equal(initial[key], true, `The actual native ${key} must be pinned.`);
        const validation = await page.evaluate(({ ref, token }) => qaSend('page_monitor_validate_model', { snapshotToken: token, tool: 'set_field', ref_id: ref }), { ref, token: snapshot.snapshotToken });
        assert.equal(validation.ready, true);
        const result = await page.evaluate(({ ref, body, token }) => qaSend('set_field', {
          ref_id: ref, text: body, clear: true, allowPassiveRebase: true, expectedModelSnapshot: token,
        }), { ref, body, token: snapshot.snapshotToken });
        assert.equal(await page.evaluate(() => qaModel), body);
        assert.deepEqual(await page.evaluate(() => qaCommands), [], 'Verification must never prepare or perform a second editor insertion.');
        assert.notEqual(result.noDispatch, true); assert.equal(result.dispatched, true);
        if (['value', 'controls', 'async-controls', 'sidebar', 'independent'].includes(mode)) {
          assert.equal(result.success, true, result.error); assert.equal(result.verified, true);
          if (['async-controls', 'sidebar', 'independent'].includes(mode)) {
            // Read-only certification must not clear global browser debt or
            // authorize any later action under the preceding model snapshot.
            const oldValidation = await page.evaluate(({ actionRef, token }) => qaSend('page_monitor_validate_model', {
              snapshotToken: token, tool: 'click_ax', ref_id: actionRef,
            }), { actionRef: oldActionRef, token: snapshot.snapshotToken });
            assert.equal(oldValidation.ready, false);
            const next = await page.evaluate(({ actionRef, token }) => qaSend('click_ax', {
              ref_id: actionRef, expectedModelSnapshot: token,
            }), { actionRef: oldActionRef, token: snapshot.snapshotToken });
            assert.equal(next.success, false);
            assert.equal(await page.evaluate(() => qaClicks), 0, 'A locally verified draft must never authorize the following stale Send/click.');
            assert.equal(await page.evaluate(() => qaModel), body);
          }
        } else {
          assert.equal(result.success, false); assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false);
          const reason = { selection: 'selection_changed', focus: 'focus_changed', expired: 'operation_expired' }[mode];
          if (reason) assert.match(result.error, new RegExp(`\\(${reason}\\)`));
          if (mode.endsWith('-clone')) assert.match(result.error, /complete value could not be verified in the same scope/);
        }
      });
    } finally { await browser.close(); }
  });
}
