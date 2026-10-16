import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Real installed MV3 transport and content scripts on an isolated loopback
// fixture. This verifies browser tab titles/favicon state, not a live website,
// sidebar rendering, audible output or operating-system notification delivery.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-16/pending-input-attention-mv3');
await fs.mkdir(out, { recursive: true });
const title = 'Owned pending-input attention fixture';
const iconHref = '/favicon.svg';
const server = http.createServer((request, response) => {
  if (request.url === iconHref) {
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2463eb"/></svg>');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${iconHref}"><h1>Owned local attention fixture</h1>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/attention`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-pending-input-attention-mv3-'));
const evidence = { fixture: 'isolated loopback; real installed Chrome MV3 extension', cases: [], skipped: [] };
let context;
try {
  const extension = path.resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  await context.route('**/*', route => {
    const requested = new URL(route.request().url());
    if (!/^https?:$/.test(requested.protocol)
        || requested.origin === new URL(url).origin) return route.continue();
    return route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  await harness.evaluate(() => chrome.storage.local.set({
    completionFlashTab: true, helpImproveWebBrain: false, tracingEnabled: false,
  }));
  const message = data => harness.evaluate(data => chrome.runtime.sendMessage({
    target: 'background', action: 'flash_tab_attention', ...data,
  }), data);
  const page = await context.newPage();
  await page.goto(url);
  // Playwright normally makes every tab appear focused/visible. Disable
  // that convenience so native tab activation exercises visibilitychange.
  for (const target of [harness, page]) {
    const session = await context.newCDPSession(target);
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  }
  const tabId = await harness.evaluate(async url =>
    (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  assert.ok(Number.isInteger(tabId), 'The actual fixture tab must exist.');
  const snapshot = () => harness.evaluate(async tabId => {
    const [state] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => ({
        generation: window.__webbrain_generation,
        title: document.title, visibility: document.visibilityState,
        icons: [...document.querySelectorAll('link[rel*="icon" i]')]
          .map(icon => icon.getAttribute('href'))
          .map(href => href?.startsWith('data:') ? `${href.split(',')[0]},[omitted]` : href),
      }),
    });
    const native = await chrome.tabs.get(tabId);
    const nativeIcon = native.favIconUrl?.startsWith('data:')
      ? `${native.favIconUrl.split(',')[0]},[omitted]` : native.favIconUrl;
    return { ...state.result, nativeTitle: native.title, nativeIcon };
  }, tabId);
  const waitFor = async (predicate, label, { optional = false, timeout = 7000 } = {}) => {
    const deadline = Date.now() + timeout;
    let state;
    do {
      state = await snapshot();
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (Date.now() < deadline);
    if (optional) return null;
    assert.fail(`${label}: ${JSON.stringify(state)}`);
  };
  await waitFor(state => state.generation > 0 && state.title === title,
    'The manifest-installed content receiver must be ready.');
  const setVisible = async (visible, optional = false) => {
    await (visible ? page : harness).bringToFront();
    await harness.evaluate(async ({ tabId, visible }) => {
      const tabs = await chrome.tabs.query({});
      const target = visible ? tabId : tabs.find(tab => tab.url === location.href)?.id;
      await chrome.tabs.update(target, { active: true });
    }, { tabId, visible });
    return waitFor(state => state.visibility === (visible ? 'visible' : 'hidden'),
      `The fixture must actually be ${visible ? 'visible' : 'hidden'}.`,
      { optional, timeout: optional ? 500 : 7000 });
  };
  const assertMarker = marker => waitFor(state => state.title === `${marker} ${title}`
    && state.nativeTitle === state.title && state.icons.length === 1
    && state.icons[0]?.startsWith('data:image/png'),
  `${marker} must appear in both document.title and native chrome.tabs.get title, with a real favicon.`);
  const stop = attentionId => harness.evaluate(({ tabId, attentionId }) =>
    chrome.tabs.sendMessage(tabId, {
      target: 'content', action: 'attention_flash_stop', params: { attentionId },
    }, { frameId: 0 }), { tabId, attentionId });
  const assertRestored = () => waitFor(state => state.title === title
    && state.nativeTitle === title && state.icons.length === 1 && state.icons[0] === iconHref,
  'Stopping the exact alert must restore the original title and favicon.');

  const canHide = !!await setVisible(false, true);
  await setVisible(true);
  if (!canHide) evidence.visibilityLimitation =
    'This Chromium platform keeps background tabs document.visibilityState=visible after native activation; hidden cases were not simulated.';

  for (const reason of ['plan_review', 'clarify']) {
    for (const visible of [true, false]) {
      const attentionId = `${reason}-${visible ? 'visible' : 'hidden'}`;
      if (!visible && !canHide) {
        evidence.skipped.push(attentionId);
        continue;
      }
      await setVisible(visible);
      const result = await message({ tabId, reason, attentionId });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.mode, 'title-flash+notification', JSON.stringify(result));
      const marked = await assertMarker('⚠️');
      // Neither visiting the pending tab nor a stale owner's cancellation
      // acknowledges a request that still waits on the user.
      if (canHide) {
        await setVisible(!visible);
        await setVisible(true);
      }
      await assertMarker('⚠️');
      assert.equal((await stop('stale-alert')).success, true);
      await assertMarker('⚠️');
      assert.equal((await stop(attentionId)).success, true);
      const restored = await assertRestored();
      evidence.cases.push({ name: attentionId, result, marked, restored });
    }
  }

  if (canHide) {
    await setVisible(false);
    const completion = await message({ tabId, reason: 'completion', success: true });
    assert.equal(completion.mode, 'title-flash', JSON.stringify(completion));
    const completionMarked = await assertMarker('🔔');
    await setVisible(true);
    evidence.cases.push({ name: 'completion-hidden-clears-on-visible', result: completion,
      marked: completionMarked, restored: await assertRestored() });
  } else evidence.skipped.push('completion-hidden-clears-on-visible');

  // Inject one transport failure at the real worker boundary. Every later
  // attempt uses Chrome's native sendMessage and real content receiver.
  await worker.evaluate(() => {
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    globalThis.pendingInputAttentionProbe = { fault: null, attempts: [] };
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      if (message.action !== 'attention_flash_start') return send(tabId, message, options);
      const probe = pendingInputAttentionProbe;
      const attempt = { tabId, reason: message.params?.reason, options };
      probe.attempts.push(attempt);
      if (probe.fault) {
        attempt.fault = probe.fault;
        probe.fault = null;
        if (attempt.fault === 'missing-receiver')
          throw new Error('Could not establish connection. Receiving end does not exist.');
        return undefined;
      }
      const response = await send(tabId, message, options);
      attempt.started = response?.started;
      return response;
    };
  });
  for (const [fault, reason] of [['missing-receiver', 'plan_review'], ['undefined-response', 'clarify']]) {
    await setVisible(true);
    const before = await snapshot();
    await worker.evaluate(fault => {
      pendingInputAttentionProbe.fault = fault;
      pendingInputAttentionProbe.attempts = [];
    }, fault);
    const attentionId = `recovery-${fault}`;
    const result = await message({ tabId, reason, attentionId });
    assert.equal(result.mode, 'title-flash+notification', JSON.stringify(result));
    const marked = await assertMarker('⚠️');
    assert.equal(marked.generation, before.generation + 1,
      'Recovery must install the production core content scripts exactly once.');
    const probe = await worker.evaluate(() => pendingInputAttentionProbe);
    assert.equal(probe.fault, null);
    assert.equal(probe.attempts.length, 2, JSON.stringify(probe));
    assert.equal(probe.attempts[0].fault, fault);
    assert.equal(probe.attempts[1].options?.frameId, 0,
      'Recovery must retry only the top-frame receiver.');
    assert.equal(probe.attempts[1].started, true);
    assert.equal((await stop(attentionId)).success, true);
    evidence.cases.push({ name: attentionId, result, beforeGeneration: before.generation,
      marked, probe, restored: await assertRestored() });
  }
  evidence.passed = true;
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await fs.rm(path.join(out, 'failure.json'), { force: true });
  console.log(JSON.stringify({ passed: true, fixture: evidence.fixture,
    cases: evidence.cases.map(item => item.name), skipped: evidence.skipped,
    visibilityLimitation: evidence.visibilityLimitation, evidence: path.join(out, 'evidence.json') }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ ...evidence, error: error.stack }, null, 2));
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-pending-input-attention-mv3-'))
    throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
