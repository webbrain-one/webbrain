import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

// The extracted product functions run next to hand-written stubs. When the
// product starts calling a helper that has no stub, the ReferenceError lands in
// an async listener or a catch block that only logs it, and the test then fails
// on an assertion that does not name the cause. Record those errors in the page
// (console text alone does not show an Error argument in Firefox) so the
// failure names the missing stub.
const RECORD_PAGE_ERRORS = `window.pageErrors = [];
window.addEventListener('error', event => window.pageErrors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => window.pageErrors.push('Unhandled rejection: ' + event.reason));
for (const level of ['warn', 'error']) {
  const log = console[level];
  console[level] = (...args) => {
    if (args.some(arg => arg instanceof ReferenceError)) window.pageErrors.push(args.map(String).join(' '));
    return log.apply(console, args);
  };
}`;
function watchPageErrors(page) {
  const uncaught = [];
  // Also catches a script that fails to parse, before it can record anything.
  page.on('pageerror', error => uncaught.push(String(error)));
  return async () => {
    // A rejected async listener reports on a later task; let it arrive first.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    const recorded = await page.evaluate(() => window.pageErrors || []);
    assert.deepEqual([...new Set([...recorded, ...uncaught])], [], 'The extracted product code threw; a stub is probably missing');
  };
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: Escape dismisses History without cancelling the active task`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const assertNoPageErrors = watchPageErrors(page);
      const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
      await page.setContent('<button id="history">History</button><div id="popover" popover="auto"><button>Recover</button></div><textarea></textarea>');
      await page.addScriptTag({ content: `
        ${RECORD_PAGE_ERRORS}
        const historyBtn = document.querySelector('#history');
        const historyPopover = document.querySelector('#popover');
        const inputEl = document.querySelector('textarea');
        const uiScaleShortcutAction = () => null;
        const closeUiScalePopover = () => false;
        const closePermissionGatePopover = () => false;
        const slashCommandMenuEl = null, selectionAskActionEl = null, providerPickerMenu = null, languagePickerMenu = null;
        const isProcessing = true;
        window.aborts = 0;
        function abortRun() { window.aborts++; }
        ${extract(source, 'handleGlobalKeydown')}
        document.addEventListener('keydown', handleGlobalKeydown, true);
        historyPopover.showPopover();
        historyBtn.focus();
      ` });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.querySelector('#popover').matches(':popover-open')), false);
      assert.equal(await page.evaluate(() => window.aborts), 0);
      await page.keyboard.press('Escape');
      await assertNoPageErrors();
      assert.equal(await page.evaluate(() => window.aborts), 1, 'Escape still aborts after dismissal');
    } finally { await browser.close(); }
  });

  test(`${build}: hidden recovery commits the new transcript before handoff`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const assertNoPageErrors = watchPageErrors(page);
      const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
      const listenerStart = source.lastIndexOf(`${build === 'firefox' ? 'browser' : 'chrome'}.runtime.onMessage.addListener(`, source.indexOf("|| msg.action !== 'tab_chat_handoff_request'"));
      const listener = source.slice(listenerStart, source.indexOf('\n});', listenerStart) + 4);
      await page.setContent('<div id="messages">old dialog</div>');
      await page.addScriptTag({ content: `
        ${RECORD_PAGE_ERRORS}
        let hidden = false;
        Object.defineProperty(document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
        const messagesEl = document.querySelector('#messages');
        const currentTabId = 42, renderedTabId = 42, tabSwitchTransitionId = null;
        const historyRecoveryTabs = new Set(), tabChats = new Map(), tabChatHandoffGenerations = new Map([[42, 1]]);
        const tabChatHandoffOwnerId = 'owner';
        const chatHistoryRecordIdsByTab = new Map(), chatHistoryConversationIdsByTab = new Map(), chatHistoryCreatedAtByTab = new Map();
        const chatHistoryTabInfoByTab = new Map([[42, { url: 'https://example.com/' }]]), chatHistorySaveSeqByTab = new Map();
        const providerSelect = null, agentMode = 'ask';
        let historyPersistTimerTabId = null, saveSeq = 0;
        const hydrateChatHistoryIdentity = async () => {};
        const fallbackHistoryRecordId = () => 'previous';
        const extractChatHistoryMessages = () => [{ role: 'user', text: messagesEl.textContent }];
        const saveChatHistoryRecord = async record => {
          if (window.archiveFails) throw new Error('IndexedDB quota exceeded');
          window.archive = record; window.archivedHidden = hidden; return record;
        };
        const getChatHistoryRecord = async () => ({ messages: [{role:'user', text:'recovered dialog'}] });
        let persistTimer = null, persistTimerTabId = null, historyPersistTimer = null, currentAssistantEl = null;
        let lastVisibleTabChatSnapshot = { tabId: 42, html: 'old dialog' };
        const historyPopover = { hidePopover() {} };
        const sameTabId = (a,b) => a === b;
        const isTabProcessing = () => false, isConversationClearInProgress = () => false;
        const getTabInfoForHistory = async () => ({ url: 'https://example.com/' });
        const setConversationClearInProgress = () => {};
        const nextChatHistorySaveSeqForTab = id => { chatHistorySaveSeqByTab.set(id, ++saveSeq); return saveSeq; };
        const releaseRetryAttachmentsInTree = () => {}, clearRetryAttachmentsForTab = () => {};
        const setApiMutationsAllowedForTab = () => {}, clearPendingAttachmentsForTab = () => {};
        const clearQueuedComposerMessagesForTab = () => {}, resetComposerHistoryNavigation = () => {};
        const resetChatNavigation = () => {}, applyConversationScopeState = () => {}, setMode = () => {};
        const setComposerModePinForTab = () => {};
        const flushPendingStreamedAssistantMarkdownRenders = () => {}, historyRecoveryMetadata = () => ({});
        const t = value => value;
        const showComposerToast = message => { window.failure = message; };
        const enqueueTabChatOperation = (tabId, fn) => fn(tabId);
        const addMessage = (role,text,options={}) => { const el = document.createElement('div'); el.textContent = text; (options.root || messagesEl).append(el); return el; };
        const rebindRestoredMessageControls = () => {};
        const requestVisibleSidePanelStateRefresh = () => { window.refreshRequested = true; };
        ${extract(source, 'persistChatHistorySnapshot')}
        ${extract(source, 'flushChatHistorySnapshot')}
        let completeRecovery;
        const sendToBackground = async (action, payload) => {
          if (action === 'recover_chat_history') { window.recoveryCalls = (window.recoveryCalls || 0) + 1; window.candidateHtml = payload.html; if (window.loseResponse) { window.persisted = payload.html; throw new Error('Response channel lost after commit'); } return new Promise(resolve => completeRecovery = resolve); }
          if (action === 'persist_tab_chat') { window.persisted = payload.html; return { ok: true }; }
          throw new Error(action);
        };
        const chrome = { runtime: { onMessage: { addListener(fn) { window.handoff = fn; } } } };
        const browser = chrome;
        ${extract(source, 'waitForHistoryRecovery')}
        ${extract(source, 'persistTabChat')}
        ${extract(source, 'flushRenderedTabChat')}
        ${extract(source, 'createHistoryRecoveryTranscript')}
        ${extract(source, 'recoverHistoryRecord')}
        ${listener}
        window.finish = () => { window.persisted = window.candidateHtml; completeRecovery({ ok: true, conversationId: 'new-id', handoffGeneration: 2, html: window.candidateHtml }); };
        window.hide = () => { hidden = true; };
        window.recovery = recoverHistoryRecord('archive', 42, 'https://example.com/');
      ` });
      await page.waitForFunction(() => typeof window.finish === 'function');
      await page.evaluate(() => {
        window.hide();
        window.handoffPending = window.handoff({target:'sidepanel', action:'tab_chat_handoff_request', ownerId:'owner', tabId:42, generation:1}, {}, value => {window.ack = value;});
      });
      assert.equal(await page.evaluate(() => window.handoffPending), true);
      assert.equal(await page.evaluate(() => window.ack), undefined);
      await page.evaluate(async () => { window.finish(); await window.recovery; });
      await assertNoPageErrors();
      await page.waitForFunction(() => window.ack);
      assert.match(await page.evaluate(() => window.persisted), /recovered dialog/);
      assert.equal(await page.evaluate(() => window.ack.ok), false, 'An acknowledgement from the old generation cannot overwrite the committed transcript');
      await page.evaluate(() => window.handoff({target:'sidepanel', action:'tab_chat_handoff_request', ownerId:'owner', tabId:42, generation:2}, {}, value => {window.freshAck = value;}));
      assert.equal(await page.evaluate(() => window.freshAck.html), await page.evaluate(() => window.persisted));
      assert.equal(await page.evaluate(() => window.archivedHidden), true);
      assert.equal(await page.evaluate(() => window.archive.id), 'new-id');
      assert.equal(await page.evaluate(() => window.archive.messages[0].text), 'recovered dialog');
      assert.equal(await page.evaluate(() => window.failure), undefined);
      await page.evaluate(async () => {
        document.querySelector('#messages').textContent = 'unsaved current changes';
        window.archiveFails = true;
        await recoverHistoryRecord('archive', 42, 'https://example.com/');
      });
      assert.equal(await page.evaluate(() => window.recoveryCalls), 1, 'Archive failure must not call background recovery');
      assert.equal(await page.locator('#messages').textContent(), 'unsaved current changes');
      assert.equal(await page.evaluate(() => window.failure), 'sp.history.failed');
      await page.evaluate(async () => {
        delete window.failure;
        window.archiveFails = false;
        window.loseResponse = true;
        await recoverHistoryRecord('archive', 42, 'https://example.com/');
        window.cacheAfterLostResponse = { snapshot:lastVisibleTabChatSnapshot,
          id:chatHistoryConversationIdsByTab.get(42), html:tabChats.get(42), generation:tabChatHandoffGenerations.get(42) };
        window.handoff({target:'sidepanel', action:'tab_chat_handoff_request', ownerId:'owner', tabId:42, generation:3}, {}, value => window.lostResponseAck = value);
      });
      assert.equal(await page.evaluate(() => window.refreshRequested), true, 'Lost response reconciles from authoritative background state');
      assert.deepEqual(await page.evaluate(() => window.cacheAfterLostResponse), {snapshot:null, id:undefined, html:undefined, generation:undefined});
      assert.equal(await page.evaluate(() => window.lostResponseAck.ok), false);
      assert.equal(await page.evaluate(() => window.failure), undefined, 'An ambiguous response cannot report the committed recovery as failed');
      await assertNoPageErrors();
    } finally { await browser.close(); }
  });
}
