(function () {
  const root = document.documentElement;
  const themeButton = document.querySelector('[data-theme-toggle]');
  const sidebarButton = document.querySelector('[data-sidebar-toggle]');

  function preferredTheme() {
    try {
      const saved = localStorage.getItem('webbrain-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (_) {}
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function setTheme(theme, persist) {
    root.dataset.theme = theme;
    if (themeButton) {
      themeButton.setAttribute('aria-label', theme === 'dark' ? 'Use light theme' : 'Use dark theme');
      themeButton.textContent = theme === 'dark' ? '☀' : '☾';
    }
    if (persist) {
      try { localStorage.setItem('webbrain-theme', theme); } catch (_) {}
    }
  }

  setTheme(preferredTheme(), false);
  themeButton?.addEventListener('click', function () {
    setTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true);
  });

  sidebarButton?.addEventListener('click', function () {
    const open = document.body.classList.toggle('sidebar-open');
    sidebarButton.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('.docs-sidebar a').forEach(function (link) {
    link.addEventListener('click', function () {
      document.body.classList.remove('sidebar-open');
      sidebarButton?.setAttribute('aria-expanded', 'false');
    });
  });
})();
