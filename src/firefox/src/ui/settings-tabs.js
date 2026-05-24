// Tab switcher for settings.html. Kept out of an inline <script> tag
// because Manifest V3's default CSP (`script-src 'self'`) refuses inline
// execution. Loaded as a classic script (not a module) at the bottom of
// the page so the tab/panel elements already exist when this runs.

(function () {
  const STORAGE_KEY = 'webbrainSettingsTab';
  const buttons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  function activate(name) {
    let matched = false;
    buttons.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      if (on) matched = true;
    });
    panels.forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === name);
    });
    if (matched) {
      try { localStorage.setItem(STORAGE_KEY, name); } catch (_) {}
    }
  }

  buttons.forEach((b) => {
    b.addEventListener('click', () => activate(b.dataset.tab));
  });

  // Restore the last-viewed tab so the page doesn't snap back to Display
  // every reload — makes iterating on a single section less annoying.
  let initial = 'display';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && document.querySelector(`.tab-btn[data-tab="${saved}"]`)) {
      initial = saved;
    }
  } catch (_) {}

  // Honour #display / #providers / #multimodal in the URL so other parts
  // of the extension can deep-link into a tab later. The "multimodal" tab
  // was previously named "vision" — old #vision deep-links no longer match
  // anything and silently fall back to the default tab, which is fine.
  const hash = (location.hash || '').replace('#', '');
  if (hash && document.querySelector(`.tab-btn[data-tab="${hash}"]`)) {
    initial = hash;
  }

  activate(initial);
})();
