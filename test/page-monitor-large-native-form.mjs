import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { sharedBrowsers } from './lib/shared-browsers.mjs';

const browsers = sharedBrowsers([chromium, firefox]);
const sources = new Map(await Promise.all(['chrome', 'firefox'].map(async build => [build,
  await Promise.all(['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']
    .map(file => readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')))])));

// The live Classic Editor had 207 native form elements. Their labels and
// metabox headings exhausted the old 256-node action footprint even though
// the selected category and Publish control were ordinary visible inputs.
function html(extraControls = 203, native = true) {
  const markup = `<!doctype html><style>body{font:16px sans-serif;margin:20px}input,button{min-height:24px}
    #clock{position:absolute;left:800px;top:20px}#collateral{margin-top:900px}</style>
    <h1>Current article</h1><form id="post" action="/save-current" method="post">
    <label for="title">Title</label><input id="title" value="Owned title">
    <label for="body">Body</label><textarea id="body">Owned body</textarea>
    <div><h2>Categories</h2><label for="category"><input id="category" type="checkbox" name="category" value="ai">Artificial intelligence</label></div>
    <div><h2>Publication</h2><button id="publish" type="submit">Publish article</button></div>
    <div id="collateral">${Array.from({ length: extraControls }, (_, i) => i < 40
      ? `<label for="field-${i}">Option ${i}</label><input id="field-${i}" name="field-${i}" value="private-${i}">`
      : `<input type="hidden" id="field-${i}" name="field-${i}" value="private-${i}">`).join('')}
    ${Array.from({ length: 18 }, (_, i) => `<h2>Panel ${i}</h2>`).join('')}</div></form>
    <aside id="clock">0</aside><button id="human">Human control</button>`;
  return native ? markup : markup.replace('<form id="post"', '<div role="form" id="post"').replace('</form>', '</div>');
}

async function fixture(browser, build, extraControls, native) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await context.route('https://large-form.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html(extraControls, native) }));
  await context.addInitScript(() => {
    const listeners = [];
    window.qaFeedback = []; window.qaSubmissions = 0; window.qaChanges = 0;
    window.chrome = window.browser = { runtime: { getURL: value => value,
      onMessage: { addListener: fn => listeners.push(fn), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: 'large-form-run', documentToken: message.documentToken };
        if (message.action === 'page_feedback') qaFeedback.push(message.feedback);
        return { accepted: true };
      },
    } };
    window.qaMessage = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      for (const listener of listeners) {
        const result = listener({ target: 'content', action, params: { runToken: 'large-form-run', ...params } }, {}, value => { answered = true; resolve(value); });
        if (answered || result === true) return;
      }
    });
  });
  for (const content of sources.get(build)) await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto('https://large-form.invalid/editor');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    post.addEventListener('submit', event => { event.preventDefault(); qaSubmissions++; });
    category.addEventListener('change', () => qaChanges++);
  });
  return { context, page };
}

const capture = (page, id = 'category') => page.evaluate(async id => {
  const snapshot = await qaMessage('page_monitor_capture_model', { includeTree: true, actionTarget: { tool: 'click_ax', selector: '#' + id } });
  return { snapshot, ref: __wb_ax_ref(document.getElementById(id)), id };
}, id);
const validate = (page, observed) => page.evaluate(({ snapshot, ref, id }) => qaMessage('page_monitor_validate_model', {
  snapshotToken: snapshot.snapshotToken, tool: id === 'category' ? 'set_checked' : 'click_ax', ref_id: ref,
}), observed);

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: complete large native forms retain their original action context`, { timeout: 60000 }, async t => {
    const browser = await browsers.lease(engine);
    const withFixture = async (work, extraControls, native) => {
      const f = await fixture(browser, build, extraControls, native);
      try { await work(f.page); } finally { await f.context.close(); }
    };
    try {
      for (const id of ['category', 'publish']) await t.test(`${id}: unrelated page updates do not block the observed native control`, () => withFixture(async page => {
        assert.equal(await page.evaluate(() => post.elements.length), 207);
        const observed = await capture(page, id);
        assert.equal((await validate(page, observed)).ready, true, JSON.stringify(await validate(page, observed)));
        await page.evaluate(() => { clock.textContent = '1'; });
        await page.waitForTimeout(180);
        assert.equal((await validate(page, observed)).ready, true);
        const result = await page.evaluate(async ({ snapshot, ref, id }) => {
          const prepared = await qaMessage('page_monitor_prepare', { tool: id === 'category' ? 'set_checked' : 'click_ax',
            ref_id: ref, operationId: 'large-form-action', expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
          const fence = prepared.ready && prepared.modelBindingValid
            ? await qaMessage('page_monitor_dispatch', { operationId: 'large-form-action', kind: 'click', fenceOnly: true }) : null;
          const action = fence?.ready ? await qaMessage(id === 'category' ? 'set_checked' : 'click_ax', {
            ref_id: ref, ...(id === 'category' ? { checked: true } : {}),
          }) : null;
          return { prepared, fence, action, checked: category.checked, changes: qaChanges, submissions: qaSubmissions };
        }, observed);
        assert.equal(result.prepared.modelBindingValid, true, JSON.stringify(result));
        assert.equal(result.fence?.ready, true, JSON.stringify(result));
        assert.equal(result.action?.success, true, JSON.stringify(result));
        assert.equal(result.changes, id === 'category' ? 1 : 0);
        assert.equal(result.submissions, id === 'publish' ? 1 : 0);
      }));
      for (const [name, mutation] of [
        ['hidden form value changes', () => { document.getElementById('field-202').value = 'another-record'; }],
        ['form destination changes', () => { post.action = '/save-other'; }],
        ['collateral control changes', () => { document.getElementById('field-39').value = 'changed'; }],
        ['category label changes', () => { document.querySelector('label[for="category"]').append(' (different choice)'); }],
        ['original control replaced', () => { category.replaceWith(category.cloneNode(true)); }],
      ]) await t.test(`${name}: old observation still cannot dispatch`, () => withFixture(async page => {
        const observed = await capture(page);
        assert.equal((await validate(page, observed)).ready, true);
        await page.evaluate(mutation);
        assert.equal((await validate(page, observed)).ready, false);
        assert.equal(await page.evaluate(() => qaChanges + qaSubmissions), 0);
      }));
      await t.test('oversized native forms still fail closed', () => withFixture(async page => {
        const observed = await capture(page);
        assert.equal((await validate(page, observed)).ready, false);
        assert.equal(await page.evaluate(() => qaChanges + qaSubmissions), 0);
      }, 520));
      await t.test('ARIA form owners retain the smaller generic bound', () => withFixture(async page => {
        const observed = await capture(page);
        assert.equal((await validate(page, observed)).ready, false);
        assert.equal(await page.evaluate(() => qaChanges + qaSubmissions), 0);
      }, 203, false));
    } finally { await browser.close(); }
  });
}
