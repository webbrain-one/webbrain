import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { installModelStub } from './semantic-decision-stub.mjs';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { scaled } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { getToolsForMode } = await import(`../src/${build}/src/agent/tools.js`);

  // QA case G7 with the real content handlers: an Ask summary written from
  // the first tree page of a long article is sent back once, the read its
  // note names continues through the real read_page windows to the end, and
  // the summary given then is accepted as it is.
  test(`${build}: an Ask summary of a long article is sent back to the read that reaches its end`, { timeout: scaled(60000) }, async () => {
    const browser = await browsers.lease(engine);
    const context = await browser.newContext();
    const url = 'https://owned-read.test/long-article';
    const text = Array.from({ length: 120 }, (_, index) =>
      `<p>Owned section ${index + 1}: ${'Placeholder history of one era for the fixture. '.repeat(4)}</p>`).join('');
    await context.route(`${url}*`, route => route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><title>Owned long article</title><h1>Owned long article</h1><article>${text}<p>OWNED_ARTICLE_TAIL</p></article>` }));
    await context.addInitScript(() => {
      const listeners = [];
      window.chrome = window.browser = { runtime: {
        onMessage: { addListener: listener => listeners.push(listener) },
        sendMessage: async () => ({}), getURL: file => file,
      } };
      window.deliverRead = message => new Promise(resolve => {
        for (const listener of listeners) if (listener(message, {}, resolve) === true) break;
      });
    });
    for (const file of ['accessibility-tree.js', 'content.js']) {
      await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
    }
    const page = await context.newPage();
    const previousChrome = globalThis.chrome;
    const previousBrowser = globalThis.browser;
    const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
    globalThis.chrome = globalThis.browser = {
      runtime: { getURL: file => `extension://owned/${file}` },
      storage: { local: area, session: area },
      tabs: {
        get: async id => ({ id, url, status: 'complete' }),
        sendMessage: async (_id, message) => (['get_accessibility_tree', 'get_page_info_cdp'].includes(message.action)
          ? page.evaluate(message => window.deliverRead(message), message) : {}),
      },
    };
    try {
      await page.goto(url);
      const provider = { promptTier: 'full', contextWindow: 32000, supportsVision: false,
        chat: async () => { throw new Error('Only fixed-choice questions reach the model here.'); } };
      const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
      Object.assign(agent, { _ensureGateSetting: async () => false, _skipPermissionGate: true, _currentUrl: async () => url,
        _persist: () => {}, _persistNow: async () => true });
      agent._rememberMastodonObservation = agent._recordProgressObservation = async () => null;
      agent._autoRecordProgressAction = () => null;
      const questions = installModelStub(agent, { decide: kind => (kind === 'page_read_scope' ? 'whole_page' : null) });
      const execute = agent.executeTool.bind(agent);
      agent.executeTool = (tabId, name, args, ...rest) => (name === 'done'
        ? Promise.resolve({ done: true, summary: args.summary }) : execute(tabId, name, args, ...rest));
      const task = 'Summarize this page.';
      const schemas = new Map(getToolsForMode('ask', { tier: 'full' }).map(tool => [tool.function.name, tool.function.parameters]));
      const summary = 'The article covers every owned section, from the first to the last.';
      let sequence = 0;
      // One Ask run per tab: the model reads the first part with `firstTool`,
      // answers, and then follows the read the note names.
      for (const [tab, firstTool, firstArgs, expectedTool] of [[1, 'get_accessibility_tree', {}, 'get_accessibility_tree'],
        [2, 'read_page', { includeChrome: false }, 'read_page']]) {
        const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: task }];
        agent.conversationModes.set(tab, 'ask');
        agent.conversations.set(tab, messages);
        await agent._beginReadCompleteness(tab, task, {});
        const call = async (name, args) => {
          const id = `owned-article-${++sequence}`;
          messages.push({ role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
          const outcome = await agent._executeToolBatch(tab, messages.at(-1).tool_calls, messages, () => {}, provider, null,
            new Set(['done', 'read_page', 'get_accessibility_tree']), sequence, {}, schemas);
          const result = messages.find(message => message.role === 'tool' && message.tool_call_id === id);
          return { outcome, shown: agent._unwrapUntrusted(result.content) };
        };
        const first = JSON.parse((await call(firstTool, firstArgs)).shown);
        assert.equal(first.hasMore, true, `The real article takes more than one ${firstTool} result`);
        const sentBack = await call('done', { summary });
        assert.equal(sentBack.outcome.action, 'continue', `A summary from the first ${firstTool} result is sent back`);
        const note = JSON.parse(sentBack.shown).error;
        const named = note.match(/Call (read_page|get_accessibility_tree)\((\{[^\n]*?\})\) now/);
        assert.ok(named, note);
        assert.equal(named[1], expectedTool, note);
        // The named read is exactly the continuation the first result returned.
        assert.deepEqual(JSON.parse(named[2]), first.continuationArgs, note);
        let tool = named[1];
        let args = JSON.parse(named[2]);
        let content = first.text ?? first.pageContent;
        for (let windows = 1; ; windows++) {
          const shown = JSON.parse((await call(tool, args)).shown);
          assert.notEqual(shown.invalidToolArguments, true, `${tool}(${JSON.stringify(args)}) is a valid call`);
          content += shown.text ?? shown.pageContent;
          if (!shown.hasMore) break;
          assert.ok(windows < 40, 'Each continuation makes forward progress');
          ({ continuationArgs: args } = shown);
        }
        assert.match(content, /OWNED_ARTICLE_TAIL/, 'The named read reaches the real end of the article');
        const accepted = await call('done', { summary });
        assert.equal(accepted.outcome.action, 'return');
        assert.equal(accepted.outcome.value, summary, `A summary of the whole article (${firstTool}) gets no caveat`);
      }
      assert.deepEqual(questions.map(question => question.kind), ['page_read_scope'],
        'The same request is read once and remembered');
    } finally {
      globalThis.chrome = previousChrome;
      globalThis.browser = previousBrowser;
      await context.close();
      await browser.close();
    }
  });

  test(`${build}: real expanded-tree continuations and bounded prose requests reach the content handler`, { timeout: scaled(60000) }, async () => {
    const browser = await browsers.lease(engine);
    const context = await browser.newContext();
    const url = 'https://owned-read.test/document';
    const text = Array.from({ length: 400 }, (_, index) =>
      `<p>Owned paragraph ${index + 1}: ${'Bounded document verification. '.repeat(5)}</p>`).join('');
    await context.route(`${url}*`, route => route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><h1>Owned long document</h1><article>${text}<p>OWNED_DOCUMENT_TAIL</p></article>` }));
    await context.addInitScript(() => {
      const listeners = [];
      window.chrome = window.browser = { runtime: {
        onMessage: { addListener: listener => listeners.push(listener) },
        sendMessage: async () => ({}), getURL: file => file,
      } };
      window.deliverRead = message => new Promise(resolve => {
        for (const listener of listeners) if (listener(message, {}, resolve) === true) break;
      });
    });
    for (const file of ['accessibility-tree.js', 'content.js']) {
      await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
    }
    const page = await context.newPage();
    const previousChrome = globalThis.chrome;
    const previousBrowser = globalThis.browser;
    const dispatchedReads = [];
    const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
    globalThis.chrome = globalThis.browser = {
      runtime: { getURL: file => `extension://owned/${file}` },
      storage: { local: area, session: area },
      tabs: {
        get: async id => ({ id, url, status: 'complete' }),
        sendMessage: async (_id, message) => {
          if (!['get_accessibility_tree', 'get_page_info_cdp'].includes(message.action)) return {};
          dispatchedReads.push({ action: message.action, args: structuredClone(message.params) });
          return page.evaluate(message => window.deliverRead(message), message);
        },
      },
    };
    try {
      await page.goto(url);
      const provider = { promptTier: 'full', contextWindow: 128000, supportsVision: false };
      const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
      agent._ensureGateSetting = async () => false;
      agent._skipPermissionGate = true;
      agent._currentUrl = async () => url;
      agent._rememberMastodonObservation = agent._recordProgressObservation = async () => null;
      agent._autoRecordProgressAction = () => null;
      agent._persist = () => {};
      agent.conversationModes.set(1, 'act');
      const schemas = new Map(getToolsForMode('act', { tier: 'full', accessibilityTreeMaxChars: 12000 })
        .map(tool => [tool.function.name, tool.function.parameters]));
      const messages = [];
      let sequence = 0;
      const call = async (name, args) => {
        const id = `owned-read-${++sequence}`;
        let observed;
        await agent._executeToolBatch(1, [{ id, function: { name, arguments: JSON.stringify(args) } }],
          messages, (type, data) => { if (type === 'tool_result') observed = data.result; },
          provider, null, new Set([name]), sequence, {}, schemas);
        const result = messages.find(message => message.role === 'tool' && message.tool_call_id === id);
        assert.ok(result, 'Every exact continuation gets a model-visible result');
        assert.ok(observed && typeof observed === 'object', 'Observe the real handler result before model-facing wrapping');
        return observed;
      };
      let tree = await call('get_accessibility_tree', { filter: 'all', maxDepth: 15, maxChars: 12000, page: 1 });
      assert.equal(tree.hasMore, true, 'The real document must require multiple expanded windows');
      let pages = 1;
      let content = tree.pageContent;
      while (tree.hasMore) {
        const continuation = tree.continuationArgs;
        assert.equal(continuation.maxChars, 12000);
        const args = pages % 2 ? { continuationArgs: continuation } : continuation;
        tree = await call('get_accessibility_tree', args);
        assert.notEqual(tree.invalidToolArguments, true, 'Exact tool-returned continuations must pass validation');
        assert.equal(dispatchedReads.at(-1).args.page, continuation.page);
        assert.equal(dispatchedReads.at(-1).args.tree_revision, continuation.tree_revision);
        assert.equal(tree.page, continuation.page);
        content += tree.pageContent;
        assert.ok(++pages < 20, 'Exact continuation must make forward progress');
      }
      assert.match(content, /OWNED_DOCUMENT_TAIL/, 'Completion requires reading the actual terminal window');
      assert.ok(pages > 2, 'Exercise both compatibility and flattened continuation forms');

      const articleRef = await page.evaluate(() => __wb_ax_ref(document.querySelector('article')));
      const malformedRef = `${articleRef}}]}]}`;
      for (const args of [{ ref_id: malformedRef }, {
        continuationArgs: { filter: 'all', maxDepth: 15, maxChars: 12000, ref_id: malformedRef, page: 1 },
      }]) {
        const before = dispatchedReads.length;
        const rejected = await call('get_accessibility_tree', args);
        assert.equal(rejected.noDispatch, true);
        assert.equal(rejected.errorCode, 'invalid_tool_arguments');
        assert.equal(dispatchedReads.length, before,
          'Malformed native refs must fail in the real Agent batch before reaching the page handler');
      }
      const recovered = await call('get_accessibility_tree', { ref_id: articleRef, filter: 'all', maxChars: 12000 });
      assert.notEqual(recovered.invalidToolArguments, true);
      assert.equal(dispatchedReads.at(-1).args.ref_id, articleRef,
        'Recovery must dispatch the exact observed anchor without punctuation repair or scope invention');
      assert.match(recovered.pageContent, /Owned paragraph 1:/);
      assert.equal(recovered.hasMore, true, 'A valid anchor does not invent complete coverage of a long subtree');

      const prose = await call('read_page', { limit: 8000, offset: 4000, includeChrome: false });
      assert.notEqual(prose.invalidToolArguments, true);
      assert.equal(dispatchedReads.at(-1).action, 'get_page_info_cdp', JSON.stringify(prose));
      assert.equal(dispatchedReads.at(-1).args.limit, 6000);
      assert.equal(dispatchedReads.at(-1).args.offset, 4000);
      assert.equal(dispatchedReads.at(-1).args.includeChrome, false);
      assert.equal(prose.textOffset, 4000);
      assert.equal(prose.textLimit, 6000);
      assert.equal(prose.hasMore, true, 'Clamping must not invent complete-document coverage');
      assert.equal(prose.nextOffset, 4000 + prose.returnedLength);
      const next = await call('read_page', { continuationArgs: prose.continuationArgs });
      assert.equal(next.textOffset, prose.nextOffset, 'Clamped prose continues at the exact returned offset');
      assert.notEqual(next.text, prose.text, 'The real handler returns the next source window');
    } finally {
      globalThis.chrome = previousChrome;
      globalThis.browser = previousBrowser;
      await context.close();
      await browser.close();
    }
  });
}

