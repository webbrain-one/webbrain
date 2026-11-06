/* global chrome, browser */
/**
 * New tab -> WebBrain hand-off.
 *
 * - Act opens the side panel next to this tab (submitTask): the agent works on the
 *   page the tab goes on to show, so the panel has to stay beside it.
 * - Ask turns this tab into WebBrain's full-page chat (openAskChat). A new tab has no
 *   page for a side panel to sit beside, so the chat takes the whole tab instead; Back
 *   returns to the new tab.
 *
 * Either way the task is passed through extension storage (not a runtime message)
 * because the receiving page is usually not loaded yet when the user submits. It reads
 * it on start-up (ui/newtab-handoff.js in each extension), checks it is fresh and
 * addressed to its own tab, and then:
 *   - Ask and Act: fills the composer and sends straight away, pinned to the chosen
 *     mode. Act therefore starts acting without a further confirmation (Plan before Act
 *     still applies when it is on, and the box warns about it before the user submits);
 *     if Act is not allowed for the panel's current provider or scope, the text is left
 *     in the composer, unsent.
 */
// One key per tab, so concurrent submissions from several new tab pages can never
// overwrite each other. Mirrors src/*/src/ui/newtab-handoff.js (checked in test/newtab.mjs).
export const HANDOFF_PREFIX = 'wbNewtabHandoff:';
export const handoffKey = (tabId) => `${HANDOFF_PREFIX}${tabId}`;
export const MAX_TASK_LENGTH = 4000;

const hasFirefoxSidebar = () =>
  typeof browser !== 'undefined' && typeof browser?.sidebarAction?.open === 'function';

const extApi = () => {
  if (hasFirefoxSidebar()) return browser;
  return typeof chrome !== 'undefined' && chrome?.runtime?.id ? chrome : null;
};

// sidePanel.open() must run inside the click's synchronous turn, so the tab id
// has to be known before the user submits.
let currentTab = null;
export async function primeCurrentTab() {
  let tab = null;
  try {
    tab = (await extApi()?.tabs?.getCurrent?.()) ?? null;
  } catch {
    tab = null;
  }
  // A reload empties the in-memory lock while an earlier task may still be waiting for a
  // cold panel, so pick it up again from storage; otherwise the next submit would replace it.
  // The tab is published only afterwards, so no submit can run in between (submitTask
  // rejects while there is no tab).
  if (tab?.id != null) await adoptPendingHandoff(extApi(), tab.id);
  currentTab = tab;
  return currentTab;
}

export function buildHandoff({ text, mode, tabId, now = Date.now() }) {
  return {
    id: `nt-${now}-${Math.random().toString(36).slice(2, 8)}`,
    tabId,
    text: String(text).slice(0, MAX_TASK_LENGTH),
    mode: mode === 'act' ? 'act' : 'ask',
    createdAt: now,
  };
}

// A new tab page is the only writer of its tab's hand-off key, so remembering here
// that one is still waiting is enough to stop a second submit from replacing it
// while a cold side panel is still starting up. The lock is taken synchronously at
// submit time (before the write or the panel-open settle) and released when the
// panel has claimed the task, the submit failed, or CLAIM_TIMEOUT_MS passed.
// Must outlast the panel's longest accepted record age (30 s + up to 120 s of its own
// startup, see src/*/src/ui/newtab-handoff.js), or a second submit could replace a
// task the panel would still accept.
const CLAIM_TIMEOUT_MS = 160_000;
const inFlight = new Map(); // tabId -> { promise, release }

function lockTab(tabId, text = '') {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  // `claimed` is false only when the wait ran out without the panel ever taking the task.
  const release = (claimed = true) => {
    if (inFlight.get(tabId)?.promise === promise) inFlight.delete(tabId);
    resolve(claimed);
  };
  inFlight.set(tabId, { promise, release, text });
  return release;
}

export const isHandoffPending = (tabId) => inFlight.has(tabId);

/** The text of the task this tab is still waiting on (to put back if the panel never takes it). */
export const pendingHandoffText = (tabId) => inFlight.get(tabId)?.text ?? '';

/**
 * Resolves true when the panel has claimed this tab's task (or the submit failed), false when the
 * wait timed out with the task still unclaimed.
 */
export function whenClaimed(tab = currentTab) {
  return inFlight.get(tab?.id)?.promise ?? Promise.resolve(true);
}

/** Re-takes the lock for a record this tab wrote before the page was reloaded. */
export async function adoptPendingHandoff(api, tabId, now = Date.now()) {
  if (!api?.storage?.local?.get || inFlight.has(tabId)) return false;
  const key = handoffKey(tabId);
  let record;
  try {
    record = (await api.storage.local.get(key))?.[key];
  } catch {
    return false;
  }
  if (!record || inFlight.has(tabId)) return false;
  const remaining = CLAIM_TIMEOUT_MS - (now - Number(record.createdAt || 0));
  if (!(remaining > 0)) return false;
  releaseWhenClaimed(api, tabId, lockTab(tabId, String(record.text ?? '')), remaining);
  return true;
}

/** After a successful write: release the lock once the record has been removed. */
function releaseWhenClaimed(api, tabId, release, timeoutMs = CLAIM_TIMEOUT_MS) {
  const key = handoffKey(tabId);
  let timer;
  const listener = (changes, area) => {
    if ((!area || area === 'local') && changes?.[key] && !changes[key].newValue) finish();
  };
  function finish(claimed = true) {
    clearTimeout(timer);
    api.storage.onChanged?.removeListener?.(listener);
    release(claimed);
  }
  timer = setTimeout(() => finish(false), timeoutMs);
  api.storage.onChanged?.addListener?.(listener);
  // It may already have been claimed between the write and now.
  Promise.resolve(api.storage.local.get?.(key))
    .then((found) => { if (!found?.[key]) finish(); })
    .catch(() => {});
}

