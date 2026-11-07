import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FirefoxBidiClient } from '../src/firefox/src/bidi/client.js';
import { BidiSession } from '../firefox-companion/session.mjs';
import { installPageFeedback, pageFeedbackMethods, validateNativePageDispatch } from '../src/firefox/src/agent/page-feedback.js';

const id = () => crypto.randomUUID();

test('uploads register input dispatches with the extension monitor', async () => {
  const tab = 955, owner = { ...pageFeedbackMethods, isRunning: () => true, _checkAbort: () => false };
  const guard = { documentToken: 'file-document', revision: 0, operationId: 'upload' };
  const registrations = [];
  const client = new FirefoxBidiClient({ tabs: { sendMessage: async (_tab, message) => {
    registrations.push(message);
    return message.action === 'page_monitor_prepare' ? { ready: true } : { ready: true, guard };
  } } });
  client.runs.set(tab, { runId: id(), bound: true });
  client.request = async (_command, args) => { assert.deepEqual(args.payload.pageFeedbackGuard, guard); return { success: true }; };
  await owner._beginPageFeedbackRun(tab, 'interactive');
  try {
    await client.perform(tab, 'upload', { selector: '#file' });
    assert.deepEqual(registrations.map(message => message.action), ['page_monitor_prepare', 'page_monitor_dispatch']);
    assert.equal(registrations[0].params.tool, 'upload');
    assert.equal(registrations[1].params.kind, 'input');
    assert.equal(registrations[1].params.navigationCandidate, false);
    assert.equal(registrations[1].params.fenceOnly, true);
  } finally { owner._finishPageFeedbackRun(tab); }
});

test('an unfocused upload marks the file input instead of the active control', async () => {
  const session = new BidiSession(), runId = id(), attributes = new Map(), focusedAttributes = new Map();
  const guard = { documentToken: 'file-document', revision: 0, operationId: 'upload' };
  const token = id(), focused = { setAttribute: (name, value) => focusedAttributes.set(name, value) };
  const el = { isConnected: true, tagName: 'INPUT', type: 'file', files: [],
    getRootNode: () => ({ activeElement: focused }),
    getAttribute: name => name === 'data-webbrain-bidi' ? token : attributes.get(name),
    removeAttribute: name => attributes.delete(name), setAttribute: (name, value) => attributes.set(name, value) };
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'file' } });
  session.call = async (_match, declaration, args = []) => ({ result: { value: vm.runInNewContext(`(${declaration})`, {
    document: { documentElement: { getAttribute: () => 'file-document:0' } },
  })(el, ...args.map(arg => arg.value)) } });
  session.send = async method => {
    if (method === 'input.setFiles') {
      assert.equal(JSON.parse(attributes.get('data-webbrain-native-action')).kind, 'input');
      assert.equal(focusedAttributes.has('data-webbrain-native-action'), false);
      el.files = [{ name: 'test.txt', size: 1 }];
    }
    return {};
  };
  try {
    assert.equal((await session.perform(runId, 'upload', { token, base64: 'eA==', filename: 'test.txt', pageFeedbackGuard: guard }, async () => true)).success, true);
  } finally { await session.close(); }
});
test('the companion reads a saved download only as the browser recorded it', async () => {
  const { mkdtemp, mkdir, writeFile, symlink, lstat, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'webbrain-saved-download-'));
  const session = new BidiSession(), runId = id();
  try {
    const file = join(dir, 'report.pdf');
    await writeFile(file, Buffer.from('%PDF-saved'));
    const record = { id: 7, state: 'complete', exists: true, filename: file, fileSize: 10, mime: 'application/pdf' };
    await assert.rejects(session.readSavedDownload(runId, record), /run stopped/);
    session.runs.set(runId, { context: 'tab' });
    const read = await session.readSavedDownload(runId, record);
    assert.deepEqual({ ...read, base64: Buffer.from(read.base64, 'base64').toString() }, { base64: '%PDF-saved', size: 10, filename: 'report.pdf', mimeType: 'application/pdf' });
    await assert.rejects(session.readSavedDownload(runId, { ...record, fileSize: 99 }), /no longer matches/);
    await assert.rejects(session.readSavedDownload(runId, { ...record, state: 'in_progress' }), /completed browser download/);
    await assert.rejects(session.readSavedDownload(runId, { ...record, filename: 'report.pdf' }), /completed browser download/);
    // Only a regular file is read: not a folder, and not a link, which is refused rather than followed.
    const folder = join(dir, 'folder.pdf');
    await mkdir(folder);
    await assert.rejects(session.readSavedDownload(runId, { ...record, filename: folder }), /not a regular file/);
    // A file symlink needs admin rights or Developer Mode on Windows; a directory junction needs
    // neither and is a link all the same, so the link case runs on every machine.
    const link = join(dir, 'link.pdf');
    try {
      await symlink(file, link);
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      await symlink(folder, link, 'junction');
    }
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    await assert.rejects(session.readSavedDownload(runId, { ...record, filename: link }), /not a regular file/);
    // The largest file the companion returns still fits a native reply; a larger one is refused with the fallback marker.
    const { nativeReplyMessages } = await import('../firefox-companion/native-messages.mjs');
    const { SAVED_DOWNLOAD_TOO_LARGE } = await import('../firefox-companion/session.mjs');
    const limit = 24 * 1024 * 1024 - 64 * 1024;
    const largest = join(dir, 'largest.bin');
    await writeFile(largest, Buffer.alloc(limit, 1));
    const fits = await session.readSavedDownload(runId, { ...record, filename: largest, fileSize: limit });
    assert.ok([...nativeReplyMessages({ id: 'request-123456', result: fits })].length > 1);
    const larger = join(dir, 'larger.bin');
    await writeFile(larger, Buffer.alloc(limit + 1, 1));
    await assert.rejects(session.readSavedDownload(runId, { ...record, filename: larger, fileSize: limit + 1 }), error => error.message.startsWith(SAVED_DOWNLOAD_TOO_LARGE));
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the client asks the companion for saved bytes only when it can read them', async () => {
  const client = new FirefoxBidiClient({ tabs: { sendMessage: async () => ({}) } });
  const tab = 956;
  const requests = [];
  client.request = async (command, args) => { requests.push({ command, args }); return { base64: 'eA==' }; };
  client.bindRun = async (_tab, owner) => { owner.bound = true; };
  const record = { id: 3, state: 'complete', exists: true, filename: '/tmp/x.bin', fileSize: 1, mime: 'application/octet-stream', url: 'https://example.test/x' };
  assert.equal(await client.readSavedDownload(tab, record), null, 'no run on this tab');
  client.runs.set(tab, { runId: 'run-1', bound: true });
  client.connect = async () => ({ connected: true, capabilities: ['point_input'] });
  assert.equal(await client.readSavedDownload(tab, record), null, 'an older companion');
  client.connect = async () => ({ connected: true, capabilities: ['point_input', 'saved_download'] });
  assert.deepEqual(await client.readSavedDownload(tab, record), { base64: 'eA==' });
  assert.deepEqual(requests, [{ command: 'readSavedDownload', args: { runId: 'run-1',
    download: { id: 3, state: 'complete', exists: true, filename: '/tmp/x.bin', fileSize: 1, mime: 'application/octet-stream' } } }]);
});

