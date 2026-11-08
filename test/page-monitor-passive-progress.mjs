import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createNativeActionMarker } from '../firefox-companion/session.mjs';
import { fixturePageTextReading } from './semantic-decision-stub.mjs';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { scaled, suiteTimeout } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

const html = `<!doctype html><style>
body { margin:0; width:900px; height:600px; }
#composer { position:absolute;left:20px;top:20px;width:300px;height:180px; }
h2 { width:250px;height:28px;margin:0; } form { width:280px;height:100px; }
#counter { position:absolute;left:500px;top:30px;width:100px;height:30px; }
#human { position:absolute;left:500px;top:100px; }
</style><section id="composer" role="region"><h2 id="recipient">Alice</h2>
<form id="form" action="/send" method="post"><label for="field">Message</label>
<input id="field" value="Prepared text"><button id="send" type="submit" aria-labelledby="send-label">Send</button></form></section>
<span id="send-label" hidden>Send</span>
<aside id="counter">100</aside><button id="human">Human control</button>`;

const modelHtml = html
  .replace('</style>', `
  #in-form-counter { position:absolute;left:220px;top:55px;width:50px;height:20px; }
  #sidebar { position:absolute;left:550px;top:200px;width:300px;height:150px; }
  #attachment { position:absolute;left:20px;top:95px;width:200px;height:25px; }
  </style>`)
  .replace('</form>', '<span id="in-form-counter">200</span><input id="attachment" type="file"></form>')
  .replace('</aside>', '</aside><aside id="sidebar"><h2 id="sidebar-heading">Unrelated sidebar</h2></aside>');

async function fixture(browser, build, body = html, { realAccessibilityTree = false, contentLibrary = false,
  richTextLibrary = false, sampleAfterOwnInput = false, fixtureUrl = 'https://monitor.test/start' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route(`${new URL(fixtureUrl).origin}/**`, route => route.fulfill({ contentType: 'text/html', body }));
  await context.addInitScript(realAccessibilityTree => {
    window.feedback = [];
    window.messageListeners = [];
    const runtime = { onMessage: { addListener: fn => messageListeners.push(fn), removeListener: () => {} },
      async sendMessage(msg) {
        if (msg.action === 'get_page_monitor_state') return { active: true, runToken: 'passive-test', documentToken: msg.documentToken };
        if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return { accepted: true }; }
        return {};
      } };
    window.chrome = { runtime }; window.browser = window.chrome;
    if (!realAccessibilityTree) window.__wb_ax_lookup = ref => document.getElementById(ref.replace(/^ref_/, ''));
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: 'passive-test', ...params } }, {}, respond);
        if (answered || asynchronous === true) break;
      }
    });
  }, realAccessibilityTree);
  if (sampleAfterOwnInput) await context.addInitScript(() => {
    const interval = window.setInterval;
    let sample;
    window.setInterval = function (callback, delay, ...args) {
      if (delay === 250) sample = callback;
      return interval.call(this, callback, delay, ...args);
    };
    document.addEventListener('input', event => {
      if (!event.isTrusted && event.target.id === 'field') setTimeout(() => sample?.(), 0);
    });
  });
  if (richTextLibrary) await context.addInitScript({
    content: fs.readFileSync(new URL(`../src/${build}/src/content/rich-text-toolbar-heuristic.js`, import.meta.url), 'utf8'),
  });
  if (realAccessibilityTree) await context.addInitScript({
    content: fs.readFileSync(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8'),
  });
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  if (contentLibrary) await context.addInitScript({
    content: fs.readFileSync(new URL(`../src/${build}/src/content/content.js`, import.meta.url), 'utf8'),
  });
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(180);
  await page.evaluate(() => { feedback = []; });
  return { context, page };
}

async function registrationFixture(browser, build, mode = 'active') {
  const context = await browser.newContext();
  await context.route('https://registration.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Registration fixture</p>' }));
  await context.addInitScript(mode => {
    window.registrationRequests = [];
    window.registrationMode = mode;
    window.registrationListeners = [];
    const runtime = { onMessage: { addListener: listener => registrationListeners.push(listener), removeListener: () => {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') {
          registrationRequests.push(message);
          if (registrationMode === 'throw') throw new Error('Background registration failed');
          if (registrationMode === 'inactive') return { active: false };
          return { active: true, runToken: 'registration-run', documentToken: message.documentToken };
        }
        return { accepted: true };
      } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.activateMonitor = () => new Promise(resolve => {
      for (const listener of registrationListeners) listener({ target: 'content', action: 'page_monitor_state', active: true }, {}, resolve);
    });
  }, mode);
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const page = await context.newPage();
  await page.goto('https://registration.test/same-url');
  await page.waitForFunction(() => window.__wbPageMonitor && registrationRequests.length > 0);
  return { context, page };
}

async function prepare(page, boundary, extra = {}) {
  return page.evaluate(async ({ boundary, extra }) => {
    const params = { operationId: 'prepared', tool: 'click_ax', selector: '#send', allowPassiveRebase: true, ...extra };
    if (boundary === 'local') {
      window.finishOperation = __wbPageMonitor.beginContentAction('click_ax', {
        ref_id: 'ref_send', allowPassiveRebase: params.allowPassiveRebase, _bidiPrepare: true,
      });
      return null;
    }
    await deliver('page_monitor_prepare', params);
    if (boundary === 'native') {
      const response = await deliver('page_monitor_dispatch', { operationId: 'prepared', kind: 'click', fenceOnly: true });
      window.preparedGuard = response.guard;
      return response.guard;
    }
    return null;
  }, { boundary, extra });
}

async function dispatch(page, boundary) {
  return page.evaluate(async boundary => {
    try {
      if (boundary === 'message') return await deliver('page_monitor_dispatch', { operationId: 'prepared', kind: 'click', fenceOnly: true });
      if (boundary === 'native') return await deliver('page_monitor_validate', { ...preparedGuard, kind: 'click' });
      if (boundary === 'activate') return __wbPageMonitor.activatePreparedDispatch({ operationId: 'prepared', kind: 'click', element: document.getElementById('send') });
      __wbPageMonitor.beforeLocalDispatch();
      finishOperation();
      return { ready: true };
    } catch (error) { return { ready: false, code: error.code }; }
  }, boundary);
}

async function modelMessage(page, action, params = {}) {
  return page.evaluate(({ action, params }) => Promise.race([
    deliver(action, params),
    new Promise(resolve => setTimeout(() => resolve({ ready: false, code: 'monitor_response_missing' }), 2000)),
  ]), { action, params });
}

// Captures the page the way page feedback does: when the capture consulted
// messaging control names nobody had read (a conversation's header actions),
// the fixtures' model oracle reads them and the page is captured again.
async function captureModelMessage(page, params = {}) {
  const result = await modelMessage(page, 'page_monitor_capture_model', params);
  if (result?.pageTextsUnread !== true) return result;
  const unread = await modelMessage(page, 'take_unread_page_texts');
  const pageReadings = {};
  for (const { kind, text } of unread?.texts || []) {
    const choice = fixturePageTextReading(kind, text);
    if (choice) (pageReadings[kind] ??= {})[text] = choice;
  }
  return modelMessage(page, 'page_monitor_capture_model', { ...params, pageReadings });
}

function assertOpaqueModelMetadata(result) {
  const allowed = new Set(['ready', 'runToken', 'documentToken', 'snapshotToken', 'targetCount', 'revision', 'code', 'reason', 'uncertified', 'focusedTargetAvailable', 'certificationFailure', 'monitoringRelaxed']);
  if (result.certificationFailure) assert.ok(['owner_unresolved', 'identity_unobserved', 'capture_limit'].includes(result.certificationFailure),
    'Certificate diagnostics contain only an enumerated failure predicate');
  assert.ok(Object.keys(result).every(key => allowed.has(key)), 'Only opaque ownership metadata and counts may cross the content boundary');
  assert.ok(Object.values(result).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)),
    'No node footprint, control values, file objects, or DOM arrays may be serialized');
  const serialized = JSON.stringify(result);
  for (const privateContent of ['Alice', 'Prepared text', 'photo-private.png', '/send', '#send', 'Unrelated sidebar']) {
    assert.equal(serialized.includes(privateContent), false, `Model ownership metadata must not include ${privateContent}`);
  }
}

async function captureModel(page) {
  const result = await captureModelMessage(page);
  assert.equal(result.ready, true, `Model capture must be supported: ${JSON.stringify(result)}`);
  assert.equal(result.runToken, 'passive-test');
  assert.ok(result.documentToken);
  assert.ok(result.snapshotToken);
  assert.ok(result.targetCount >= 3, 'The snapshot includes actual controls independently of AX reference enumeration');
  assertOpaqueModelMetadata(result);
  return result;
}

async function validateModel(page, snapshot, target = { tool: 'click_ax', ref_id: 'ref_send' }) {
  const result = await modelMessage(page, 'page_monitor_validate_model', { snapshotToken: snapshot.snapshotToken, ...target });
  assertOpaqueModelMetadata(result);
  if (result.ready) {
    assert.equal(result.runToken, snapshot.runToken);
    assert.equal(result.documentToken, snapshot.documentToken);
    assert.equal(result.snapshotToken, snapshot.snapshotToken);
  }
  return result;
}

async function prepareModel(page, snapshot, target = { tool: 'click_ax', ref_id: 'ref_send' }) {
  return modelMessage(page, 'page_monitor_prepare', {
    operationId: 'model-prepared', allowPassiveRebase: true,
    expectedModelSnapshot: snapshot.snapshotToken, ...target,
  });
}

async function dispatchModel(page, boundary = 'message') {
  const result = await modelMessage(page, 'page_monitor_dispatch', {
    operationId: 'model-prepared', kind: 'click', fenceOnly: boundary === 'native',
  });
  if (!result.ready) return result;
  if (boundary === 'native') {
    const marker = createNativeActionMarker(result.guard, 'click', 1);
    await page.evaluate(marker => { document.getElementById('send').setAttribute('data-webbrain-native-action', marker); }, marker);
    await page.locator('#send').click();
  } else {
    await page.evaluate(() => __wbPageMonitor.withPreparedDispatch('model-prepared', () => document.getElementById('send').click()));
  }
  return result;
}

