'use strict';

// Turning what someone types into the address bar into a URL, and mapping the
// chrome:// pages people (and WebBrain) expect onto Murshid's own pages.

const INTERNAL_ALIASES = {
  'chrome://newtab': 'murshid://newtab',
  'chrome://newtab/': 'murshid://newtab',
  'chrome://new-tab-page': 'murshid://newtab',
  'chrome://new-tab-page/': 'murshid://newtab',
  'about:newtab': 'murshid://newtab',
  'about:home': 'murshid://newtab',
  'chrome://settings': 'murshid://settings',
  'chrome://settings/': 'murshid://settings',
  'chrome://version': 'murshid://about',
  'chrome://version/': 'murshid://about',
  'chrome://extensions': 'murshid://about',
  'chrome://extensions/': 'murshid://about',
  'about:version': 'murshid://about',
  'about:murshid': 'murshid://about',
  'murshid://': 'murshid://newtab',
};

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:', 'murshid:', 'chrome-extension:', 'data:', 'view-source:', 'about:']);

function mapInternal(url) {
  if (typeof url !== 'string') return url;
  const key = url.trim().toLowerCase();
  return INTERNAL_ALIASES[key] || url;
}

function looksLikeHost(text) {
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return true;
  if (/^\[[0-9a-f:]+\](:\d+)?(\/|$)/i.test(text)) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(text)) return true;
  // host.tld[:port][/path] with a tld of 2+ letters (or punycode).
  return /^([a-z0-9-]+\.)+([a-z]{2,63}|xn--[a-z0-9-]+)(:\d+)?([/?#]|$)/i.test(text);
}

/**
 * @param {string} input   what was typed
 * @param {(q: string) => string} searchUrl
 * @returns {string} a URL to load
 */
function resolveInput(input, searchUrl) {
  const text = String(input || '').trim();
  if (!text) return 'murshid://newtab';

  const aliased = mapInternal(text);
  if (aliased !== text) return aliased;

  if (/\s/.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return searchUrl(text);

  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    try {
      const parsed = new URL(text);
      if (ALLOWED_SCHEMES.has(parsed.protocol)) return parsed.href;
      if (parsed.protocol === 'chrome:') return mapInternal(parsed.href);
    } catch {
      // Fall through: "foo:bar" that isn't a URL is a search.
    }
    if (looksLikeHost(text)) return `https://${text}`;
    return searchUrl(text);
  }

  if (looksLikeHost(text)) {
    const isLocal = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(text)
      || /\.(localhost|test|local)(:\d+)?([/?#]|$)/i.test(text);
    return `${isLocal ? 'http' : 'https'}://${text}`;
  }
  return searchUrl(text);
}

/** What the address bar shows for a URL (empty for the new tab page). */
function displayUrl(url, newTabUrls) {
  if (!url) return '';
  if (newTabUrls.some((candidate) => candidate && url.split(/[?#]/)[0] === candidate)) return '';
  if (url === 'about:blank') return '';
  return url;
}

module.exports = { resolveInput, displayUrl, mapInternal, looksLikeHost };