test('connection loss cannot fall through to synthetic input', async () => {
  let messages = 0;
  const client = new FirefoxBidiClient({ tabs: { sendMessage() { messages++; } } });
  client.runs.set(1, { runId: id(), bound: true });
  client.disconnect();
  const result = await client.sendContent(1, { action: 'click' });
  assert.equal(result.noDispatch, true);
  assert.equal(messages, 0);
});
test('a replacement run cannot inherit prepared input from its predecessor', async () => {
  let finish;
  const client = new FirefoxBidiClient({ tabs: { sendMessage: () => new Promise(resolve => { finish = resolve; }) } });
  client.runs.set(1, { runId: id(), bound: true });
  let dispatches = 0; client.request = async () => { dispatches++; };
  const pending = client.sendContent(1, { action: 'click' });
  await Promise.resolve();
  client.runs.set(1, { runId: id(), bound: true });
  finish({ bidiPrepared: true, url: 'https://example.com/' });
  assert.equal((await pending).noDispatch, true);
  assert.equal(dispatches, 0);
});
test('stopping during native tab binding prevents late ownership', async () => {
  const session = new BidiSession(); const runId = id();
  let finish;
  session.locate = () => new Promise(resolve => { finish = resolve; });
  session.call = async () => ({});
  const opening = session.openRun(runId, id(), 'https://example.com/');
  await session.closeRun(runId);
  finish({ context: 'tab' });
  await assert.rejects(opening, /stopped/);
  assert.equal(session.runs.size, 0);
});
test('native dispatch validation returns through the extension-owned frame monitor', async () => {
  const originalBrowser = globalThis.browser;
  const tabId = 956, runId = id(), posts = [], monitorChecks = [];
  let onMessage, preparedOperationId, enterAction, releaseAction;
  const entered = new Promise(resolve => { enterAction = resolve; });
  const release = new Promise(resolve => { releaseAction = resolve; });
  const port = {
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) { posts.push(message); },
    disconnect() {},
  };
  const api = {
    runtime: { connectNative: () => port },
    tabs: {
      get: async () => ({ url: 'https://example.test/' }),
      sendMessage: async (tab, message, options) => {
        if (message.action === 'page_monitor_prepare') preparedOperationId = message.params.operationId;
        if (message.action === 'page_monitor_validate') {
          monitorChecks.push({ tab, frameId: options?.frameId, params: message.params });
          return { ready: true };
        }
        return {};
      },
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }, { frameId: 9 }] },
  };
  class TestAgent {
    static STATE_CHANGE_TOOLS = new Set(['click']);
    isRunning() { return true; }
    _checkAbort() { return false; }
    _hasPendingPageFeedback() { return false; }
    async executeTool() {
      this.pageMonitorState({ tab: { id: tabId }, frameId: 9, documentId: 'document-9', url: 'https://frame.test/' }, 'monitor-document');
      enterAction();
      await release;
      return { success: true, dispatched: true };
    }
  }
  installPageFeedback(TestAgent);
  const agent = new TestAgent();
  globalThis.browser = api;
  const client = new FirefoxBidiClient(api);
  client.runs.set(tabId, { runId, bound: true });
  try {
    await agent._beginPageFeedbackRun(tabId, 'interactive');
    const action = agent.executeTool(tabId, 'click', { selector: '#target' });
    await entered;
    const request = client.request('ready');
    onMessage({ id: 1, result: true });
    assert.equal(await request, true);
    onMessage({ command: 'validatePageDispatch', id: 'private-check', runId,
      guard: { runToken: agent._pageFeedbackRuns.get(tabId).token, documentToken: 'monitor-document', operationId: preparedOperationId, revision: 4 },
      kind: 'input', rebindFocus: false });
    for (let attempt = 0; attempt < 10 && !posts.some(message => message.replyTo === 'private-check'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 0));
    const response = posts.find(message => message.replyTo === 'private-check');
    assert.deepEqual(response, { replyTo: 'private-check', result: true });
    assert.deepEqual(monitorChecks, [{ tab: tabId, frameId: 9, params: {
      runToken: agent._pageFeedbackRuns.get(tabId).token, documentToken: 'monitor-document',
      operationId: preparedOperationId, revision: 4, kind: 'input', rebindFocus: false,
    } }]);
    releaseAction();
    await action;
  } finally {
    releaseAction();
    agent._finishPageFeedbackRun(tabId);
    if (originalBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = originalBrowser;
  }
});
test('BiDi prepares the target frame before validating native dispatch', async () => {
  const originalBrowser = globalThis.browser;
  const tabId = 957, runId = id(), deliveries = [], prepared = new Map();
  const api = {
    tabs: {
      get: async () => ({ url: 'https://example.test/' }),
      sendMessage: async (tab, message, options) => {
        const frameId = options?.frameId || 0;
        const params = message.params || {};
        deliveries.push({ tab, frameId, action: message.action, params });
        const key = `${frameId}:${params.operationId}`;
        if (message.action === 'page_monitor_prepare') {
          prepared.set(key, params);
          return { ready: true };
        }
        if (message.action === 'page_monitor_dispatch') return { ready: true, guard: {
          documentToken: frameId === 9 ? 'document-9' : 'document-0', revision: 4,
          operationId: params.operationId, runToken: params.runToken,
        } };
        if (message.action === 'page_monitor_validate') return { ready: prepared.has(key) };
        return { ready: true };
      },
    },
    webNavigation: { getAllFrames: async () => [
      { frameId: 0, documentId: 'doc-0', url: 'https://example.test/' },
      { frameId: 9, documentId: 'doc-9', url: 'https://frame.test/' },
    ] },
  };
  class TestAgent {
    static STATE_CHANGE_TOOLS = new Set(['click']);
    isRunning() { return true; }
    _checkAbort() { return false; }
    _hasPendingPageFeedback() { return false; }
    async executeTool(tab, action, args) {
      this.pageMonitorState({ tab: { id: tab }, frameId: 9, documentId: 'doc-9', url: 'https://frame.test/' }, 'document-9');
      return client.perform(tab, action, { ...args, frameId: 9 });
    }
  }
  installPageFeedback(TestAgent);
  const agent = new TestAgent();
  const client = new FirefoxBidiClient(api);
  client.runs.set(tabId, { runId, bound: true });
  globalThis.browser = api;
  let validatedGuard;
  client.request = async (_command, args) => {
    validatedGuard = args.payload.pageFeedbackGuard;
    assert.ok(validatedGuard, 'The child-frame monitor must return a dispatch guard');
    assert.equal(await validateNativePageDispatch(api, tabId, validatedGuard, { kind: 'input' }), true,
      'The child-frame monitor must validate the prepared operation');
    return { success: true };
  };
  try {
    await agent._beginPageFeedbackRun(tabId, 'interactive');
    await agent.executeTool(tabId, 'click', { selector: '#target' });
    const prepare = deliveries.find(item => item.action === 'page_monitor_prepare' && item.frameId === 9);
    const dispatch = deliveries.find(item => item.action === 'page_monitor_dispatch' && item.frameId === 9);
    assert.ok(prepare, 'The resolved target frame must receive a preparation message');
    assert.ok(dispatch, 'The resolved target frame must receive the dispatch fence');
    assert.equal(prepare.params.operationId, dispatch.params.operationId);
    assert.equal(prepare.params.tool, 'click');
    assert.ok(deliveries.indexOf(prepare) < deliveries.indexOf(dispatch), 'Preparation must precede dispatch');
  } finally {
    agent._finishPageFeedbackRun(tabId);
    if (originalBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = originalBrowser;
  }
});
test('dialogs are scoped to a live run and navigation permission is single use', () => {
  const session = new BidiSession(); const replies = [];
  session.send = async (method, params) => { replies.push({ method, ...params }); };
  const event = (context, type) => session.receive({ method: 'browsingContext.userPromptOpened', params: { context, type } });
  event('idle', 'alert'); assert.equal(replies.length, 0);
  const run = { context: 'owned', navigation: false }; session.runs.set(id(), run);
  for (const type of ['confirm', 'prompt', 'beforeunload', 'alert']) event('owned', type);
  assert.deepEqual(replies.map(item => item.accept), [false, false, false, true]);
  run.navigation = true;
  event('owned', 'beforeunload'); event('owned', 'beforeunload');
  assert.deepEqual(replies.slice(-2).map(item => item.accept), [true, false]);
});
test('target lookup rejects ambiguity even when URLs match', async () => {
  const session = new BidiSession();
  session.send = async method => method === 'browsingContext.getTree'
    ? { contexts: [{ context: 'a', url: 'https://example.com/' }, { context: 'b', url: 'https://example.com/' }] }
    : { nodes: [{ sharedId: 'node' }] };
  await assert.rejects(session.locate(id(), 'https://example.com/'), /ambiguous/);
});
test('stop during target preparation prevents input dispatch', async () => {
  const session = new BidiSession(); const runId = id(); const sent = [];
  session.runs.set(runId, { context: 'a' });
  session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
  session.call = async () => { await session.closeRun(runId); return { result: { value: true } }; };
  session.send = async method => { sent.push(method); return {}; };
  await assert.rejects(session.perform(runId, 'click', {}), /stopped/);
  assert.equal(sent.includes('input.performActions'), false);
});
test('BiDi navigation revalidates the page feedback guard before native dispatch', async () => {
  const session = new BidiSession(), runId = id(), sent = [];
  session.runs.set(runId, { context: 'a' });
  session.send = async (method, params) => { sent.push({ method, params }); return {}; };
  const guard = { documentToken: 'doc', revision: 4, operationId: 'op' };
  await assert.rejects(session.perform(runId, 'navigate', { url: 'https://example.com/next', pageFeedbackGuard: guard },
    async (_id, received, kind, rebindFocus) => {
      assert.equal(received, guard);
      assert.equal(kind, 'navigate');
      assert.equal(rebindFocus, false);
      return false;
    }), error => {
    assert.equal(error.code, 'page_feedback_pending');
    assert.equal(error.dispatchState.noDispatch, true);
    assert.equal(error.dispatchState.outcomeUnknown, false);
    return true;
  });
  assert.equal(sent.some(call => call.method === 'browsingContext.navigate'), false,
    'A stale guard must be rejected before the native navigation command is sent');

  await session.perform(runId, 'navigate', { url: 'https://example.com/next', pageFeedbackGuard: guard },
    async (_id, _guard, kind) => kind === 'navigate');
  assert.equal(sent.filter(call => call.method === 'browsingContext.navigate').length, 1);
});
for (const failAt of [1, 2, 3, 4]) {
  test(`page feedback change before native input ${failAt} preserves dispatch evidence`, async () => {
    const session = new BidiSession(), runId = id();
    session.runs.set(runId, { context: 'a' });
    session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
    let checks = 0, inputs = 0;
    session.call = async (_match, declaration) => ({ result: { value: declaration.includes('el.innerText : el.value') ? '' : true } });
    session.send = async method => { if (method === 'input.performActions') inputs++; return {}; };
    await assert.rejects(session.perform(runId, 'type', { text: 'ab', clear: false,
      pageFeedbackGuard: { documentToken: 'doc', revision: 7, operationId: 'op' } }, async () => ++checks < failAt), error => {
      assert.equal(error.code, 'page_feedback_pending');
      assert.equal(error.dispatchState.noDispatch, failAt < 4);
      assert.equal(error.dispatchState.dispatched, failAt === 4);
      assert.equal(error.dispatchState.outcomeUnknown, failAt === 4);
      return true;
    });
    assert.equal(inputs, failAt === 4 ? 1 : 0, 'No subsequent character may be sent after the intervention');
  });
}

test('feedback during BiDi target lookup blocks focus before the focus-capable target check', async () => {
  const session = new BidiSession(), runId = id();
  session.runs.set(runId, { context: 'a' });
  let intervened = false, targetChecks = 0;
  session.locate = async () => {
    intervened = true;
    return { context: 'a', node: { sharedId: 'el' } };
  };
  session.call = async () => { targetChecks++; return { result: { value: true } }; };
  await assert.rejects(session.perform(runId, 'type', { text: 'stale', clear: false,
    pageFeedbackGuard: { documentToken: 'doc', revision: 7, operationId: 'op' } },
  async () => !intervened), error => {
    assert.equal(error.code, 'page_feedback_pending');
    assert.equal(error.dispatchState.noDispatch, true);
    return true;
  });
  assert.equal(targetChecks, 0, 'A stale page must be rejected before the target check calls focus()');
});

test('page feedback after native marker installation clears attribution and blocks input', async () => {
  const session = new BidiSession(), runId = id(), sent = [];
  session.runs.set(runId, { context: 'a' });
  session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
  let markerInstalled = false, markerCleared = false, validations = 0;
  session.call = async (_match, declaration) => {
    if (declaration.includes('target.setAttribute')) { markerInstalled = true; return { result: { value: true } }; }
    if (declaration.includes('removeAttribute')) { markerCleared = true; markerInstalled = false; return { result: { value: true } }; }
    return { result: { value: true } };
  };
  session.send = async method => { sent.push(method); return {}; };
  await assert.rejects(session.perform(runId, 'click', { token: 'target', url: 'https://example.com',
    pageFeedbackGuard: { documentToken: 'doc', revision: 3, operationId: 'op' } },
  async () => ++validations === 1), error => {
    assert.equal(error.code, 'page_feedback_pending');
    assert.equal(error.dispatchState.noDispatch, true);
    assert.equal(error.dispatchState.outcomeUnknown, false);
    return true;
  });
  assert.equal(validations, 2, 'Validate again after awaiting installation of the native marker');
  assert.equal(markerInstalled, false);
  assert.equal(markerCleared, true);
  assert.equal(sent.includes('input.performActions'), false);
});
for (const platform of ['Win32', 'MacIntel']) {
  test(`field clearing renews native attribution between modifier and A on ${platform}`, async () => {
    const session = new BidiSession(), runId = id(), sent = [];
    session.runs.set(runId, { context: 'a' });
    session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
    let checks = 0;
    session.call = async (_match, declaration) => ({ result: { value:
      declaration.includes('navigator.platform') ? platform
          : declaration.includes('el.innerText : el.value') ? '' : true } });
    session.send = async (method, params) => { if (method === 'input.performActions') sent.push({ marks: checks, actions: params.actions[0].actions }); return {}; };
    await session.perform(runId, 'field', { text: 'x', pageFeedbackGuard: { documentToken: 'doc', revision: 0, operationId: 'op' } }, async () => { checks++; return true; });
    assert.deepEqual(sent.map(item => item.marks), [3, 5, 7, 9]);
    assert.deepEqual(sent[0].actions, [{ type: 'keyDown', value: platform === 'MacIntel' ? '\uE03D' : '\uE009' }]);
    assert.equal(sent[1].actions[0].value, 'a');
    assert.equal(sent[2].actions[0].value, '\uE003');
  });
}
test('human intervention after the clear modifier blocks A and releases held keys', async () => {
  const session = new BidiSession(), runId = id(), sent = [];
  session.runs.set(runId, { context: 'a' });
  session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
  let checks = 0;
  session.call = async (_match, declaration) => ({ result: { value:
    declaration.includes('navigator.platform') ? 'Win32'
        : declaration.includes('el.innerText : el.value') ? '' : true } });
  session.send = async method => { sent.push(method); return {}; };
  await assert.rejects(session.perform(runId, 'field', { text: 'x',
    pageFeedbackGuard: { documentToken: 'doc', revision: 0, operationId: 'op' } }, async () => ++checks < 4), error => {
    assert.equal(error.code, 'page_feedback_pending');
    assert.equal(error.dispatchState.dispatched, true);
    assert.equal(error.dispatchState.outcomeUnknown, true);
    return true;
  });
  assert.equal(sent.filter(method => method === 'input.performActions').length, 1);
  assert.equal(sent.at(-1), 'input.releaseActions');
});
test('repeated native Tab validates and rebinds to the focused target before each follow-up', async () => {
  const session = new BidiSession(), runId = id(), validations = [], sent = [];
  session.runs.set(runId, { context: 'a' });
  session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
  session.call = async () => ({ result: { value: true } });
  session.send = async (method, params) => { if (method === 'input.performActions') sent.push(params); return {}; };
  const result = await session.perform(runId, 'key', { key: 'Tab', repeat: 3,
    pageFeedbackGuard: { documentToken: 'doc', revision: 0, operationId: 'op' } }, async (_id, _guard, kind, rebindFocus) => {
    validations.push({ kind, rebindFocus }); return true;
  });
  assert.equal(result.success, true);
  assert.deepEqual(validations, [
    { kind: 'input', rebindFocus: false },
    { kind: 'input', rebindFocus: false },
    { kind: 'input', rebindFocus: false },
    { kind: 'input', rebindFocus: true },
    { kind: 'input', rebindFocus: true },
    { kind: 'input', rebindFocus: true },
    { kind: 'input', rebindFocus: true },
  ]);
  assert.equal(sent.length, 3);
});
test('unsupported commands and modifiers fail before touching the page', async () => {
  const session = new BidiSession(); const runId = id();
  session.runs.set(runId, { context: 'a' });
  await assert.rejects(session.perform(runId, 'rawScript', {}), /Unsupported/);
  await assert.rejects(session.perform(runId, 'key', { modifiers: ['Control'] }), /modifiers/);
});

test('installer and native launcher preserve Firefox message framing and command whitelist', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'webbrain-native-test-'));
  try {
    const install = spawnSync(process.execPath, ['firefox-companion/install.mjs', directory], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const manifest = JSON.parse(await readFile(join(directory, 'one.webbrain.bidi.json'), 'utf8'));
    // On Windows the wrapper is a .cmd batch file, which Node cannot spawn
    // directly (CreateProcess EINVAL); route it through cmd.exe the same way
    // Firefox does. POSIX wrappers are executable scripts and spawn directly.
    const spawnHost = input => process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', manifest.path], { input, timeout: 5000 })
      : spawnSync(manifest.path, [], { input, timeout: 5000 });
    assert.deepEqual(manifest.allowed_extensions, ['webbrain@esokullu.com']);
    const message = Buffer.from(JSON.stringify({ id: 12, command: 'script.evaluate', expression: 'arbitrary code' }));
    const header = Buffer.alloc(4); header.writeUInt32LE(message.length);
    const result = spawnHost(Buffer.concat([header, message]));
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.equal(result.stdout.readUInt32LE(0), result.stdout.length - 4);
    assert.deepEqual(JSON.parse(result.stdout.subarray(4)), { id: 12, error: 'Unknown companion command' });
    const rejected = Buffer.from(JSON.stringify({id:13,command:'perform',runId:id(),action:'click',payload:{}}));
    const rejectedHeader = Buffer.alloc(4); rejectedHeader.writeUInt32LE(rejected.length);
    const rejectedResult = spawnHost(Buffer.concat([rejectedHeader, rejected]));
    assert.equal(rejectedResult.status,0,rejectedResult.stderr?.toString());
    const failure = JSON.parse(rejectedResult.stdout.subarray(4));
    assert.equal(failure.id,13);
    assert.deepEqual(failure.dispatchState,{dispatched:false,noDispatch:true,outcomeUnknown:false,retryable:true});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('expired action deadline fails before target lookup', async () => {
  const session = new BidiSession(); const runId = id();
  session.runs.set(runId, { context: 'a' });
  session.locate = () => assert.fail('expired actions must not locate a target');
  await assert.rejects(session.perform(runId, 'click', { deadlineAt: Date.now() - 1 }), /deadline/);
});

test('blank-tab runs defer binding and retain ownership through navigation', async () => {
  let url = 'about:blank', injections = 0; const calls = [];
  const client = new FirefoxBidiClient({
    storage: { local: { get: async () => ({firefoxBidiEnabled:true}) } },
    tabs: {
      get: async () => ({url}),
      update: async (_id, value) => { url = value.url; },
      executeScript: async (_tab, options) => { injections++; assert.equal(options.file, '/src/bidi/bind.js'); assert.equal(options.code, undefined); return [{token:id(), url}]; },
    },
  });
  client.connect = async () => ({});
  client.request = async command => { calls.push(command); return {}; };
  await client.startRun(1);
  assert.equal(injections, 0);
  assert.ok(client.runs.has(1));
  assert.equal((await client.perform(1, 'navigate', {url:'https://example.com/'})).bindingDeferred, true);
  await client.bindRun(1, client.runs.get(1));
  assert.equal(injections, 1);
  assert.deepEqual(calls, ['openRun']);
});
test('pending dialogs are handled only after binding their owner', async () => {
  const session = new BidiSession(); const calls = [];
  session.send = async (method, params) => { calls.push({method,params}); return {}; };
  session.locate = async () => ({context:'tab', node:{sharedId:'html'}});
  session.receive({method:'browsingContext.userPromptOpened',params:{context:'tab',type:'confirm'}});
  assert.equal(calls.length, 0);
  await session.openRun(id(), id(), 'https://example.com/');
  assert.equal(calls[0].method, 'browsingContext.handleUserPrompt');
  assert.equal(calls[0].params.accept, false);
  assert.equal(session.dialogs.size, 0);
});
test('closed idle dialogs are not replayed when a task binds', async () => {
  const session = new BidiSession(); const calls = [];
  session.send = async method => { calls.push(method); return {}; };
  session.locate = async () => ({context:'tab', node:{sharedId:'html'}});
  session.receive({method:'browsingContext.userPromptOpened',params:{context:'tab',type:'alert'}});
  session.receive({method:'browsingContext.userPromptClosed',params:{context:'tab'}});
  await session.openRun(id(), id(), 'https://example.com/');
  assert.deepEqual(calls, ['script.callFunction']);
});
test('a focus change blocks key dispatch before any text can leak', async () => {
  const session = new BidiSession(); const runId = id(); const sent = [];
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'input'}});
  session.call = async (_match, fn) => ({result:{value:fn.includes('activeElement === el') ? false : true}});
  session.send = async method => { sent.push(method); return {}; };
  await assert.rejects(session.perform(runId, 'type', {text:'secret'}), /Focus changed/);
  assert.equal(sent.includes('input.performActions'), false);
});
test('Stop after one character never queues the remaining text', async () => {
  const session = new BidiSession(); const runId = id(); const dispatched = [];
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'input'}});
  session.call = async () => ({result:{value:true}});
  session.send = async (method, params) => {
    if (method === 'input.performActions') { dispatched.push(params); await session.closeRun(runId); }
    return {};
  };
  await assert.rejects(session.perform(runId, 'type', {text:'hello'}), /stopped/);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].actions[0].actions.length, 2);
});
test('literal newline insertion never dispatches an Enter key', async () => {
  const session = new BidiSession(); const runId = id(); const dispatched = []; const scripts = [];
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'input'}});
  session.call = async (_match, fn) => { scripts.push(fn); return {result:{value:true}}; };
  session.send = async (method, params) => { if(method==='input.performActions') dispatched.push(params); return {}; };
  await session.perform(runId, 'type', {text:'a\nb'});
  assert.ok(scripts.some(fn=>fn.includes("execCommand('insertText'")));
  assert.deepEqual(dispatched.flatMap(p=>p.actions[0].actions.map(a=>a.value)), ['a','a','b','b']);
});