const tableColumns = ['ID', 'stock', 'unit_price_cents', 'exacttechnical_literal']
  .map((name, index) => ({ name, index, type: index === 1 || index === 2 ? 'integer' : 'string' }));
const inventoryRows = Array.from({ length: 172 }, (_, index) => {
  const hash = createHash('sha256').update(`literal-table-regression:${index}`).digest('hex');
  return [
    `N${String(index + 1).padStart(3, '0')}`,
    String(parseInt(hash.slice(0, 6), 16) % 997),
    String(parseInt(hash.slice(6, 12), 16) % 100003),
    `  µ-device "${hash.slice(12, 22)}" \\path\\${index}\t'quoted'\nline Ω 漢字  `,
  ];
});
const documentRows = Array.from({ length: inventoryRows.length }, (_, index) => inventoryRows[(index * 73) % 172]);
const tableEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const rowMarkup = cells => `<tr>${cells.map(cell => `<td>${tableEscape(cell)}</td>`).join('')}</tr>`;
const tableMarkup = `<!doctype html><meta charset="utf-8"><style>td{white-space:pre-wrap}</style>
<table><caption>Inventory exact literals</caption><tr>${tableColumns.map(column => `<th>${column.name}</th>`).join('')}</tr>
${documentRows.map(rowMarkup).join('')}</table>
<table><caption>Noninventory distractors</caption><tr><th>ID</th><th>stock</th><th>unit_price_cents</th><th>exacttechnical_literal</th></tr>
${[['DISTRACTOR-A', '901', '100', 'Different µ'], ['DISTRACTOR-B', '902', '101', 'Never inventory']].map(rowMarkup).join('')}</table>`;

