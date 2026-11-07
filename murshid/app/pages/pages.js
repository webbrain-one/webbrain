'use strict';

// Script for Murshid's own pages. window.murshid comes from app/pages/preload.js
// and exists only on murshid:// pages.

(() => {
  const api = window.murshid;
  const $ = (id) => document.getElementById(id);
  const page = document.body.dataset.page;

  // New tab fallback ------------------------------------------------------------
  $('search')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('q').value.trim();
    if (text) api?.navigate(text);
  });
  $('webbrain')?.addEventListener('click', () => api?.openWebBrain());

  // Settings ----------------------------------------------------------------------
  if (page === 'settings' && api) {
    api.settings().then(({ values, searchEngines }) => {
      const select = $('engine');
      for (const engine of searchEngines) {
        const option = document.createElement('option');
        option.value = engine.id;
        option.textContent = engine.name;
        select.append(option);
      }
      select.value = values.searchEngine;
      select.addEventListener('change', () => api.setSetting('searchEngine', select.value));
      const companion = $('companion');
      companion.checked = Boolean(values.startCompanion);
      companion.addEventListener('change', () => api.setSetting('startCompanion', companion.checked));
      const asChrome = $('as-chrome');
      asChrome.checked = Boolean(values.identifyAsChrome);
      asChrome.addEventListener('change', () => api.setSetting('identifyAsChrome', asChrome.checked));
      const persistSession = $('persist-session');
      persistSession.checked = values.persistBrowserSession !== false;
      persistSession.addEventListener('change', () => api.setSetting('persistBrowserSession', persistSession.checked));
    });
    $('open-companion').addEventListener('click', () => api.companion());
  }

  // About ----------------------------------------------------------------------------
  if (page === 'about' && api) {
    api.info().then((info) => {
      const set = (key, value) => {
        const el = document.querySelector(`[data-k="${key}"]`);
        if (el) el.textContent = value;
      };
      set('version', info.version);
      set('chrome', info.chrome);
      set('electron', info.electron);
      set('platform', info.platform);
      set('profile', info.profile);
      set('userAgent', info.userAgent);
      set('webBrain', info.webBrain ? `${info.webBrain.version} (${info.webBrain.id})` : 'not installed in this build');
      const c = info.companion;
      set('companion', c.running ? `running on 127.0.0.1:${c.port}` : c.found ? `installed, not running (${c.path})` : 'not installed');
    });
  }

  // Load error -----------------------------------------------------------------------
  if (page === 'error') {
    const params = new URLSearchParams(location.search);
    const url = params.get('url') || '';
    let host = url;
    try { host = new URL(url).host || url; } catch {}
    $('host').textContent = host || 'The page';
    $('url').textContent = url;
    const description = params.get('description') || '';
    $('code').textContent = `${description} (${params.get('code') || '?'})`;
    const friendly = {
      ERR_NAME_NOT_RESOLVED: 'Its address could not be found. Check the spelling, or your connection.',
      ERR_INTERNET_DISCONNECTED: 'This computer is offline.',
      ERR_CONNECTION_REFUSED: 'The server refused the connection.',
      ERR_CONNECTION_TIMED_OUT: 'The server took too long to answer.',
      ERR_CERT_AUTHORITY_INVALID: 'Its security certificate is not trusted, so Murshid stopped.',
      ERR_CERT_COMMON_NAME_INVALID: 'Its security certificate is for a different site, so Murshid stopped.',
      ERR_CERT_DATE_INVALID: 'Its security certificate has expired or is not valid yet.',
    };
    $('why').textContent = friendly[description] || '';
    $('retry').addEventListener('click', () => { if (url) api?.navigate(url); });
  }
})();