test('the settled typing readback names the reader that compared the value', async () => {
  const session = new BidiSession(); const runId = id(); const scripts = [];
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'editor'}});
  const marker = 'const settledReading = readRichTextFieldReading(el, semanticKind)';
  let settled = { verified: false, compared: true, reader: 'semantic' };
  session.call = async (_match, fn) => {
    scripts.push(fn);
    if (!fn.includes(marker)) return {result:{value:true}};
    return {result:{type:'object', value:Object.entries(settled).map(([key, value]) => [key, {type:typeof value, value}])}};
  };
  session.send = async () => ({});
  const mismatch = await session.perform(runId, 'field', {text:'ab', submit:true});
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.submitted, false);
  assert.deepEqual(mismatch.readback, {compared:true, reader:'semantic'});
  // The extension reads an editor model's mismatch as known.
  const client = new FirefoxBidiClient({tabs:{sendMessage:async () => ({bidiPrepared:true, url:'https://example.com/',
    fieldMeta:{tag:'div', contentEditable:true}})}});
  client.runs.set(1, {runId, bound:true});
  client.bindRun = async () => {};
  client.perform = async () => mismatch;
  const known = await client.sendContent(1, {action:'set_field', params:{text:'ab'}});
  assert.deepEqual(known.unverified, {reason:'readback_mismatch', reader:'semantic'});
  assert.equal(known.readbackExact, true);
  settled = { verified: false, compared: false, reason: 'element_replaced' };
  assert.deepEqual((await session.perform(runId, 'field', {text:'ab'})).readback, {compared:false, reason:'element_replaced'});
  settled = { verified: true, compared: true, reader: 'exact' };
  assert.equal((await session.perform(runId, 'field', {text:'ab'})).verified, true);

  // The readback itself, against a minimal DOM.
  const declaration = scripts.find(fn => fn.includes(marker));
  const settle = (...args) => ({ ...vm.runInNewContext(`(${declaration})`)(...args) });
  const style = {display:'block', visibility:'visible', opacity:'1', contentVisibility:'visible'};
  const doc = {defaultView:{getComputedStyle:() => style}};
  const element = ({classes = [], ...props}) => ({nodeType:1, isConnected:true, shadowRoot:null, hidden:false, ownerDocument:doc,
    getAttribute:() => null, classList:{contains:name => classes.includes(name)}, children:[], childNodes:[], getRootNode:() => doc, ...props});
  const input = element({tagName:'INPUT', isContentEditable:false, value:'ab'});
  assert.deepEqual(settle(input, 'ab', '', null), {verified:true, compared:true, reader:'exact'});
  input.value = 'a';
  assert.deepEqual(settle(input, 'ab', '', null), {verified:false, compared:true, reader:'exact'});
  const paragraph = element({tagName:'P', isContentEditable:true, childNodes:[{nodeType:3, nodeValue:'Original'}]});
  const proseMirror = element({tagName:'DIV', isContentEditable:true, classes:['ProseMirror'], childNodes:[paragraph], innerText:'Original'});
  assert.deepEqual(settle(proseMirror, 'Original', 'prosemirror', null), {verified:true, compared:true, reader:'semantic'});
  assert.deepEqual(settle(proseMirror, 'First\n\nLast', 'prosemirror', null), {verified:false, compared:true, reader:'semantic'});
  const editor = element({tagName:'DIV', isContentEditable:true, innerText:'Original'});
  assert.deepEqual(settle(editor, 'First', '', null), {verified:false, compared:true, reader:'rendered'});
  const other = element({tagName:'DIV', isContentEditable:false});
  assert.deepEqual(settle(other, 'ab', '', null), {verified:false, compared:true, reader:'unknown'});
  assert.deepEqual(settle(input, 'a', '', {editor:proseMirror, document:doc, root:doc}), {verified:false, compared:false, reason:'element_replaced'});
  proseMirror.classList = {contains:() => false};
  assert.deepEqual(settle(proseMirror, 'Original', 'prosemirror', null), {verified:false, compared:false, reason:'readback_unavailable'});
});

