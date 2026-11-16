// Providers and Permissions used to be pages of their own; their sections now
// live in settings.html. Old links (bookmarks, the side panel, docs) land on
// providers.html or permissions.html, which load only this script, and are
// forwarded with their #section: providers.html#vision opens Settings →
// Vision. settings-tabs.js resolves the old names (#multimodal, #providers).
//
// A classic external script because Manifest V3's default CSP blocks inline
// scripts. Shared verbatim by the Chrome and Firefox builds.
(function () {
  const section = (location.hash || '').replace('#', '') || document.currentScript?.dataset.defaultSection || '';
  location.replace(new URL(`settings.html${section ? `#${section}` : ''}`, location.href).href);
})();
