import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { uploadReleaseHtml, stageSequentialReleaseUploads, xComposeUploadHtml, instagramDirectThreadHtml } from './lib/upload-release-fixture.mjs';

const recipientUploadHtml = `<!doctype html><style>
#binary-widget{display:block;width:400px;padding:10px}input[type=file]{width:1px;height:1px;opacity:0}
</style><form id="release-form"><div id="recipient">Upload recipient: Alice</div>
<div id="binary-widget"><button type="button" aria-controls="releases-upload">Upload document</button><input type="file" id="releases-upload"></div></form>
<script>window.attachmentEvents={markdown:[],binary:[]};window.chooserClicks=0;window.uploadRecipients=[];
document.getElementById('releases-upload').onchange=event=>{
 attachmentEvents.binary.push([...event.target.files].map(file=>({name:file.name,size:file.size})));
 uploadRecipients.push(document.getElementById('release-form').firstChild.textContent);
};</script>`;

async function fixture(browser, build, html = uploadReleaseHtml) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.route('https://owned-upload.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(() => {
    window.listeners = []; window.feedback = []; window.qaRunToken = 'upload-release-run';
    const runtime = { onMessage: { addListener: listener => listeners.push(listener), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: qaRunToken, documentToken: message.documentToken };
        if (message.action === 'page_feedback') { feedback.push(message.feedback); return { accepted: true }; }
        return {};
      } };
    window.chrome = window.browser = { runtime };
    window.deliver = (action, params = {}) => new Promise(resolve => {
      for (const listener of listeners) {
        let answered = false;
        const message = action === 'page_monitor_state'
          ? { target: 'content', action, runToken: 'upload-release-run', ...params }
          : { target: 'content', action, params: { runToken: 'upload-release-run', ...params } };
        const asynchronous = listener(message, {}, result => { answered = true; resolve(result); });
        if (answered || asynchronous === true) return;
      }
    });
  });
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js'])
    await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8') });
  const page = await context.newPage(); await page.goto('https://owned-upload.invalid/owned/repository/releases/new');
  await page.waitForFunction(() => window.__wbPageMonitor?.active); await page.waitForTimeout(180);
  return { context, page };
}