test('validation failures preserve no-dispatch status across the native client', async () => {
  const session = new BidiSession(); const runId = id();
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => { throw new Error('stale target'); };
  let receive;
  const client = new FirefoxBidiClient({
    runtime: { connectNative: () => ({
      onMessage: {addListener: listener => {receive=listener;}}, onDisconnect: {addListener(){}},
      postMessage: message => {
        session.perform(message.runId, message.action, message.payload).then(
          result => receive({id:message.id,result}),
          error => receive({id:message.id,error:error.message,dispatchState:error.dispatchState}),
        );
      },
    }) },
    tabs: {sendMessage: async () => ({bidiPrepared:true,url:'https://example.com/'})},
  });
  client.runs.set(1,{runId,bound:true});
  const result = await client.sendContent(1,{action:'click',params:{}});
  assert.equal(result.dispatched,false);
  assert.equal(result.noDispatch,true);
  assert.equal(result.outcomeUnknown,false);
  assert.equal(result.retryable,true);
});
test('click_ax preparation carries checkable state into trusted input', async () => {
  const client = new FirefoxBidiClient({
    tabs: { sendMessage: async () => ({
      bidiPrepared: true,
      url: 'https://example.com/',
      checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'choice' },
    }) },
  });
  client.runs.set(1, { runId: id(), bound: true });
  let payload;
  client.perform = async (_tabId, _action, received) => { payload = received; return { success: true, verified: true }; };
  const result = await client.sendContent(1, { action: 'click_ax', params: { ref_id: 'ax-1' } });
  assert.equal(result.success, true);
  assert.deepEqual(payload.checkable, { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'choice' });
});
test('trusted checkable clicks report a prevented state transition', async () => {
  const session = new BidiSession(); const runId = id(); const sent = [];
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'check' } });
  session.call = async (_match, fn) => ({ result: { value: fn.includes('checkbox" || el.type')
    ? { checkedAfter: false, elapsedMs: 80 }
    : true } });
  session.send = async (method, params) => { sent.push({ method, params }); return {}; };
  const result = await session.perform(runId, 'click', {
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'check' },
  });
  assert.equal(sent.some(item => item.method === 'input.performActions'), true);
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(result.noProgress, true);
  assert.equal(result.checkedAfter, false);
  assert.equal(result.checkedChanged, false);
});
test('trusted checkable clicks wait on state events and report observation time', async () => {
  const session = new BidiSession(); const runId = id(); const scripts = [];
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'check' } });
  session.call = async (_match, fn) => {
    scripts.push(fn);
    return scripts.length === 1
      ? { result: { value: true } }
      : { result: { value: { checkedAfter: true, elapsedMs: 12 } } };
  };
  session.send = async () => ({});
  const result = await session.perform(runId, 'click', {
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'check' },
  });
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(result.checkedAfter, true);
  assert.equal(result._checkableObservationMs, 12);
  assert.match(scripts[1], /addEventListener\(['"]change['"], check\)/);
  assert.match(scripts[1], /setTimeout\(/, 'a bounded timeout must remain as the no-event fallback');
});
test('trusted target validation descends through open shadow roots', async () => {
  const session = new BidiSession(); const runId = id(); let validation;
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'shadow-button' } });
  session.call = async (_match, fn) => { validation = fn; return { result: { value: true } }; };
  session.send = async () => ({});
  await session.perform(runId, 'click', {});
  assert.match(validation, /shadowRoot\.elementFromPoint/);
  assert.match(validation, /node\.parentNode \|\| node\.host/);
});
test('a trusted click over an embedded frame is refused before any input', async () => {
  // The marked element is a container whose point is covered by a frame:
  // the press would land in the frame's own document, another site.
  for (const action of ['click', 'click_at']) {
    const session = new BidiSession(); const runId = id(); const token = id(); const sent = [];
    const el = { isConnected: true, tagName: 'DIV', disabled: false,
      getAttribute: name => name === 'data-webbrain-bidi' ? token : null, removeAttribute() {},
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 200 }) };
    const frame = { tagName: 'IFRAME', parentNode: el };
    session.runs.set(runId, { context: 'tab' });
    session.locate = async () => ({ context: 'tab', node: { sharedId: 'container' } });
    session.call = async (_match, declaration, args = []) => ({ result: { value: vm.runInNewContext(`(${declaration})`, {
      document: { elementFromPoint: () => frame }, innerWidth: 800, innerHeight: 600,
    })(el, ...args.map(arg => arg.type === 'null' ? null : arg.value)) } });
    session.send = async method => { sent.push(method); return {}; };
    await assert.rejects(session.perform(runId, action, { token, point: { x: 40, y: 40 } }),
      error => /Target changed or is covered/.test(error.message) && error.dispatchState.noDispatch === true, action);
    assert.deepEqual(sent, [], action);
  }
});
test('keyboard validation does not require pointer geometry', async () => {
  const session = new BidiSession(); const runId = id(); const calls = [];
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'body' } });
  session.call = async (_match, fn) => { calls.push(fn); return { result: { value: true } }; };
  session.send = async () => ({});
  await session.perform(runId, 'key', { key: 'Escape' });
  assert.match(calls[0], /action === 'click' \|\| action === 'hover'/);
});
test('post-dispatch failure and transport uncertainty are never safe retries', async () => {
  const session = new BidiSession(); const runId = id();
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'el'}});
  session.call = async () => ({result:{value:true}});
  session.send = async method => { if(method==='input.performActions')throw new Error('connection lost'); return {}; };
  await assert.rejects(session.perform(runId,'click',{}), error => error.dispatchState.dispatched === true && error.dispatchState.retryable === false);
  const client = new FirefoxBidiClient({tabs:{sendMessage:async()=>({bidiPrepared:true,url:'https://example.com/'})}});
  client.runs.set(1,{runId,bound:true}); client.request=async()=>{throw new Error('timeout')};
  const result=await client.sendContent(1,{action:'click',params:{}});
  assert.equal(result.dispatched,true);
  assert.equal(result.outcomeUnknown,true);
  assert.equal(result.retryable,false);
});
test('coordinate clicks retain their validated viewport point', async () => {
  const session = new BidiSession(); const runId = id(); const sent=[];
  session.runs.set(runId,{context:'tab'});
  session.locate=async()=>({context:'tab',node:{sharedId:'canvas'}});
  session.call=async(_match,fn,args)=>{assert.equal(args[2].value,17);assert.equal(args[3].value,23);return {result:{value:true}}};
  session.send=async(method,params)=>{if(method==='input.performActions')sent.push(params);return {}};
  await session.perform(runId,'click',{point:{x:17,y:23}});
  assert.deepEqual(sent[0].actions[0].actions[0],{type:'pointerMove',origin:'viewport',x:17,y:23});
});
test('release workflows run the full suite on the companion runtime', async () => {
  const {readFile}=await import('node:fs/promises');
  const pkg=JSON.parse(await readFile('package.json','utf8'));
  const shards=Object.keys(pkg.scripts).filter(name=>name.startsWith('test:shard:'));
  assert.ok(shards.length>0,'expected sharded test scripts in package.json');
  for(const workflow of ['main','minor-release']) {
    const source=await readFile(`.github/workflows/${workflow}.yml`,'utf8');
    assert.match(source,/node-version: 22/);
  }
  const minor=await readFile('.github/workflows/minor-release.yml','utf8');
  assert.match(minor,/run: npm test/);
  const main=await readFile('.github/workflows/main.yml','utf8');
  assert.match(main,/npm run test:shard:\$\{\{ matrix\.shard \}\}/);
  for(const shard of shards) {
    assert.ok(main.includes(`          - ${shard.replace('test:shard:','')}`),`main.yml matrix should run ${shard}`);
  }
});

