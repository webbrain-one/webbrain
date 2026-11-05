import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const unexport = source => source.replace(/^export /gm, '');

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: only fallback-safe Ask interruptions retain the partial and retry the same grounded request`, async () => {
    const source = read(build, 'src/agent/agent.js');
    const start = source.indexOf('    const chatMainTurnRaw = async (');
    const end = source.indexOf('\n    const chatMainTurn = async (', start);
    assert.ok(start >= 0 && end > start);
    const turn = source.slice(start, end);
    for (const [safe, code, emittedText] of [
      [true, 'transport_error', true],
      [true, 'missing_response_completed', true],
      [true, 'transport_error', false],
      [false, 'content_policy', true],
      [false, 'invalid_response', true],
    ]) {
      const updates = [], calls = [];
      const error = Object.assign(new Error(code), { code, isAskStreamFallbackSafe: safe });
      const messages = [{ role: 'system', content: 'Use only this selected text: selected source.' }, { role: 'user', content: 'Explain it.' }];
      const options = { tools: [], signal: { selectedTextOnly: true } };
      const requestContext = { tabId: 7, sourceGrounding: { kind: 'selected_text' } };
      const agent = {
        _interactiveAskStreamingDecision: () => ({ eligible: true, reason: 'eligible' }),
        _interactiveAskStreamingProtocol: () => 'responses',
        _interactiveAskStreamingFailure: () => ({ errorCode: code }),
        _isCostAllowanceError: () => false,
        _readCompletenessBlock: () => null,
        _shouldFallbackAskStream: value => value.isAskStreamFallbackSafe === true,
        async _chatStreamWithCostAllowance(_provider, passedMessages, passedOptions, _cost, passedContext, delta) {
          calls.push({ kind: 'stream', messages: passedMessages, options: passedOptions, context: passedContext });
          if (emittedText) delta('The selected text means');
          throw error;
        },
        async _chatWithCostAllowance(_provider, passedMessages, passedOptions, _cost, passedContext) {
          calls.push({ kind: 'retry', messages: passedMessages, options: passedOptions, context: passedContext });
          return { content: 'A complete explanation.', toolCalls: [] };
        },
        _logDebug() {},
      };
      const run = vm.runInNewContext(`(function () { let askStreamingDisabledForRun = false; ${turn}; return chatMainTurnRaw; }).call(agent)`, {
        agent, provider: {}, mode: 'ask', runOptions: { interactiveChat: true }, costState: {},
        recordAskStreaming() {}, onUpdate: (type, data) => updates.push({ type, data }),
      });
      if (safe) {
        assert.equal((await run(messages, options, requestContext)).content, 'A complete explanation.');
        assert.equal(updates.some(update => update.type === 'text' && update.data.replace), false);
        const retry = updates.find(update => update.type === 'response_retry');
        assert.equal(retry.data.reason, 'stream_interrupted');
        assert.equal(retry.data.retainPartial, emittedText);
        assert.equal(calls.length, 2);
        for (const call of calls) {
          assert.equal(call.messages, messages, 'Retry preserves the selected-text source boundary');
          assert.equal(call.options, options);
          assert.equal(call.context, requestContext);
        }
      } else {
        await assert.rejects(run(messages, options, requestContext), value => value === error);
        assert.equal(updates.some(update => update.type === 'response_retry'), false);
        assert.equal(updates.at(-1).type, 'text');
        assert.equal(updates.at(-1).data.content, '');
        assert.equal(updates.at(-1).data.replace, true);
        assert.equal(calls.length, 1);
      }
    }
  });

  test(`${build}: real message DOM preserves interrupted streams and replaces them cleanly`, async t => {
    const source = read(build, 'src/ui/sidepanel.js');
    const helperStart = source.indexOf('const ASSISTANT_RENDERABLE_ELEMENT_SELECTOR =');
    const observerStart = source.indexOf('const persistObserver =', helperStart);
    const observerEnd = source.indexOf('\n});', observerStart) + '\n});'.length;
    const observeCall = source.match(/persistObserver\.observe\(messagesEl, \{[^\n]+\}\);/)?.[0];
    assert.ok(observeCall);
    const functions = [
      'getStreamedAssistantText', 'hasStreamedAssistantText', 'clearStreamedAssistantText',
      'renderStreamedAssistantMarkdownNow', 'scheduleStreamedAssistantMarkdownRender',
      'flushPendingStreamedAssistantMarkdownRenders', 'markResponseIncomplete', 'beginResponseRetry',
      'finishResponseRetry', 'clearAssistantTextStreamState', 'renderAssistantTextUpdate',
      'isStoppedByUserStatus', 'looksLikeRawToolCallText', 'clearTransientAssistantTextForToolCall',
      'clearThinkingActivityTimers', 'setActivityText', 'showActivity', 'hideActivity',
      'startThinkingActivity', 'renderAgentErrorUpdate', 'handleAgentUpdateMessage',
      'roleFromMessageElement', 'normalizeHistoryText', 'extractChatHistoryMessages', 'formatMarkdown', 'isSuccessfulAskCompletion',
      'invalidateUnresolvedClarifyCards',
    ].map(name => extract(source, name)).join('\n');
    const hydration = extract(source, 'applyActiveRunState');
    const snapshotStart = hydration.indexOf('    let lastRenderedSeq =');
    const snapshotEnd = hydration.indexOf('    reconcileRunMessageAttachmentState(', snapshotStart);
    assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
    const send = extract(source, 'sendMessage');
    const responseStart = send.indexOf('    if (renderToCurrentTab && currentTabId === tabId && isTabAbortRequested(tabId))');
    const responseEnd = send.indexOf('\n  } catch (e) {', responseStart);
    assert.ok(responseStart >= 0 && responseEnd > responseStart);
    const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    const browser = await engine.launch({ headless: true });
    try {
      async function withPage(run) {
        const page = await browser.newPage({ viewport: { width: 460, height: 600 } });
        try {
          await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style><div id="activity"><span id="activity-text"></span></div><div id="live"></div><main id="messages"><div class="message user"><div class="message-content"><div class="message-text">Explain selected text.</div></div></div><div class="message assistant" data-run-request-id="request"><div class="message-content"><div class="message-text"></div></div></div></main>`);
          await page.addScriptTag({ content: `
            var messagesEl = document.querySelector('#messages');
            var currentAssistantEl = document.querySelector('.assistant'), currentTabId = 7, renderedTabId = 7;
            var localRunRequestIds = new Map([[7, 'request']]), clearedConversationRunRequestIds = new Set();
            var verboseMode = false, compactProgressVisible = true;
            var agentActivity = document.querySelector('#activity'), activityText = document.querySelector('#activity-text');
            var activityLiveStatus = document.querySelector('#live'), activityDisplayMode = 'idle', thinkingActivityTimer = null;
            var streamedAssistantTextByEl = new WeakMap(), streamedAssistantRenderFrameByEl = new WeakMap();
            var translations = ${JSON.stringify(english)}, errorMessages = [];
            function t(key) { return translations[key] || key; }
            function schedulePersist() {}
            function scrollToBottom() {}
            function scheduleMathRender() {}
            function parseCostAllowanceError() { return null; }
            function parseSubscribeError() { return null; }
            function updatesContainStoreReviewFailure(updates) { return (updates || []).some(update => update.type === 'error'); }
            function renderSubscribeError() { return false; }
            function renderCostAllowanceError() { return false; }
            function addMessageCopyButton() {}
            function ensureCurrentRunAssistant() { return currentAssistantEl; }
            function beginThinkingActivity() { showActivity('Thinking…'); }
            function hideInspectionBanner() {}
            function setCompactProgressVisible(value) { compactProgressVisible = value; }
            function markLastStepFailed() {}
            function setMessageCreatedAt() {}
            function finalizeSteps() {}
            function reconcileRunMessageAttachmentState() {}
            async function reconcilePersistedStagedScreenshots() {}
            function invalidatePlanReviewCards() {}
            function setPlanReviewAwaiting() {}
            function clearPlanReviewActiveRun() { hideActivity(); }
            function isPlanReviewTimeoutTerminal() { return false; }
            function isTabAbortRequested() { return false; }
            function holdQueuedComposerMessages() {}
            function formatErrorMessage(value) { return String(value); }
            function takeActiveRetryPayloadForError() { return {}; }
            function activeRetryPayloadForRequest() { return null; }
            function retryPayloadForRunAssistant() { return null; }
            function addMessage(role, value) {
              const node = document.createElement('div'); node.className = 'message ' + role;
              node.textContent = value; messagesEl.appendChild(node); errorMessages.push(value); return node;
            }
            function showComposerToast() {}
            function renderFailureRecoveryCard() {}
            function runUiUnavailableBeforeSeq() { return 0; }
            function addRunProgressReplayGapNote() {}
            function isTerminalRunUiStatus(status) { return ['completed', 'stopped', 'cancelled', 'failed'].includes(status); }
            function messageAttachmentMetadata() { return []; }
            function messageCreatedAt() { return 1; }
            ${unexport(read(build, 'src/ui/utils.js'))}
            ${unexport(read(build, 'src/ui/markdown-render.js'))}
            ${unexport(read(build, 'src/ui/markdown-link.js'))}
            ${unexport(read(build, 'src/ui/history-text.js'))}
            ${unexport(read(build, 'src/context-menu-storage.js'))}
            ${unexport(read(build, 'src/chat-history-recovery.js').replace(/^import .*;\n/gm, ''))}
            ${source.slice(helperStart, observerEnd)}
            ${functions}
            ${observeCall}
            function update(type, data = {}, seq) { handleAgentUpdateMessage({ tabId: 7, requestId: 'request', type, data, ...(seq ? { seq } : {}) }); }
            function hydrateSnapshot(runUi) {
              const runAssistantEl = currentAssistantEl, numericTabId = 7, requestId = 'request', state = {};
              ${hydration.slice(snapshotStart, snapshotEnd)}
            }
            function applyReturnedResponse(res) {
              const renderToCurrentTab = true, tabId = currentTabId, assistantEl = currentAssistantEl, modeForSend = 'ask', retryPayload = null;
              ${send.slice(responseStart, responseEnd)}
            }
          ` });
          await run(page);
        } finally { await page.close(); }
      }

      await t.test('partial stays visible during retry and the regenerated answer replaces it even in verbose mode', () => withPage(async page => {
        await page.evaluate(() => update('text_delta', { content: '**The selected text** means' }, 1));
        await page.waitForFunction(() => document.querySelector('.message-text strong'));
        assert.equal(await page.locator('#activity-text').textContent(), 'Generating answer…');
        await page.evaluate(() => {
          update('response_retry', { reason: 'stream_interrupted', retainPartial: true }, 2);
          update('warning', { code: 'ask_stream_fallback' }, 3);
          update('thinking', {}, 4);
        });
        assert.equal(await page.locator('.assistant .message-text').textContent(), 'The selected text means');
        assert.equal(await page.locator('.response-incomplete-note').textContent(), 'Incomplete response · retrying…');
        assert.equal(await page.locator('#activity-text').textContent(), 'Retrying response…');
        assert.notEqual(await page.locator('.assistant').evaluate(node => getComputedStyle(node).display), 'none');
        assert.deepEqual(await page.evaluate(() => extractChatHistoryMessages().map(message => message.role)), ['user']);
        await page.evaluate(() => { verboseMode = true; update('text', { content: 'A **complete explanation**.' }, 5); });
        assert.equal(await page.locator('.assistant .message-text').textContent(), 'A complete explanation.');
        assert.equal(await page.locator('.response-incomplete-note').count(), 0);
        assert.equal(await page.locator('.reasoning-step').count(), 0);
        assert.equal(await page.locator('.assistant').getAttribute('data-response-retrying'), null);
        assert.deepEqual(await page.evaluate(() => extractChatHistoryMessages().map(message => message.role)), ['user', 'assistant']);
      }));

      await t.test('cancel and errors settle the retry while retaining clearly incomplete prose', () => withPage(async page => {
        for (const status of ['stopped', 'failed']) {
          await page.evaluate(status => {
            currentAssistantEl.querySelector('.message-text').textContent = '';
            finishResponseRetry(currentAssistantEl, { completed: true });
            update('text_delta', { content: 'A useful partial explanation.' });
            update('response_retry', { reason: 'stream_interrupted', retainPartial: true });
            if (status === 'failed') update('error', { message: 'The response service is unavailable.' });
            else update('text', { content: '[Stopped by user]', replace: true });
            update('run_complete', { status, finalContent: status === 'stopped' ? '[Stopped by user]' : 'The response service is unavailable.' });
          }, status);
          assert.equal(await page.locator('.assistant .message-text').textContent(), 'A useful partial explanation.');
          assert.equal(await page.locator('.response-incomplete-note').textContent(), 'Incomplete response');
          assert.equal(await page.locator('.assistant').getAttribute('data-response-retrying'), null);
          assert.equal(await page.locator('.assistant .message-text').getAttribute('data-response-incomplete'), 'true');
          assert.equal(await page.evaluate(() => extractChatHistoryMessages().some(message => message.role === 'assistant')), false);
        }
      }));

      await t.test('explicit invalid-response resets still clear and a new streamed answer cannot concatenate retained text', () => withPage(async page => {
        await page.evaluate(() => {
          update('text_delta', { content: 'Interrupted attempt.' });
          update('response_retry', { reason: 'stream_interrupted', retainPartial: true });
          update('text', { content: '', replace: true });
        });
        assert.equal(await page.locator('.assistant .message-text').textContent(), '');
        assert.equal(await page.locator('.response-incomplete-note').count(), 0);
        await page.evaluate(() => {
          update('text_delta', { content: 'Another partial.' });
          update('response_retry', { reason: 'stream_interrupted', retainPartial: true });
          update('text_delta', { content: 'Fresh ' });
          update('text_delta', { content: 'answer.' });
        });
        await page.waitForFunction(() => currentAssistantEl.querySelector('.message-text').textContent === 'Fresh answer.');
        assert.equal(await page.locator('.response-incomplete-note').count(), 0);
        assert.equal(await page.locator('#activity-text').textContent(), 'Generating answer…');
      }));

      await t.test('the resolved sender response preserves failed partials and only successful regeneration replaces them', () => withPage(async page => {
        for (const status of ['failed', 'cancelled']) {
          await page.evaluate(status => {
            clearAssistantTextStreamState(currentAssistantEl);
            finishResponseRetry(currentAssistantEl, { completed: true });
            currentAssistantEl.querySelector('.message-text').textContent = '';
            update('text_delta', { content: 'Useful retained explanation.' });
            update('response_retry', { reason: 'stream_interrupted', retainPartial: true });
            const content = status === 'cancelled' ? '[Stopped by user]' : 'Response generation failed.';
            update('run_complete', { status, finalContent: content });
            applyReturnedResponse({ content, runSucceeded: false, updates: [{ type: 'error' }] });
          }, status);
          assert.equal(await page.locator('.assistant .message-text').textContent(), 'Useful retained explanation.', status);
          assert.equal(await page.locator('.response-incomplete-note').textContent(), 'Incomplete response', status);
          assert.equal(await page.evaluate(() => extractChatHistoryMessages().some(message => message.role === 'assistant')), false, status);
        }
        await page.evaluate(() => applyReturnedResponse({ content: 'Successfully regenerated answer.', runSucceeded: true, updates: [] }));
        assert.equal(await page.locator('.assistant .message-text').textContent(), 'Successfully regenerated answer.');
        assert.equal(await page.locator('.response-incomplete-note').count(), 0);
      }));

      await t.test('retry before the first token clears its state on new deltas, success, cancellation, or error', () => withPage(async page => {
        for (const outcome of ['delta', 'success', 'stopped', 'error']) {
          await page.evaluate(outcome => {
            clearAssistantTextStreamState(currentAssistantEl);
            currentAssistantEl.querySelector('.message-text').textContent = '';
            update('response_retry', { reason: 'stream_interrupted', retainPartial: false });
            if (outcome === 'delta') update('text_delta', { content: 'First token.' });
            if (outcome === 'success') update('run_complete', { status: 'completed', finalContent: 'Complete answer.' });
            if (outcome === 'stopped') update('run_complete', { status: 'stopped', finalContent: '[Stopped by user]' });
            if (outcome === 'error') update('error', { message: 'Temporary service error.' });
          }, outcome);
          assert.equal(await page.locator('.assistant').getAttribute('data-response-retrying'), null, outcome);
          assert.equal(await page.locator('.response-incomplete-note').count(), 0, outcome);
        }
      }));

      await t.test('acknowledged snapshots restore both retrying and settled partials, and normal streams use the generating label', () => withPage(async page => {
        for (const status of ['running', 'failed', 'stopped']) for (const replayable of [false, true]) {
          await page.evaluate(({ status, replayable }) => {
            messagesEl.querySelector('.assistant').remove();
            currentAssistantEl = document.createElement('div');
            currentAssistantEl.className = 'message assistant';
            currentAssistantEl.dataset.runRequestId = 'request';
            currentAssistantEl.innerHTML = '<div class="message-content"><div class="message-text"></div></div>';
            messagesEl.appendChild(currentAssistantEl);
            const events = replayable ? [
              { seq: 1, type: 'text_delta', data: { content: 'Restored partial.' } },
              { seq: 4, type: 'response_retry', data: { reason: 'stream_interrupted', retainPartial: true } },
              ...(status === 'failed' ? [{ seq: 7, type: 'error', data: { message: 'Retry failed.' } }] : []),
              ...(status !== 'running' ? [{ seq: 8, type: 'run_complete', data: { status, finalContent: status === 'stopped' ? '[Stopped by user]' : 'Retry failed.' } }] : []),
            ] : [];
            hydrateSnapshot({ requestId: 'request', status, seq: 8, events, streamedText: 'Restored partial.', streamedTextStartSeq: 1, streamedTextSeq: 3, responseIncomplete: true,
              responseRetry: status === 'running' ? { reason: 'stream_interrupted', retainPartial: true, seq: 4 } : null });
            if (status !== 'running') update('run_complete', { status, finalContent: 'Retry failed.' }, 8);
          }, { status, replayable });
          assert.equal(await page.locator('.assistant .message-text').textContent(), 'Restored partial.', status);
          assert.equal(await page.locator('.response-incomplete-note').textContent(), status === 'running' ? 'Incomplete response · retrying…' : 'Incomplete response', status);
          assert.equal(await page.evaluate(() => extractChatHistoryMessages().some(message => message.role === 'assistant')), false, status);
        }
        await page.evaluate(() => {
          hydrateSnapshot({ requestId: 'request', status: 'running', seq: 9, events: [], streamedText: 'Fresh restored answer.', streamedTextStartSeq: 9, streamedTextSeq: 9, responseRetry: null, responseIncomplete: false });
        });
        assert.equal(await page.locator('.assistant .message-text').textContent(), 'Fresh restored answer.');
        assert.equal(await page.locator('.response-incomplete-note').count(), 0);
        assert.equal(await page.locator('#activity-text').textContent(), 'Generating answer…');
      }));
    } finally { await browser.close(); }
  });
}
