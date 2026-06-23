// Theme helper for the WebBrain extension UI (sidepanel + settings + traces).
//
// Three modes:
//   - 'system' (default) — follows prefers-color-scheme, updates live if the
//                          OS theme changes.
//   - 'light'            — forced cream / coffee palette.
//   - 'dark'             — forced original dark palette.
//
// We mirror the pref into both localStorage (sync read for FOUC-free
// bootstrap from inline <head> scripts) and chrome.storage.local (canonical
// source the settings page reads/writes). chrome.storage.onChanged keeps
// every open extension page (sidepanel + settings + traces) in sync when
// any one of them changes the setting.
//
// Loaded as an ES module; the FOUC-prevention bootstrap is a separate
// inline script in each HTML page that reads localStorage synchronously.

const LS_KEY = 'wbTheme';

export const THEME_MODES = ['system', 'light', 'dark'];
export const DEFAULT_MODE = 'system';

function readLocal() {
  try {
    const v = localStorage.getItem(LS_KEY);
    return THEME_MODES.includes(v) ? v : DEFAULT_MODE;
  } catch { return DEFAULT_MODE; }
}

function writeLocal(mode) {
  try { localStorage.setItem(LS_KEY, mode); } catch { /* ignore */ }
}

function osTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Resolve a mode ('system'|'light'|'dark') to the actual theme to apply. */
export function resolveTheme(mode) {
  return mode === 'system' ? osTheme() : mode;
}

/** Apply a mode to <html data-theme="..."> and remember it. */
export async function applyMode(mode, opts = {}) {
  if (!THEME_MODES.includes(mode)) mode = DEFAULT_MODE;
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  if (opts.persist !== false) {
    writeLocal(mode);
    if (opts.syncStorage !== false && globalThis.chrome?.storage?.local) {
      await chrome.storage.local.set({ themeMode: mode }).catch(() => {});
    }
  }
}

/** Pull the canonical mode from chrome.storage.local, fall back to local. */
export async function loadMode() {
  try {
    if (globalThis.chrome?.storage?.local) {
      const { themeMode } = await chrome.storage.local.get(['themeMode']);
      if (THEME_MODES.includes(themeMode)) {
        // Keep localStorage in sync for the next page-load bootstrap.
        writeLocal(themeMode);
        return themeMode;
      }
    }
  } catch { /* fall through */ }
  return readLocal();
}

/** Wire live updates: OS theme changes (when in 'system' mode) + storage
    changes from another extension page. Returns a teardown fn. */
export function watch(getMode) {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onOS = () => { if (getMode() === 'system') applyMode('system', { persist: false }); };
  if (mq.addEventListener) mq.addEventListener('change', onOS);
  else if (mq.addListener) mq.addListener(onOS);

  let onStorage = null;
  if (globalThis.chrome?.storage?.onChanged) {
    onStorage = (changes, area) => {
      if (area !== 'local' || !changes.themeMode) return;
      const next = changes.themeMode.newValue;
      if (THEME_MODES.includes(next)) applyMode(next, { syncStorage: false });
    };
    chrome.storage.onChanged.addListener(onStorage);
  }

  return () => {
    if (mq.removeEventListener) mq.removeEventListener('change', onOS);
    else if (mq.removeListener) mq.removeListener(onOS);
    if (onStorage && globalThis.chrome?.storage?.onChanged) {
      chrome.storage.onChanged.removeListener(onStorage);
    }
  };
}
