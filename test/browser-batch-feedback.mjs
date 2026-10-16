import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const RUN = 'batch-feedback-run';
const html = `<!doctype html><main><h1>Account details</h1><form aria-label="Account details">
<label>Name <input id="name" value="Existing "></label><label>Email <input id="email"></label>
<label>Note <textarea id="note"></textarea></label><button type="button">Save details</button>
</form></main><aside id="counter">0</aside><button id="human">Human control</button>`;

test('batch feedback and monitor implementations are byte-identical across browsers', async () => {
  for (const file of ['agent/page-feedback.js', 'content/page-monitor.js']) {
    const contents = await Promise.all(['chrome', 'firefox'].map(build => readFile(new URL(`../src/${build}/src/${file}`, import.meta.url))));
    assert.deepEqual(contents[0], contents[1]);
  }
});

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: batched fields carry only verified owned values across original target certificates`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    async function fixture() {
      const context = await browser.newContext();
      await context.route('https://batch.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      await context.addInitScript(RUN => {
        window.listeners = [];
        window.chrome = window.browser = { runtime: {
          onMessage: { addListener: fn => listeners.push(fn), removeListener() {} },
          sendMessage: async msg => msg.action === 'get_page_monitor_state'
            ? { active: true, runToken: RUN, documentToken: msg.documentToken } : { accepted: true },
        } };
        window.send = (action, params = {}) => new Promise(resolve => {
          let answered = false;
          for (const listener of listeners) {
            const async = listener({ target: 'content', action, params: { runToken: RUN, ...params } }, {}, value => { answered = true; resolve(value); });
            if (answered || async === true) return;
          }
          resolve(null);
        });
      }, RUN);
      for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
        await context.addInitScript({ content: await readFile(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8') });
      }
      const page = await context.newPage();
      await page.goto('https://batch.test/form');
      await page.waitForFunction(() => window.__wbPageMonitor?.active);
      await page.waitForTimeout(200);
      await page.evaluate(async () => { window.snapshot = await send('page_monitor_capture_model', { includeTree: true }); });
      return { context, page };
    }
    const validate = (page, selector = '#email', batchId = 'parent') => page.evaluate(({ selector, batchId }) => send('page_monitor_validate_model', {
      tool: 'set_field', selector, snapshotToken: snapshot.snapshotToken, batchId,
    }), { selector, batchId });
    const write = (page, { seal = true, selector = '#name', text = 'Ada', mutation = null, tool = 'set_field', clear = true } = {}) => page.evaluate(async ({ seal, selector, text, mutation, tool, clear }) => {
      const params = { tool, selector, operationId: `op-${selector}`, batchId: 'parent',
        expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true };
      const preparation = await send('page_monitor_prepare', params);
      const action = preparation.modelBindingValid ? await send('type', { selector, text, clear }) : null;
      if (mutation) (0, eval)(`(${mutation})`)();
      const finish = await send('page_monitor_finish', { operationId: params.operationId, batchId: 'parent',
        commitBrowserBatchInput: seal, batchInputText: text, batchInputClear: clear });
      return { preparation, action, finish, value: document.querySelector(selector).value };
    }, { seal, selector, text, mutation: mutation?.toString() || null, tool, clear });
    try {
      await t.test('two owned field writes retain the original next field and sibling top-level calls stay fenced', async () => {
        const { page, context } = await fixture();
        try {
          const first = await write(page);
          assert.equal(first.preparation.modelBindingValid, true, JSON.stringify(first));
          assert.equal(first.action?.success, true, JSON.stringify(first));
          assert.equal(first.finish.batchInputSealed, true, JSON.stringify(first));
          const next = await validate(page);
          assert.equal(next.ready, true, JSON.stringify(next));
          assert.equal((await validate(page, '#email', null)).ready, false);
          assert.equal((await validate(page, '#email', 'different-parent')).ready, false);
          const second = await write(page, { selector: '#email', text: 'ada@example.test' });
          assert.equal(second.finish.batchInputSealed, true, JSON.stringify(second));
          assert.equal((await validate(page, '#note')).ready, true);
        } finally { await context.close(); }
      });
      await t.test('unverified writes never advance a batch certificate', async () => {
        const { page, context } = await fixture();
        try { await write(page, { seal: false }); assert.equal((await validate(page)).ready, false); }
        finally { await context.close(); }
      });
      for (const clear of [true, false]) await t.test(`selector type_text ${clear ? 'replacement' : 'append'} retains only its own verified field value`, async () => {
        const { page, context } = await fixture();
        try {
          const first = await write(page, { tool: 'type_text', clear });
          assert.equal(first.preparation.modelBindingValid, true, JSON.stringify(first));
          assert.equal(first.action?.success, true, JSON.stringify(first));
          assert.equal(first.value, clear ? 'Ada' : 'Existing Ada');
          assert.equal(first.finish.batchInputSealed, true, JSON.stringify(first));
          assert.equal((await validate(page)).ready, true);
          assert.equal((await validate(page, '#email', 'another-batch')).ready, false);
          const second = await write(page, { tool: 'type_text', selector: '#email', text: 'ada@example.test', clear: true });
          assert.equal(second.finish.batchInputSealed, true, JSON.stringify(second));
          assert.equal((await validate(page, '#note')).ready, true);
        } finally { await context.close(); }
      });
      for (const [name, mutation] of [
        ['collateral value', () => { document.querySelector('#note').value = 'Unseen collateral value'; }],
        ['form identity', () => { document.querySelector('form').setAttribute('aria-label', 'Another account'); }],
        ['target replacement', () => { const old = document.querySelector('#email'); old.replaceWith(old.cloneNode()); }],
        ['owned value changed after dispatch', () => { document.querySelector('#name').value = 'Unexpected rewrite'; }],
      ]) await t.test(`${name} cannot borrow an owned-input continuation`, async () => {
        const { page, context } = await fixture();
        try {
          const first = await write(page, { mutation });
          assert.equal(first.finish.batchInputSealed, false, JSON.stringify(first));
          assert.equal((await validate(page)).ready, false);
        } finally { await context.close(); }
      });
      await t.test('a human gesture after the owned write keeps the intervention fence', async () => {
        const { page, context } = await fixture();
        try {
          const first = await write(page);
          assert.equal(first.finish.batchInputSealed, true);
          await page.locator('#human').click();
          assert.equal((await validate(page)).ready, false);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
