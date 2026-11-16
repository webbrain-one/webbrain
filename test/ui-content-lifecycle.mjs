import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium, firefox } from 'playwright';

// Real production functions, controlled asynchronous boundaries, and native DOM
// fixtures. No external page or account is opened by this suite.
const read = (build, path) => fs.readFileSync(new URL(`../src/${build}/src/${path}`, import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
function extract(source, name, indent = '') {
  const start = source.search(new RegExp(`^${indent}(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `production function ${name} exists`);
  const end = source.indexOf(`\n${indent}}`, start);
  assert.ok(end > start);
  return source.slice(start, end + indent.length + 2);
}
// A private content-script constant, single- or multi-line, exactly as written.
function extractConst(source, name, indent = '  ') {
  const declaration = source.match(new RegExp(`^${indent}const ${name} = [\\s\\S]*?;$`, 'm'))?.[0];
  assert.ok(declaration, `production constant ${name} exists`);
  return declaration;
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let checked = 0;
function panelHarness(build) {
  const pending = new Map();
  const loads = new Map();
  const restored = [];
  const handledUpdates = [];
  const context = {
    currentTabId: 1, renderedTabId: 1, tabSwitchGeneration: 0, document: { visibilityState: 'visible' },
    tabSwitchTransitionId: null, queuedTabSwitchMessages: [],
    newConversationConfirmationState: null, visibleStateRefreshPending: false,
    currentAssistantEl: null, historyPopover: null, newtabHandoff: { consume: async () => {} },
    waitForHistoryRecovery: async () => {}, TAB_CHAT_LOAD_FAILED: Symbol('load-failed'),
    messagesEl: { innerHTML: 'tab 1', querySelectorAll: () => [] },
    sendToBackground: (_action, { tabId }) => {
      const request = deferred(); pending.set(tabId, request); return request.promise;
    },
    loadTabChat: async tabId => loads.has(tabId) ? await loads.get(tabId).promise : `tab ${tabId}`,
    restoreActiveRunState: async tabId => { restored.push(tabId); },
    researchEscalationSourceTabIdFromState: state => state?.sourceTabId ?? null,
    sameTabId: (a, b) => a === b,
    isTabProcessing: () => false,
    handleAgentUpdateMessage: message => handledUpdates.push(message),
    consumePendingContextMenuPrompt: async () => {},
  };
  for (const name of [
    'syncSendButtonState', 'dismissSelectionAskAction', 'settleNewConversationConfirmation',
    'hideActivity', 'flushRenderedTabChat', 'flushChatHistorySnapshot', 'captureInputDraftForTab',
    'resetChatNavigation', 'syncCurrentTabRunFlags', 'syncApiMutationsAllowedForCurrentTab',
    'syncSelectionScopeUi', 'hydrateRestoredChatHistory', 'migrateLegacyEmptyStateFromRestoredChat',
    'rebindRestoredMessageControls', 'refreshRenderedStepLabels', 'syncProgressDisplayMode', 'restoreInputDraftForTab',
    'renderAttachmentPreviews', 'renderQueuedComposerMessages', 'restoreLatestChatTurnPosition',
    'closePermissionSkipDialog', 'restoreComposerModeForCurrentTab',
    'refreshScheduledJobs', 'refreshRecommendedActions', 'drainQueuedAgentUpdatesForTab',
    'drainQueuedPromptsAfterRunSettles', 'requestVisibleSidePanelStateRefresh', 'waitForTabChatHandoffRetry',
  ]) context[name] = () => {};
  vm.createContext(context);
  for (const name of ['switchToTab', 'queueAgentUpdateDuringTabSwitch', 'drainQueuedAgentUpdatesForTab']) {
    vm.runInContext(extract(read(build, 'ui/sidepanel.js'), name), context);
  }
  return { context, pending, loads, restored, handledUpdates, switchToTab: context.switchToTab };
}

if (!process.argv.includes('--dom')) for (const build of ['chrome', 'firefox']) {
  {
    const h = panelHarness(build);
    const toB = h.switchToTab(2);
    await tick();
    assert.equal(h.context.tabSwitchTransitionId, 2, 'preflight blocks sending to the outgoing tab');
    await h.switchToTab(1);
    h.pending.get(2).resolve({});
    await toB;
    assert.equal(h.context.currentTabId, 1, `${build}: A → B → A keeps A authoritative`);
    assert.equal(h.context.renderedTabId, 1);
    assert.equal(h.context.messagesEl.innerHTML, 'tab 1');
    assert.equal(h.context.tabSwitchTransitionId, null);
    assert.deepEqual(h.restored, [1], 'interrupted current-tab run updates are restored');
    checked++;
  }
  {
    const h = panelHarness(build);
    const toB = h.switchToTab(2);
    await tick();
    const toC = h.switchToTab(3);
    await tick();
    const loadC = deferred(); h.loads.set(3, loadC);
    h.pending.get(3).resolve({});
    await tick();
    assert.equal(h.context.currentTabId, 3);
    h.pending.get(2).resolve({});
    await toB;
    assert.equal(h.context.tabSwitchTransitionId, 3, 'stale finally cannot unlock a newer restore');
    loadC.resolve('tab 3');
    await toC;
    assert.equal(h.context.renderedTabId, 3);
    assert.equal(h.context.messagesEl.innerHTML, 'tab 3');
    assert.equal(h.context.tabSwitchTransitionId, null);
    checked++;
  }
  {
    const h = panelHarness(build);
    const toB = h.switchToTab(2);
    await tick();
    await h.switchToTab(1);
    h.pending.get(2).reject(new Error('worker unavailable'));
    await toB;
    assert.equal(h.context.currentTabId, 1, 'failed old lookup also remains cancelled');
    assert.equal(h.context.tabSwitchTransitionId, null);
    checked++;
  }
  {
    const h = panelHarness(build);
    const toResearchTab = h.switchToTab(2);
    await tick();
    h.pending.get(2).resolve({ sourceTabId: 1 });
    await toResearchTab;
    assert.equal(h.context.currentTabId, 1);
    assert.equal(h.context.tabSwitchTransitionId, null, 'research-tab veto releases the transition');
    assert.deepEqual(h.restored, [1]);
    checked++;
  }
  {
    const h = panelHarness(build);
    const restore = deferred();
    h.context.restoreActiveRunState = async () => restore.promise;
    const toResearchTab = h.switchToTab(2);
    await tick();
    h.pending.get(2).resolve({ sourceTabId: 1 });
    await tick();
    assert.equal(h.context.tabSwitchTransitionId, 1, 'retained source owns in-flight update queue');
    const event = { tabId: 1, seq: 7, type: 'text', data: { content: 'New source update' } };
    assert.equal(h.context.queueAgentUpdateDuringTabSwitch(event), true);
    assert.deepEqual(h.handledUpdates, []);
    restore.resolve();
    await toResearchTab;
    assert.deepEqual(h.handledUpdates, [event], 'source events newer than restore snapshot are replayed');
    assert.equal(h.context.tabSwitchTransitionId, null);
    checked++;
  }
  {
    const h = panelHarness(build);
    let abortRequested = true;
    let thinking = 0;
    let recoveryReads = 0;
    const activity = [];
    const assistant = { dataset: {}, isConnected: true, querySelector: () => null, querySelectorAll: () => [] };
    Object.assign(h.context, {
      isConversationClearInProgress: () => false,
      clearedConversationRunRequestIds: new Set(),
      cancelledRunRecoveryRequestIds: new Set(['request-a']),
      localRunRequestIds: new Map(), adoptedRunRecoveryRequestIds: new Set(),
      submittedClarificationIds: new Set(),
      isTabAbortRequested: () => abortRequested,
      setTabAbortRequested: (_tab, value) => { abortRequested = value; },
      setTabProcessing: () => {}, hideRecommendedActions: () => {},
      startThinkingActivity: () => { thinking++; }, showActivity: value => activity.push(value),
      t: key => key, CSS: { escape: value => value },
      isTerminalRunUiStatus: status => ['completed', 'stopped', 'failed', 'cancelled'].includes(status),
      runUiUnavailableBeforeSeq: () => 0,
      reconcileRunMessageAttachmentState: () => {},
      reconcilePersistedStagedScreenshots: async () => {},
      invalidatePlanReviewCards: () => {},
      sendRunWithReconnect: async () => { throw new Error('Cancelled run must not be re-adopted'); },
      sendToBackground: async () => { recoveryReads++; throw new Error('Pending Stop must not request clarification recovery or acknowledge it'); },
    });
    h.context.messagesEl.querySelector = () => assistant;
    for (const name of ['clarificationSubmissionKey', 'invalidateUnresolvedClarifyCards',
      'restorePendingCurrentClarification', 'applyActiveRunState', 'adoptRestoredRunState']) {
      vm.runInContext(extract(read(build, 'ui/sidepanel.js'), name), h.context);
    }
    const state = { running: true, pendingCurrentClarification: null,
      runUi: { requestId: 'request-a', status: 'running', seq: 0, ackedSeq: 0 } };
    await h.context.applyActiveRunState(1, state);
    assert.equal(abortRequested, true, 'restoring same request cannot consume pending Stop');
    assert.equal(thinking, 0);
    assert.equal(recoveryReads, 0, 'pending Stop prevents live-question recovery and replay acknowledgement');
    assert.deepEqual(activity, ['sp.activity.stopping']);
    await h.context.adoptRestoredRunState(1, state);
    assert.equal(h.context.adoptedRunRecoveryRequestIds.size, 0, 'cancelled recovery never starts again');
    checked++;
  }
  {
    const h = panelHarness(build);
    const { createSidePanelWindowScope } = await import(`../src/${build}/src/ui/sidepanel-window-scope.js`);
    let activeTabId = 1;
    const scope = createSidePanelWindowScope({
      initialWindowId: 10,
      browserApi: {
        windows: { getCurrent: async () => ({ id: 10 }) },
        tabs: { query: async () => [{ id: activeTabId, windowId: 10 }] },
      },
      getCurrentTabId: () => h.context.currentTabId,
      getRenderedTabId: () => h.context.renderedTabId,
      switchToTab: h.switchToTab,
    });
    activeTabId = 2;
    const toB = scope.handleActivated({ tabId: 2, windowId: 10 });
    await tick();
    activeTabId = 1;
    await scope.handleActivated({ tabId: 1, windowId: 10 });
    h.pending.get(2).resolve({});
    await toB;
    assert.equal(h.context.currentTabId, 1, 'real window-scope caller preserves latest tab intent');
    checked++;
  }
}

if (process.argv.includes('--dom')) for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const build of ['chrome', 'firefox']) {
      const source = read(build, 'content/content.js');
      const ownInputScope = source.match(/^  let _messageRecipientOwnedInputScope = null;$/m)?.[0];
      assert.ok(ownInputScope, 'Use the real private production owned-input scope');
      const caretReceipts = source.match(/^  const _nativeChatEmptyCaretReceipts = new WeakMap\(\);$/m)?.[0];
      assert.ok(caretReceipts, 'Use the real private production native-chat caret state');
      const settleDelay = source.match(/^  const SET_FIELD_VERIFY_DELAY_MS = \d+;$/m)?.[0];
      assert.ok(settleDelay, 'Use the production page-handler render delay');
      // _typeTextInner also prepares focus through the page monitor, refuses a
      // truncated preview of the field's own value, and routes native date
      // inputs; use the real helpers and the constants they read.
      const constants = ['TRUNCATED_PREVIEW_MIN_PREFIX', 'TRUNCATED_PREVIEW_MIN_HIDDEN', 'TRUNCATED_PREVIEW_MARKERS', '_NATIVE_DATE_INPUT_FORMATS']
        .map(name => extractConst(source, name));
      const functions = [ownInputScope, caretReceipts, settleDelay, ...constants].join('\n') + '\n' + [
        'readProseMirrorText', 'readCodeMirrorText', 'readEmptyCaretText', 'isDraftJsEditor', 'isModelManagedEditor', 'readDraftJsText',
        '_nativeChatCaretContext', '_sameNativeChatCaretContext', '_singleEditableCaretBreak',
        '_rememberNativeChatEmptyCaret', '_nativeChatCaretValueIsEmpty', '_editableTextValue',
        '_insertContentEditableText', '_withTypingPreparation', '_nativeDateInputType',
        '_truncatedPreviewReplacement', '_truncatedPreviewValueFailure', '_truncatedPreviewReplacementFailure', '_typeTextInner',
        ...(build === 'firefox' ? ['_isTypeableElement', '_isDisabledEditable', '_isTextTypeableInput'] : []),
      ].map(name => extract(source, name, '  ')).join('\n');
      const setup = async (html, behavior = '', paragraphEditor = false) => {
        await page.goto('about:blank');
        await page.setContent(`<main><div id="editor" contenteditable="true"${paragraphEditor ? ' class="ProseMirror"' : ''}>${html}</div><input id="other"><div id="other-editor" contenteditable="true">Untouched</div></main>`);
        await page.evaluate(({ functions, behavior }) => {
          window.typeIntoEditor = Function(`
            const _richTextToolbarExactInsertion = (before, after, inserted) => after === before + inserted;
            const safeIndexedQuerySelector = selector => ({element: document.querySelector(selector)});
            const _consumeDispatchBinding = () => true;
            const showAgentWorkingTarget = () => {};
            const _fieldMeta = () => ({contentEditable:true});
            ${functions}
            return params => _typeTextInner({selector:'#editor', ...params});
          `)();
          window.originalHtml = document.getElementById('editor').innerHTML;
          window.originalNodes = [...document.querySelectorAll('#editor *')];
          window.events = [];
          const editor = document.getElementById('editor');
          editor.addEventListener('beforeinput', event => {
            window.events.push({ type: event.type, html: editor.innerHTML, inputType: event.inputType });
            if (behavior === 'cancel') event.preventDefault();
            if (behavior === 'retarget') document.getElementById('other').focus();
            if (behavior === 'editor-handles') {
              event.preventDefault();
              editor.append('handled');
            }
          });
          editor.addEventListener('input', event => {
            window.events.push({ type: event.type, html: editor.innerHTML, inputType: event.inputType });
            if (behavior === 'restore-deletion' && event.inputType.startsWith('delete')) editor.innerHTML = 'Restored';
            if (behavior === 'retarget-after-delete' && event.inputType.startsWith('delete')) setTimeout(() => {
              const range = document.createRange();
              range.selectNodeContents(document.getElementById('other-editor'));
              range.collapse(false);
              const selection = getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            }, 0);
            if (behavior === 'revert-insertion') editor.textContent = 'Reverted';
          });
        }, { functions, behavior });
      };
      const type = params => page.evaluate(params => window.typeIntoEditor(params), params);
      await setup('<p>Hello <strong>bold</strong> <a href="#kept">link</a></p><p><span contenteditable="false">@mention</span> tail</p>');
      const appended = await type({ text: ' added' });
      assert.equal(appended.success, true, `${engineName}/${build}: ${JSON.stringify(appended)}; ${await page.locator('#editor').innerHTML()}`);
      assert.equal(appended.verified, true);
      const structure = await page.evaluate(() => ({
        allNodesRetained: window.originalNodes.every(node => document.getElementById('editor').contains(node)),
        firstGateHtml: window.events[0]?.html,
        originalHtml: window.originalHtml,
        text: document.getElementById('editor').innerText,
      }));
      assert.equal(structure.allNodesRetained, true, 'native append retains paragraphs, formatting, links and mentions');
      assert.equal(structure.firstGateHtml, structure.originalHtml, 'beforeinput sees original markup');
      assert.ok(structure.text.endsWith('tail added'));
      checked++;

      await setup('<p>Original <strong>format</strong></p>', 'cancel');
      const cancelled = await type({ text: 'replacement', clear: true });
      assert.equal(cancelled.success, false);
      assert.equal(cancelled.noDispatch, true);
      assert.equal(cancelled.cancelled, true);
      assert.equal(await page.locator('#editor').innerHTML(), '<p>Original <strong>format</strong></p>');
      assert.equal(await page.evaluate(() => window.events.some(event => event.type === 'input')), false);
      checked++;

      // A model-owned document must reach trusted input without a DOM edit.
      await setup('<p>Original <strong>format</strong></p>', '', true);
      const replacement = await type({ text: 'New\ntext', clear: true });
      assert.equal(replacement.success, false, `${engineName}/${build}: ${JSON.stringify(replacement)}`);
      assert.equal(replacement.noDispatch, true);
      assert.equal(replacement.trustedTypeRequired, true);
      const gates = await page.evaluate(() => window.events.filter(event => event.type === 'beforeinput'));
      assert.equal(gates.length, 0);
      assert.equal(await page.locator('#editor').innerHTML(), '<p>Original <strong>format</strong></p>');
      checked++;

      for (const text of [' leading  middle trailing ', 'a\n\nb\n', '\n']) {
        await setup('Original');
        const whitespace = await type({ text, clear: true });
        assert.equal(whitespace.success, true, `${engineName}/${build}: ${JSON.stringify(text)} ${JSON.stringify(whitespace)}; ${await page.locator('#editor').innerHTML()}`);
        checked++;
      }

      await setup('<img alt="embedded image"><span contenteditable="false"></span>');
      const imageReplacement = await type({ text: 'Replacement', clear: true });
      assert.equal(imageReplacement.success, true, `${engineName}/${build}: clear image-only editor`);
      assert.equal(await page.locator('#editor img, #editor [contenteditable="false"]').count(), 0);
      checked++;

      await setup('<p>Original</p>', 'restore-deletion', true);
      const restored = await type({ text: 'Never inserted', clear: true });
      assert.equal(restored.success, false);
      assert.equal(restored.noDispatch, true);
      assert.equal(await page.locator('#editor').innerText(), 'Original');
      assert.equal(await page.evaluate(() => window.events.some(event => event.inputType === 'insertText')), false);
      checked++;

      await setup('<p>Original</p>', 'retarget-after-delete', true);
      const movedAfterDelete = await type({ text: 'Never inserted', clear: true });
      assert.equal(movedAfterDelete.success, false);
      assert.equal(movedAfterDelete.noDispatch, true, 'model-owned nodes are untouched before trusted input');
      assert.equal(await page.locator('#other-editor').innerText(), 'Untouched');
      assert.equal(await page.evaluate(() => window.events.some(event => event.inputType === 'insertText')), false);
      checked++;

      await setup('Original', 'retarget');
      const retargeted = await type({ text: 'Never inserted' });
      assert.equal(retargeted.success, false);
      assert.equal(await page.locator('#editor').innerText(), 'Original');
      assert.equal(await page.locator('#other').inputValue(), '');
      checked++;

      await setup('Original', 'editor-handles');
      const handled = await type({ text: 'Must not duplicate' });
      assert.equal(handled.success, false);
      assert.equal(handled.mutationMayHaveOccurred, true);
      assert.equal(await page.locator('#editor').innerText(), 'Originalhandled');
      checked++;

      await setup('Original', 'revert-insertion');
      const reverted = await type({ text: ' added' });
      assert.equal(reverted.success, false, 'editor model rejection must not return successful text entry');
      assert.equal(reverted.verified, false);
      assert.equal(reverted.mutationMayHaveOccurred, true);
      checked++;

      await setup('<p>Original <a href="#link">link</a></p>');
      await page.evaluate(() => { document.execCommand = () => { throw new Error('unsupported'); }; });
      const unsupported = await type({ text: ' added' });
      assert.equal(unsupported.success, false);
      assert.equal(await page.locator('#editor').innerHTML(), '<p>Original <a href="#link">link</a></p>', 'no flattening fallback');
      checked++;
    }
  } finally {
    await browser.close();
  }
}
console.log(`${checked} UI/content lifecycle checks passed`);