/**
 * Call directly from the submit handler (no await before it) so the browser
 * still sees the user gesture. Resolves true once the panel has been asked to
 * open and the task is stored.
 */
export function submitTask({ text, mode }, api = extApi(), tab = currentTab) {
  if (!api || tab?.id == null) return Promise.reject(new Error('Extension API unavailable'));
  if (inFlight.has(tab.id)) return Promise.reject(new Error('Previous task is still being handed over'));
  const firefox = hasFirefoxSidebar();
  if (!firefox && !api.sidePanel?.open) return Promise.reject(new Error('Side panel API unavailable'));

  const release = lockTab(tab.id, String(text ?? ''));
  const handoff = buildHandoff({ text, mode, tabId: tab.id });

  let stored;
  let opened;
  try {
    stored = Promise.resolve(api.storage.local.set({ [handoffKey(tab.id)]: handoff }));
    if (firefox) {
      opened = api.sidebarAction.open();
    } else {
      Promise.resolve(
        api.sidePanel.setOptions({ tabId: tab.id, path: 'src/ui/sidepanel.html', enabled: true }),
      ).catch(() => {});
      opened = api.sidePanel.open({ tabId: tab.id });
    }
  } catch (error) {
    opened = Promise.reject(error);
    stored ??= Promise.resolve();
  }

  return Promise.all([stored, opened]).then(
    () => {
      releaseWhenClaimed(api, tab.id, release);
      Promise.resolve(api.runtime.sendMessage({ type: 'WB_NEWTAB_PANEL_OPENED', tabId: tab.id })).catch(() => {});
      return true;
    },
    async (error) => {
      // The panel did not open, so the user is told it failed. Take the task back
      // out of storage, otherwise opening the panel by hand within the next 30 s
      // would pick it up and send it as if the submit had worked.
      await stored.catch(() => {});
      await discardHandoff(api, tab.id, handoff.id);
      release();
      throw error;
    },
  );
}

// The full-page chat Ask opens in this tab: the side panel page in its standalone (Ask-only)
// layout, bound to the tab it is loaded in (`tab=1`, see src/*/src/ui/sidepanel.js).
export const TAB_CHAT_PATH = 'src/ui/sidepanel.html?mode=ask&standalone=true&tab=1';

/**
 * Ask: store the task for this tab, then load the full-page chat in it. The chat page
 * claims the record addressed to its own tab, as the side panel would. No user gesture is
 * needed (it is a navigation, not sidePanel.open), so the write is awaited first: leaving
 * the page before it lands could lose the task.
 */
export function openAskChat({ text }, api = extApi(), tab = currentTab, navigate = (url) => window.location.assign(url)) {
  if (!api?.storage?.local?.set || !api?.runtime?.getURL || tab?.id == null) {
    return Promise.reject(new Error('Extension API unavailable'));
  }
  if (inFlight.has(tab.id)) return Promise.reject(new Error('Previous task is still being handed over'));

  const release = lockTab(tab.id, String(text ?? ''));
  const handoff = buildHandoff({ text, mode: 'ask', tabId: tab.id });
  let stored;
  try {
    stored = Promise.resolve(api.storage.local.set({ [handoffKey(tab.id)]: handoff }));
  } catch (error) {
    stored = Promise.reject(error);
  }
  return stored.then(
    async () => {
      try {
        navigate(api.runtime.getURL(TAB_CHAT_PATH));
      } catch (error) {
        await discardHandoff(api, tab.id, handoff.id);
        release();
        throw error;
      }
      // Normally this page is gone by now; if it is still here, stay locked until the
      // chat has taken the task, as after a side panel hand-off.
      releaseWhenClaimed(api, tab.id, release);
      return true;
    },
    (error) => {
      release();
      throw error;
    },
  );
}

/** Removes the stored hand-off, but only if it is still the one we wrote. */
export async function discardHandoff(api, tabId, id) {
  const key = handoffKey(tabId);
  try {
    const current = (await api.storage.local.get(key))?.[key];
    if (!current || current.id === id) await api.storage.local.remove(key);
  } catch {
    // best effort: the panel also drops anything older than 30 s
  }
}

export function canSearch(api = extApi()) {
  return hasFirefoxSidebar() ? typeof api?.search?.search === 'function' : typeof api?.search?.query === 'function';
}

const SAFE_URL_SCHEMES = new Set(['http:', 'https:']);

/** Returns a navigable http(s) URL if the text is one, otherwise null. */
export function toNavigableUrl(input) {
  const value = String(input || '').trim();
  if (!value || /\s/.test(value)) return null;
  try {
    const direct = new URL(value);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      return SAFE_URL_SCHEMES.has(direct.protocol) ? direct.href : null;
    }
  } catch {
    // not an absolute URL; try as a bare host below
  }
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?([/?#]\S*)?$/i.test(value)) {
    try {
      const url = new URL(`https://${value}`);
      return SAFE_URL_SCHEMES.has(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Search with the browser's own default engine; never a hard-coded one. */
export async function runSearch(text, api = extApi(), nav = (url) => window.location.assign(url)) {
  const url = toNavigableUrl(text);
  if (url) {
    nav(url);
    return true;
  }
  if (hasFirefoxSidebar() && api?.search?.search) {
    await api.search.search({ query: text, disposition: 'CURRENT_TAB' });
    return true;
  }
  if (api?.search?.query) {
    await api.search.query({ text, disposition: 'CURRENT_TAB' });
    return true;
  }
  throw new Error('Search API unavailable');
}
