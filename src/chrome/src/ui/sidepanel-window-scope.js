function sameTabId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/**
 * Keep one side-panel document scoped to the browser window that currently
 * contains it. Tab activation events are extension-wide, and a browser can keep
 * the same panel document alive while its tab/group is dragged to a different
 * window, so a window ID captured once at startup eventually becomes stale.
 */
export function createSidePanelWindowScope({
  browserApi,
  initialWindowId = null,
  getCurrentTabId,
  getRenderedTabId,
  switchToTab,
  settleWindowTransfer = () => new Promise(resolve => setTimeout(resolve, 0)),
}) {
  let ownWindowId = initialWindowId;
  let tabTransfer = null;
  let syncGeneration = 0;

  async function refreshOwnWindowId() {
    try {
      const ownWindow = await browserApi.windows.getCurrent();
      if (ownWindow?.id != null) ownWindowId = ownWindow.id;
    } catch {
      // Keep the last confirmed ID. A transient windows API failure should
      // not make an unrelated window eligible to control this panel.
    }
    return ownWindowId;
  }

  async function syncActiveTab({ expectedWindowId = null, expectedTabId = null } = {}) {
    const windowId = await refreshOwnWindowId();
    if (windowId == null) return null;
    if (expectedWindowId != null && expectedWindowId !== windowId) return null;
    // Only a confirmed event from this panel's window supersedes an older
    // in-flight sync. Noise from another browser window must not cancel it.
    const generation = ++syncGeneration;

    let activeTab = null;
    try {
      [activeTab] = await browserApi.tabs.query({ active: true, windowId });
    } catch {
      return null;
    }
    if (generation !== syncGeneration || !activeTab?.id) return null;
    if (activeTab.windowId != null && activeTab.windowId !== windowId) return null;
    if (expectedTabId != null && !sameTabId(activeTab.id, expectedTabId)) return null;

    await switchToTab(activeTab.id);
    return activeTab;
  }

  function handleDetached(tabId, detachInfo = {}) {
    if (!sameTabId(tabId, getCurrentTabId()) && !sameTabId(tabId, getRenderedTabId())) {
      return false;
    }
    tabTransfer = {
      tabId,
      oldWindowId: detachInfo.oldWindowId ?? ownWindowId,
    };
    // The cached owner is intentionally invalid during transfer. If the live
    // windows lookup fails after attach, fail closed instead of falling back
    // to the window the panel just left.
    ownWindowId = null;
    // Invalidate an activation lookup that may have started just before the
    // detach event. Its result belongs to the window the panel is leaving.
    syncGeneration += 1;
    return true;
  }

  async function handleAttached(tabId) {
    if (!tabTransfer || !sameTabId(tabId, tabTransfer.tabId)) return null;
    const transfer = tabTransfer;
    // Let the browser finish reparenting the side-panel document before
    // asking getCurrent() where it lives. During this turn, old-window
    // activation events remain suppressed by tabTransfer.
    await settleWindowTransfer();
    if (tabTransfer !== transfer) return null;
    tabTransfer = null;
    // getCurrent() tells us whether the browser moved this panel document with
    // the tab or kept it in the old window. Follow the actual panel location.
    return await syncActiveTab();
  }

  async function handleActivated(info = {}) {
    if (tabTransfer && info.windowId === tabTransfer.oldWindowId) return null;
    return await syncActiveTab({
      expectedWindowId: info.windowId,
      expectedTabId: info.tabId,
    });
  }

  async function handleFocusChanged(windowId, windowIdNone) {
    if (windowId === windowIdNone) return null;
    if (tabTransfer && windowId === tabTransfer.oldWindowId) return null;
    return await syncActiveTab({ expectedWindowId: windowId });
  }

  return {
    syncActiveTab,
    handleDetached,
    handleAttached,
    handleActivated,
    handleFocusChanged,
  };
}
