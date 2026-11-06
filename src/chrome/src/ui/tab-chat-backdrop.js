// Pre-paint backdrop for the full-page chat (sidepanel.html?mode=ask&standalone=true&tab=1),
// the page the WebBrain new tab turns into when the user asks something there.
//
// The chat is a centred column (styles/sidepanel.css, html[data-tab-chat]). Around it, it shows
// the background the new tab was showing, so asking feels like the new tab opening up rather
// than a jump to another page. The new tab leaves a description of that background in this
// tab's sessionStorage right before it navigates (newtab/src/features/background/api/
// chatBackdrop.js); sessionStorage is per tab and per origin, so it survives the navigation and
// reloads and no other tab sees it. Without one (backgrounds off, a video, opened some other way)
// the column sits on a plain surround.
//
// Classic script, loaded synchronously in <head> like theme-bootstrap.js, so the backdrop is in
// place before the first paint. Everything read here is checked: only an image address of this
// extension or http(s), a plain colour or gradient (no url()), a custom-background id, and
// bounded filter numbers are used.
//
// The Chrome and Firefox copies of this file are identical: edit both together.
(function () {
  var KEY = 'wbTabChatBackdrop';
  var FILTERS = ['grayscale', 'sepia', 'invert', 'saturate', 'contrast'];
  // The new tab's upload store (newtab/src/utils/customBackgroundDB.js), read-only here.
  var CUSTOM_DB = 'MueCustomBackgrounds';
  var CUSTOM_STORE = 'backgrounds';

  var root = document.documentElement;

  function supports(property, value) {
    try {
      return !globalThis.CSS?.supports || globalThis.CSS.supports(property, value);
    } catch (_) {
      return false;
    }
  }

  function bounded(value, min, max, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  // A CSS url() for an address that may contain ) " \ or a line break.
  function cssUrl(url) {
    return 'url("' + String(url).replace(/[\\"]/g, '\\$&').replace(/\r?\n|\r/g, '\\a ') + '")';
  }

  function imageAllowed(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    var url;
    try {
      url = new URL(raw);
    } catch (_) {
      return null;
    }
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    // A picture bundled with the extension (same origin as this page).
    if (url.href.indexOf(window.location.origin + '/') === 0) return url.href;
    return null;
  }

  // In the new tab's order: its overlay blurs and applies the effect (backdrop-filter), then
  // darkens the result with black, so brightness comes last. It covers colours and pictures alike.
  function applyEffects(backdrop) {
    var blur = bounded(backdrop.blur, 0, 100, 0);
    var brightness = bounded(backdrop.brightness, 0, 100, 100);
    var parts = [];
    if (blur > 0) parts.push('blur(' + blur + 'px)');
    if (FILTERS.indexOf(backdrop.filter) !== -1) {
      parts.push(backdrop.filter + '(' + bounded(backdrop.filterAmount, 0, 100, 100) + '%)');
    }
    if (brightness !== 100) parts.push('brightness(' + brightness + '%)');
    root.style.setProperty('--tab-chat-backdrop-filter', parts.join(' ') || 'none');
    // A blurred edge fades to transparent; drawing the backdrop a little larger hides that.
    root.style.setProperty('--tab-chat-backdrop-bleed', (blur * -2) + 'px');
  }

  function paintImage(href, backdrop) {
    root.style.setProperty('--tab-chat-backdrop-image', cssUrl(href));
    if (typeof backdrop.colour === 'string' && backdrop.colour.length <= 64 && supports('color', backdrop.colour)) {
      root.style.setProperty('--tab-chat-backdrop-colour', backdrop.colour);
    }
    applyEffects(backdrop);
    root.setAttribute('data-tab-chat-backdrop', 'image');
  }

  // Opens the upload store only if it already exists: opening a missing database would create
  // an empty one without its store and break the new tab's own uploads.
  function paintCustom(id, backdrop) {
    var listed = globalThis.indexedDB?.databases
      ? Promise.resolve(indexedDB.databases()).then(function (list) {
        return list.some(function (entry) { return entry?.name === CUSTOM_DB; });
      }, function () { return true; })
      : Promise.resolve(true);
    listed.then(function (exists) {
      if (exists) readCustom(id, backdrop);
    });
  }

  function readCustom(id, backdrop) {
    var request;
    try {
      request = indexedDB.open(CUSTOM_DB);
    } catch (_) {
      return;
    }
    request.onupgradeneeded = function () {
      try { request.transaction.abort(); } catch (_) { /* ignore */ }
    };
    request.onerror = function (event) { event?.preventDefault?.(); };
    request.onsuccess = function () {
      var db = request.result;
      try {
        if (!db.objectStoreNames.contains(CUSTOM_STORE)) {
          db.close();
          return;
        }
        var get = db.transaction(CUSTOM_STORE, 'readonly').objectStore(CUSTOM_STORE).get(id);
        get.onsuccess = function () {
          var url = get.result?.url;
          db.close();
          if (typeof url !== 'string') return;
          if (/^data:image\//i.test(url)) paintImage(url, backdrop);
          else {
            var href = imageAllowed(url);
            if (href) paintImage(href, backdrop);
          }
        };
        get.onerror = function () { db.close(); };
      } catch (_) {
        try { db.close(); } catch (_e) { /* ignore */ }
      }
    };
  }

  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('standalone') !== 'true' || params.get('tab') !== '1') return;
    root.setAttribute('data-tab-chat', 'true');

    var raw = null;
    try {
      raw = window.sessionStorage.getItem(KEY);
    } catch (_) { /* blocked storage: plain surround */ }
    if (!raw) return;
    var backdrop = JSON.parse(raw);
    if (!backdrop || typeof backdrop !== 'object' || backdrop.v !== 1) return;

    var href = imageAllowed(backdrop.image);
    if (href) {
      paintImage(href, backdrop);
    } else if (Number.isInteger(backdrop.customId) && backdrop.customId >= 0) {
      paintCustom(backdrop.customId, backdrop);
    } else if (
      typeof backdrop.background === 'string'
      && backdrop.background.length <= 300
      && !/url\s*\(/i.test(backdrop.background)
      && supports('background', backdrop.background)
    ) {
      root.style.setProperty('--tab-chat-backdrop-background', backdrop.background);
      applyEffects(backdrop);
      root.setAttribute('data-tab-chat-backdrop', 'colour');
    }
  } catch (_) {
    // A malformed description only costs the backdrop.
  }
})();
