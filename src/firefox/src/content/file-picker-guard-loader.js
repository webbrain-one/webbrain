/*
 * Firefox MV2 content scripts run in an isolated world. Load the file-picker
 * bridge through a web-accessible extension URL so it executes in the page's
 * main world and can intercept page-owned input.showPicker() calls.
 */
(() => {
  try {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('src/content/file-picker-guard-page.js');
    script.async = false;
    script.onload = () => { try { script.remove(); } catch {} };
    script.onerror = () => { try { script.remove(); } catch {} };
    (document.head || document.documentElement).appendChild(script);
  } catch {}
})();
