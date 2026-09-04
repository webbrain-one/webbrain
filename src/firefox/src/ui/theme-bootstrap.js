// Pre-paint theme bootstrap. Sets <html data-theme="..."> from
// localStorage('wbTheme') > prefers-color-scheme > 'dark' before the
// stylesheet loads, so the page never opens in the wrong theme.
//
// Must be a classic script (not a module) loaded synchronously in <head>
// BEFORE the stylesheet link — that way it's parser-blocking and runs
// before any layout/paint. MV3's default CSP forbids inline scripts, so
// this lives in its own file.
//
// Stays in lockstep with theme.js, but uses only DOM APIs (no chrome.*)
// since this runs before any module hydration.
(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('standalone') === 'true') {
      document.documentElement.setAttribute('data-standalone', 'true');
      // Standalone chat has no History strip. Reuse the existing New chat
      // button so its confirmation and event wiring remain unchanged.
      window.addEventListener('DOMContentLoaded', function () {
        var headerActions = document.querySelector('#header .header-right');
        var newChat = document.getElementById('btn-clear');
        var expand = document.getElementById('btn-expand');
        if (headerActions && newChat) headerActions.insertBefore(newChat, expand);
      }, { once: true });
    }
  } catch (_) { /* ignore */ }

  try {
    var mode = localStorage.getItem('wbTheme');
    if (mode !== 'light' && mode !== 'dark') mode = 'system';
    var theme = (mode === 'system')
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : mode;
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  try {
    if (window.location.pathname.endsWith('/sidepanel.html')) {
      var root = document.documentElement;
      var levels = [75, 80, 90, 100, 110, 125, 150, 175];
      var applyScale = function (value) {
        var scale = Number(value);
        if (levels.indexOf(scale) === -1) scale = 100;
        var inverse = Number((10000 / scale).toFixed(4));
        root.setAttribute('data-ui-scale', String(scale));
        root.style.setProperty('--ui-scale-zoom', String(scale / 100));
        // Only the viewport-unit height needs the inverse: percentage widths
        // already resolve inside the zoomed coordinate space.
        root.style.setProperty('--ui-scale-height', inverse + 'vh');
      };
      var ready = false;
      var reveal = function () {
        if (ready) return;
        ready = true;
        root.setAttribute('data-ui-scale-ready', 'true');
      };

      // localStorage is synchronous and avoids a flash on normal page opens.
      // The canonical storage API is checked below because MV3 service workers
      // cannot update this mirror when a global command changes the scale.
      var mirrored = null;
      try {
        mirrored = localStorage.getItem('wbUiScale');
      } catch (_) { /* private mode and blocked site data both land here */ }
      applyScale(mirrored);
      if (levels.indexOf(Number(mirrored)) === -1) {
        // Only blank the panel when there is no usable mirror to paint from.
        // With one, the pre-paint scale is already right and the reconcile
        // below can adjust it in place instead of costing every open a
        // storage round-trip behind a hidden panel.
        root.setAttribute('data-ui-scale-ready', 'false');
        // Register the escape hatch BEFORE touching the browser API: a
        // synchronous throw (an invalidated extension context after a
        // reload) would otherwise skip it and hide the panel forever.
        window.setTimeout(reveal, 1000);
      } else {
        ready = true;
      }
      try {
        var storage = globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local;
        if (!storage?.get) {
          reveal();
        } else if (globalThis.browser?.storage?.local?.get) {
          Promise.resolve(storage.get({ uiScale: 100 })).then(function (stored) {
            applyScale(stored?.uiScale);
            reveal();
          }).catch(reveal);
        } else {
          storage.get({ uiScale: 100 }, function (stored) {
            applyScale(stored?.uiScale);
            reveal();
          });
        }
      } catch (_) {
        reveal();
      }
    }
  } catch (_) {
    // Default CSS variables keep the panel at 100%, but the reveal gate above
    // may already be set — clear it so a failed scale init can never leave the
    // panel hidden.
    try {
      document.documentElement.setAttribute('data-ui-scale-ready', 'true');
    } catch (_e) { /* ignore */ }
  }
})();