async function withTableDispatch(engine, build, callback) {
  const browser = await browsers.lease(engine);
  try {
    const context = await browser.newContext();
    const url = 'https://owned-table.test/literal-inventory';
    await context.route(`${url}*`, route => route.fulfill({ contentType: 'text/html', body: tableMarkup }));
    await context.addInitScript(() => {
      const listeners = [];
      window.qaTableActions = 0;
      document.addEventListener('click', () => window.qaTableActions++);
      window.chrome = window.browser = { runtime: {
        onMessage: { addListener: listener => listeners.push(listener) },
        sendMessage: async () => ({}), getURL: file => file,
      } };
      window.deliverTable = message => new Promise((resolve, reject) => {
        let responses = 0;
        const timeout = setTimeout(() => reject(new Error('Content dispatch did not return a response.')), 3000);
        const respond = result => {
          clearTimeout(timeout);
          responses++;
          resolve({ result, responses });
        };
        for (const listener of listeners) if (listener(message, {}, respond) === true) break;
      });
    });
    for (const file of ['accessibility-tree.js', 'content.js']) {
      await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
    }
    const page = await context.newPage();
    await page.goto(url);
    const extract = async params => {
      const response = await page.evaluate(params => window.deliverTable({ target: 'content', action: 'extract_data', params }), params);
      assert.equal(response.responses, 1, 'The real content listener returns exactly one complete response');
      return response.result;
    };
    await callback(page, extract, url);
    assert.equal(await page.evaluate(() => qaTableActions), 0, 'Literal exports must not perform page actions');
    await context.close();
  } finally { await browser.close(); }
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: actual table dispatch preserves all 172 shuffled literal rows and refuses missing requested IDs`,
    { timeout: scaled(60000) }, () => withTableDispatch(engine, build, async (_page, extract, url) => {
      const args = { type: 'tables', caption: 'Inventory exact literals', columns: tableColumns };
      const full = await extract(args);
      assert.equal(full.success, true);
      assert.equal(full.schema, 'webbrain.table-snapshot.v1');
      assert.equal(full.pageUrl, url);
      assert.equal(full.tableIndex, 0);
      assert.equal(full.caption, args.caption);
      assert.deepEqual(full.headerRows, [tableColumns.map(column => column.name)], 'Native headers are captured independently of model output field names');
      assert.equal(full.rows.length, 172);
      assert.deepEqual(full.rows, documentRows, 'Unicode, quotes, backslashes, tabs and surrounding whitespace remain literal');
      assert.ok(JSON.stringify(full.rows).length > 12000, 'The complete snapshot exceeds the legacy model text window');
      const ids = ['N172', 'N003', 'N107', 'N056', 'N022', 'N098', 'N043', 'N121', 'N065', 'N011'];
      const selected = await extract({ ...args, row_filter: { column: 0, equals: ids } });
      assert.equal(selected.success, true);
      assert.equal(selected.documentToken, full.documentToken);
      assert.deepEqual(selected.rows, documentRows.filter(row => ids.includes(row[0])), 'Selection stays in document order, not requested or inferred order');
      const includingHeader = await extract({ ...args, first_data_row: 0 });
      assert.deepEqual(includingHeader.headerRows, full.headerRows, 'Including data row zero cannot omit credential header evidence');
      const missing = await extract({ ...args, row_filter: { column: 0, equals: ['N003', 'ABSENT-ID'] } });
      assert.equal(missing.success, false, 'Missing requested rows must not masquerade as a complete smaller export');
      assert.equal(missing.rows, undefined, 'Refusal never returns sampled rows');
      assert.match(missing.error, /missing|not found/i);
      await _page.evaluate(() => {
        const row = document.querySelector('table').insertRow();
        for (const value of ['Late native header', 'Stock label', 'Price label', 'password']) {
          const cell = document.createElement('th'); cell.textContent = value; row.append(cell);
        }
      });
      const filteredHeaders = await extract({ ...args, row_filter: { column: 0, equals: ids } });
      assert.deepEqual(filteredHeaders.rows, selected.rows);
      assert.deepEqual(filteredHeaders.headerRows, [full.headerRows[0], ['Late native header', 'Stock label', 'Price label', 'password']],
        'Filtering data cannot hide later source th header rows');
    }));

  test(`${build}: table dispatch rejects ambiguous captions and malformed explicit selection`,
    { timeout: scaled(60000) }, () => withTableDispatch(engine, build, async (page, extract) => {
      const args = { type: 'tables', columns: tableColumns };
      const ambiguous = await extract(args);
      assert.equal(ambiguous.success, false);
      assert.equal(ambiguous.rows, undefined);
      for (const invalid of [
        { caption: 9 }, { table_index: -1 }, { table_index: 0.5 },
        { caption: 'Inventory exact literals', table_index: 1 },
        { table_index: 0, first_data_row: -1 },
        { table_index: 0, row_filter: { column: 0, equals: [9] } },
        { table_index: 0, row_filter: { column: -1, equals: ['N003'] } },
      ]) {
        const result = await extract({ ...args, ...invalid });
        assert.equal(result.success, false, `Malformed explicit selection must be refused: ${JSON.stringify(invalid)}`);
        assert.equal(result.rows, undefined);
      }
      await page.evaluate(() => document.querySelectorAll('table')[1].caption.textContent = 'Inventory exact literals');
      assert.equal((await extract({ ...args, caption: 'Inventory exact literals' })).success, false);
      await page.evaluate(() => document.querySelectorAll('table')[1].remove());
      assert.equal((await extract({ ...args, table_index: -1 })).success, false, 'Invalid explicit indexes cannot silently fall back to a singleton');
    }));

  test(`${build}: table dispatch refuses complete overlimit snapshots and preserves legacy extraction`,
    { timeout: scaled(60000) }, () => withTableDispatch(engine, build, async (page, extract) => {
      const legacy = await extract({ type: 'tables' });
      assert.equal(legacy.length, 2);
      assert.equal(legacy[0].rows.length, 173);
      assert.equal(legacy[0].rows[1][0], documentRows[0][0]);
      assert.equal(legacy[1].rows.length, 3);
      assert.equal(legacy[1].rows[1][0], 'DISTRACTOR-A');
      const headings = await extract({ type: 'headings' });
      assert.deepEqual(headings, []);
      const args = { type: 'tables', table_index: 0, first_data_row: 0, columns: tableColumns };
      await page.evaluate(() => {
        const table = document.querySelector('table');
        table.replaceChildren();
        const body = document.createElement('tbody');
        for (let index = 0; index < 10001; index++) {
          const row = body.insertRow(); row.insertCell().textContent = String(index);
        }
        table.append(body);
      });
      const tooMany = await extract(args);
      assert.equal(tooMany.success, false);
      assert.equal(tooMany.rows, undefined);
      assert.match(tooMany.error, /limit/i);
      await page.evaluate(() => {
        const table = document.querySelector('table'); table.replaceChildren();
        table.insertRow().insertCell().textContent = 'µ'.repeat(2000001);
      });
      const tooLarge = await extract(args);
      assert.equal(tooLarge.success, false);
      assert.equal(tooLarge.rows, undefined);
      assert.match(tooLarge.error, /limit/i);
    }));
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: real Agent extract_data and done transport recheck exact table references and native secret headers`,
    { timeout: scaled(60000) }, () => withTableDispatch(engine, build, async (page, _extract, url) => {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
      const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
      const transport = [];
      globalThis.chrome = globalThis.browser = {
        runtime: { getURL: file => `extension://owned/${file}` },
        storage: { local: area, session: area },
        tabs: {
          get: async id => ({ id, url, status: 'complete' }),
          sendMessage: async (_id, message) => {
            transport.push({ action: message.action, params: structuredClone(message.params) });
            const response = await page.evaluate(message => window.deliverTable(message), message);
            assert.equal(response.responses, 1);
            return response.result;
          },
        },
      };
      try {
        const provider = { promptTier: 'full', contextWindow: 128000, supportsVision: false };
        const agent = new Agent({ getActive: () => provider });
        // Strict checks: the guard's refusal itself is under test.
        agent.strictGuards = true;
        agent._effectiveRunMode = () => 'ask';
        agent._ensureGateSetting = async () => false;
        agent._skipPermissionGate = true;
        agent._persist = () => {};
        agent.conversations.set(1, [{ role: 'system', content: 'Follow the authentic current task.' },
          { role: 'user', content: 'Export the inventory exactly.', webbrainUserAuthoredText: 'Export the inventory exactly.' }]);
        agent.readCompletenessStates.set(1, { runToken: 'owned-table-transport-run' });
        const args = { type: 'tables', caption: 'Inventory exact literals', columns: tableColumns };
        const receipt = await agent.executeTool(1, 'extract_data', args);
        assert.equal(receipt.success, true, JSON.stringify(receipt));
        assert.equal(receipt.rowCount, 172);
        assert.ok(receipt.data_ref);
        assert.ok(JSON.stringify(receipt).length < 4000);
        assert.equal(receipt.rows, undefined, 'The model receives a bounded reference, not a clipped complete array');
        assert.equal(receipt.headerRows, undefined, 'Native sensitive-header metadata stays inside the app');
        const count = () => transport.filter(message => message.action === 'extract_data').length;
        assert.equal(count(), 1);
        const { getToolsForMode } = await import(`../src/${build}/src/agent/tools.js`);
        const schemas = new Map(getToolsForMode('ask', { tier: 'full' })
          .map(tool => [tool.function.name, tool.function.parameters]));
        const progressSession = agent._setProgressSession(1, {
          mode: 'active', allowedActions: ['process_item'], forbiddenActions: [], confidence: 1,
        }, { taskText: 'Export the inventory exactly.', pageScope: url, source: 'planner' });
        assert.ok(progressSession.sessionId);
        agent.progressLedgers.set(1, [{ id: 'inventory-extracted', label: 'Inventory extraction',
          status: 'processed', action: 'process_item', sessionId: progressSession.sessionId }]);
        assert.equal(agent._currentTaskLedgerRows(1).length, 1);
        assert.match(agent._appendProgressLedgerToFinal(1, 'Ordinary summary'), /Progress ledger:/,
          'The ordinary summary path still includes the real current-task progress ledger');
        let finished;
        const terminal = await agent._executeToolBatch(1, [{ id: 'exact-table-done', function: {
          name: 'done', arguments: JSON.stringify({ summary: 'Full inventory', data_ref: receipt.data_ref }),
        } }], agent.conversations.get(1), (type, data) => {
          if (type === 'tool_result' && data.name === 'done') finished = data.result;
        }, provider, null, new Set(['done']), 1, {}, schemas);
        assert.equal(finished.done, true, JSON.stringify(finished));
        assert.equal(count(), 2, 'Normal done re-enters the ordinary extract_data transport exactly once');
        assert.equal(terminal.action, 'return');
        assert.equal(terminal.value, finished.summary,
          'The real batch terminal preserves complete JSON without display repair, truncation or progress prose');
        assert.equal(terminal.rawSummary, finished.summary);
        const payload = JSON.parse(finished.summary);
        assert.deepEqual(payload, { rowCount: 172, rows: documentRows.map(cells => ({
          ID: cells[0], stock: Number(cells[1]), unit_price_cents: Number(cells[2]), exacttechnical_literal: cells[3],
        })) });
        const actSchemas = new Map(getToolsForMode('act', { tier: 'full' })
          .map(tool => [tool.function.name, tool.function.parameters]));
        agent._effectiveRunMode = () => 'act';
        agent.chatSessions.set(1, { threadKey: 'dom:owned:table', pendingOutbound: null });
        for (const outcome of ['partial', 'failed']) {
          const exact = await agent.executeTool(1, 'extract_data', args);
          assert.ok(exact.data_ref);
          const beforeDone = count();
          let ended;
          const incomplete = await agent._executeToolBatch(1, [{ id: 'table-' + outcome, function: {
            name: 'done', arguments: JSON.stringify({ summary: 'Table extraction', data_ref: exact.data_ref, outcome }),
          } }], agent.conversations.get(1), (type, data) => {
            if (type === 'tool_result' && data.name === 'done') ended = data.result;
          }, provider, null, new Set(['done']), 2, {}, actSchemas);
          assert.equal(incomplete.action, 'return', JSON.stringify(incomplete));
          assert.equal(ended.done, true); assert.equal(ended.outcome, outcome);
          assert.equal(ended.runEnded, true); assert.equal(ended.autoResumeScheduled, false);
          assert.equal(count(), beforeDone + 1, 'Partial/failed terminal still independently rereads the source');
          assert.equal(incomplete.value, JSON.stringify(payload),
            'Exact JSON keeps its format while partial/failed chat terminal flags remain truthful');
          assert.equal(incomplete.rawSummary, incomplete.value);
          assert.equal(ended.summary, incomplete.value);
        }
        agent.chatSessions.delete(1);
        agent._effectiveRunMode = () => 'ask';
        const stale = await agent.executeTool(1, 'extract_data', args);
        await page.evaluate(() => document.querySelector('table').rows[5].cells[3].textContent += ' CHANGED');
        const refused = await agent.executeTool(1, 'done', { summary: 'Cached inventory', data_ref: stale.data_ref });
        assert.equal(refused.blockedDone, true);
        assert.notEqual(refused.done, true);
        const owned = await agent.executeTool(1, 'extract_data', args);
        const beforeTaskChange = count();
        agent.conversations.set(1, [{ role: 'system', content: 'Follow the authentic current task.' },
          { role: 'user', content: 'A different task.', webbrainUserAuthoredText: 'A different task.' }]);
        assert.equal((await agent.executeTool(1, 'done', { summary: 'Old inventory', data_ref: owned.data_ref })).blockedDone, true);
        assert.equal(count(), beforeTaskChange, 'A previous task reference cannot even dispatch freshness verification');
        agent.strictSecretMode = true;
        await page.evaluate(() => document.querySelector('table').rows[0].cells[3].textContent = 'password');
        for (const first_data_row of [0, 1]) {
          const renamedSecret = await agent.executeTool(1, 'extract_data', { type: 'tables', table_index: 0,
            first_data_row, columns: [{ name: 'value', index: 3, type: 'string' }] });
          assert.equal(renamedSecret.success, false, 'Renaming the native password header cannot authorize secret export');
          assert.equal(renamedSecret.data_ref, undefined);
          assert.equal(renamedSecret.preview, undefined);
        }
      } finally {
        globalThis.chrome = previousChrome;
        globalThis.browser = previousBrowser;
      }
    }));
}