// ── Vision mode's point input (point_input) ────────────────────────────────

test('the companion reports point input when it connects', async () => {
  const { COMPANION_CAPABILITIES } = await import('../firefox-companion/session.mjs');
  assert.deepEqual([...COMPANION_CAPABILITIES], ['point_input', 'saved_download']);
  const session = new BidiSession();
  session.socket = { readyState: 1 };
  assert.deepEqual(await session.connectSession(9222), { connected: true, capabilities: ['point_input', 'saved_download'] });
});

function pointSession({ context = 'tab', disabled = false, validate = async () => true } = {}) {
  const session = new BidiSession(), runId = id(), token = id(), sent = [], checks = [], markers = [];
  const el = {
    isConnected: true, disabled, tagName: 'DIV', attributes: new Map([['data-webbrain-bidi', token]]),
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    setAttribute(name, value) { this.attributes.set(name, value); if (name === 'data-webbrain-native-action') markers.push(JSON.parse(value).kind); },
    removeAttribute(name) { this.attributes.delete(name); },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 100 }),
    getRootNode: () => ({ activeElement: null }),
  };
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context, node: { sharedId: 'marked' } });
  session.call = async (_match, declaration, args = []) => {
    checks.push(declaration);
    const document = { elementFromPoint: () => el, documentElement: { getAttribute: () => 'point-document:0' } };
    return { result: { value: vm.runInNewContext(`(${declaration})`, { document, innerWidth: 1000, innerHeight: 700 })(el, ...args.map(arg => arg.value)) } };
  };
  session.send = async (method, params) => { if (method === 'input.performActions') sent.push(params.actions[0]); return {}; };
  return { session, runId, token, sent, checks, markers, el, url: 'https://example.com/', guard: { documentToken: 'point-document', revision: 0, operationId: 'vision', nativeSecret: 'secret' }, validate };
}

