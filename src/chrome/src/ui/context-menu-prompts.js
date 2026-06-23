/**
 * Context-menu prompt handling shared between Chrome and Firefox sidepanel.js.
 * The Chrome and Firefox copies of this file are identical — edit both together.
 */

export function createContextMenuPromptHandler({
  getCurrentTabId,
  getIsProcessing,
  getAgentMode,
  setMode,
  getInputEl,
  autoResizeInput,
  sendMessage,
  sendToBackground,
}) {
  const handledContextMenuPromptIds = new Set();
  const deferredContextMenuPrompts = [];
  const queuedContextMenuPrompts = [];

  function normalizeContextMenuPromptPayload(raw) {
    const payload = raw?.prompt || raw;
    const text = String(payload?.text || '').trim();
    if (!text) return null;
    const numericTabId = payload?.tabId == null ? null : Number(payload.tabId);
    const tabId = Number.isFinite(numericTabId) ? numericTabId : null;
    const id = payload?.id
      ? String(payload.id)
      : `ctx-${tabId ?? 'unknown'}-${payload?.createdAt || Date.now()}-${text.length}`;
    return { id, tabId, text };
  }

  function contextMenuPromptMatchesCurrentTab(payload) {
    const currentTabId = getCurrentTabId();
    return payload?.tabId == null || currentTabId == null || Number(payload.tabId) === Number(currentTabId);
  }

  function acceptContextMenuPrompt(rawPayload) {
    const payload = normalizeContextMenuPromptPayload(rawPayload);
    if (!payload) return;
    if (getCurrentTabId() == null) {
      deferredContextMenuPrompts.push(payload);
      return;
    }
    if (handledContextMenuPromptIds.has(payload.id)) return;
    handledContextMenuPromptIds.add(payload.id);

    // Queue prompts that belong to a different tab or arrive while busy.
    // drainQueuedContextMenuPrompts picks them up on tab switch or run completion.
    if (!contextMenuPromptMatchesCurrentTab(payload) || getIsProcessing()) {
      queuedContextMenuPrompts.push(payload);
      return;
    }
    runContextMenuPrompt(payload);
  }

  function flushDeferredContextMenuPrompts() {
    if (getCurrentTabId() == null || deferredContextMenuPrompts.length === 0) return;
    const deferred = deferredContextMenuPrompts.splice(0);
    for (const payload of deferred) acceptContextMenuPrompt(payload);
  }

  function drainQueuedContextMenuPrompts() {
    if (getCurrentTabId() == null || getIsProcessing()) return;
    flushDeferredContextMenuPrompts();
    if (getIsProcessing() || queuedContextMenuPrompts.length === 0) return;

    // Find first queued prompt that belongs to the currently active tab and run it.
    // Non-matching entries stay in the queue for when the user returns to that tab.
    const idx = queuedContextMenuPrompts.findIndex(p => contextMenuPromptMatchesCurrentTab(p));
    if (idx !== -1) {
      const [payload] = queuedContextMenuPrompts.splice(idx, 1);
      runContextMenuPrompt(payload);
    }
  }

  async function runContextMenuPrompt(payload) {
    if (!payload?.text) return;
    if (getIsProcessing()) {
      queuedContextMenuPrompts.push(payload);
      return;
    }

    const currentTabId = getCurrentTabId();
    const clearPayload = { tabId: payload.tabId ?? currentTabId, promptId: payload.id };

    if (getAgentMode() !== 'ask') setMode('ask');
    getInputEl().value = payload.text;
    getInputEl().dispatchEvent(new Event('input', { bubbles: true }));
    autoResizeInput();

    // Pass clearPayload to sendMessage() so the background can clear storage
    // immediately when it starts the run — after receiving the request (so a
    // pre-acceptance crash preserves the prompt) but before the agent loop
    // (so a mid-run panel close does not replay it on reopen).
    const accepted = await sendMessage({ contextMenuClear: clearPayload });
    if (!accepted) {
      queuedContextMenuPrompts.push(payload);
    }
  }

  async function consumePendingContextMenuPrompt() {
    const currentTabId = getCurrentTabId();
    if (currentTabId == null) return;
    try {
      const res = await sendToBackground('consume_context_menu_prompt', { tabId: currentTabId });
      if (res?.prompt) acceptContextMenuPrompt(res.prompt);
    } catch { /* best effort */ }
  }

  // Called when the background reports that a tab navigated to a new URL.
  // Drops any in-panel queued/deferred prompts for that tab so they aren't
  // submitted against the wrong page.
  function clearQueuedForTab(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return;
    const keep = (p) => Number(p.tabId) !== numericTabId;
    queuedContextMenuPrompts.splice(0, queuedContextMenuPrompts.length,
      ...queuedContextMenuPrompts.filter(keep));
    deferredContextMenuPrompts.splice(0, deferredContextMenuPrompts.length,
      ...deferredContextMenuPrompts.filter(keep));
  }

  return {
    acceptContextMenuPrompt,
    drainQueuedContextMenuPrompts,
    consumePendingContextMenuPrompt,
    clearQueuedForTab,
  };
}
