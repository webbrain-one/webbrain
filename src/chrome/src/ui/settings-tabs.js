// Section switcher for settings.html: the sidebar's buttons (.tab-btn) show
// one section (.tab-panel) at a time. Kept out of an inline <script> tag
// because Manifest V3's default CSP (`script-src 'self'`) refuses inline
// execution. Loaded as a classic script (not a module) at the bottom of the
// page so the buttons and sections already exist when this runs.
//
// The nav element carries the page's configuration:
//   data-default-tab  section shown when neither the URL nor the last visit picks one
//   data-storage-key  localStorage key that remembers the last section
//   data-moved-tabs   old #hash -> another page that now holds it (redirected)
//   data-tab-aliases  old #hash -> section on this page

(function () {
  const nav = document.querySelector('nav.tabs');
  const buttons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  const STORAGE_KEY = nav?.dataset.storageKey || 'webbrainSettingsTab';
  const DEFAULT_TAB = nav?.dataset.defaultTab || 'display';
  const searchBox = document.getElementById('settings-search');
  const searchInput = document.getElementById('input-general-search');

  function readMap(name) {
    try { return JSON.parse(nav?.dataset[name] || '{}'); } catch (_) { return {}; }
  }

  // A #hash that names a section living on another page goes there.
  const hash = (location.hash || '').replace('#', '');
  const moved = readMap('movedTabs');
  if (hash && Object.hasOwn(moved, hash)) {
    location.replace(new URL(moved[hash], location.href).href);
    return;
  }

  function hasTab(name) {
    return Array.from(buttons).some((b) => b.dataset.tab === name);
  }

  function activate(name) {
    let matched = false;
    buttons.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      if (on) {
        b.setAttribute('aria-current', 'page');
        matched = true;
      } else {
        b.removeAttribute('aria-current');
      }
    });
    let activePanel = null;
    panels.forEach((p) => {
      const on = p.dataset.panel === name;
      p.classList.toggle('active', on);
      if (on) activePanel = p;
    });
    // The settings search covers the tabs marked data-search only.
    if (searchBox) searchBox.hidden = !activePanel?.hasAttribute('data-search');
    if (matched) {
      try { localStorage.setItem(STORAGE_KEY, name); } catch (_) {}
    }
  }

  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      // Picking a tab ends a search that was showing several tabs at once.
      if (searchInput?.value) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      activate(b.dataset.tab);
    });
  });

  // During a search each tab's matches sit under its name, and the name opens
  // that tab. Focus moves to its tab button, as if it had been picked.
  document.querySelectorAll('[data-search-tab]').forEach((link) => {
    link.addEventListener('click', () => {
      const tab = Array.from(buttons).find((b) => b.dataset.tab === link.dataset.searchTab);
      if (!tab) return;
      tab.click();
      tab.focus();
      window.scrollTo({ top: 0 });
    });
  });

  // Restore the last-viewed tab so the page doesn't snap back to the default
  // every reload — makes iterating on a single section less annoying.
  let initial = DEFAULT_TAB;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && hasTab(saved)) {
      initial = saved;
    }
  } catch (_) {}

  // Honour #<section> in the URL so other parts of the extension can
  // deep-link into a section, e.g. settings.html#vision from Apocalypse Mode.
  const aliases = readMap('tabAliases');
  const requested = Object.hasOwn(aliases, hash) ? aliases[hash] : hash;
  if (requested && hasTab(requested)) {
    initial = requested;
  }

  activate(initial);
})();