const capture = (page, params = {}) => page.evaluate(params => deliver('page_monitor_capture_model', { includeTree: true, ...params }), params);
const validate = (page, snapshot, selector = '#releases-upload') => page.evaluate(({ snapshot, selector }) => deliver('page_monitor_validate_model', {
  tool: 'upload_file', selector, snapshotToken: snapshot.snapshotToken,
}), { snapshot, selector });
async function attach(page, snapshot, race = null, filename = 'owned.zip') {
  await page.evaluate(snapshot => {
    window.qaUploadSnapshot = snapshot.snapshotToken;
    return deliver('page_monitor_prepare', { operationId: 'owned-upload', tool: 'upload_file',
      selector: '#releases-upload', expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
  }, snapshot);
  if (race) await race(page);
  return page.evaluate(async filename => {
    const validation = await deliver('page_monitor_validate_model', { tool: 'upload_file', selector: '#releases-upload',
      snapshotToken: window.qaUploadSnapshot });
    const fence = await deliver('page_monitor_dispatch', { operationId: 'owned-upload', kind: 'input', fenceOnly: true });
    if (validation.ready && fence.ready) __wbPageMonitor.withPreparedDispatch('owned-upload', () => __wbPageMonitor.withLocalDispatch(() => {
      const input = document.getElementById('releases-upload'), transfer = new DataTransfer();
      transfer.items.add(new File(['PK\\u0003\\u0004owned bytes'], filename, { type: 'application/zip', lastModified: 1 }));
      input.files = transfer.files; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    return { validation, fence, events: attachmentEvents, chooserClicks };
  }, filename);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: release binary upload has exact widget, recovery and dispatch fences`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const withFixture = async (work, html) => {
        const { context, page } = await fixture(browser, build, html);
        try { await work(page); } finally { await context.close(); }
      };
      for (const location of ['sibling element', 'form text']) for (const mutation of ['unchanged', 'text changed', 'node replaced']) await t.test(`a direct hidden slot binds its recipient in ${location}: ${mutation}`, () => withFixture(async page => {
        if (location === 'form text') await page.evaluate(() => {
          const recipient = document.getElementById('recipient');
          recipient.replaceWith(document.createTextNode(recipient.textContent));
        });
        const snapshot = await capture(page, { uploadTargets: ['#releases-upload'] });
        assert.equal((await validate(page, snapshot)).ready, true);
        assert.match(snapshot.page.pageContent, /Upload recipient: Alice/);
        const attached = await attach(page, snapshot, mutation === 'unchanged' ? null : page => page.evaluate(mutation => {
          const recipient = document.getElementById('release-form').firstChild;
          if (mutation === 'text changed') recipient.textContent = 'Upload recipient: Mallory';
          else recipient.replaceWith(recipient.cloneNode(true));
        }, mutation));
        // A text node replacement with identical content keeps its bound
        // parent and destination; an element replacement changes that owner.
        const expected = mutation === 'unchanged' || (location === 'form text' && mutation === 'node replaced');
        assert.equal(attached.validation.ready, expected);
        assert.equal(attached.fence.ready, expected);
        assert.equal(attached.events.binary.length, expected ? 1 : 0);
        assert.deepEqual(await page.evaluate(() => uploadRecipients), expected ? ['Upload recipient: Alice'] : []);
        assert.deepEqual(attached.events.markdown, []); assert.equal(attached.chooserClicks, 0);
      }, recipientUploadHtml));
      for (const changed of [false, true]) await t.test(`a direct hidden slot binds native select options: ${changed ? 'changed' : 'unchanged'}`, () => withFixture(async page => {
        await page.evaluate(() => {
          const select = document.createElement('select'); select.setAttribute('aria-label', 'Release target');
          select.innerHTML = '<option value="alice">Alice</option><option value="mallory">Mallory</option>';
          document.getElementById('release-form').append(select);
        });
        const snapshot = await capture(page, { uploadTargets: ['#releases-upload'] });
        assert.equal((await validate(page, snapshot)).ready, true);
        const attached = await attach(page, snapshot, changed ? page => page.evaluate(() => {
          document.querySelector('select').value = 'mallory';
        }) : null);
        assert.equal(attached.fence.ready, !changed);
        assert.equal(attached.events.binary.length, changed ? 0 : 1);
        assert.deepEqual(attached.events.markdown, []); assert.equal(attached.chooserClicks, 0);
      }, recipientUploadHtml));
      for (const changed of [false, true]) await t.test(`a direct hidden slot retains its existing form heading owner: ${changed ? 'changed' : 'unchanged'}`, () => withFixture(async page => {
        await page.evaluate(() => {
          const recipient = document.getElementById('recipient'), heading = document.createElement('h2');
          heading.id = recipient.id; heading.textContent = recipient.textContent; recipient.replaceWith(heading);
          const editor = document.createElement('div'); editor.innerHTML = 'Name <input type="text" value="Owned">';
          document.getElementById('release-form').append(editor);
        });
        const snapshot = await capture(page, { uploadTargets: ['#releases-upload'] });
        assert.equal((await validate(page, snapshot)).ready, true);
        const attached = await attach(page, snapshot, changed ? page => page.evaluate(() => {
          document.getElementById('recipient').textContent = 'Upload recipient: Mallory';
        }) : null);
        assert.equal(attached.fence.ready, !changed);
        assert.deepEqual(await page.evaluate(() => uploadRecipients), changed ? [] : ['Upload recipient: Alice']);
      }, recipientUploadHtml));
      for (const unrelated of ['aria-controls removed', 'aria-controls names another input'])
        await t.test(`a direct hidden slot cannot borrow an unrelated button in its form: ${unrelated}`, () => withFixture(async page => {
          await page.evaluate(unrelated => {
            const button = document.querySelector('#binary-widget button');
            if (unrelated === 'aria-controls removed') button.removeAttribute('aria-controls');
            else button.setAttribute('aria-controls', 'another-upload');
          }, unrelated);
          const snapshot = await capture(page, { uploadTargets: ['#releases-upload'] });
          assert.equal((await validate(page, snapshot)).ready, false, 'A button merely sharing the form is not the slot\'s activator');
          const attached = await attach(page, snapshot);
          assert.equal(attached.events.binary.length, 0); assert.equal(attached.chooserClicks, 0);
        }, recipientUploadHtml));
      await t.test('a direct hidden slot cannot use partially observed recipient text', () => withFixture(async page => {
        await page.evaluate(() => { document.getElementById('recipient').textContent = 'Upload recipient: ' + 'Alice '.repeat(100); });
        const snapshot = await capture(page, { uploadTargets: ['#releases-upload'] });
        assert.equal((await validate(page, snapshot)).ready, false);
        const attached = await attach(page, snapshot);
        assert.equal(attached.fence.ready, false); assert.deepEqual(attached.events, { markdown: [], binary: [] });
        assert.deepEqual(await page.evaluate(() => uploadRecipients), []);
      }, recipientUploadHtml));
      await t.test('discovered binary input receives one file, with no Markdown attachment or chooser', () => withFixture(async page => {
        const inventory = await page.evaluate(() => deliver('get_interactive_elements_cdp'));
        assert.equal(inventory.filter(item => item.type === 'file').length, 2);
        assert.equal(inventory.find(item => item.id === 'releases-upload')?.selector, '#releases-upload');
        const snapshot = await capture(page), result = await validate(page, snapshot);
        assert.equal(result.ready, true, JSON.stringify({ result, targetCount: snapshot.targetCount, page: snapshot.page }));
        assert.match(snapshot.page.pageContent, /file input selector="#releases-upload" widget_ref=/);
        await page.evaluate(() => document.getElementById('clock').textContent = '2');
        assert.equal((await validate(page, snapshot)).ready, true);
        const attached = await attach(page, snapshot);
        assert.equal(attached.fence.ready, true); assert.equal(attached.events.binary.length, 1);
        assert.deepEqual(attached.events.markdown, []); assert.equal(attached.chooserClicks, 0);
      }));
      for (const hiding of ['clipped', 'opacity']) await t.test(`consumed attachments retain an exclusive ${hiding} file slot for the next asset`, () => withFixture(async page => {
        await page.evaluate(stageSequentialReleaseUploads, hiding);
        const filenames = ['chrome.zip', 'edge.zip', 'firefox.zip', 'corresponding-source.zip'];
        for (const [index, filename] of filenames.entries()) {
          const snapshot = await capture(page, { uploadTargets: ['#releases-upload'] });
          assert.equal((await validate(page, snapshot)).ready, true, `Asset ${filename} must have its own fresh certificate.`);
          assert.match(snapshot.page.pageContent, /file input selector="#releases-upload" widget_ref=/);
          const attached = await attach(page, snapshot, null, filename);
          assert.equal(attached.validation.ready, true); assert.equal(attached.fence.ready, true);
          assert.equal(attached.events.binary.length, index + 1);
          assert.deepEqual(attached.events.markdown, []); assert.equal(attached.chooserClicks, 0);
          assert.equal(await page.locator('#releases-upload').evaluate(input => input.files.length), 0);
          await page.evaluate(() => deliver('page_monitor_finish', { operationId: 'owned-upload' }));
          assert.equal((await validate(page, snapshot)).ready, false, 'Consumption never repairs or reuses the previous certificate.');
        }
        assert.deepEqual(await page.locator('.staged-asset input').evaluateAll(inputs => inputs.map(input => input.value)), filenames);
      }));
      const consumedMutations = [
        ['second file slot', () => { const extra = document.createElement('input'); extra.type = 'file'; document.getElementById('binary-widget').append(extra); }],
        ['second activator', () => { const extra = document.createElement('button'); extra.type = 'button'; extra.textContent = 'Another upload'; document.getElementById('binary-widget').append(extra); }],
        ['hidden widget', () => { document.getElementById('binary-widget').style.display = 'none'; }],
        ['inert widget', () => { document.getElementById('binary-widget').inert = true; }],
        ['form association', () => { document.getElementById('releases-upload').setAttribute('form', 'other-form'); }],
        ['staged filename', () => { document.querySelector('.staged-asset input').value = 'another.zip'; }],
        ['staged removal handler', () => { document.querySelector('.staged-asset button').onclick = () => { window.unexpected = true; }; }],
      ];
      for (const [name, mutate] of consumedMutations) await t.test(`a consumed direct slot rejects ${name} before the next dispatch`, () => withFixture(async page => {
        await page.evaluate(stageSequentialReleaseUploads);
        const first = await capture(page);
        assert.equal((await attach(page, first, null, 'chrome.zip')).events.binary.length, 1);
        await page.evaluate(() => deliver('page_monitor_finish', { operationId: 'owned-upload' }));
        const fresh = await capture(page, { uploadTargets: ['#releases-upload'] });
        assert.equal((await validate(page, fresh)).ready, true);
        const attached = await attach(page, fresh, page => page.evaluate(mutate), 'edge.zip');
        assert.equal(attached.fence.ready, false);
        assert.equal(attached.events.binary.length, 1); assert.deepEqual(attached.events.markdown, []);
        assert.equal(attached.chooserClicks, 0);
      }));
      for (const association of ['missing', 'another-form']) await t.test(`a consumed direct slot cannot borrow an activator with ${association} form association`, () => withFixture(async page => {
        await page.evaluate(stageSequentialReleaseUploads);
        const first = await capture(page);
        assert.equal((await attach(page, first, null, 'chrome.zip')).events.binary.length, 1);
        await page.evaluate(() => deliver('page_monitor_finish', { operationId: 'owned-upload' }));
        await page.evaluate(association => {
          if (association === 'another-form') {
            const form = document.createElement('form'); form.id = association; document.body.append(form);
          }
          document.getElementById('binary-button').setAttribute('form', association);
        }, association);
        const fresh = await capture(page, { uploadTargets: ['#releases-upload'] });
        assert.equal((await validate(page, fresh)).ready, false);
        const attached = await attach(page, fresh, null, 'edge.zip');
        assert.equal(attached.fence.ready, false); assert.equal(attached.events.binary.length, 1);
        assert.deepEqual(attached.events.markdown, []); assert.equal(attached.chooserClicks, 0);
      }));
      await t.test('a deep discovered input belongs only to a fresh bounded observation', () => withFixture(async page => {
        await page.evaluate(() => {
          const decoration = document.createElement('div'); decoration.hidden = true;
          decoration.innerHTML = '<span></span>'.repeat(5000); document.getElementById('binary-widget').before(decoration);
        });
        const original = await capture(page);
        assert.equal((await validate(page, original)).reason, 'target_uncovered');
        const inventory = await page.evaluate(() => deliver('get_interactive_elements_cdp'));
        const fresh = await capture(page, { uploadTargets: inventory.filter(item => item.type === 'file').map(item => item.selector) });
        assert.equal((await validate(page, original)).ready, false, 'New observation never repairs the old rejected call.');
        assert.equal((await validate(page, fresh)).ready, true);
        const attached = await attach(page, fresh); assert.equal(attached.fence.ready, true); assert.equal(attached.events.binary.length, 1);
      }));
      for (const changeHandler of [false, true]) await t.test(`associated native label ${changeHandler ? 'rejects a changed handler' : 'retains its original handler'}`, () => withFixture(async page => {
        await page.evaluate(() => {
          const button = document.getElementById('binary-button'), label = document.createElement('label');
          label.id = button.id; label.htmlFor = 'releases-upload'; label.textContent = button.textContent;
          label.onclick = () => {}; button.replaceWith(label);
        });
        const snapshot = await capture(page);
        assert.equal((await validate(page, snapshot)).ready, true);
        const attached = await attach(page, snapshot, changeHandler
          ? page => page.evaluate(() => { document.getElementById('binary-button').onclick = () => { window.unexpected = true; }; })
          : undefined);
        assert.equal(attached.fence.ready, !changeHandler);
        assert.equal(attached.events.binary.length, changeHandler ? 0 : 1);
        assert.deepEqual(attached.events.markdown, []);
        assert.equal(attached.chooserClicks, 0);
      }));
      const mutations = [
        ['input replacement', () => { const input = document.getElementById('releases-upload'); input.replaceWith(input.cloneNode()); }],
        ['widget replacement', () => { const widget = document.getElementById('binary-widget'); widget.replaceWith(widget.cloneNode(true)); }],
        ['activation purpose', () => { document.getElementById('binary-button').textContent = 'Upload to another place'; }],
        ['activation handler identity', () => { document.getElementById('binary-button').onclick = () => {}; }],
        ['repository heading', () => { document.querySelector('h1').textContent = 'New release for another/repository'; }],
        ['form association', () => { document.getElementById('releases-upload').setAttribute('form', 'other-form'); }],
        ['accepted type', () => { document.getElementById('releases-upload').accept = 'image/*'; }],
        ['disabled input', () => { document.getElementById('releases-upload').disabled = true; }],
        ['transport aria hidden', () => { document.getElementById('releases-upload').parentElement.setAttribute('aria-hidden', 'true'); }],
        ['hidden widget', () => { document.getElementById('binary-widget').style.display = 'none'; }],
        ['inert widget', () => { document.getElementById('binary-widget').inert = true; }],
        ['second file slot', () => { const extra = document.createElement('input'); extra.type = 'file'; document.getElementById('binary-widget').append(extra); }],
        ['URL', () => { history.replaceState({}, '', '/another/repository/releases/new'); }],
      ];
      for (const [name, mutate] of mutations) await t.test(`${name} between preparation and file assignment blocks both slots`, () => withFixture(async page => {
        const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true);
        const attached = await attach(page, snapshot, page => page.evaluate(mutate));
        assert.equal(attached.fence.ready, false); assert.deepEqual(attached.events, { markdown: [], binary: [] });
        assert.equal(attached.chooserClicks, 0);
      }));
      await t.test('duplicate selectors cannot acquire a certificate', () => withFixture(async page => {
        const snapshot = await capture(page);
        assert.equal((await validate(page, snapshot, 'input[type=file]')).ready, false);
        await page.evaluate(() => document.getElementById('fc-release-body').id = 'releases-upload');
        assert.equal((await validate(page, snapshot)).ready, false);
      }));
      // Trace e6187b5f: X's test id names the composer dialog's input and the
      // timeline composer's copy behind it. The inventory must still name the
      // dialog's input exactly enough to bind.
      await t.test('X dialog composer input binds by its inventory selector, not the shared test id', () => withFixture(async page => {
        const snapshot = await capture(page);
        assert.equal((await validate(page, snapshot, 'input[data-testid="fileInput"]')).reason, 'target_ambiguous');
        const files = (await page.evaluate(() => deliver('get_interactive_elements_cdp'))).filter(item => item.type === 'file');
        const dialogInput = files.find(item => item.inDialog === true);
        assert.ok(dialogInput?.selector && files.every(item => item.selector), JSON.stringify(files));
        const fresh = await capture(page, { uploadTargets: files.map(item => item.selector) });
        const validation = await validate(page, fresh, dialogInput.selector);
        assert.equal(validation.ready, true, JSON.stringify(validation));
      }, xComposeUploadHtml));
      // Trace b71fd1dc and the Codex review of #502: Instagram's message input
      // is formless, hidden and deep in a large thread, so it is never
      // certified. The monitor knows which node an inventory listed under its
      // selector; a node the page re-mounts under the same selector is not it.
      await t.test('Instagram composer input is known by the node its inventory listed, not by its selector', () => withFixture(async page => {
        const inventory = token => page.evaluate(token => deliver('get_interactive_elements_cdp', { _fileInventoryToken: token }), token)
          .then(items => items.filter(item => item.type === 'file'));
        const check = (snapshot, selector, fileInventoryToken) => page.evaluate(params => deliver('page_monitor_validate_model',
          { tool: 'upload_file', ...params }), { selector, snapshotToken: snapshot.snapshotToken, ...(fileInventoryToken ? { fileInventoryToken } : {}) });
        const [file] = await inventory('inventory-1');
        assert.equal(file?.selector, 'input[type="file"][accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg"][multiple]', JSON.stringify(file));
        const snapshot = await capture(page, { uploadTargets: [file.selector] });
        const listed = await check(snapshot, file.selector, 'inventory-1');
        assert.equal(listed.ready, false, JSON.stringify(listed));
        assert.equal(listed.reason, 'target_uncovered', JSON.stringify(listed));
        assert.equal(listed.inventoried, true, JSON.stringify(listed));
        assert.equal((await check(snapshot, file.selector, 'inventory-0')).inventoried, undefined, 'another inventory');
        assert.equal((await check(snapshot, file.selector)).inventoried, undefined, 'no inventory');
        await page.evaluate(() => window.rerenderComposerInput());
        const remounted = await check(await capture(page, { uploadTargets: [file.selector] }), file.selector, 'inventory-1');
        assert.equal(remounted.reason, 'target_uncovered', JSON.stringify(remounted));
        assert.equal(remounted.inventoried, undefined, `a re-mounted input was never listed: ${JSON.stringify(remounted)}`);
        const [fresh] = await inventory('inventory-2');
        assert.equal(fresh?.selector, file.selector);
        const current = await capture(page, { uploadTargets: [fresh.selector] });
        assert.equal((await check(current, fresh.selector, 'inventory-2')).inventoried, true, 'the fresh inventory lists the new node');
        assert.equal((await check(current, fresh.selector, 'inventory-1')).inventoried, undefined, 'the older inventory is spent');
      }, instagramDirectThreadHtml()));
      // A vision run's upload handoff (vision-runtime.js): the blocked
      // click_at's result named the input by selector, and the monitor keeps
      // the node that selector names when the handoff starts, under the
      // agent's token, as an inventory would.
      await t.test('a handoff\'s blocked input is known by the node its selector named when the handoff started', () => withFixture(async page => {
        const selector = 'input[type="file"][accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg"][multiple]';
        const record = params => page.evaluate(params => deliver('page_monitor_record_upload_targets', params), params);
        const check = (snapshot, selector, fileInventoryToken) => page.evaluate(params => deliver('page_monitor_validate_model',
          { tool: 'upload_file', ...params }), { selector, snapshotToken: snapshot.snapshotToken, fileInventoryToken });
        // Only a selector naming one file input is kept.
        const recorded = await record({ token: 'handoff-1', selectors: [selector, 'input[type="file"].missing', '[role="textbox"]'] });
        assert.deepEqual(recorded.recorded, [selector], JSON.stringify(recorded));
        assert.equal(recorded.runToken, 'upload-release-run');
        const snapshot = await capture(page, { uploadTargets: [selector] });
        const listed = await check(snapshot, selector, 'handoff-1');
        assert.equal(listed.reason, 'target_uncovered', JSON.stringify(listed));
        assert.equal(listed.inventoried, true, JSON.stringify(listed));
        assert.equal((await check(snapshot, 'input[type=file]', 'handoff-1')).inventoried, undefined, 'a guessed selector for the same node');
        assert.deepEqual((await record({ token: 'handoff-2', selectors: [selector], runToken: 'another-run' })).recorded, [], 'another run records nothing');
        assert.equal((await check(snapshot, selector, 'handoff-1')).inventoried, true, 'and leaves the handoff\'s record');
        await page.evaluate(() => window.rerenderComposerInput());
        const remounted = await check(await capture(page, { uploadTargets: [selector] }), selector, 'handoff-1');
        assert.equal(remounted.reason, 'target_uncovered', JSON.stringify(remounted));
        assert.equal(remounted.inventoried, undefined, `a re-mounted input was never named: ${JSON.stringify(remounted)}`);
      }, instagramDirectThreadHtml()));
      for (const authority of ['user', 'Stop', 'run', 'document']) await t.test(`${authority} revokes upload authority`, () => withFixture(async page => {
        const snapshot = await capture(page);
        const attached = await attach(page, snapshot, async page => {
          if (authority === 'user') await page.locator('#human').click();
          else if (authority === 'Stop') await page.evaluate(() => deliver('page_monitor_state', { active: false }));
          else if (authority === 'run') await page.evaluate(async () => { qaRunToken = 'another-run'; await deliver('page_monitor_state', { active: true }); });
          else await page.reload();
        });
        assert.equal(attached.validation.ready, false); assert.deepEqual(attached.events, { markdown: [], binary: [] });
      }));
    } finally { await browser.close(); }
  });
}