async function modelFixture(browser, build, owner = 'region') {
  const result = await fixture(browser, build, modelHtml.replace('role="region"', `role="${owner}"`));
  await result.page.evaluate(() => {
    window.submissions = 0;
    document.getElementById('form').addEventListener('submit', event => { event.preventDefault(); submissions++; });
    const files = new DataTransfer();
    files.items.add(new File(['AAAA'], 'photo-private.png', { type: 'image/png', lastModified: 1 }));
    document.getElementById('attachment').files = files.files;
  });
  await result.page.waitForTimeout(180);
  return result;
}

async function treeModelFixture(browser, build, body = modelHtml, options = {}) {
  const result = await fixture(browser, build, body, { realAccessibilityTree: true, ...options });
  await result.page.evaluate(() => {
    window.submissions = 0; window.clicks = 0;
    document.getElementById('form')?.addEventListener('submit', event => { event.preventDefault(); submissions++; });
    document.addEventListener('click', event => { if (event.target.closest?.('#send')) clicks++; });
  });
  assert.equal(await result.page.evaluate(() => window.__wb_ax_installed), true);
  return result;
}

async function captureTreeModel(page) {
  const result = await captureModelMessage(page, { includeTree: true });
  assert.equal(result.ready, true, `The real accessibility tree must be captured: ${JSON.stringify(result)}`);
  const { page: observation, ...metadata } = result;
  assertOpaqueModelMetadata(metadata);
  assert.equal(metadata.runToken, 'passive-test');
  assert.ok(metadata.documentToken);
  assert.ok(metadata.snapshotToken);
  // The smallest chat fixture has only its editor and Send action; an
  // unrelated body button intentionally remains uncertified.
  assert.ok(metadata.targetCount >= 2, `Current editor/action controls must be certified: ${JSON.stringify(metadata)}`);
  assert.equal(observation?.success, true);
  assert.ok(JSON.stringify(observation).length <= 16000, 'The complete model-visible page must fit the Agent serializer before ref coverage is certified');
  assert.equal(observation.url, page.url());
  assert.equal(typeof observation.pageContent, 'string');
  assert.ok(observation.pageContent.length > 0);
  return result;
}

function sendRefFromTree(snapshot) {
  const line = snapshot.page.pageContent.split('\n').find(line => /button "Send"/.test(line));
  const ref = line?.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref, `The real tree must expose the Send control: ${snapshot.page.pageContent}`);
  assert.notEqual(ref, 'ref_send');
  return ref;
}

const plainChatHtml = modelHtml
  .replace('<section id="composer" role="region">', '<div id="composer">')
  .replace('</section>', '</div>');

const toolbarChatHtml = `<!doctype html><style>
body { margin:0;width:900px;height:600px; }
#chat { position:absolute;left:20px;top:20px;width:450px;height:250px; }
#chat h2 { margin:0;height:30px; }
#composer { width:400px;height:150px; }
#field { width:280px;height:50px; }
#toolbar { width:300px;height:40px; }
#in-form-counter { position:absolute;left:330px;top:100px; }
#human { position:absolute;left:600px;top:350px; }
</style><main id="chat"><header><h2 id="recipient">Alice</h2></header>
<div id="composer"><div id="editor"><label for="field">Message</label><textarea id="field">Prepared text</textarea></div>
<div id="toolbar"><button id="send" type="button">Send</button><span id="in-form-counter">200</span></div></div></main>
<button id="human">Human control</button>`;

async function focusedModelFixture(browser, build) {
  const body = `${modelHtml}<input id="other-field" value="unrelated draft" style="position:absolute;left:650px;top:450px;width:200px">`;
  const result = await treeModelFixture(browser, build, body, { contentLibrary: true });
  await result.page.evaluate(() => {
    const field = document.getElementById('field'); field.focus(); field.setSelectionRange(field.value.length, field.value.length);
    window.receivedKeys = [];
    field.addEventListener('keydown', event => receivedKeys.push(event.key));
  });
  await result.page.waitForTimeout(180);
  await result.page.evaluate(() => { feedback = []; });
  return result;
}

async function nativeInputGuard(page, snapshot, target = { tool: 'press_keys', key: 'ArrowLeft' }) {
  assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
  const prepared = await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'input', fenceOnly: true });
  assert.equal(prepared.ready, true);
  assert.ok(prepared.guard?.nativeSecret);
  return prepared.guard;
}