test('click_at presses the left button once at the point, under a click marker', async () => {
  const run = pointSession();
  const result = await run.session.perform(run.runId, 'click_at', { token: run.token, url: run.url, point: { x: 120, y: 40 }, pageFeedbackGuard: run.guard }, async () => true);
  assert.equal(result.success, true);
  assert.equal(result.method, 'firefox-bidi');
  assert.deepEqual(run.sent, [{ type: 'pointer', id: 'webbrain-pointer', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', x: 120, y: 40, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }]);
  assert.deepEqual(run.markers, ['click']);
  assert.equal(run.el.getAttribute('data-webbrain-bidi'), null, 'the binding is used once');
});

test('hover_at moves the pointer to the point and may rest on a disabled control', async () => {
  const run = pointSession({ disabled: true });
  assert.equal((await run.session.perform(run.runId, 'hover_at', { token: run.token, url: run.url, point: { x: 30, y: 60 } })).success, true);
  assert.deepEqual(run.sent[0].actions, [{ type: 'pointerMove', x: 30, y: 60, origin: 'viewport' }]);
  const pressed = pointSession({ disabled: true });
  await assert.rejects(pressed.session.perform(pressed.runId, 'click_at', { token: pressed.token, url: pressed.url, point: { x: 30, y: 60 } }), /covered/);
  assert.deepEqual(pressed.sent, []);
});

test('point input refuses a fractional or missing point, a wheel and a frame target before any input', async () => {
  for (const [action, payload, pattern] of [
    ['click_at', { point: { x: 10.5, y: 4 } }, /Invalid point/],
    ['hover_at', {}, /Invalid point/],
    ['scroll_at', { point: { x: 1, y: 1 }, deltaY: 100 }, /Unsupported BiDi action/],
  ]) {
    const run = pointSession();
    await assert.rejects(run.session.perform(run.runId, action, { token: run.token, url: run.url, ...payload }),
      error => pattern.test(error.message) && error.dispatchState.noDispatch === true, `${action} ${JSON.stringify(payload)}`);
    assert.deepEqual(run.sent, []);
  }
  const framed = pointSession({ context: 'child-frame' });
  await assert.rejects(framed.session.perform(framed.runId, 'click_at', { token: framed.token, url: framed.url, point: { x: 5, y: 5 } }), /top document/);
  assert.deepEqual(framed.sent, []);
});

function visionClient({ prepared = null, capabilities = ['point_input'], perform = null, sendMessage = null } = {}) {
  const messages = [];
  const client = new FirefoxBidiClient({ tabs: { sendMessage: sendMessage || (async (_tab, message, options) => {
    messages.push({ message, options });
    return prepared ? prepared(message) : { bidiPrepared: true, success: false, dispatched: false, noDispatch: true,
      url: 'https://example.com/', point: { x: 120, y: 40 }, target: { tag: 'button' }, _filePickerGuardId: 'fpg_1' };
  }) } });
  client.connect = async () => (capabilities ? { connected: true, capabilities } : { connected: true });
  client.runs.set(1, { runId: id(), bound: true });
  const performed = [];
  client.perform = perform || (async (_tab, action, payload) => { performed.push({ action, payload }); return { success: true, dispatched: true, method: 'firefox-bidi' }; });
  return { client, messages, performed };
}

test('trusted vision input: a left click is prepared by the content script and pressed by the companion', async () => {
  const { client, messages, performed } = visionClient();
  const result = await client.visionInput(1, { type: 'click', x: 120.4, y: 39.6, button: 'left', clickCount: 1 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.action, 'vision_input');
  assert.equal(messages[0].options.frameId, 0);
  assert.match(messages[0].message.params._bidiPrepare, /^[a-f0-9-]{36}$/);
  assert.equal(performed.length, 1);
  assert.equal(performed[0].action, 'click_at');
  assert.deepEqual(performed[0].payload, { token: messages[0].message.params._bidiPrepare, url: 'https://example.com/', point: { x: 120, y: 40 } });
  assert.deepEqual(result, { success: true, dispatched: true, method: 'firefox-bidi', target: { tag: 'button' }, _filePickerGuardId: 'fpg_1' });
});

test('trusted vision input: a hover goes to the companion at its prepared point', async () => {
  const { client, messages, performed } = visionClient();
  await client.visionInput(1, { type: 'hover', x: 10, y: 10 });
  assert.deepEqual(performed.map(entry => entry.action), ['hover_at']);
  assert.deepEqual(performed[0].payload, { token: messages[0].message.params._bidiPrepare, url: 'https://example.com/', point: { x: 120, y: 40 } });
});

test('trusted vision input leaves synthetic what it does not send, and sends nothing for it', async () => {
  // A BiDi wheel scrolls only the window's selected tab; a run's tab can be in the background.
  for (const params of [{ type: 'drag', x: 1, y: 1, toX: 50, toY: 1 }, { type: 'click', x: 1, y: 1, clickCount: 2 },
    { type: 'click', x: 1, y: 1, button: 'right' }, { type: 'click', x: 1, y: 1, button: 'middle' },
    { type: 'wheel', x: 1, y: 1, deltaY: 300 }]) {
    const { client, messages, performed } = visionClient();
    assert.equal(await client.visionInput(1, params), null, JSON.stringify(params));
    assert.equal(messages.length + performed.length, 0);
  }
  const older = visionClient({ capabilities: null });
  assert.equal(await older.client.visionInput(1, { type: 'click', x: 1, y: 1 }), null, 'a companion without point input');
  assert.equal(older.messages.length, 0);
  const noRun = visionClient();
  noRun.client.runs.clear();
  assert.equal(await noRun.client.visionInput(1, { type: 'click', x: 1, y: 1 }), null, 'a run without trusted input');
  const framed = visionClient({ prepared: () => ({ bidiUnavailable: true, success: false, dispatched: false, noDispatch: true }) });
  assert.equal(await framed.client.visionInput(1, { type: 'click', x: 1, y: 1 }), null, 'a point over an embedded frame');
  assert.equal(framed.performed.length, 0);
});

test('trusted vision input returns the content refusal and never falls back after a disconnect', async () => {
  const refusal = { success: false, dispatched: false, noDispatch: true, visionInputRefused: 'disabled_control', error: 'disabled' };
  const refused = visionClient({ prepared: () => refusal });
  assert.deepEqual(await refused.client.visionInput(1, { type: 'click', x: 1, y: 1 }), refusal);
  assert.equal(refused.performed.length, 0);
  const lost = visionClient();
  lost.client.runs.get(1).disconnected = true;
  const result = await lost.client.visionInput(1, { type: 'click', x: 1, y: 1 });
  assert.equal(result.noDispatch, true);
  assert.equal(result.retryable, false);
  assert.equal(lost.messages.length, 0);
});

test('trusted vision input keeps no-dispatch and uncertain outcomes apart', async () => {
  const vetoed = visionClient({ perform: async () => { const error = new Error('Page changed'); error.code = 'page_feedback_pending'; throw error; } });
  const pending = await vetoed.client.visionInput(1, { type: 'click', x: 1, y: 1 });
  assert.equal(pending.noDispatch, true);
  assert.equal(pending.pageFeedbackPending, true);
  assert.equal(pending._filePickerGuardId, 'fpg_1', 'the armed file-chooser guard is still settled');
  const uncertain = visionClient({ perform: async () => { throw new Error('Firefox companion timed out'); } });
  const unknown = await uncertain.client.visionInput(1, { type: 'click', x: 1, y: 1 });
  assert.equal(unknown.dispatched, true);
  assert.equal(unknown.outcomeUnknown, true);
  assert.equal(unknown.retryable, false);
});

test('trusted vision input fences its click or hover like the synthetic sequence', async () => {
  for (const [action, expected] of [
    ['click_at', { kind: 'click', fenceOnly: true, navigationCandidate: true }],
    ['hover_at', { kind: 'click', fenceOnly: true, navigationCandidate: false }],
  ]) {
    const tab = 957, owner = { ...pageFeedbackMethods, isRunning: () => true, _checkAbort: () => false };
    const registrations = [];
    const client = new FirefoxBidiClient({ tabs: { sendMessage: async (_tab, message) => {
      registrations.push(message);
      return { ready: true, guard: { documentToken: 'd', revision: 0, operationId: 'o' } };
    } } });
    client.runs.set(tab, { runId: id(), bound: true });
    client.request = async (_command, args) => { assert.equal(args.action, action); return { success: true }; };
    await owner._beginPageFeedbackRun(tab, 'interactive');
    try {
      await client.perform(tab, action, { token: id(), url: 'https://example.com/', point: { x: 5, y: 6 } });
      assert.deepEqual(registrations.map(message => message.action), ['page_monitor_dispatch'], `${action}: no second preparation of the vision point`);
      const params = registrations[0].params;
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(params[key], value, `${action}: ${key}`);
      assert.equal(params.x, undefined, `${action}: the prepared point stands`);
      assert.equal(params.prepareMonitor, undefined);
    } finally { owner._finishPageFeedbackRun(tab); }
  }
});

test('Firefox vision input goes through the companion when the run has one, and stays synthetic otherwise', async () => {
  const { Agent } = await import('../src/firefox/src/agent/agent.js');
  const { firefoxBidi } = await import('../src/firefox/src/bidi/client.js');
  const originalBrowser = globalThis.browser, originalVisionInput = firefoxBidi.visionInput;
  const contentMessages = [];
  globalThis.browser = { tabs: { sendMessage: async (_tab, message) => { contentMessages.push(message); return { success: true, dispatched: true, method: 'synthetic-vision-pointer' }; } } };
  const agent = Object.create(Agent.prototype);
  // No run to stop: _visionContentInput checks Stop first.
  agent._runAbortStates = new Map();
  try {
    firefoxBidi.runs.set(31, { runId: id(), bound: true });
    firefoxBidi.visionInput = async () => ({ success: true, dispatched: true, method: 'firefox-bidi' });
    assert.equal((await agent._visionContentInput(31, { type: 'click', x: 5, y: 5 })).method, 'firefox-bidi');
    assert.equal(contentMessages.length, 0);
    firefoxBidi.visionInput = async () => null;
    assert.equal((await agent._visionContentInput(31, { type: 'drag', x: 5, y: 5, toX: 50, toY: 5 }, 'click')).method, 'synthetic-vision-pointer');
    assert.equal(contentMessages.at(-1).action, 'vision_input');
    firefoxBidi.visionInput = async () => { throw new Error('Tab or element binding is stale'); };
    const failed = await agent._visionContentInput(31, { type: 'hover', x: 5, y: 5 });
    assert.equal(failed.noDispatch, true);
    assert.equal(contentMessages.length, 1, 'a failed preparation is not retried synthetically');
    firefoxBidi.visionInput = async () => { const error = new Error('stopped'); error.name = 'AbortError'; throw error; };
    await assert.rejects(agent._visionContentInput(31, { type: 'hover', x: 5, y: 5 }), /stopped/);
    firefoxBidi.runs.delete(31);
    firefoxBidi.visionInput = async () => { throw new Error('a run without trusted input never asks'); };
    assert.equal((await agent._visionContentInput(31, { type: 'click', x: 5, y: 5 })).method, 'synthetic-vision-pointer');
  } finally {
    firefoxBidi.runs.delete(31);
    firefoxBidi.visionInput = originalVisionInput;
    if (originalBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = originalBrowser;
  }
});
