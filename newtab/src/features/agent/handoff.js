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
 *
 * Ask also leaves the background this new tab is showing for the chat to open on
 * (features/background/api/chatBackdrop.js).
 */
import { saveChatBackdrop } from '../background/api/chatBackdrop.js';
import { TLDS } from './tlds.js';

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

// Which page may claim the record. A side panel already open beside this tab listens for the same
// key, so Ask's record says it is for the full-page chat and the panel leaves it alone. Mirrors
// NEWTAB_HANDOFF_TARGET_* in src/*/src/ui/newtab-handoff.js (checked in test/newtab.mjs).
export const HANDOFF_TARGET_PANEL = 'panel';
export const HANDOFF_TARGET_TAB_CHAT = 'tab-chat';

export function buildHandoff({ text, mode, tabId, now = Date.now(), target = HANDOFF_TARGET_PANEL }) {
  return {
    id: `nt-${now}-${Math.random().toString(36).slice(2, 8)}`,
    tabId,
    text: String(text).slice(0, MAX_TASK_LENGTH),
    mode: mode === 'act' ? 'act' : 'ask',
    createdAt: now,
    target: target === HANDOFF_TARGET_TAB_CHAT ? HANDOFF_TARGET_TAB_CHAT : HANDOFF_TARGET_PANEL,
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
 * the page before it lands could lose the task. The background on screen is left for the
 * chat (`rememberBackdrop`) right before leaving.
 */
export function openAskChat(
  { text },
  api = extApi(),
  tab = currentTab,
  navigate = (url) => window.location.assign(url),
  rememberBackdrop = saveChatBackdrop,
) {
  if (!api?.storage?.local?.set || !api?.runtime?.getURL || tab?.id == null) {
    return Promise.reject(new Error('Extension API unavailable'));
  }
  if (inFlight.has(tab.id)) return Promise.reject(new Error('Previous task is still being handed over'));

  const release = lockTab(tab.id, String(text ?? ''));
  const handoff = buildHandoff({ text, mode: 'ask', tabId: tab.id, target: HANDOFF_TARGET_TAB_CHAT });
  let stored;
  try {
    stored = Promise.resolve(api.storage.local.set({ [handoffKey(tab.id)]: handoff }));
  } catch (error) {
    stored = Promise.reject(error);
  }
  return stored.then(
    async () => {
      try {
        rememberBackdrop();
      } catch {
        // cosmetic only: the chat then opens on its plain surround
      }
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
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// host[:port][/path, ?query or #fragment], read the way an address bar reads
// typed text: a dotted name (in any script), localhost, an IPv4 address or a
// bracketed IPv6 one.
const BARE_HOST_RE = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]{2,63})(:\d{1,5})?(?:[/?#]\S*)?$/iu;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// This computer and the local network, which an address bar opens over http
// (dev servers and routers rarely serve https), with the private-use names
// that are not in IANA's list.
const LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|0\.0\.0\.0|\[::1\])$|\.(?:localhost|local|test|internal|lan|home|corp|intranet|home\.arpa)$/i;

/**
 * Returns the http(s) URL the text is, when it is only an address, otherwise
 * null. With a scheme, only http(s). Without one, a name must end in a real
 * top-level domain, so "node.js", "notes.txt" or "config.yaml" stay text, and
 * opens over https, except a local host, which opens over http.
 */
export function toNavigableUrl(input) {
  const value = String(input || '').trim();
  if (!value || /\s/.test(value)) return null;
  if (SCHEME_RE.test(value)) {
    try {
      const url = new URL(value);
      return SAFE_URL_SCHEMES.has(url.protocol) && url.hostname ? url.href : null;
    } catch {
      return null;
    }
  }
  const typed = BARE_HOST_RE.exec(value)?.[1];
  if (!typed) return null;
  // A number with dots is an address only as four parts ("1.2.30" is a version).
  if (/^[\d.]+$/.test(typed) && !IPV4_RE.test(typed)) return null;
  let url;
  try {
    url = new URL(`http://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (LOCAL_HOST_RE.test(host)) return url.href;
  if (!IPV4_RE.test(host) && !TLDS.has(host.slice(host.lastIndexOf('.') + 1))) return null;
  url.protocol = 'https:';
  return url.href;
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