async function performNativeKey(page, guard, key, sequence, { rebindFocus = false } = {}) {
  const validation = await modelMessage(page, 'page_monitor_validate', { ...guard, kind: 'input', rebindFocus });
  if (!validation.ready) return validation;
  const current = { ...guard, revision: validation.revision };
  const marker = createNativeActionMarker(current, 'input', sequence);
  await page.evaluate(({ marker, rebindFocus }) => {
    const target = rebindFocus ? document.activeElement : document.getElementById('field');
    target.setAttribute('data-webbrain-native-action', marker);
  }, { marker, rebindFocus });
  await page.keyboard.press(key);
  return { ...validation, guard: current };
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: newest explicit preparation supersedes an older selectorless focus proof on the same field`, async () => {
    const browser = await browsers.lease(engine);
    const { context, page } = await focusedModelFixture(browser, build);
    try {
      const previous = await captureTreeModel(page);
      const oldTarget = { tool: 'press_keys', key: 'ArrowLeft' };
      const oldPreparation = await modelMessage(page, 'page_monitor_prepare', {
        operationId: 'older-focused-proof', expectedModelSnapshot: previous.snapshotToken, allowPassiveRebase: true, ...oldTarget,
      });
      assert.equal(oldPreparation.modelBindingValid, true);
      await page.evaluate(() => { document.getElementById('other-field').focus(); });
      await page.waitForTimeout(20);
      assert.equal((await validateModel(page, previous, oldTarget)).ready, false);

      const current = await captureTreeModel(page);
      const refs = [...current.page.pageContent.matchAll(/\[(ref_[A-Za-z0-9_-]+)\]/g)].map(match => match[1]);
      const ref_id = await page.evaluate(refs => refs.find(ref => __wb_ax_lookup(ref) === document.getElementById('field')), refs);
      assert.ok(ref_id, 'Use the current real AX reference for the explicit field action');
      const target = { tool: 'type_ax', ref_id, text: ' appended', clear: false };
      assert.equal((await validateModel(page, current, target)).ready, true);
      assert.equal((await prepareModel(page, current, target)).modelBindingValid, true);
      const result = await modelMessage(page, 'type_ax', { ref_id, text: ' appended', clear: false });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await page.evaluate(() => document.getElementById('field').value), 'Prepared text appended');
      assert.equal(await page.evaluate(() => document.getElementById('other-field').value), 'unrelated draft');
      assert.equal((await validateModel(page, previous, oldTarget)).ready, false);
      assert.equal((await modelMessage(page, 'page_monitor_dispatch', { operationId: 'older-focused-proof', kind: 'input', fenceOnly: true })).ready, false);
    } finally { await context.close(); await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  // 8 subtests.
  test(`${build}: ordinary forms bind their outside page heading across the real field handler`, { timeout: suiteTimeout(8) }, async t => {
    const browser = await browsers.lease(engine);
    const body = `<!doctype html><style>body{font:18px sans-serif;margin:32px}label{display:block;margin:18px 0}aside{position:absolute;right:35px;top:20px}</style>
      <h1 id="page-heading">QA contact form</h1><aside id="counter">100</aside>
      <form id="form" action="/send"><label>Name <input id="field" name="name"></label>
      <label>Email <input id="email" name="email"></label><button id="send">Send</button></form>`;
    try {
      await t.test('the periodic sample cannot reinterpret an own value setter during field verification', async () => {
        const { context, page } = await treeModelFixture(browser, build, body, {
          contentLibrary: true, sampleAfterOwnInput: true,
        });
        try {
          const snapshot = await captureTreeModel(page);
          const ref = snapshot.page.pageContent.split('\n').find(line => /textbox "Name"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          assert.equal((await prepareModel(page, snapshot, { tool: 'set_field', ref_id: ref })).modelBindingValid, true);
          assert.equal((await modelMessage(page, 'set_field', { ref_id: ref, text: 'WebBrain QA' })).success, true);
          await page.waitForTimeout(180);
          assert.equal((await page.evaluate(() => feedback)).some(event => event.kind === 'dom' && event.source === 'unknown'), false,
            'A timer tick after own input attribution ends must preserve the already observed value write');
          const next = await captureTreeModel(page);
          const email = next.page.pageContent.split('\n').find(line => /textbox "Email"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          assert.equal((await validateModel(page, next, { tool: 'set_field', ref_id: email })).ready, true);
        } finally { await context.close(); }
      });
      await t.test('an unrelated sidebar cannot starve an unchanged observed field', async () => {
        const { context, page } = await treeModelFixture(browser, build, body, { contentLibrary: true });
        try {
          const snapshot = await captureTreeModel(page);
          const ref = snapshot.page.pageContent.split('\n').find(line => /textbox "Name"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          assert.ok(ref, snapshot.page.pageContent);
          const target = { tool: 'set_field', ref_id: ref };
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
          const fence = await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'input', ref_id: ref, fenceOnly: true });
          assert.equal(fence.ready, true, JSON.stringify(fence));
          const result = await modelMessage(page, 'set_field', { ref_id: ref, text: 'WebBrain QA' });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(await page.locator('#field').inputValue(), 'WebBrain QA');
          assert.equal((await page.evaluate(() => feedback)).some(event => event.kind === 'input'), false,
            'Own synchronous field events must not become independent page interventions');
          await modelMessage(page, 'page_monitor_finish', { operationId: 'model-prepared' });
          const next = await captureTreeModel(page);
          const emailRef = next.page.pageContent.split('\n').find(line => /textbox "Email"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          await page.evaluate(() => { window.counterTimer = setInterval(() => { document.getElementById('counter').textContent = String(Number(document.getElementById('counter').textContent) + 1); }, 50); });
          await page.waitForTimeout(280);
          const validation = await validateModel(page, next, { tool: 'set_field', ref_id: emailRef });
          assert.equal(validation.ready, true,
            `The finished action late-event grace must not make unrelated counters invalidate the next inference: ${JSON.stringify({ validation, feedback: await page.evaluate(() => feedback) })}`);
          assert.equal((await prepareModel(page, next, { tool: 'set_field', ref_id: emailRef })).modelBindingValid, true);
          assert.equal((await modelMessage(page, 'set_field', { ref_id: emailRef, text: 'qa@example.test' })).success, true);
          await page.evaluate(() => { clearInterval(counterTimer); });
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });
      await t.test('independent page input after the dispatch task still invalidates the next decision', async () => {
        const { context, page } = await treeModelFixture(browser, build, body, { contentLibrary: true });
        try {
          const snapshot = await captureTreeModel(page);
          const ref = snapshot.page.pageContent.split('\n').find(line => /textbox "Name"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          assert.equal((await prepareModel(page, snapshot, { tool: 'set_field', ref_id: ref })).modelBindingValid, true);
          assert.equal((await modelMessage(page, 'set_field', { ref_id: ref, text: 'WebBrain QA' })).success, true);
          const next = await captureTreeModel(page);
          await page.evaluate(() => { const field = document.getElementById('field'); field.value = 'Independent page edit'; field.dispatchEvent(new Event('input', { bubbles: true })); });
          assert.equal((await validateModel(page, next, { tool: 'set_field', ref_id: ref })).ready, false);
          assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'input' && event.source === 'page'));
        } finally { await context.close(); }
      });
      await t.test('human typing immediately after a finished field action is not absorbed by its late-event grace', async () => {
        const { context, page } = await treeModelFixture(browser, build, body, { contentLibrary: true });
        try {
          const snapshot = await captureTreeModel(page);
          const ref = snapshot.page.pageContent.split('\n').find(line => /textbox "Name"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          assert.equal((await prepareModel(page, snapshot, { tool: 'set_field', ref_id: ref })).modelBindingValid, true);
          assert.equal((await modelMessage(page, 'set_field', { ref_id: ref, text: 'WebBrain QA' })).success, true);
          await modelMessage(page, 'page_monitor_finish', { operationId: 'model-prepared' });
          await page.evaluate(() => { feedback = []; });
          await page.keyboard.type('x');
          assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'),
            'A finished action must not claim the next real user key/input sequence');
        } finally { await context.close(); }
      });
      for (const [name, mutate] of [
        ['page identity', () => { document.getElementById('page-heading').textContent = 'Different contact form'; }],
        ['form action', () => { document.getElementById('form').action = '/other'; }],
        ['sibling form value', () => { document.getElementById('email').value = 'other@example.test'; }],
        ['same-ref node replacement', () => { const field = document.getElementById('field'); field.replaceWith(field.cloneNode(true)); }],
      ]) await t.test(`${name} changes still reject before field dispatch`, async () => {
        const { context, page } = await treeModelFixture(browser, build, body, { contentLibrary: true });
        try {
          const snapshot = await captureTreeModel(page);
          const ref = snapshot.page.pageContent.split('\n').find(line => /textbox "Name"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          const target = { tool: 'set_field', ref_id: ref };
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          await page.evaluate(mutate);
          const fence = await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'input', ref_id: ref, fenceOnly: true });
          assert.equal(fence.ready, false);
          assert.equal(await page.locator('#field').inputValue(), '');
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  // 17 subtests.
  test(`${build}: focused snapshots reach actual content handlers and preserve native dispatch phases`, { timeout: suiteTimeout(17) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const [name, target, action, params, expectedValue] of [
        ['selectorless text', { tool: 'type_text', text: ' appended' }, 'type', { text: ' appended' }, 'Prepared text appended'],
        ['selectorless keys', { tool: 'press_keys', key: 'ArrowLeft', repeat: 2 }, 'press_keys', { key: 'ArrowLeft', repeat: 2 }, 'Prepared text'],
      ]) await t.test(`${name} inherits its original focused target through the real message handler`, async () => {
        const { context, page } = await focusedModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          assert.equal(snapshot.focusedTargetAvailable, true);
          await page.evaluate(() => { document.getElementById('in-form-counter').textContent = '201'; });
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          const result = await modelMessage(page, action, params);
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.pageFeedbackPending, undefined);
          assert.equal(await page.evaluate(() => document.getElementById('field').value), expectedValue);
          if (action === 'press_keys') assert.deepEqual(await page.evaluate(() => receivedKeys), ['ArrowLeft', 'ArrowLeft']);
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['focus identity', () => document.getElementById('other-field').focus()],
        ['recipient', () => { document.getElementById('recipient').textContent = 'Bob'; }],
        ['field value', () => { document.getElementById('field').value = 'Different private draft'; }],
      ]) await t.test(`selectorless typing rejects changed ${name} before its first dispatch`, async () => {
        const { context, page } = await focusedModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'type_text', text: ' appended' };
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          await page.evaluate(mutate);
          await page.waitForTimeout(180);
          assert.equal((await validateModel(page, snapshot, target)).ready, false);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
          const fence = await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'input', fenceOnly: true });
          assert.equal(fence.ready, false);
          assert.equal((await page.evaluate(() => document.getElementById('field').value)).includes(' appended'), false);
        } finally { await context.close(); }
      });

      await t.test('recipient race after a valid prepare remains blocked at the actual content message boundary', async () => {
        const { context, page } = await focusedModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'type_text', text: ' appended' };
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          await page.evaluate(() => { document.getElementById('recipient').textContent = 'Bob'; });
          const result = await modelMessage(page, 'type', { text: ' appended' });
          assert.equal(result.success, false);
          assert.equal(result.noDispatch, true);
          assert.equal(result.pageFeedbackPending, true);
          assert.equal(await page.evaluate(() => document.getElementById('field').value), 'Prepared text');
        } finally { await context.close(); }
      });

      await t.test('body-level keyboard actions retain the global fence', async () => {
        const { context, page } = await treeModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          assert.equal(snapshot.focusedTargetAvailable, false);
          for (const target of [{ tool: 'press_keys', key: 'Escape' }, { tool: 'type_text', text: 'unused' }]) {
            const validation = await validateModel(page, snapshot, target);
            assert.equal(validation.ready, false);
            assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
            assert.equal((await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'input', fenceOnly: true })).ready, false);
          }
        } finally { await context.close(); }
      });

      await t.test('native split typing accepts its own changed input value with the same original focus', async () => {
        const { context, page } = await focusedModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const guard = await nativeInputGuard(page, snapshot, { tool: 'type_text', text: 'xy' });
          const first = await performNativeKey(page, guard, 'x', 1);
          assert.equal(first.ready, true);
          assert.equal(await page.evaluate(() => document.getElementById('field').value), 'Prepared textx');
          const second = await performNativeKey(page, first.guard, 'y', 2);
          assert.equal(second.ready, true);
          assert.equal(await page.evaluate(() => document.getElementById('field').value), 'Prepared textxy');
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
        } finally { await context.close(); }
      });

      await t.test('native split typing preserves an unlabeled contenteditable body with the same recipient', async () => {
        const body = modelHtml.replace('<label for="field">Message</label>', '')
          .replace('<input id="field" value="Prepared text">', '<div id="field" role="textbox" contenteditable="true">Prepared text</div>');
        const { context, page } = await treeModelFixture(browser, build, body);
        try {
          await page.evaluate(() => {
            const field = document.getElementById('field'); field.focus();
            const range = document.createRange(); range.selectNodeContents(field); range.collapse(false);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          });
          await page.waitForTimeout(180);
          await page.evaluate(() => { feedback = []; });
          const snapshot = await captureTreeModel(page);
          const guard = await nativeInputGuard(page, snapshot, { tool: 'type_text', text: 'xy' });
          const first = await performNativeKey(page, guard, 'x', 1);
          assert.equal(first.ready, true);
          assert.equal(await page.evaluate(() => document.getElementById('field').textContent), 'Prepared textx');
          const second = await performNativeKey(page, first.guard, 'y', 2);
          assert.equal(second.ready, true);
          assert.equal(await page.evaluate(() => document.getElementById('field').textContent), 'Prepared textxy');
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
        } finally { await context.close(); }
      });

      await t.test('requested native Tab can rebind focus for its next native phase', async () => {
        const { context, page } = await focusedModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const guard = await nativeInputGuard(page, snapshot, { tool: 'press_keys' });
          const first = await performNativeKey(page, guard, 'Tab', 1);
          assert.equal(first.ready, true);
          assert.equal(await page.evaluate(() => document.activeElement.id), 'send');
          const second = await performNativeKey(page, first.guard, 'Tab', 2, { rebindFocus: true });
          assert.equal(second.ready, true);
          assert.equal(await page.evaluate(() => document.activeElement.id), 'attachment');
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
        } finally { await context.close(); }
      });

      await t.test('synchronous input handler recipient switching cannot authorize the next native key', async () => {
        const { context, page } = await focusedModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const guard = await nativeInputGuard(page, snapshot, { tool: 'type_text', text: 'xy' });
          await page.evaluate(() => document.getElementById('field').addEventListener('input', () => {
            document.getElementById('recipient').textContent = 'Bob';
          }, { once: true }));
          const first = await performNativeKey(page, guard, 'x', 1);
          assert.equal(first.ready, true);
          assert.equal(await page.evaluate(() => document.getElementById('recipient').textContent), 'Bob');
          const next = await performNativeKey(page, first.guard, 'y', 2);
          assert.equal(next.ready, false);
          assert.equal(await page.evaluate(() => document.getElementById('field').value), 'Prepared textx');
        } finally { await context.close(); }
      });

      await t.test('finished action expiry does not label subsequent clock churn as unknown', async () => {
        const { context, page } = await focusedModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'type_text', text: ' appended' };
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          assert.equal((await modelMessage(page, 'type', { text: ' appended' })).success, true);
          await modelMessage(page, 'page_monitor_finish', { operationId: 'model-prepared' });
          await page.waitForTimeout(350);
          await page.evaluate(() => { feedback = []; document.getElementById('in-form-counter').textContent = '201'; });
          await page.waitForTimeout(180);
          const observations = await page.evaluate(() => feedback.filter(event => event.kind === 'dom'));
          assert.ok(observations.length > 0);
          assert.ok(observations.every(event => event.source === 'page'), JSON.stringify(observations));
          const fresh = await captureTreeModel(page);
          await page.evaluate(() => { document.getElementById('in-form-counter').textContent = '202'; });
          assert.equal((await validateModel(page, fresh, { tool: 'type_text', text: ' again' })).ready, true);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['recipient', () => { document.getElementById('recipient').textContent = 'Bob'; }],
        ['focus', () => document.getElementById('other-field').focus()],
      ]) for (const afterFirst of [false, true]) await t.test(`native ${name} change ${afterFirst ? 'between typing phases' : 'before first input'} prevents the next key`, async () => {
        const { context, page } = await focusedModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          let guard = await nativeInputGuard(page, snapshot, { tool: 'type_text', text: 'xy' });
          if (afterFirst) {
            const first = await performNativeKey(page, guard, 'x', 1);
            assert.equal(first.ready, true); guard = first.guard;
          }
          await page.evaluate(mutate);
          const result = await performNativeKey(page, guard, 'y', afterFirst ? 2 : 1);
          assert.equal(result.ready, false);
          assert.equal(await page.evaluate(() => document.getElementById('field').value), `Prepared text${afterFirst ? 'x' : ''}`);
          assert.equal(await page.evaluate(() => document.getElementById('other-field').value), 'unrelated draft');
        } finally { await context.close(); }
      });

      await t.test('certified click fallback reprepare preserves the pre-inference recipient fence', async () => {
        const { context, page } = await treeModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          await modelMessage(page, 'page_monitor_prepare', { operationId: 'model-prepared', ...target, allowPassiveRebase: true });
          await page.evaluate(() => { document.getElementById('recipient').textContent = 'Bob'; });
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: uncertified raw selectors preserve node identity and the strict global fence`, { timeout: scaled(30000) }, async t => {
    const browser = await browsers.lease(engine);
    const rawBody = modelHtml.replace('</aside>', '</aside><div id="raw" onclick="window.rawClicks++" style="position:absolute;left:600px;top:500px;width:120px;height:30px">Raw action</div>');
    try {
      await t.test('original raw onclick node reports only an opaque uncertified result and can use strict preparation', async () => {
        const { context, page } = await treeModelFixture(browser, build, rawBody, { contentLibrary: true });
        try {
          await page.evaluate(() => { window.rawClicks = 0; });
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'click', selector: '#raw' };
          const validation = await validateModel(page, snapshot, target);
          assert.equal(validation.ready, false); assert.equal(validation.uncertified, true);
          await modelMessage(page, 'page_monitor_prepare', { operationId: 'raw-strict', ...target, allowPassiveRebase: false });
          const fence = await modelMessage(page, 'page_monitor_dispatch', { operationId: 'raw-strict', kind: 'click', fenceOnly: true });
          assert.equal(fence.ready, true);
          const result = await modelMessage(page, 'click', { selector: '#raw' });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(await page.evaluate(() => rawClicks), 1);
        } finally { await context.close(); }
      });
      for (const [name, mutate] of [
        ['replacement', () => { const raw = document.getElementById('raw'); raw.replaceWith(raw.cloneNode(true)); }],
        ['action label', () => { document.getElementById('raw').textContent = 'Other raw action'; }],
        ['authored handler', () => { document.getElementById('raw').setAttribute('onclick', 'window.changedAction=true'); }],
      ]) await t.test(`raw ${name} cannot inherit even the uncertified old-node proof`, async () => {
        const { context, page } = await treeModelFixture(browser, build, rawBody);
        try {
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'click', selector: '#raw' };
          assert.equal((await validateModel(page, snapshot, target)).uncertified, true);
          await page.evaluate(mutate);
          const validation = await validateModel(page, snapshot, target);
          assert.equal(validation.ready, false); assert.notEqual(validation.uncertified, true);
        } finally { await context.close(); }
      });
      await t.test('uncertified targets never rebase a counter mutation during strict preparation', async () => {
        const { context, page } = await treeModelFixture(browser, build, rawBody);
        try {
          const snapshot = await captureTreeModel(page);
          assert.equal((await validateModel(page, snapshot, { tool: 'click', selector: '#raw' })).uncertified, true);
          await modelMessage(page, 'page_monitor_prepare', { operationId: 'raw-strict', tool: 'click', selector: '#raw', allowPassiveRebase: false });
          await page.evaluate(() => { document.getElementById('in-form-counter').textContent = '201'; });
          const result = await modelMessage(page, 'page_monitor_dispatch', { operationId: 'raw-strict', kind: 'click', fenceOnly: true });
          assert.equal(result.ready, false); assert.equal(result.pageFeedbackPending, true);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

const conversationPaneHtml = `<!doctype html><style>
body { margin:0;font:16px sans-serif; } aside { position:absolute;left:0;top:0;width:300px;height:650px;overflow:auto; }
#main { position:absolute;left:320px;top:0;width:670px;height:650px; }
#main>header { height:70px;display:flex;align-items:center;gap:20px;padding-left:30px; }
#contact { width:180px;height:24px; } #messages { height:440px;overflow:auto; }
footer { display:flex;gap:15px;align-items:center; } #body { width:380px;min-height:32px; }
button { min-height:28px; } #footer-clock { position:absolute;left:550px;top:570px; }
</style><aside><header><h1>App title</h1></header><button>Anne</button><h2 id="sidebar-heading">Sidebar recipient</h2></aside>
<main id="main"><header><img alt="" width="40" height="40">
<div id="contact" role="button" tabindex="0"><span title="Anne">Anne</span></div>
<button aria-label="Voice call">Call</button><button aria-label="Search">Search</button></header>
<section id="messages"><span id="history-counter">100</span><div>Anne</div><button id="history-action">Other person</button></section>
<footer><button id="attach">Attach</button><div id="body" contenteditable="true" role="textbox" aria-label="Type a message to +90 555 000 00 01">Selam</div>
<input id="file" type="file" accept="image/*" hidden><button id="send" aria-label="Send">Send</button><span id="footer-clock">12:00</span></footer></main>`;

async function conversationPaneFixture(browser, build, body = conversationPaneHtml, fixtureUrl = 'https://web.whatsapp.com/') {
  const result = await fixture(browser, build, body, { realAccessibilityTree: true, contentLibrary: true, richTextLibrary: true, fixtureUrl });
  await result.page.evaluate(() => {
    window.submissions = 0; document.getElementById('send').addEventListener('click', () => submissions++);
  });
  return result;
}

async function conversationRecipientBinding(page) {
  const result = await modelMessage(page, 'probe_message_recipient_guard', {
    adapterName: 'generic-messaging', tool: 'click', args: { selector: '#send' }, bindDispatch: true, expectedRecipients: ['anne'],
  });
  assert.equal(result.conclusive, true);
  assert.equal(result.strongRecipientCandidates?.length, 1);
  assert.ok(result.messageRecipientDispatchBinding?.token);
  return { messageRecipientGuardRequired: true, messageRecipientDispatchBinding: result.messageRecipientDispatchBinding };
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: heading-free native conversation panes share exact recipient evidence with model snapshots`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const [name, body, fixtureUrl, mutate] of [
        ['history counter', conversationPaneHtml, 'https://web.whatsapp.com/', () => { document.getElementById('history-counter').textContent = '101'; }],
        ['history action and sidebar heading', conversationPaneHtml, 'https://example.test/chat/one', () => {
          document.getElementById('history-action').textContent = 'An unrelated history action';
          document.getElementById('sidebar-heading').textContent = 'Another sidebar heading';
        }],
        ['footer clock', conversationPaneHtml, 'https://web.whatsapp.com/', () => { document.getElementById('footer-clock').textContent = '12:01'; }],
        ['inner footer action toolbar', conversationPaneHtml.replace('<button id="send" aria-label="Send">Send</button>', '<div role="toolbar"><button id="send" aria-label="Send">Send</button></div>'), 'https://web.whatsapp.com/', () => { document.getElementById('history-counter').textContent = '101'; }],
      ]) await t.test(`${name} can update around a captured contact-button send`, async () => {
        const { context, page } = await conversationPaneFixture(browser, build, body, fixtureUrl);
        try {
          const snapshot = await captureTreeModel(page);
          assert.ok(snapshot.page.pageContent.includes('Anne'));
          assert.ok(snapshot.page.pageContent.includes('Type a message to +90 555 000 00 01'));
          for (const privateField of ['signature', 'aliases', 'contextNodes', 'labelledByNodes']) {
            assert.equal(JSON.stringify(snapshot).includes(`"${privateField}"`), false);
          }
          const target = { tool: 'click', selector: '#send' };
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          await page.evaluate(mutate);
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          const recipient = name === 'inner footer action toolbar' ? null : await conversationRecipientBinding(page);
          await page.evaluate(() => { document.getElementById('history-counter').textContent = '102'; });
          // The monitor also covers an exact footer action in a small inner
          // toolbar. Preserve the recipient classifier's existing utility
          // outcome for that shape; exercise its certified dispatch directly.
          if (recipient) {
            const result = await modelMessage(page, 'click', { selector: '#send', ...recipient });
            assert.equal(result.success, true, JSON.stringify(result));
          } else assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
        } finally { await context.close(); }
      });

      await t.test('priority capture exposes the complete composer destination when history truncates its AX node', async () => {
        const history = Array.from({ length: 250 }, (_, index) => `<button type="submit" style="position:absolute;left:20px;top:140px">Unrelated history action ${index} with enough rendered text to truncate this pane observation</button>`).join('');
        const body = conversationPaneHtml.replace('<section id="messages">', `<section id="messages">${history}`);
        const { context, page } = await conversationPaneFixture(browser, build, body);
        try {
          const target = { tool: 'click', selector: '#send' };
          const snapshot = await captureDeepPriority(page, target);
          assert.match(snapshot.page.pageContent, /visible identity "Type a message to \+90 555 000 00 01" \[ref_/);
          assert.ok(snapshot.page.pageContent.includes('Anne'));
          assert.equal(snapshot.page.pageContent.includes('Selam'), false, 'The supplemental label must not serialize the omitted editor contents');
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          await page.evaluate(() => { document.getElementById('history-counter').textContent = '101'; });
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);

          const current = await captureDeepPriority(page, target);
          await page.evaluate(() => { document.getElementById('body').setAttribute('aria-label', 'Type a message to +90 555 000 00 02'); });
          assert.equal((await validateModel(page, current, target)).ready, false);
          assert.equal((await prepareModel(page, current, target)).modelBindingValid, false);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      await t.test('a complete long composer label is exposed once per capture across multiple footer controls', async () => {
        const authoredLabel = `Type a message to +90 555 000 00 01 ${'complete destination details '.repeat(10).trim()}`;
        assert.ok(authoredLabel.length > 120 && authoredLabel.length <= 512);
        const controls = Array.from({ length: 8 }, (_, index) => `<button id="footer-action-${index}" style="position:absolute;left:400px;top:${120 + index * 35}px">Post action ${index}</button>`).join('');
        const body = conversationPaneHtml.replace('aria-label="Type a message to +90 555 000 00 01"', `aria-label="${authoredLabel}"`)
          .replace('<footer>', `<footer>${controls}`);
        const { context, page } = await conversationPaneFixture(browser, build, body);
        try {
          const target = { tool: 'click', selector: '#send' };
          for (const actionTarget of [undefined, target]) {
            const snapshot = await captureDeepPriority(page, actionTarget);
            const completeLines = snapshot.page.pageContent.split('\n').filter(line => line.startsWith(`visible identity ${JSON.stringify(authoredLabel)} `));
            assert.equal(completeLines.length, 1, 'Each new snapshot must publish one complete authored label despite repeated footer proofs');
            assert.equal((await validateModel(page, snapshot, target)).ready, true);
            for (let index = 0; index < 8; index++) {
              assert.equal((await validateModel(page, snapshot, { tool: 'click', selector: `#footer-action-${index}` })).ready, true);
            }
            await page.evaluate(() => { document.getElementById('history-counter').textContent += '1'; });
            assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          }
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['same-name destination phone', () => { document.getElementById('body').setAttribute('aria-label', 'Type a message to +90 555 000 00 02'); }],
        ['same-name contact replacement', () => { const contact = document.getElementById('contact'); contact.replaceWith(contact.cloneNode(true)); }],
        ['composer replacement', () => { const editor = document.getElementById('body'); editor.replaceWith(editor.cloneNode(true)); }],
        ['header scope', () => { document.getElementById('messages').appendChild(document.querySelector('#main>header')); }],
        ['new ambiguous header contact', () => { const contact = document.createElement('div'); contact.setAttribute('role', 'button'); contact.textContent = 'Bob'; document.querySelector('#main>header').appendChild(contact); }],
      ]) await t.test(`${name} changes reject the original contact-button proof before dispatch`, async () => {
        const { context, page } = await conversationPaneFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'click', selector: '#send' };
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          await page.evaluate(mutate);
          assert.equal((await validateModel(page, snapshot, target)).ready, false);
          assert.equal((await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'click', fenceOnly: true })).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      await t.test('the original public contact and private conversation proof are captured in the same task', async () => {
        const { context, page } = await conversationPaneFixture(browser, build);
        try {
          // The header controls' names are read before this capture, so it is
          // one capture task, as in a run that already observed this page.
          await captureModelMessage(page, { includeTree: true });
          await page.evaluate(() => {
            const original = window.__generateAccessibilityTree; let queued = false;
            window.__generateAccessibilityTree = (...args) => {
              const result = original(...args);
              if (!queued) { queued = true; queueMicrotask(() => { const label = document.querySelector('#contact span'); label.textContent = 'Bob'; label.title = 'Bob'; }); }
              return result;
            };
          });
          const snapshot = await captureTreeModel(page);
          assert.ok(snapshot.page.pageContent.includes('Anne'));
          assert.equal(snapshot.page.pageContent.includes('Bob'), false);
          assert.equal(await page.evaluate(() => document.getElementById('contact').innerText), 'Bob');
          assert.equal((await validateModel(page, snapshot, { tool: 'click', selector: '#send' })).ready, false);
          assert.equal((await prepareModel(page, snapshot, { tool: 'click', selector: '#send' })).modelBindingValid, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

const ownerIdentityHtml = modelHtml.replace('<form id="form"', `<div id="recipient-chip" data-recipient-id="Alice" style="position:absolute;left:350px;top:0;width:160px;height:25px">Alice</div>
<label id="recipient-control-label" for="recipient-control" style="position:absolute;left:350px;top:30px">Recipient</label>
<input id="recipient-control" value="Alice" style="position:absolute;left:350px;top:55px;width:140px">
<span id="owner-clock" style="position:absolute;left:350px;top:90px">12:00</span>
<aside id="owner-sidebar" role="complementary" style="position:absolute;left:600px;top:30px">
<label for="sidebar-field">Sidebar filter</label><input id="sidebar-field" value="unrelated"></aside><form id="form"`);

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: owner-local recipient carriers outside a form remain bound without freezing sidebar state`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const [name, mutate] of [
        ['recipient identity carrier', () => { document.getElementById('recipient-chip').setAttribute('data-recipient-id', 'Bob'); }],
        ['outside-form recipient input', () => { document.getElementById('recipient-control').value = 'Bob'; }],
        ['outside-form recipient label', () => { document.getElementById('recipient-control-label').textContent = 'Other recipient'; }],
      ]) for (const afterPrepare of [false, true]) await t.test(`${name} changes ${afterPrepare ? 'after prepare' : 'during inference'} prevent submit`, async () => {
        const { context, page } = await treeModelFixture(browser, build, ownerIdentityHtml);
        try {
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          if (afterPrepare) assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          await page.evaluate(mutate);
          assert.equal((await validateModel(page, snapshot, target)).ready, false);
          if (!afterPrepare) assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['unrelated clock sibling', () => { document.getElementById('owner-clock').textContent = '12:01'; }],
        ['unrelated sidebar input', () => { document.getElementById('sidebar-field').value = 'another unrelated filter'; }],
      ]) await t.test(`${name} may update while the intended owner controls stay unchanged`, async () => {
        const { context, page } = await treeModelFixture(browser, build, ownerIdentityHtml);
        try {
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
          await page.evaluate(mutate);
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      await t.test('a complete 200–400 character visible carrier label is observed and certified without exposing its private identity', async () => {
        const { context, page } = await treeModelFixture(browser, build, ownerIdentityHtml);
        try {
          const label = 'Recipient "Team" '.repeat(20).trim();
          assert.ok(label.length >= 200 && label.length <= 400);
          await page.evaluate(label => {
            const chip = document.getElementById('recipient-chip');
            chip.textContent = label; chip.setAttribute('data-recipient-id', 'opaque-recipient-private');
          }, label);
          await page.waitForTimeout(180);
          const snapshot = await captureTreeModel(page);
          const carrierRef = await page.evaluate(() => __wb_ax_ref(document.getElementById('recipient-chip')));
          const identityLine = snapshot.page.pageContent.split('\n').find(line => line.includes(`[${carrierRef}]`));
          assert.ok(identityLine?.startsWith('visible identity '));
          assert.ok(identityLine.includes(JSON.stringify(label)), 'A long but bounded carrier must expose its complete normalized label');
          assert.equal(snapshot.page.pageContent.includes('opaque-recipient-private'), false);
          const target = { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
          await page.evaluate(() => { document.getElementById('owner-clock').textContent = '12:01'; });
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      for (const budget of ['label', 'text traversal']) await t.test(`${budget} overflow cannot acquire a partially observed carrier certificate`, async () => {
        const { context, page } = await treeModelFixture(browser, build, ownerIdentityHtml);
        try {
          await page.evaluate(budget => {
            const chip = document.getElementById('recipient-chip'); chip.replaceChildren();
            chip.setAttribute('data-recipient-id', 'opaque-recipient-private');
            if (budget === 'label') chip.textContent = 'N'.repeat(513);
            else for (let index = 0; index < 129; index++) chip.appendChild(document.createTextNode('x '));
          }, budget);
          await page.waitForTimeout(180);
          for (const actionTarget of [undefined, { tool: 'click', selector: '#send' }]) {
            const snapshot = await captureDeepPriority(page, actionTarget);
            const carrierRef = await page.evaluate(() => __wb_ax_ref(document.getElementById('recipient-chip')));
            assert.equal(snapshot.page.pageContent.includes(`[${carrierRef}]`), false, 'No ref from a partial identity line may count as observed evidence');
            assert.equal(snapshot.page.pageContent.includes('opaque-recipient-private'), false);
            const target = { tool: 'click', selector: '#send' };
            const validation = await validateModel(page, snapshot, target);
            assert.equal(validation.ready, false); assert.equal(validation.reason, 'target_uncovered');
            assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
            assert.equal((await dispatchModel(page)).ready, false);
          }
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      await t.test('plain unknown recipient text without a semantic identity stays uncertified', async () => {
        const ambiguous = modelHtml.replace('<h2 id="recipient">Alice</h2>', '<div id="recipient">Alice</div>');
        const { context, page } = await treeModelFixture(browser, build, ambiguous);
        try {
          const snapshot = await captureModelMessage(page, { includeTree: true });
          assert.equal(snapshot.ready, true);
          const { page: observation, ...metadata } = snapshot;
          assertOpaqueModelMetadata(metadata);
          assert.ok(observation.pageContent);
          const target = { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
          const validation = await validateModel(page, snapshot, target);
          assert.equal(validation.ready, false); assert.equal(validation.uncertified, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['recipient', () => { document.getElementById('recipient').textContent = 'Bob'; }],
        ['selected file object with identical metadata', () => {
          const files = new DataTransfer(); files.items.add(new File(['BBBB'], 'photo-private.png', { type: 'image/png', lastModified: 1 }));
          document.getElementById('attachment').files = files.files;
        }],
      ]) await t.test(`hidden file target binds its visible owner and ${name} through a selector`, async () => {
        const body = modelHtml.replace('id="attachment" type="file"', 'id="attachment" type="file" style="display:none"');
        const { context, page } = await treeModelFixture(browser, build, body);
        try {
          await page.evaluate(() => {
            const files = new DataTransfer(); files.items.add(new File(['AAAA'], 'photo-private.png', { type: 'image/png', lastModified: 1 }));
            document.getElementById('attachment').files = files.files;
          });
          await page.waitForTimeout(180);
          const snapshot = await captureTreeModel(page);
          const target = { tool: 'upload_file', selector: '#attachment' };
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          await page.evaluate(() => { document.getElementById('in-form-counter').textContent = '201'; });
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          await page.evaluate(mutate);
          assert.equal((await validateModel(page, snapshot, target)).ready, false);
          assert.equal((await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'click', fenceOnly: true })).ready, false);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

const shadowComposerHtml = `<style>
  h2 { margin:0;width:280px;height:28px; } form { width:300px;height:100px; }
  #field { width:190px; } #in-form-counter { position:absolute;left:240px;top:85px; }
  </style><section id="composer" role="region"><h2 id="recipient">Alice</h2>
  <form id="form" action="/send"><label for="field">Message</label>
  <input id="field" value="Prepared text"><button id="send" type="submit">Send</button>
  <span id="in-form-counter">200</span></form></section>`;

async function shadowModelFixture(browser, build, mode = 'open') {
  const body = '<!doctype html><div id="shadow-owner" style="position:absolute;left:20px;top:20px;width:320px;height:180px"></div>'
    + '<button id="human" style="position:absolute;left:650px;top:400px">Human control</button>';
  const result = await fixture(browser, build, body, {
    realAccessibilityTree: true, contentLibrary: true, fixtureUrl: 'https://www.linkedin.com/shadow-fixture',
  });
  await result.page.evaluate(({ mode, shadowComposerHtml }) => {
    window.submissions = 0;
    const root = document.getElementById('shadow-owner').attachShadow({ mode });
    root.innerHTML = shadowComposerHtml;
    root.getElementById('form').addEventListener('submit', event => { event.preventDefault(); submissions++; });
  }, { mode, shadowComposerHtml });
  await result.page.waitForTimeout(180);
  await result.page.evaluate(() => { feedback = []; });
  return result;
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: exact open-shadow selectors and actual AX references retain private model certificates`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const addressing of ['selector', 'ref']) await t.test(`${addressing} certifies the same shadow node for its supported AX dispatch after an unrelated counter update`, async () => {
        const { context, page } = await shadowModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const target = addressing === 'selector' ? { tool: 'click', selector: '#send' }
            : { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          await page.evaluate(() => { document.getElementById('shadow-owner').shadowRoot.getElementById('in-form-counter').textContent = '201'; });
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          if (addressing === 'selector') {
            // The legacy content selector handler is document-only. Its
            // unsupported lookup must leave the certified node untouched so
            // the existing AX/native fallback can use the same preparation.
            const unsupported = await modelMessage(page, 'click', { selector: '#send' });
            assert.equal(unsupported.success, false);
            assert.equal(unsupported.dispatched, false);
            assert.equal(unsupported.error, 'Element not found');
            assert.equal(await page.evaluate(() => submissions), 0);
          }
          const ref_id = sendRefFromTree(snapshot);
          assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === document.getElementById('shadow-owner').shadowRoot.getElementById('send'), ref_id), true);
          const dispatched = await modelMessage(page, 'click_ax', { ref_id });
          assert.equal(dispatched.success, true, JSON.stringify(dispatched));
          assert.equal(dispatched.noDispatch, undefined);
          assert.equal(await page.evaluate(() => submissions), 1);
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
        } finally { await context.close(); }
      });

      for (const addressing of ['selector', 'ref']) await t.test(`${addressing} rejects an identical shadow target replacement before dispatch`, async () => {
        const { context, page } = await shadowModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const target = addressing === 'selector' ? { tool: 'click', selector: '#send' }
            : { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          await page.evaluate(() => {
            const original = document.getElementById('shadow-owner').shadowRoot.getElementById('send');
            original.replaceWith(original.cloneNode(true));
          });
          assert.equal((await validateModel(page, snapshot, target)).ready, false);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
          assert.equal((await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'click' })).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      await t.test('a duplicate selector in another open root cannot select an approved target', async () => {
        const { context, page } = await shadowModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          assert.equal((await validateModel(page, snapshot, { tool: 'click', selector: '#send' })).ready, true);
          await page.evaluate(shadowComposerHtml => {
            const host = document.createElement('div');
            host.style.cssText = 'position:absolute;left:450px;top:20px;width:320px;height:180px';
            host.attachShadow({ mode: 'open' }).innerHTML = shadowComposerHtml;
            document.body.appendChild(host);
          }, shadowComposerHtml);
          const fresh = await captureTreeModel(page);
          for (const candidate of [snapshot, fresh]) {
            assert.equal((await validateModel(page, candidate, { tool: 'click', selector: '#send' })).ready, false);
            assert.equal((await prepareModel(page, candidate, { tool: 'click', selector: '#send' })).modelBindingValid, false);
            assert.equal((await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'click' })).ready, false);
          }
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      await t.test('a closed shadow target remains inaccessible to model certification', async () => {
        const { context, page } = await shadowModelFixture(browser, build, 'closed');
        try {
          const snapshot = await captureDeepPriority(page, { tool: 'click', selector: '#send' });
          assert.equal(snapshot.page.pageContent.includes('button "Send"'), false);
          assert.equal((await validateModel(page, snapshot, { tool: 'click', selector: '#send' })).ready, false);
          assert.equal((await prepareModel(page, snapshot, { tool: 'click', selector: '#send' })).modelBindingValid, false);
          assert.equal((await modelMessage(page, 'page_monitor_dispatch', { operationId: 'model-prepared', kind: 'click' })).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

const deepPriorityHtml = modelHtml
  .replace('</style>', '.priority-filler { position:absolute;left:700px;top:550px;width:240px;height:20px; }</style>')
  // Fill the real generator's twenty-control prelude before the deep target,
  // then exceed the monitor's DOM scan as well as the main AX output budget.
  .replace('<section id="composer"', `${Array.from({ length: 20 }, (_, index) => `<input class="priority-filler" readonly aria-label="Unrelated decorative entry ${index}" value="${'decorative '.repeat(12)}">`).join('')}${Array.from({ length: 2300 }, (_, index) => `<h3 class="priority-filler">Unrelated decorative row ${index} with enough text to truncate the main observation</h3>`).join('')}<section id="composer"`);

async function captureDeepPriority(page, actionTarget) {
  const result = await captureModelMessage(page, { includeTree: true, ...(actionTarget ? { actionTarget } : {}) });
  assert.equal(result.ready, true);
  const { page: observation, ...metadata } = result;
  assertOpaqueModelMetadata(metadata);
  assert.equal(observation.success, true);
  assert.ok(JSON.stringify(observation).length <= 16000, 'Initial and priority observations must fit the complete serialized-page budget');
  assert.equal(observation.url, page.url());
  assert.ok(observation.pageContent.length > 0);
  return result;
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: bounded priority recovery observes an uncovered target before certifying a fresh decision`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const selector of ['#send', `#send:not([data-never="${'x'.repeat(620)}"])`]) await t.test(`fresh scoped observation binds the exact ${selector.length > 500 ? 'long' : 'short'} selector after the original target was uncovered`, async () => {
        const { context, page } = await treeModelFixture(browser, build, deepPriorityHtml);
        try {
          const target = { tool: 'click', selector };
          const previous = await captureDeepPriority(page);
          assert.equal(previous.page.pageContent.includes('button "Send"'), false, 'The actionable control lies beyond the returned main AX chunk');
          const uncovered = await validateModel(page, previous, target);
          assert.equal(uncovered.ready, false);
          assert.equal(uncovered.reason, 'target_uncovered');
          assert.notEqual(uncovered.uncertified, true);
          assert.equal((await prepareModel(page, previous, target)).modelBindingValid, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);

          await page.evaluate(() => { document.getElementById('recipient').textContent = 'Bob'; });
          await page.waitForTimeout(180);
          const current = await captureDeepPriority(page, target);
          assert.notEqual(current.snapshotToken, previous.snapshotToken);
          assert.ok(current.page.pageContent.includes('Bob'), 'Recovery exposes the current recipient to the new decision');
          const liveRef = sendRefFromTree(current);
          assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === document.getElementById('send'), liveRef), true);
          assert.equal((await validateModel(page, current, target)).ready, true);
          assert.equal((await validateModel(page, current, { tool: 'click_ax', ref_id: liveRef })).ready, true);
          await page.evaluate(() => { document.getElementById('in-form-counter').textContent = '201'; });
          assert.equal((await validateModel(page, current, target)).ready, true);
          assert.equal((await prepareModel(page, current, target)).modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);

          const next = await captureDeepPriority(page, target);
          await page.evaluate(() => { document.getElementById('recipient').textContent = 'Carol'; });
          const changed = await validateModel(page, next, target);
          assert.equal(changed.ready, false);
          assert.notEqual(changed.reason, 'target_uncovered', 'A changed original target must never masquerade as missing scan coverage');
          assert.equal((await prepareModel(page, next, target)).modelBindingValid, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      await t.test('priority recovery preserves the hard human-intervention boundary', async () => {
        const { context, page } = await treeModelFixture(browser, build, deepPriorityHtml);
        try {
          const target = { tool: 'click', selector: '#send' };
          const snapshot = await captureDeepPriority(page, target);
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          await page.locator('#human').click();
          assert.equal((await validateModel(page, snapshot, target)).ready, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      await t.test('coordinate and ambiguous priority requests cannot acquire an action certificate', async () => {
        const { context, page } = await treeModelFixture(browser, build, deepPriorityHtml);
        try {
          for (const target of [{ tool: 'click', x: 250, y: 90 }, { tool: 'click', selector: 'button' }]) {
            const snapshot = await captureDeepPriority(page, target);
            const validation = await validateModel(page, snapshot, target);
            assert.equal(validation.ready, false);
            assert.notEqual(validation.uncertified, true);
            assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
            assert.equal((await dispatchModel(page)).ready, false);
          }
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: atomic model capture returns a fresh real AX page with matching private target bindings`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      await t.test('real generated references survive tree regeneration and unrelated heading updates', async () => {
        const { context, page } = await treeModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const ref = sendRefFromTree(snapshot);
          assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === document.getElementById('send'), ref), true);
          assert.equal(await page.evaluate(() => __wb_ax_lookup('ref_send')), null, 'No hardcoded DOM-ID lookup is installed');
          assert.match(snapshot.page.pageContent, /Alice/);
          assert.match(snapshot.page.pageContent, /Prepared text/);
          await page.evaluate(() => {
            document.getElementById('sidebar-heading').textContent = 'Fresh unrelated sidebar';
            document.getElementById('in-form-counter').textContent = '201';
          });
          const fresh = await captureTreeModel(page);
          assert.match(fresh.page.pageContent, /Fresh unrelated sidebar/);
          assert.equal(fresh.page.pageContent.includes('Unrelated sidebar'), false);
          assert.equal(sendRefFromTree(fresh), ref);
          assert.equal(fresh.documentToken, snapshot.documentToken);
          assert.notEqual(fresh.snapshotToken, snapshot.snapshotToken);
          const target = { tool: 'click_ax', ref_id: ref };
          const validation = await validateModel(page, snapshot, target);
          assert.equal(validation.ready, true, JSON.stringify({ validation,
            state: await page.evaluate(() => ({ feedback, fence: document.documentElement.getAttribute('data-webbrain-page-revision') })) }));
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      await t.test('tree and binding are captured in one task before a queued property change', async () => {
        const { context, page } = await treeModelFixture(browser, build);
        try {
          await page.evaluate(() => {
            const generate = window.__generateAccessibilityTree;
            window.captureGeneratorCalls = 0;
            window.__generateAccessibilityTree = (...args) => {
              captureGeneratorCalls++;
              const result = generate(...args);
              queueMicrotask(() => { document.getElementById('field').value = 'Changed after the observed tree'; });
              return result;
            };
          });
          const snapshot = await captureTreeModel(page);
          assert.equal(await page.evaluate(() => captureGeneratorCalls), 1, 'The production tree generator runs exactly once');
          assert.match(snapshot.page.pageContent, /Prepared text/);
          assert.equal(snapshot.page.pageContent.includes('Changed after the observed tree'), false);
          assert.equal(await page.evaluate(() => document.getElementById('field').value), 'Changed after the observed tree');
          const target = { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
          assert.equal((await validateModel(page, snapshot, target)).ready, false,
            'An asynchronous gap between tree and footprint would incorrectly capture the changed value');
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      await t.test('identical control replacement invalidates both its removed ref and its fresh ref against the old snapshot', async () => {
        const { context, page } = await treeModelFixture(browser, build);
        try {
          const snapshot = await captureTreeModel(page);
          const removedRef = sendRefFromTree(snapshot);
          await page.evaluate(() => { const node = document.getElementById('send'); node.replaceWith(node.cloneNode(true)); });
          const regenerated = await page.evaluate(() => __generateAccessibilityTree('visible', 15, 12000));
          const newRef = sendRefFromTree({ page: regenerated });
          assert.notEqual(newRef, removedRef);
          assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref), removedRef), null);
          assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === document.getElementById('send'), newRef), true);
          for (const ref of [removedRef, newRef]) {
            const target = { tool: 'click_ax', ref_id: ref };
            assert.equal((await validateModel(page, snapshot, target)).ready, false);
            assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
            assert.equal((await dispatchModel(page)).ready, false);
          }
          assert.equal(await page.evaluate(() => clicks), 0);
          const fresh = await captureTreeModel(page);
          assert.equal(sendRefFromTree(fresh), newRef);
          const target = { tool: 'click_ax', ref_id: newRef };
          assert.equal((await validateModel(page, fresh, target)).ready, true);
          assert.equal((await prepareModel(page, fresh, target)).modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      await t.test('metadata-only capture remains opaque when the real accessibility generator is installed', async () => {
        const { context, page } = await treeModelFixture(browser, build);
        try {
          const withTree = await captureTreeModel(page);
          const metadata = await captureModel(page);
          assert.equal(Object.hasOwn(metadata, 'page'), false);
          const target = { tool: 'click_ax', ref_id: sendRefFromTree(withTree) };
          const validation = await validateModel(page, metadata, target);
          assert.equal(validation.ready, true, JSON.stringify({ metadata, validation, target,
            pageState: await page.evaluate(ref => ({ liveRef: __wb_ax_lookup(ref)?.id,
              refKeys: Object.keys(window.__wbElementMap), feedback }), target.ref_id) }));
          assert.equal((await prepareModel(page, metadata, target)).modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      for (const [name, body] of [['plain chat form', plainChatHtml], ['small form-less toolbar', toolbarChatHtml]]) {
        await t.test(`${name} binds the recipient outside its form or toolbar while allowing a local counter`, async () => {
          const { context, page } = await treeModelFixture(browser, build, body);
          try {
            const snapshot = await captureTreeModel(page);
            const target = { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
            assert.match(snapshot.page.pageContent, /Alice/);
            await page.evaluate(() => { document.getElementById('in-form-counter').textContent = '201'; });
            const validation = await validateModel(page, snapshot, target);
            assert.equal(validation.ready, true, JSON.stringify({ validation,
              state: await page.evaluate(() => ({ feedback, fence: document.documentElement.getAttribute('data-webbrain-page-revision') })) }));
            assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, true);
            assert.equal((await dispatchModel(page)).ready, true);
            assert.equal(await page.evaluate(() => clicks), 1);
          } finally { await context.close(); }
        });
        await t.test(`${name} cannot keep approval when its outside recipient heading changes`, async () => {
          const { context, page } = await treeModelFixture(browser, build, body);
          try {
            const snapshot = await captureTreeModel(page);
            const target = { tool: 'click_ax', ref_id: sendRefFromTree(snapshot) };
            assert.equal((await validateModel(page, snapshot, target)).ready, true);
            await page.evaluate(() => { document.getElementById('recipient').textContent = 'Bob'; });
            await page.waitForTimeout(180);
            assert.equal((await validateModel(page, snapshot, target)).ready, false);
            assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
            assert.equal((await dispatchModel(page)).ready, false);
            assert.equal(await page.evaluate(() => clicks), 0);
          } finally { await context.close(); }
        });
      }
    } finally { await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: model snapshots bind intended controls before inference while harmless DOM updates progress`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const [name, target, mutate, boundary, owner] of [
        ['counter inside the same form', { tool: 'click_ax', ref_id: 'ref_send' }, () => { document.getElementById('in-form-counter').textContent = '201'; }],
        ['unrelated sidebar heading', { tool: 'click_ax', ref_id: 'ref_send' }, () => { document.getElementById('sidebar-heading').textContent = 'Updated unrelated heading'; }],
        ['independent absolute body child', { tool: 'click_ax', ref_id: 'ref_send' }, () => {
          const decoration = document.createElement('div'); decoration.textContent = 'Updated unrelated content';
          decoration.style.cssText = 'position:absolute;left:650px;top:450px;width:200px;height:30px'; document.body.append(decoration);
        }],
        ['exact selector click', { tool: 'click', selector: '#send' }, () => { document.getElementById('in-form-counter').textContent = '201'; }],
        ['native submit control', { tool: 'click_ax', ref_id: 'ref_send' }, () => { document.getElementById('in-form-counter').textContent = '201'; }, 'native'],
        ['dialog owner with a passive counter', { tool: 'click_ax', ref_id: 'ref_send' }, () => { document.getElementById('in-form-counter').textContent = '201'; }, 'message', 'dialog'],
      ]) await t.test(`${name} validates the old model snapshot and performs the intended submit`, async () => {
        const { context, page } = await modelFixture(browser, build, owner);
        try {
          const snapshot = await captureModel(page);
          await page.evaluate(mutate);
          await page.waitForTimeout(180);
          assert.equal((await validateModel(page, snapshot, target)).ready, true);
          const prepared = await prepareModel(page, snapshot, target);
          assert.equal(prepared.ready, true);
          assert.equal(prepared.modelBindingValid, true);
          assert.equal((await dispatchModel(page, boundary)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
          const observations = await page.evaluate(() => feedback);
          assert.ok(observations.some(event => event.kind === 'dom' && event.source === 'page'), 'Passive feedback remains observable');
          if (boundary === 'native') assert.equal(observations.some(event => event.source === 'user'), false,
            'The native marker still attributes the actual submit to the prepared operation');
        } finally { await context.close(); }
      });

      await t.test('counter mutation queued between validation and prepare progresses without a new model snapshot', async () => {
        const { context, page } = await modelFixture(browser, build);
        try {
          const snapshot = await captureModel(page);
          assert.equal((await validateModel(page, snapshot)).ready, true);
          const prepared = await page.evaluate(async snapshotToken => {
            document.getElementById('in-form-counter').textContent = '201';
            return deliver('page_monitor_prepare', { operationId: 'model-prepared', tool: 'click_ax', ref_id: 'ref_send',
              allowPassiveRebase: true, expectedModelSnapshot: snapshotToken });
          }, snapshot.snapshotToken);
          assert.equal(prepared.modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['recipient heading outside the form in its owner region', () => { document.getElementById('recipient').textContent = 'Bob'; }],
        ['field value', () => { document.getElementById('field').value = 'Changed private message'; }],
        ['selected file with identical metadata', () => {
          const files = new DataTransfer(); files.items.add(new File(['BBBB'], 'photo-private.png', { type: 'image/png', lastModified: 1 }));
          document.getElementById('attachment').files = files.files;
        }],
        ['form action', () => { document.getElementById('form').action = '/other'; }],
        ['external accessible label', () => { document.getElementById('send-label').textContent = 'Delete'; }],
        ['target node identity', () => { const node = document.getElementById('send'); node.replaceWith(node.cloneNode(true)); }],
        ['opaque occluding overlay', () => {
          const rect = document.getElementById('send').getBoundingClientRect(); const overlay = document.createElement('div');
          overlay.style.cssText = `position:fixed;z-index:99999;background:black;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
          document.body.append(overlay);
        }],
      ]) await t.test(`${name} changed before prepare cannot be accepted by recapturing the current target`, async () => {
        const { context, page } = await modelFixture(browser, build);
        try {
          const snapshot = await captureModel(page);
          await page.evaluate(mutate);
          await page.waitForTimeout(180);
          assert.equal((await validateModel(page, snapshot)).ready, false);
          const prepared = await prepareModel(page, snapshot);
          assert.equal(prepared.modelBindingValid, false, 'Preparation must compare against the pre-inference snapshot');
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      // A ref/selector decision binds the node, not its coordinates: a pure
      // move with identical semantics and hit is rebased before preparation.
      // Geometry is still exact from preparation to dispatch (see
      // test/monitor-owned-geometry.mjs).
      await t.test('target geometry changed before prepare keeps the decision for the same node', async () => {
        const { context, page } = await modelFixture(browser, build);
        try {
          const snapshot = await captureModel(page);
          await page.evaluate(() => { document.getElementById('send').style.transform = 'translateX(45px)'; });
          await page.waitForTimeout(180);
          assert.equal((await validateModel(page, snapshot)).ready, true);
          assert.equal((await prepareModel(page, snapshot)).modelBindingValid, true);
          assert.equal((await dispatchModel(page)).ready, true);
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      await t.test('target changed after successful model validation is checked again during prepare', async () => {
        const { context, page } = await modelFixture(browser, build);
        try {
          const snapshot = await captureModel(page);
          assert.equal((await validateModel(page, snapshot)).ready, true);
          await page.evaluate(() => { document.getElementById('recipient').textContent = 'Bob'; });
          await page.waitForTimeout(180);
          assert.equal((await prepareModel(page, snapshot)).modelBindingValid, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['human interaction', async page => page.locator('#human').click()],
        ['same-document navigation', async page => page.evaluate(() => history.pushState({}, '', '/changed'))],
        ['same-URL new document', async page => {
          await page.reload(); await page.waitForFunction(() => window.__wbPageMonitor?.active);
          await page.evaluate(() => { window.submissions = 0; document.getElementById('form').addEventListener('submit', event => { event.preventDefault(); submissions++; }); });
        }],
      ]) await t.test(`${name} invalidates a pre-inference model snapshot`, async () => {
        const { context, page } = await modelFixture(browser, build);
        try {
          const snapshot = await captureModel(page);
          await mutate(page);
          await page.waitForTimeout(180);
          assert.equal((await validateModel(page, snapshot)).ready, false);
          assert.equal((await prepareModel(page, snapshot)).modelBindingValid, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      for (const [name, target] of [
        ['coordinates', { tool: 'click', x: 185, y: 70 }],
        ['ambiguous selector', { tool: 'click', selector: 'button' }],
        ['unresolved selector', { tool: 'click', selector: '#missing' }],
        ['unknown script target', { tool: 'execute_js' }],
      ]) await t.test(`${name} cannot acquire approval to bypass passive feedback`, async () => {
        const { context, page } = await modelFixture(browser, build);
        try {
          const snapshot = await captureModel(page);
          await page.evaluate(() => { document.getElementById('in-form-counter').textContent = '201'; });
          assert.equal((await validateModel(page, snapshot, target)).ready, false);
          assert.equal((await prepareModel(page, snapshot, target)).modelBindingValid, false);
          assert.equal((await dispatchModel(page)).ready, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      await t.test('model tokens remain tied to their run and document rather than being reusable opaque approvals', async () => {
        const { context, page } = await modelFixture(browser, build);
        try {
          const snapshot = await captureModel(page);
          for (const params of [
            { runToken: 'different-run', snapshotToken: snapshot.snapshotToken },
            { snapshotToken: 'unknown-snapshot' },
          ]) {
            const result = await modelMessage(page, 'page_monitor_validate_model', { tool: 'click_ax', ref_id: 'ref_send', ...params });
            assertOpaqueModelMetadata(result);
            assert.equal(result.ready, false);
          }
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: only explicitly validated stable targets survive unrelated passive page updates`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const boundary of ['message', 'activate', 'native', 'local']) {
        await t.test(`${boundary}: unchanged target progresses while counter feedback remains observable`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            const guard = await prepare(page, boundary);
            await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
            const result = await dispatch(page, boundary);
            assert.equal(result.ready, true);
            assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom' && event.source === 'page'),
              'The validated operation may progress, but the agent must still receive the passive update');
            if (boundary === 'native') assert.ok(result.revision > guard.revision, 'The caller receives the fresh revision for its next signed marker');
          } finally { await context.close(); }
        });
        for (const [change, mutate] of [
          ['recipient', () => { document.getElementById('recipient').textContent = 'Bob'; }],
          ['control value', () => { document.getElementById('field').value = 'Different private message'; }],
          ['node replacement', () => { const el = document.getElementById('send'); el.replaceWith(el.cloneNode(true)); }],
          ['form action', () => { document.getElementById('form').action = '/other'; }],
          ['hidden accessible label', () => { document.getElementById('send-label').textContent = 'Delete'; }],
        ]) await t.test(`${boundary}: ${change} prevents dispatch despite a matching target label`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            await prepare(page, boundary);
            await page.evaluate(mutate);
            await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
            const result = await dispatch(page, boundary);
            assert.equal(result.ready, false);
            if (boundary !== 'native') assert.equal(result.code || (result.pageFeedbackPending ? 'page_feedback_pending' : ''), 'page_feedback_pending');
          } finally { await context.close(); }
        });
      }

      for (const [name, options] of [
        ['unapproved operation', { allowPassiveRebase: false }],
        ['coordinates', { x: 185, y: 70 }],
        ['arbitrary script', { tool: 'execute_js' }],
        ['ambiguous selector', { selector: 'button' }],
        ['unresolved target', { selector: '#missing' }],
      ]) await t.test(`${name} retains the strict global revision fence`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, 'message', options);
          await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
          const result = await dispatch(page, 'message');
          assert.equal(result.ready, false);
          assert.equal(result.pageFeedbackPending, true);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['page focus theft', async page => page.locator('#field').focus()],
        ['human interaction', async page => page.locator('#human').click()],
        ['viewport change', async page => page.setViewportSize({ width: 990, height: 700 })],
        ['same-document navigation', async page => page.evaluate(() => history.pushState({}, '', '/changed'))],
        ['unknown DOM attribution', async page => page.evaluate(() => {
          __wbPageMonitor.dispatch({ operationId: 'other-operation', kind: 'dom', runToken: 'passive-test' });
          document.getElementById('counter').textContent = '101';
        })],
      ]) await t.test(`${name} cannot be rebased as passive churn`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, 'message');
          await mutate(page);
          const result = await dispatch(page, 'message');
          assert.equal(result.ready, false);
          assert.equal(result.pageFeedbackPending, true);
        } finally { await context.close(); }
      });

      await t.test('native marker uses the refreshed revision and preserves later human detection', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const guard = await prepare(page, 'native');
          await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
          const validation = await dispatch(page, 'native');
          assert.equal(validation.ready, true);
          const marker = createNativeActionMarker({ ...guard, revision: validation.revision }, 'click', 1);
          await page.evaluate(marker => { feedback = []; document.getElementById('send').setAttribute('data-webbrain-native-action', marker);
            document.getElementById('form').addEventListener('submit', event => event.preventDefault()); }, marker);
          await page.locator('#send').click();
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
          await page.locator('#human').click();
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), true);
        } finally { await context.close(); }
      });

      await t.test('long property values are compared completely rather than sampled', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => { document.getElementById('field').value = 'a'.repeat(20000); });
          await page.waitForTimeout(180);
          await prepare(page, 'message');
          await page.evaluate(() => {
            const field = document.getElementById('field');
            field.value = `${field.value.slice(0, 19998)}ba`;
            document.getElementById('counter').textContent = '101';
          });
          assert.equal((await dispatch(page, 'message')).ready, false);
          assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('a'.repeat(100)), false);
        } finally { await context.close(); }
      });

      await t.test('direct navigation can rebase passive churn without a page target', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(async () => {
            await deliver('page_monitor_prepare', { operationId: 'navigate', tool: 'navigate', allowPassiveRebase: true });
            document.getElementById('counter').textContent = '101';
          });
          const result = await page.evaluate(() => deliver('page_monitor_dispatch', { operationId: 'navigate', kind: 'navigate' }));
          assert.equal(result.ready, true);
        } finally { await context.close(); }
      });

      await t.test('local dispatch inherits approval only from the same untouched prepared target', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, 'message');
          await page.evaluate(() => {
            window.finishOperation = __wbPageMonitor.beginContentAction('click_ax', { ref_id: 'ref_send', _bidiPrepare: true });
            document.getElementById('counter').textContent = '101';
          });
          assert.equal((await dispatch(page, 'local')).ready, true);
        } finally { await context.close(); }
      });

      await t.test('local approval cannot be inherited across a physical intervention', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, 'message');
          await page.locator('#human').click();
          await page.evaluate(() => {
            window.finishOperation = __wbPageMonitor.beginContentAction('click_ax', { ref_id: 'ref_send', _bidiPrepare: true });
            document.getElementById('counter').textContent = '101';
          });
          assert.equal((await dispatch(page, 'local')).ready, false);
        } finally { await context.close(); }
      });

      await t.test('changing a selected file cannot preserve approval through identical file metadata', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => {
            const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.id = 'attachment';
            document.getElementById('form').append(fileInput);
            const files = new DataTransfer(); files.items.add(new File(['AAAA'], 'photo.png', { type: 'image/png', lastModified: 1 }));
            fileInput.files = files.files;
          });
          await page.waitForTimeout(180);
          await prepare(page, 'message');
          await page.evaluate(() => {
            const files = new DataTransfer(); files.items.add(new File(['BBBB'], 'photo.png', { type: 'image/png', lastModified: 1 }));
            document.getElementById('attachment').files = files.files;
            document.getElementById('counter').textContent = '101';
          });
          assert.equal((await dispatch(page, 'message')).ready, false);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: monitor registration acknowledgment proves current document ownership`, { timeout: scaled(30000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      await t.test('successful registration returns the active document and run tokens', async () => {
        const { context, page } = await registrationFixture(browser, build);
        try {
          const acknowledgment = await page.evaluate(() => activateMonitor());
          const requestedToken = await page.evaluate(() => registrationRequests.at(-1).documentToken);
          assert.equal(acknowledgment.ready, true);
          assert.equal(acknowledgment.active, true);
          assert.equal(acknowledgment.documentToken, requestedToken);
          assert.equal(acknowledgment.runToken, 'registration-run');
          assert.ok(acknowledgment.documentToken);
          assert.equal(await page.evaluate(() => __wbPageMonitor.active), true);
        } finally { await context.close(); }
      });

      for (const mode of ['inactive', 'throw']) for (const previouslyActive of [false, true]) await t.test(`${mode} background registration (${previouslyActive ? 'previously active' : 'new document'}) cannot acknowledge active ownership`, async () => {
        const { context, page } = await registrationFixture(browser, build, previouslyActive ? 'active' : mode);
        try {
          if (previouslyActive) {
            assert.equal((await page.evaluate(() => activateMonitor())).active, true);
            await page.evaluate(value => { registrationMode = value; }, mode);
          }
          const acknowledgment = await page.evaluate(() => activateMonitor());
          assert.equal(acknowledgment.ready, true);
          assert.equal(acknowledgment.active, false);
          assert.notEqual(acknowledgment.runToken, 'registration-run');
          assert.equal(await page.evaluate(() => __wbPageMonitor.active), false);
        } finally { await context.close(); }
      });

      await t.test('reloading the same URL returns a fresh document token', async () => {
        const { context, page } = await registrationFixture(browser, build);
        try {
          const previous = await page.evaluate(() => activateMonitor());
          await page.reload();
          await page.waitForFunction(() => window.__wbPageMonitor && registrationRequests.length > 0);
          const current = await page.evaluate(() => activateMonitor());
          assert.equal(current.active, true);
          assert.equal(current.runToken, previous.runToken);
          assert.notEqual(current.documentToken, previous.documentToken);
          assert.equal(current.documentToken, await page.evaluate(() => registrationRequests.at(-1).documentToken));
          assert.equal(page.url(), 'https://registration.test/same-url');
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

test('Chrome and Firefox passive preparation validation stay byte-identical', () => {
  assert.equal(
    fs.readFileSync(new URL('../src/chrome/src/content/page-monitor.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/firefox/src/content/page-monitor.js', import.meta.url), 'utf8'),
  );
});
