'use strict';

// Script for Murshid's own pages. window.murshid comes from app/pages/preload.js
// and exists only on murshid:// pages.

(() => {
  const api = window.murshid;
  const $ = (id) => document.getElementById(id);
  const page = document.body.dataset.page;
  // The page arrives translated (app/protocol.js); these are for what we fill in.
  const strings = api?.i18n?.strings || {};
  const t = (key, vars) => {
    const text = strings[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text;
  };

  // New tab fallback ------------------------------------------------------------
  $('search')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('q').value.trim();
    if (text) api?.navigate(text);
  });
  $('webbrain')?.addEventListener('click', () => api?.openWebBrain());

  // Settings ----------------------------------------------------------------------
  if (page === 'settings' && api) {
    const count = new Intl.NumberFormat(api.i18n?.locale || 'en');
    const showHistoryCount = (n) => {
      $('history-count').textContent = n === 1
        ? t('page.settings.historyCountOne')
        : t('page.settings.historyCount', { count: count.format(n) });
      $('clear-history').disabled = n === 0;
    };
    api.settings().then(({ values, searchEngines, languages, historyCount }) => {
      const language = $('language');
      for (const entry of languages || []) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.lang = entry.lang;
        option.textContent = entry.name;
        language.append(option);
      }
      language.value = values.language || 'auto';
      language.addEventListener('change', () => api.setSetting('language', language.value));
      const suggest = $('suggest');
      suggest.checked = Boolean(values.searchSuggestions);
      suggest.addEventListener('change', () => api.setSetting('searchSuggestions', suggest.checked));
      showHistoryCount(historyCount || 0);
      $('clear-history').addEventListener('click', () => {
        if (!window.confirm(t('page.settings.clearHistoryConfirm'))) return;
        api.clearHistory().then(showHistoryCount);
      });
      const select = $('engine');
      for (const engine of searchEngines) {
        const option = document.createElement('option');
        option.value = engine.id;
        option.textContent = engine.name;
        select.append(option);
      }
      select.value = values.searchEngine;
      select.addEventListener('change', () => api.setSetting('searchEngine', select.value));
      const updates = $('check-updates');
      updates.checked = values.checkUpdates !== false;
      updates.addEventListener('change', () => api.setSetting('checkUpdates', updates.checked));
      const companion = $('companion');
      companion.checked = Boolean(values.startCompanion);
      companion.addEventListener('change', () => api.setSetting('startCompanion', companion.checked));
      const adblock = $('adblock');
      adblock.checked = values.adblock !== false;
      adblock.addEventListener('change', () => api.setSetting('adblock', adblock.checked));
      const asChrome = $('as-chrome');
      asChrome.checked = Boolean(values.identifyAsChrome);
      asChrome.addEventListener('change', () => api.setSetting('identifyAsChrome', asChrome.checked));
      const persistSession = $('persist-session');
      persistSession.checked = values.persistBrowserSession !== false;
      persistSession.addEventListener('change', () => api.setSetting('persistBrowserSession', persistSession.checked));
    });
    $('open-companion').addEventListener('click', () => api.companion());
  }

  // Updates --------------------------------------------------------------------------
  if (page === 'updates' && api) {
    const render = (state) => {
      if (!state) return;
      $('installed-version').textContent = state.installedVersion;
      const status = ['idle', 'checking', 'current', 'available', 'downloading', 'ready', 'installing', 'error', 'unsupported', 'opened'].includes(state.status) ? state.status : 'error';
      $('update-status').textContent = t(`page.updates.${status}`, { version: status === 'current' ? state.installedVersion : state.latestVersion || state.installedVersion });
      $('update-hint').textContent = t(state.native ? 'page.updates.native' : 'page.updates.manual');
      $('check-update').disabled = ['checking', 'downloading', 'ready', 'installing'].includes(status);
      $('download-update').hidden = status !== 'available';
      $('install-update').hidden = status !== 'ready';
    };
    const act = async (call) => {
      try { render(await call()); } catch { $('update-status').textContent = t('page.updates.error'); }
    };
    $('check-update').addEventListener('click', () => act(() => api.checkUpdates()));
    $('download-update').addEventListener('click', () => act(() => api.downloadUpdate()));
    $('install-update').addEventListener('click', () => act(() => api.installUpdate()));
    act(async () => {
      const state = await api.updateStatus();
      return ['idle', 'error', 'current', 'unsupported'].includes(state?.status) ? api.checkUpdates() : state;
    });
    const timer = setInterval(() => { if (!document.hidden) act(() => api.updateStatus()); }, 1000);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
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
      set('webBrain', info.webBrain ? `${info.webBrain.version} (${info.webBrain.id})` : t('page.about.notInBuild'));
      const c = info.companion;
      set('companion', c.running
        ? t('page.about.companionRunning', { address: `127.0.0.1:${c.port}` })
        : c.found ? t('page.about.companionStopped', { path: c.path }) : t('page.about.companionMissing'));
    });
  }

  // Load error -----------------------------------------------------------------------
  if (page === 'error') {
    const params = new URLSearchParams(location.search);
    const url = params.get('url') || '';
    let host = url;
    try { host = new URL(url).host || url; } catch {}
    $('host').textContent = host || t('page.error.thePage');
    $('url').textContent = url;
    const description = params.get('description') || '';
    $('code').textContent = `${description} (${params.get('code') || '?'})`;
    // A plain-language reason for the common errors (page.error.ERR_* strings).
    const reason = /^ERR_[A-Z_]+$/.test(description) ? `page.error.${description}` : '';
    $('why').textContent = reason && strings[reason] ? strings[reason] : '';
    $('retry').addEventListener('click', () => { if (url) api?.navigate(url); });
  }
})();
