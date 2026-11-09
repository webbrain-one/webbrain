import { createRequestDeadline, readResponseText, responseAbortError } from './response-body.js';
import { prepareAuthenticatedDownload, createAuthenticatedDownloadJobs, createDiskDownloadStore } from './download-staging.js';
import { isMastodonPublicMediaUrl } from '../agent/public-media-url.js';
import { isKnownMastodonHost } from '../agent/adapters.js';
import { firefoxRestrictedDomainFailure } from '../firefox-restricted-domains.js';
import { filenameInConfiguredDownloadDirectory } from '../download-directory.js';

/**
 * Network & download tools for the WebBrain agent (Firefox).
 *
 * Same surface as the chrome version but uses browser.* APIs and
 * browser.tabs.executeScript instead of chrome.scripting.executeScript.
 * MV2 background pages support DOMParser, but we use the same regex
 * stripping for consistency with the chrome MV3 service worker version.
 */

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&#160;': ' ',
  '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
  '&laquo;': '«', '&raquo;': '»', '&copy;': '©', '&reg;': '®',
  '&trade;': '™',
};

function decodeEntities(s) {
  return s
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => HTML_ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function htmlToText(html) {
  if (!html) return { title: '', text: '' };
  let s = html;
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
  s = s.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|article|section|header|footer)[^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: s };
}

// fetch_url returns a semantic character window rather than relying on the
// agent's generic result truncation. This keeps continuation metadata aligned
// with the text the model actually received and gives large source files a
// deterministic search/pagination path.
const FETCH_BODY_MAX_BYTES = 8 * 1024 * 1024;
const FETCH_REQUEST_TIMEOUT_MS = 30000;
const FETCH_TEXT_DEFAULT_LIMIT = 7000;
const FETCH_TEXT_MIN_LIMIT = 1000;
const FETCH_TEXT_MAX_LIMIT = 7000;
const FETCH_RESULT_MAX_CHARS = 8000;
const FETCH_FIND_MAX_MATCHES = 20;
const FETCH_FIND_CONTEXT_CHARS = 120;
// Other network helpers keep their existing generous one-shot caps.
const FETCH_TEXT_LIMIT = 192000;
const FETCH_JSON_LIMIT = 96000;
const PAGE_SOURCE_DEFAULT_LIMIT = 6000;
const PAGE_SOURCE_MIN_LIMIT = 1000;
const PAGE_SOURCE_MAX_LIMIT = 7000;
const PAGE_SOURCE_RESULT_MAX_CHARS = 8000;
const PAGE_SOURCE_RESULT_SAFETY_CHARS = 200;
const PAGE_SOURCE_ASSET_KINDS = ['stylesheets', 'scripts'];
const PAGE_SOURCE_BODY_MAX_BYTES = 1000000;
const SKILL_DOWNLOAD_DATA_URL_MAX_BYTES = 25 * 1024 * 1024;
const SKILL_DOWNLOAD_STAGED_MAX_BYTES = 1024 * 1024 * 1024;
const REMOTE_MEDIA_FAILURE_CONTEXT = Object.freeze({
  executionContext: 'remote_service',
  browserLoginAffectsRequest: false,
  retryGuidance: 'The media provider runs on a separate server. Signing into this browser or retrying while logged in will not change the provider request. Try the exact public media permalink or retry later.',
});

function fetchTextWindow(source, opts = {}, field = 'text') {
  const text = String(source ?? '');
  const originalLength = text.length;
  const find = String(opts.find ?? '').trim().slice(0, 200);
  if (find) {
    const haystack = text.toLowerCase();
    const needle = find.toLowerCase();
    const matches = [];
    let index = haystack.indexOf(needle);
    while (index >= 0 && matches.length < FETCH_FIND_MAX_MATCHES) {
      const start = Math.max(0, index - FETCH_FIND_CONTEXT_CHARS);
      const end = Math.min(text.length, index + needle.length + FETCH_FIND_CONTEXT_CHARS);
      const line = 1 + (text.slice(0, index).match(/\n/g) || []).length;
      matches.push({
        offset: index,
        line,
        text: text.slice(start, end).replace(/\s+/g, ' ').trim(),
      });
      index = haystack.indexOf(needle, index + Math.max(1, needle.length));
    }
    const matchesTruncated = index >= 0;
    return {
      find,
      matches,
      matchCount: matches.length,
      matchesTruncated,
      originalLength,
      nextOffset: null,
      hasMore: false,
      truncated: matchesTruncated,
    };
  }

  const offset = Math.min(
    originalLength,
    Math.max(0, Math.floor(Number(opts.offset) || 0)),
  );
  const rawMaxChars = Number(opts.maxChars);
  const requested = Number.isFinite(rawMaxChars)
    ? rawMaxChars
    : FETCH_TEXT_DEFAULT_LIMIT;
  const maxChars = Math.max(
    FETCH_TEXT_MIN_LIMIT,
    Math.min(FETCH_TEXT_MAX_LIMIT, Math.floor(requested)),
  );
  const end = Math.min(text.length, offset + maxChars);
  const nextOffset = end < text.length ? end : null;
  return {
    [field]: text.slice(offset, end),
    offset,
    maxChars: end - offset,
    nextOffset,
    hasMore: nextOffset != null,
    truncated: nextOffset != null,
    originalLength,
  };
}

function constrainFetchTextResult(result, field, maxResultChars = FETCH_RESULT_MAX_CHARS) {
  if (JSON.stringify(result).length <= maxResultChars) return result;

  if (Array.isArray(result.matches)) {
    const fitted = {
      ...result,
      matches: result.matches.map(match => ({
        ...match,
        text: String(match.text || '').slice(0, 180),
      })),
    };
    while (fitted.matches.length && JSON.stringify(fitted).length > maxResultChars) {
      fitted.matches.pop();
    }
    fitted.matchesTruncated = result.matchesTruncated || fitted.matchCount > fitted.matches.length;
    fitted.truncated = fitted.matchesTruncated;
    return fitted;
  }

  const delivered = typeof result[field] === 'string' ? result[field] : '';
  let best = { ...result, [field]: '', maxChars: 0 };
  let low = 0;
  let high = delivered.length;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const nextOffset = result.offset + length < result.originalLength
      ? result.offset + length
      : null;
    const candidate = {
      ...result,
      [field]: delivered.slice(0, length),
      maxChars: length,
      nextOffset,
      hasMore: nextOffset != null,
      truncated: nextOffset != null,
    };
    if (JSON.stringify(candidate).length <= maxResultChars) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

function safeFetchResponseMetadata(headers) {
  const read = (name, limit) => String(headers?.get?.(name) || '').trim().slice(0, limit);
  const contentRange = read('content-range', 200);
  const acceptRanges = read('accept-ranges', 80);
  const contentLength = parseContentLength(read('content-length', 40));
  return {
    ...(contentRange ? { contentRange } : {}),
    ...(acceptRanges ? { acceptRanges } : {}),
    ...(contentLength != null ? { contentLength } : {}),
  };
}

/**
 * Validate a URL before the agent fetches it.
 *
 * The LLM-callable fetch tools run in the background page with broad host
 * permissions. Without this gate, prompt-injected text on a visited page can
 * steer the agent into:
 *   - reading cloud instance-metadata endpoints (169.254.169.254, etc.),
 *   - probing the user's intranet / RFC1918 hosts,
 *   - fetching local services (Ollama, Grafana, internal admin panels),
 *   - using non-http schemes (file:, moz-extension:, javascript:, data:).
 *
 * Returns { ok: true } if the URL is safe, or { ok: false, error } otherwise.
 *
 * Two tiers of blocks:
 *   - ALWAYS-BLOCKED: non-http schemes, cloud-metadata IPs/hostnames,
 *     link-local IPv6, multicast/reserved, *.internal/*.local. Never relaxed.
 *   - LOCAL-NETWORK: loopback, RFC1918, unique-local IPv6, `localhost`,
 *     *.localhost. Relaxed when opts.allowLocalNetwork is true.
 */
export function validateFetchUrl(rawUrl, opts = {}) {
  const allowLocal = !!opts.allowLocalNetwork;

  let u;
  try { u = new URL(rawUrl); }
  catch (_) { return { ok: false, error: `Invalid URL: ${rawUrl}` }; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `Unsupported URL scheme: ${u.protocol} (only http/https allowed)` };
  }

  let host = (u.hostname || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return { ok: false, error: 'URL has no hostname.' };

  const ALWAYS_BLOCKED_HOSTS = new Set([
    'metadata.google.internal',
    'metadata.goog',
    'metadata.aws.internal',
    'metadata.azure.com',
  ]);
  if (ALWAYS_BLOCKED_HOSTS.has(host) ||
      host.endsWith('.internal') ||
      host.endsWith('.local')) {
    return { ok: false, error: `Blocked hostname: ${host}` };
  }
  if (!allowLocal && (host === 'localhost' || host.endsWith('.localhost'))) {
    return { ok: false, error: `Blocked local hostname: ${host} (enable "Allow agent to access local network" in settings to permit)` };
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const o = ipv4.slice(1).map((n) => parseInt(n, 10));
    if (o.some((n) => Number.isNaN(n) || n > 255)) {
      return { ok: false, error: `Invalid IPv4: ${host}` };
    }
    if (o[0] === 0) return { ok: false, error: `Blocked unspecified IPv4: ${host}` };
    if (o[0] === 169 && o[1] === 254) return { ok: false, error: `Blocked link-local IPv4 (cloud metadata): ${host}` };
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return { ok: false, error: `Blocked CGNAT IPv4: ${host}` };
    if (o[0] >= 224) return { ok: false, error: `Blocked multicast/reserved IPv4: ${host}` };
    if (!allowLocal) {
      const localHint = ' (enable "Allow agent to access local network" in settings to permit)';
      if (o[0] === 10) return { ok: false, error: `Blocked private IPv4: ${host}${localHint}` };
      if (o[0] === 127) return { ok: false, error: `Blocked loopback IPv4: ${host}${localHint}` };
      if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return { ok: false, error: `Blocked private IPv4: ${host}${localHint}` };
      if (o[0] === 192 && o[1] === 168) return { ok: false, error: `Blocked private IPv4: ${host}${localHint}` };
    }
  }

  if (host.includes(':')) {
    if (/^fe[89ab][0-9a-f]?:/i.test(host)) {
      return { ok: false, error: `Blocked link-local IPv6: ${host}` };
    }
    if (host === '::') {
      return { ok: false, error: `Blocked unspecified IPv6: ${host}` };
    }
    if (!allowLocal) {
      const localHint = ' (enable "Allow agent to access local network" in settings to permit)';
      if (host === '::1' || /^0:0:0:0:0:0:0:[01]$/.test(host)) {
        return { ok: false, error: `Blocked loopback IPv6: ${host}${localHint}` };
      }
      if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) {
        return { ok: false, error: `Blocked unique-local IPv6: ${host}${localHint}` };
      }
    }
    // IPv4-mapped IPv6. URL parser normalizes `::ffff:127.0.0.1` to
    // `::ffff:7f00:1`, so match either form, decode the last two hextets
    // to a v4 address, and re-validate (passing through opts).
    const mappedDotted = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    const mappedHex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    let mappedV4 = null;
    if (mappedDotted) {
      mappedV4 = mappedDotted[1];
    } else if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      mappedV4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    if (mappedV4) {
      return validateFetchUrl(`${u.protocol}//${mappedV4}${u.pathname}${u.search}${u.hash}`, opts);
    }
  }

  return { ok: true };
}

// ─── Resolved-address check ─────────────────────────────────────────────

// validateFetchUrl() sees only the URL text, so a public hostname whose DNS
// answer is loopback, RFC1918, unique-local or link-local (cloud metadata)
// passes it. Firefox can resolve the name first (the "dns" permission), so a
// hostname with any blocked answer is refused before anything is sent.
// fetch() cannot pin that answer, and redirects reach other names, so the
// tools also read the address the browser actually connected to from
// webRequest (details.ip) and discard the response when it is blocked.
// Chrome has no DNS API and relies on the webRequest check alone.
const RESPONSE_ADDRESS_WAIT_MS = 1500;
const RESPONSE_ADDRESS_EVENTS = ['onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred'];

/**
 * Classify a resolved address with the same tiers as validateFetchUrl():
 * metadata/link-local, CGNAT, multicast and unspecified are always blocked;
 * loopback, RFC1918 and unique-local only while local-network access is off.
 * IPv4-mapped IPv6 is decoded and classified as IPv4.
 */
export function validateResolvedAddress(address, opts = {}) {
  let ip = String(address || '').trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const literal = ip.includes(':') ? `[${ip}]` : ip;
  let host = '';
  try { host = new URL(`http://${literal}/`).hostname; } catch (_) {}
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.startsWith('[')) {
    return { ok: false, error: `Invalid resolved address: ${address}` };
  }
  return validateFetchUrl(`http://${host}/`, opts);
}

function blockedAddressError(url, reason) {
  let host = '';
  try { host = new URL(url).hostname; } catch (_) {}
  return `${host || url} resolved to a blocked address. ${reason}`;
}

/**
 * Resolve the URL's hostname before sending and refuse it when any answer is
 * blocked: the browser may connect to any of them. A failed lookup is left
 * to the request itself, since a configured proxy may still reach the host;
 * the response address check still applies. Strict callers require a nonempty,
 * validated DNS answer before trusting a proxy that hides the destination IP.
 */
export async function resolvedHostFailure(rawUrl, allowLocal, { requireAddress = false } = {}) {
  const unverified = requireAddress ? 'Cannot verify the PDF destination resolved address.' : null;
  let host;
  try { host = new URL(rawUrl).hostname; } catch (_) { return unverified; }
  // IP literals were already classified by validateFetchUrl().
  if (!host || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (typeof globalThis.browser?.dns?.resolve !== 'function') return unverified;
  let record;
  try { record = await globalThis.browser.dns.resolve(host); } catch (_) { return unverified; }
  if (!record?.addresses?.length) return unverified;
  for (const address of record.addresses) {
    const check = validateResolvedAddress(address, { allowLocalNetwork: allowLocal });
    if (!check.ok) return blockedAddressError(rawUrl, check.error);
  }
  return null;
}

/**
 * Record the address each matching webRequest event reports. keyOf(details)
 * names the request or tab an event belongs to (null to ignore it). Returns
 * null when webRequest is unavailable.
 */
function watchResponseAddresses(filter, keyOf, allowLocal, requireAddress = false, proxyDestinationVerified = false) {
  const webRequest = globalThis.browser?.webRequest;
  if (RESPONSE_ADDRESS_EVENTS.some(name => typeof webRequest?.[name]?.addListener !== 'function')) return null;
  const seen = new Set();
  const verified = new Set();
  const failures = new Map();
  const waiters = new Set();
  const listener = (details) => {
    const key = keyOf(details);
    if (key == null) return;
    seen.add(key);
    // A proxied request reports the proxy's address, not the destination's;
    // only the DNS check before sending applies to it.
    const proxied = details.proxyInfo && details.proxyInfo.type !== 'direct';
    // Strict PDF reads may accept a proxy event only after the caller has
    // validated every destination DNS answer (or the literal URL address).
    if (proxied && proxyDestinationVerified) verified.add(key);
    if (details.ip && !proxied && !failures.has(key)) {
      const check = validateResolvedAddress(details.ip, { allowLocalNetwork: allowLocal });
      if (!check.ok) failures.set(key, blockedAddressError(details.url, check.error));
      else verified.add(key);
    }
    for (const wake of waiters) wake();
  };
  const added = [];
  try {
    for (const name of RESPONSE_ADDRESS_EVENTS) {
      webRequest[name].addListener(listener, { urls: ['<all_urls>'], ...filter });
      added.push(name);
    }
  } catch (_) {
    for (const name of added) webRequest[name].removeListener(listener);
    return null;
  }
  return {
    failure: key => failures.get(key) || null,
    // fetch() and webRequest events are delivered separately, so fetch() can
    // resolve before the response's event arrives. Wait briefly for it.
    async settledFailure(key, timeoutMs = RESPONSE_ADDRESS_WAIT_MS) {
      const settled = () => requireAddress ? verified.has(key) || failures.has(key) : seen.has(key);
      if (!settled()) {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
          const wake = () => { if (settled()) done(); };
          const timer = setTimeout(done, timeoutMs);
          waiters.add(wake);
        });
      }
      return failures.get(key) || (requireAddress && !verified.has(key)
        ? 'Cannot verify the PDF response resolved address.' : null);
    },
    close() {
      for (const name of added) {
        try { webRequest[name].removeListener(listener); } catch (_) {}
      }
    },
  };
}

// The extension's own background fetch: tab -1, keyed by its URL (webRequest
// reports URLs without the fragment).
export function watchFetchAddresses(url, allowLocal, { requireAddress = false, proxyDestinationVerified = false } = {}) {
  let target;
  try {
    const u = new URL(url);
    u.hash = '';
    target = u.href;
  } catch (_) { return null; }
  return watchResponseAddresses({ tabId: -1 }, d => (d.url === target ? 'fetch' : null), allowLocal, requireAddress, proxyDestinationVerified);
}

// ─── Same-eTLD+1 cookie policy ──────────────────────────────────────────

/**
 * Best-effort registrable-domain (eTLD+1) extractor. Used to decide whether
 * an agent-driven fetch should attach the user's cookies. See chrome's copy
 * for the full rationale.
 */
const KNOWN_MULTI_LABEL_TLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in', 'co.il', 'co.th',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'com.hk',
  'com.tw', 'com.ar', 'com.co', 'com.pe', 'com.ph', 'com.my', 'com.vn',
  'gov.uk', 'gov.au', 'gov.in', 'gov.cn',
  'ac.uk', 'ac.jp', 'ac.in', 'ac.kr',
  'org.uk', 'org.au', 'org.nz',
  'net.au', 'net.uk',
  'github.io', 'gitlab.io',
  'netlify.app', 'netlify.com',
  'vercel.app',
  'pages.dev', 'workers.dev',
  'herokuapp.com', 'firebaseapp.com', 'web.app', 'glitch.me',
  'cloudfront.net', 'azurewebsites.net',
  'r2.dev', 'github.dev',
]);

export function registrableDomain(host) {
  if (!host) return host;
  const lower = String(host).toLowerCase();
  if (lower.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(lower)) return lower;
  const parts = lower.split('.');
  if (parts.length < 2) return lower;
  const last2 = parts.slice(-2).join('.');
  if (parts.length >= 3 && KNOWN_MULTI_LABEL_TLDS.has(last2)) {
    return parts.slice(-3).join('.');
  }
  return last2;
}

// ─── Allow-local-network setting (cached) ───────────────────────────────

let _allowLocalNetwork = false;
try {
  // Firefox: prefer browser.* but tolerate chrome.* polyfills.
  const storageApi = (typeof browser !== 'undefined' && browser.storage)
    ? browser.storage
    : (typeof chrome !== 'undefined' ? chrome.storage : null);
  if (storageApi) {
    Promise.resolve(storageApi.local.get('agentAllowLocalNetwork')).then((r) => {
      _allowLocalNetwork = !!(r && r.agentAllowLocalNetwork);
    }).catch(() => {});
    storageApi.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.agentAllowLocalNetwork) {
        _allowLocalNetwork = !!changes.agentAllowLocalNetwork.newValue;
      }
    });
  }
} catch (_) { /* storage not available — default false */ }

export function getAllowLocalNetwork() {
  return _allowLocalNetwork;
}

async function currentTabUrl(tabId) {
  if (tabId == null) return '';
  try {
    const tab = await browser.tabs.get(tabId);
    return tab?.url || '';
  } catch (_) {
    return '';
  }
}

function providerError(status, data, rawText) {
  const detail = data?.detail || data?.error || data?.message || rawText || `HTTP ${status}`;
  return typeof detail === 'string' ? detail.slice(0, 1000) : JSON.stringify(detail).slice(0, 1000);
}

// Unknown instances must identify their software independently of the status
// path. Probe only public metadata on that origin, never the supplied post URL.
async function verifyMastodonInstance(origin) {
  const deadline = createRequestDeadline({ timeoutMs: 10000 });
  const readJson = async (url) => {
    const response = await fetch(url, {
      method: 'GET', headers: { Accept: 'application/json' },
      credentials: 'omit', redirect: 'manual', signal: deadline.signal,
    });
    if (!response.ok || response.type === 'opaqueredirect'
      || (response.url && response.url !== url)) return null;
    const body = await readResponseText(response, {
      signal: deadline.signal, maxBytes: 65536, idleTimeoutMs: 10000,
    });
    return body.exceeded ? null : JSON.parse(body.text);
  };
  try {
    const discovery = await readJson(`${origin}/.well-known/nodeinfo`);
    const links = Array.isArray(discovery?.links) ? discovery.links : [];
    const link = ['2.1', '2.0'].map(version => links.find(item =>
      item?.rel === `http://nodeinfo.diaspora.software/ns/schema/${version}`)).find(Boolean);
    if (!link || typeof link.href !== 'string') return false;
    const metadataUrl = new URL(link.href);
    if (metadataUrl.origin !== origin || metadataUrl.username || metadataUrl.password) return false;
    const metadata = await readJson(metadataUrl.href);
    return metadata?.software?.name === 'mastodon';
  } catch (_) {
    return false;
  } finally {
    deadline.dispose();
  }
}

async function allowedSkillInputUrl(rawUrl, rules = []) {
  if (!rules.length) return rawUrl;
  let u;
  try { u = new URL(rawUrl); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname || '/';
  for (const rule of rules) {
    if (rule.siteAdapter === 'mastodon') {
      // URL already normalizes Unicode domains to IDNA. Check DNS labels rather
      // than requiring an alphabetic TLD, which would reject punycoded TLDs.
      const labels = host.split('.');
      const publicDomain = host.length <= 253 && labels.length > 1
        && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
        && !/^\d+$/.test(labels.at(-1))
        && !/\.(?:local|internal|localhost|lan|home|corp)$/i.test(host);
      if (u.protocol !== 'https:' || u.username || u.password || u.port
        || !publicDomain || !validateFetchUrl(rawUrl).ok || !isMastodonPublicMediaUrl(rawUrl)) continue;
      if (isKnownMastodonHost(host) || await verifyMastodonInstance(u.origin)) {
        // A public status needs only its path; never forward query tokens.
        return `${u.origin}${path}`;
      }
      continue;
    }
    const ruleHost = String(rule.host || '').toLowerCase();
    if (!ruleHost || !(host === ruleHost || host.endsWith(`.${ruleHost}`))) continue;
    const paths = Array.isArray(rule.paths) && rule.paths.length ? rule.paths : ['/'];
    if (paths.some(prefix => path.startsWith(String(prefix || '/')))) return rawUrl;
  }
  return null;
}

function applySkillResponseLimits(value, limits = {}) {
  if (!value || typeof value !== 'object') return value;
  const rawMaxTextChars = limits.maxTextChars;
  const unlimitedText = rawMaxTextChars === 'unlimited';
  const maxTextChars = unlimitedText
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(Number(rawMaxTextChars)) ? Math.max(1000, Number(rawMaxTextChars)) : 160000;
  const arrayLimits = limits.maxArrayItems && typeof limits.maxArrayItems === 'object' ? limits.maxArrayItems : {};
  const out = Array.isArray(value) ? [...value] : { ...value };
  for (const [key, item] of Object.entries(out)) {
    if (typeof item === 'string' && item.length > maxTextChars) {
      out[key] = item.slice(0, maxTextChars);
      out.truncated = true;
      out.originalLength = out.originalLength ?? item.length;
    } else if (Array.isArray(item)) {
      const limit = Number(arrayLimits[key]);
      if (Number.isFinite(limit) && limit >= 0 && item.length > limit) {
        out[key] = item.slice(0, limit);
        out.truncated = true;
      }
    }
  }
  return out;
}

function isHttpRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function filterArgsToDeclaredParameters(args, tool) {
  const properties = tool?.parameters?.properties;
  if (!properties || typeof properties !== 'object') return {};
  const allowed = new Set(Object.keys(properties));
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (!allowed.has(key)) continue;
    const schema = properties[key] || {};
    const type = schema.type;
    const isNumeric = type === 'number' || type === 'integer';
    if (isNumeric && value != null && value !== '') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        let next = type === 'integer' ? Math.trunc(numeric) : numeric;
        const min = Number(schema.minimum);
        const max = Number(schema.maximum);
        if (Number.isFinite(min)) next = Math.max(min, next);
        if (Number.isFinite(max)) next = Math.min(max, next);
        out[key] = next;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function fillSkillJobEndpoint(template, jobId, baseEndpoint, label) {
  if (!template) return { ok: false, error: `Skill download job is missing ${label}.` };
  let url;
  try {
    url = new URL(template.replace(/\{job_id\}/g, encodeURIComponent(jobId)));
  } catch {
    return { ok: false, error: `Skill download job has an invalid ${label}.` };
  }
  if (url.protocol !== 'https:') return { ok: false, error: `Skill download job ${label} must use https.` };
  if (baseEndpoint && url.origin !== baseEndpoint.origin) {
    return { ok: false, error: `Skill download job ${label} must stay on ${baseEndpoint.origin}.` };
  }
  return { ok: true, url: url.href };
}

function safeDownloadFilename(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || '';
  const safe = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return safe || undefined;
}

function contentDispositionParameters(value) {
  const header = String(value || '').slice(0, 2048);
  const parameters = new Map();
  let index = header.indexOf(';');
  if (index < 0) return parameters;

  while (index < header.length) {
    if (header[index] === ';') index += 1;
    while (index < header.length && /\s/.test(header[index])) index += 1;
    const nameStart = index;
    while (index < header.length && header[index] !== '=' && header[index] !== ';') index += 1;
    if (index >= header.length || header[index] !== '=') {
      while (index < header.length && header[index] !== ';') index += 1;
      continue;
    }
    const name = header.slice(nameStart, index).trim().toLowerCase();
    index += 1;
    while (index < header.length && /\s/.test(header[index])) index += 1;

    let parsed = '';
    let valid = true;
    if (header[index] === '"') {
      index += 1;
      let closed = false;
      while (index < header.length) {
        const char = header[index];
        if (char === '\\') {
          if (index + 1 >= header.length) {
            valid = false;
            break;
          }
          parsed += header[index + 1];
          index += 2;
          continue;
        }
        if (char === '"') {
          closed = true;
          index += 1;
          break;
        }
        parsed += char;
        index += 1;
      }
      if (!closed) {
        // The rest of the header is ambiguous because semicolons may belong
        // to the unterminated quoted value. Keep earlier parameters only.
        break;
      }
      while (index < header.length && /\s/.test(header[index])) index += 1;
      if (index < header.length && header[index] !== ';') valid = false;
    } else {
      const valueStart = index;
      while (index < header.length && header[index] !== ';') index += 1;
      parsed = header.slice(valueStart, index).trim();
    }

    if (valid && name && parsed && !parameters.has(name)) parameters.set(name, parsed);
    while (index < header.length && header[index] !== ';') index += 1;
  }
  return parameters;
}

export function filenameFromContentDisposition(value) {
  const parameters = contentDispositionParameters(value);
  const extended = parameters.get('filename*');
  if (extended) {
    let encoded = extended;
    const charsetEnd = encoded.indexOf("'");
    const languageEnd = charsetEnd >= 0 ? encoded.indexOf("'", charsetEnd + 1) : -1;
    if (languageEnd >= 0) encoded = encoded.slice(languageEnd + 1);
    try { encoded = decodeURIComponent(encoded); } catch (_) {}
    const safe = safeDownloadFilename(encoded);
    if (safe) return safe;
  }

  return safeDownloadFilename(parameters.get('filename'));
}

async function filenameForConfiguredDownload(filename) {
  const explicitFilename = safeDownloadFilename(filename);
  return filenameInConfiguredDownloadDirectory(browser, explicitFilename);
}

function defaultSkillDownloadFilename(contentType) {
  const type = safeDataUrlMimeType(contentType);
  const extension = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }[type];
  return extension ? `public-media.${extension}` : undefined;
}

function throwIfSkillAborted(signal) {
  if (signal?.aborted) throw responseAbortError(signal);
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(responseAbortError(signal));
    if (!signal?.addEventListener) {
      setTimeout(resolve, ms);
      return;
    }
    const timer = setTimeout(() => {
      try { signal.removeEventListener('abort', onAbort); } catch {}
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(responseAbortError(signal));
    };
    try { signal.addEventListener('abort', onAbort, { once: true }); } catch {
      // If the signal cannot be observed, fall back to an uninterruptible sleep.
    }
  });
}

async function fetchSkillJson(url, init, endpoint, tool, signal = null) {
  const urlCheck = validateFetchUrl(url, { allowLocalNetwork: getAllowLocalNetwork() });
  if (!urlCheck.ok) {
    return {
      success: false,
      provider: endpoint.hostname,
      skillTool: tool.name || '',
      skillName: tool.skillName || '',
      finalUrl: url,
      error: `Skill tool endpoint is blocked: ${urlCheck.error}`,
    };
  }
  try {
    throwIfSkillAborted(signal);
    const res = await fetch(url, {
      credentials: 'omit',
      redirect: 'manual',
      ...init,
      ...(signal ? { signal } : {}),
    });
    if (res?.type === 'opaqueredirect' || isHttpRedirectStatus(res?.status)) {
      return {
        success: false,
        status: res.status,
        provider: endpoint.hostname,
        skillTool: tool.name || '',
        skillName: tool.skillName || '',
        finalUrl: url,
        error: 'Skill tool redirects are not allowed because browser manual redirects cannot be validated before following.',
      };
    }
    const responseUrl = res.url || url;
    const responseUrlCheck = validateFetchUrl(responseUrl, { allowLocalNetwork: getAllowLocalNetwork() });
    if (!responseUrlCheck.ok) {
      return {
        success: false,
        status: res.status,
        provider: endpoint.hostname,
        skillTool: tool.name || '',
        skillName: tool.skillName || '',
        finalUrl: responseUrl,
        error: `Skill tool redirected to blocked URL: ${responseUrlCheck.error}`,
      };
    }
    const rawText = await res.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch (_) {}
    if (!res.ok) {
      return {
        success: false,
        status: res.status,
        provider: endpoint.hostname,
        skillTool: tool.name || '',
        skillName: tool.skillName || '',
        error: providerError(res.status, data, rawText),
      };
    }
    return { success: true, status: res.status, data: data && typeof data === 'object' ? data : { text: rawText } };
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw responseAbortError(signal);
    return { success: false, provider: endpoint.hostname, skillTool: tool.name || '', skillName: tool.skillName || '', error: `Skill tool request failed: ${e.message}` };
  }
}

async function cleanupSkillDownloadJob(url, endpoint, tool) {
  const result = await fetchSkillJson(url, { method: 'DELETE' }, endpoint, tool);
  if (result.success) return { success: true, status: result.status };
  return { success: false, status: result.status, error: result.error };
}

async function withSkillDownloadJobCleanup(result, cleanupEndpoint, endpoint, tool) {
  if (!cleanupEndpoint?.ok) return result;
  const cleanup = await cleanupSkillDownloadJob(cleanupEndpoint.url, endpoint, tool);
  return { ...result, cleanup };
}

const pendingSkillDownloadCleanups = new Map();

function summarizeDownloadItem(item) {
  if (!item) return null;
  return {
    filename: item.filename || null,
    state: item.state,
    error: item.error || null,
    bytesReceived: item.bytesReceived ?? null,
    totalBytes: item.totalBytes ?? null,
    url: item.url || null,
    finalUrl: item.finalUrl || item.url || null,
  };
}

async function findDownloadItem(downloadId) {
  try {
    const items = await browser.downloads.search({ id: downloadId });
    return items && items[0] ? items[0] : null;
  } catch {
    return null;
  }
}

function validateSkillDownloadFinalUrl(finalUrl, expectedUrl) {
  if (!finalUrl) return { ok: true };
  let final;
  let expected;
  try {
    final = new URL(finalUrl);
    expected = new URL(expectedUrl);
  } catch {
    return { ok: false, error: 'Skill download redirected to an invalid URL.' };
  }
  if (final.protocol !== 'https:') {
    return { ok: false, error: 'Skill download redirected away from HTTPS.' };
  }
  const urlCheck = validateFetchUrl(final.href, { allowLocalNetwork: getAllowLocalNetwork() });
  if (!urlCheck.ok) {
    return { ok: false, error: `Skill download redirected to blocked URL: ${urlCheck.error}` };
  }
  if (final.origin !== expected.origin) {
    return { ok: false, error: `Skill download redirected outside ${expected.origin}.` };
  }
  return { ok: true, finalUrl: final.href };
}

function markUnsafeSkillDownload(info, expectedUrl) {
  if (!info?.finalUrl || !expectedUrl) return info;
  const finalUrlCheck = validateSkillDownloadFinalUrl(info.finalUrl, expectedUrl);
  if (finalUrlCheck.ok) return info;
  return {
    ...info,
    finalUrlBlocked: true,
    finalUrlError: finalUrlCheck.error,
  };
}

function safeDataUrlMimeType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)
    ? type
    : 'application/octet-stream';
}

function arrayBufferToDataUrl(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${safeDataUrlMimeType(mimeType)};base64,${btoa(binary)}`;
}

function skillDownloadTooLargeError(size) {
  return `Skill download exceeds the in-memory encoding cutoff and requires local staging (${size} bytes > ${SKILL_DOWNLOAD_DATA_URL_MAX_BYTES} bytes).`;
}

async function readSkillDownloadBuffer(res) {
  const expectedSize = parseContentLength(res.headers?.get?.('content-length'));
  if (expectedSize != null && expectedSize > SKILL_DOWNLOAD_DATA_URL_MAX_BYTES) {
    try { await res.body?.cancel?.(); } catch (_) {}
    return {
      success: false,
      tooLarge: true,
      bytesExpected: expectedSize,
      error: skillDownloadTooLargeError(expectedSize),
    };
  }

  const reader = res.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let bytesReceived = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      bytesReceived += chunk.byteLength;
      if (bytesReceived > SKILL_DOWNLOAD_DATA_URL_MAX_BYTES) {
        try { await reader.cancel(); } catch (_) {}
        return {
          success: false,
          tooLarge: true,
          bytesReceived,
          error: skillDownloadTooLargeError(bytesReceived),
        };
      }
      chunks.push(chunk);
    }
    const buffer = new ArrayBuffer(bytesReceived);
    const out = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { success: true, buffer, bytesReceived };
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > SKILL_DOWNLOAD_DATA_URL_MAX_BYTES) {
    return {
      success: false,
      tooLarge: true,
      bytesReceived: buffer.byteLength,
      error: skillDownloadTooLargeError(buffer.byteLength),
    };
  }
  return { success: true, buffer, bytesReceived: buffer.byteLength };
}

async function fetchSkillDownloadData(url, expectedUrl, signal = null) {
  const initialUrlCheck = validateSkillDownloadFinalUrl(url, expectedUrl);
  if (!initialUrlCheck.ok) {
    return { success: false, blocked: true, finalUrl: url, error: initialUrlCheck.error };
  }
  try {
    throwIfSkillAborted(signal);
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (res?.type === 'opaqueredirect' || isHttpRedirectStatus(res?.status)) {
      return {
        success: false,
        blocked: true,
        status: res.status,
        finalUrl: url,
        error: 'Skill download redirects are not allowed because the final URL cannot be validated before saving.',
      };
    }
    const responseUrl = res.url || url;
    const responseUrlCheck = validateSkillDownloadFinalUrl(responseUrl, expectedUrl);
    if (!responseUrlCheck.ok) {
      return {
        success: false,
        blocked: true,
        status: res.status,
        finalUrl: responseUrl,
        error: responseUrlCheck.error,
      };
    }
    if (!res.ok) {
      return {
        success: false,
        status: res.status,
        finalUrl: responseUrl,
        error: `Skill download file request failed with HTTP ${res.status}.`,
      };
    }
    const contentType = safeDataUrlMimeType(res.headers?.get?.('content-type'));
    const contentDisposition = String(res.headers?.get?.('content-disposition') || '').slice(0, 2048);
    const suggestedFilename = filenameFromContentDisposition(contentDisposition);
    const file = await readSkillDownloadBuffer(res);
    if (!file.success) {
      return {
        success: false,
        status: res.status,
        finalUrl: responseUrl,
        contentType,
        ...(contentDisposition ? { contentDisposition } : {}),
        ...(suggestedFilename ? { suggestedFilename } : {}),
        ...(file.bytesExpected != null ? { bytesExpected: file.bytesExpected } : {}),
        ...(file.bytesReceived != null ? { bytesReceived: file.bytesReceived } : {}),
        ...(file.tooLarge ? { tooLarge: true } : {}),
        error: file.error,
      };
    }
    const dataUrl = arrayBufferToDataUrl(file.buffer, contentType);
    return {
      success: true,
      status: res.status,
      finalUrl: responseUrl,
      contentType,
      ...(contentDisposition ? { contentDisposition } : {}),
      ...(suggestedFilename ? { suggestedFilename } : {}),
      dataUrl,
      bytesReceived: file.bytesReceived,
    };
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw responseAbortError(signal);
    return { success: false, finalUrl: url, error: `Skill download file request failed: ${e.message}` };
  }
}

async function callBrowserDownloadAction(name, ...args) {
  const fn = browser.downloads?.[name];
  if (typeof fn !== 'function') return false;
  try {
    await fn.call(browser.downloads, ...args);
    return true;
  } catch {
    return false;
  }
}

async function prepareStagedSkillDownload(url, expectedUrl, signal = null) {
  const initialUrlCheck = validateSkillDownloadFinalUrl(url, expectedUrl);
  if (!initialUrlCheck.ok) {
    return { success: false, blocked: true, finalUrl: url, error: initialUrlCheck.error };
  }
  try {
    throwIfSkillAborted(signal);
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (response?.type === 'opaqueredirect' || isHttpRedirectStatus(response?.status)) {
      return {
        success: false,
        blocked: true,
        status: response.status,
        finalUrl: url,
        error: 'Skill download redirects are not allowed because the final URL cannot be validated before saving.',
      };
    }
    const finalUrl = response.url || url;
    const finalUrlCheck = validateSkillDownloadFinalUrl(finalUrl, expectedUrl);
    if (!finalUrlCheck.ok) {
      return { success: false, blocked: true, status: response.status, finalUrl, error: finalUrlCheck.error };
    }
    if (!response.ok) {
      return { success: false, status: response.status, finalUrl, error: `Skill download file request failed with HTTP ${response.status}.` };
    }
    const responseContentType = String(response.headers?.get?.('content-type') || '').trim();
    const contentDisposition = String(response.headers?.get?.('content-disposition') || '').slice(0, 2048);
    const expectedSize = parseContentLength(response.headers?.get?.('content-length'));
    if (expectedSize != null && expectedSize > SKILL_DOWNLOAD_STAGED_MAX_BYTES) {
      try { await response.body?.cancel?.(); } catch (_) {}
      return {
        success: false,
        status: response.status,
        finalUrl,
        bytesExpected: expectedSize,
        error: `Skill download exceeds the staged-file limit (${expectedSize} bytes > ${SKILL_DOWNLOAD_STAGED_MAX_BYTES} bytes).`,
      };
    }
    const responseBlob = typeof response.blob === 'function'
      ? await response.blob()
      : new Blob([await response.arrayBuffer()], { type: responseContentType || 'application/octet-stream' });
    throwIfSkillAborted(signal);
    const contentType = safeDataUrlMimeType(responseContentType || responseBlob.type);
    const blob = responseBlob.type === contentType
      ? responseBlob
      : new Blob([responseBlob], { type: contentType });
    if (blob.size > SKILL_DOWNLOAD_STAGED_MAX_BYTES) {
      return {
        success: false,
        status: response.status,
        finalUrl,
        bytesReceived: blob.size,
        error: `Skill download exceeds the staged-file limit (${blob.size} bytes > ${SKILL_DOWNLOAD_STAGED_MAX_BYTES} bytes).`,
      };
    }
    const localUrl = URL.createObjectURL(blob);
    return {
      success: true,
      status: response.status,
      finalUrl,
      localUrl,
      releaseToken: localUrl,
      bytesReceived: blob.size,
      contentType,
      ...(contentDisposition ? { contentDisposition } : {}),
    };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw responseAbortError(signal);
    return { success: false, finalUrl: url, error: `Skill download staging failed: ${error.message}` };
  }
}

async function releaseStagedSkillDownload(releaseToken) {
  if (!releaseToken) return;
  try { URL.revokeObjectURL(releaseToken); } catch (_) {}
}

async function removeUnsafeSkillDownload(downloadId, state) {
  if (state !== 'complete') await callBrowserDownloadAction('cancel', downloadId);
  if (state === 'complete') await callBrowserDownloadAction('removeFile', downloadId);
  await callBrowserDownloadAction('erase', { id: downloadId });
}

function scheduleSkillDownloadCleanup(downloadId, cleanupUrl, endpoint, tool, options = {}) {
  const downloads = browser.downloads;
  if (!downloads?.onChanged?.addListener) return false;
  const key = String(downloadId);
  if (pendingSkillDownloadCleanups.has(key)) return true;
  const expectedUrl = options.expectedUrl || '';
  const releaseToken = options.releaseToken || '';
  let settled = false;

  const finish = async (state, finalUrl) => {
    if (settled) return;
    settled = true;
    downloads.onChanged?.removeListener?.(listener);
    pendingSkillDownloadCleanups.delete(key);
    try {
      let unsafe = null;
      if (expectedUrl && finalUrl) {
        const finalUrlCheck = validateSkillDownloadFinalUrl(finalUrl, expectedUrl);
        if (!finalUrlCheck.ok) unsafe = finalUrlCheck.error;
      }
      if (expectedUrl && !unsafe) {
        const item = await findDownloadItem(downloadId);
        const info = markUnsafeSkillDownload(summarizeDownloadItem(item), expectedUrl);
        if (info?.finalUrlBlocked) unsafe = info.finalUrlError;
      }
      if (unsafe) await removeUnsafeSkillDownload(downloadId, state);
    } catch (_) {
      // Cleanup is still attempted even if validating/removing the local file fails.
    }
    await releaseStagedSkillDownload(releaseToken);
    try {
      await cleanupSkillDownloadJob(cleanupUrl, endpoint, tool);
    } catch (_) {}
  };

  const listener = (delta) => {
    if (!delta || delta.id !== downloadId) return;
    const state = delta.state?.current;
    const finalUrl = delta.finalUrl?.current || delta.url?.current || '';
    if (expectedUrl && finalUrl) {
      const finalUrlCheck = validateSkillDownloadFinalUrl(finalUrl, expectedUrl);
      if (!finalUrlCheck.ok) {
        return finish(state || 'interrupted', finalUrl);
      }
    }
    if (state === 'complete' || state === 'interrupted') {
      return finish(state, finalUrl);
    }
    return undefined;
  };

  pendingSkillDownloadCleanups.set(key, listener);
  downloads.onChanged.addListener(listener);
  findDownloadItem(downloadId).then((item) => {
    if (item?.state === 'complete' || item?.state === 'interrupted') {
      finish(item.state, item.finalUrl || item.url || '');
    }
  }).catch(() => {});
  return true;
}

async function downloadSkillFile(url, filename, waitMs = 60000, signal = null) {
  throwIfSkillAborted(signal);
  const file = await fetchSkillDownloadData(url, url, signal);
  let staged = null;
  if (file.tooLarge === true) {
    staged = await prepareStagedSkillDownload(url, url, signal);
    if (!staged?.success) {
      return {
        success: false,
        ...(staged?.blocked ? { blocked: true } : {}),
        ...(staged?.status != null ? { status: staged.status } : {}),
        ...((staged?.bytesExpected ?? file.bytesExpected) != null
          ? { bytesExpected: staged?.bytesExpected ?? file.bytesExpected }
          : {}),
        ...((staged?.bytesReceived ?? file.bytesReceived) != null
          ? { bytesReceived: staged?.bytesReceived ?? file.bytesReceived }
          : {}),
        finalUrl: staged?.finalUrl || file.finalUrl || url,
        error: staged?.error || file.error,
      };
    }
  }
  if (!file.success && !staged) {
    return {
      success: false,
      ...(file.blocked ? { blocked: true } : {}),
      ...(file.status != null ? { status: file.status } : {}),
      ...(file.bytesExpected != null ? { bytesExpected: file.bytesExpected } : {}),
      ...(file.bytesReceived != null ? { bytesReceived: file.bytesReceived } : {}),
      finalUrl: file.finalUrl || url,
      error: file.error,
    };
  }
  const contentType = safeDataUrlMimeType(staged?.contentType || file.contentType);
  const responseFilename = filenameFromContentDisposition(staged?.contentDisposition)
    || safeDownloadFilename(staged?.suggestedFilename)
    || safeDownloadFilename(file.suggestedFilename)
    || filenameFromContentDisposition(file.contentDisposition);
  const opts = { url: staged ? staged.localUrl : file.dataUrl, conflictAction: 'uniquify' };
  const safeName = safeDownloadFilename(filename) || responseFilename || defaultSkillDownloadFilename(contentType);
  let downloadId;
  let info;
  try {
    const configuredName = await filenameInConfiguredDownloadDirectory(browser, safeName);
    if (configuredName) opts.filename = configuredName;
    throwIfSkillAborted(signal);
    downloadId = await browser.downloads.download(opts);
    info = await resolveDownloadInfo(downloadId, waitMs, { signal });
    throwIfSkillAborted(signal);
  } catch (error) {
    if (downloadId != null) await callBrowserDownloadAction('cancel', downloadId);
    await releaseStagedSkillDownload(staged?.releaseToken);
    throw error;
  }
  const result = {
    downloadId,
    success: false,
    url,
    finalUrl: staged?.finalUrl || file.finalUrl || url,
    contentType,
    ...(safeName ? { suggestedFilename: safeName } : {}),
    ...(staged ? { stagedDownload: true } : {}),
    ...((staged?.status ?? file.status) != null ? { status: staged?.status ?? file.status } : {}),
    ...(file.bytesExpected != null ? { bytesExpected: file.bytesExpected } : {}),
    ...((staged?.bytesReceived ?? file.bytesReceived) != null
      ? { bytesReceived: staged?.bytesReceived ?? file.bytesReceived, totalBytes: staged?.bytesReceived ?? file.bytesReceived }
      : {}),
  };
  if (info) {
    if (info.filename) result.filename = info.filename;
    if (info.state) result.state = info.state;
    if (info.error) result.error = info.error;
    if (info.bytesReceived != null) result.bytesReceived = info.bytesReceived;
    if (info.totalBytes != null) result.totalBytes = info.totalBytes;
    if (info.url && !/^(?:data|blob):/i.test(String(info.url))) result.url = info.url;
    if (info.finalUrl && !/^(?:data|blob):/i.test(String(info.finalUrl))) result.finalUrl = info.finalUrl;
    if (info.finalUrlBlocked) {
      await removeUnsafeSkillDownload(downloadId, info.state);
      result.blocked = true;
      result.error = info.finalUrlError || 'Skill download redirected to a blocked URL.';
    } else if (info.state === 'complete') {
      result.success = true;
    } else if (info.state === 'interrupted') {
      result.error = info.error ? `Download interrupted: ${info.error}` : 'Download interrupted before completion.';
    } else {
      result.pending = true;
      result.error = `Download did not complete before timeout${info.state ? ` (state: ${info.state})` : ''}.`;
    }
  } else {
    result.pending = true;
    result.error = 'Download did not report completion before timeout.';
  }
  if (staged?.releaseToken) {
    if (result.pending) result.releaseToken = staged.releaseToken;
    else await releaseStagedSkillDownload(staged.releaseToken);
  }
  return result;
}

async function executeHttpDownloadJobSkillTool(tool, payload, endpoint, ctx = {}) {
  const signal = ctx?.signal || null;
  throwIfSkillAborted(signal);
  const create = await fetchSkillJson(endpoint.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, endpoint, tool, signal);
  if (!create.success) return create;

  const idField = tool.job?.idField || 'job_id';
  const jobId = String(create.data?.[idField] || create.data?.job_id || '').trim();
  if (!jobId) {
    return { success: false, provider: endpoint.hostname, skillTool: tool.name || '', skillName: tool.skillName || '', error: `Skill download job response did not include ${idField}.` };
  }

  const statusEndpoint = fillSkillJobEndpoint(tool.job?.statusEndpoint, jobId, endpoint, 'statusEndpoint');
  const fileEndpoint = fillSkillJobEndpoint(tool.job?.fileEndpoint, jobId, endpoint, 'fileEndpoint');
  const cleanupEndpoint = fillSkillJobEndpoint(tool.job?.cleanupEndpoint || tool.job?.statusEndpoint, jobId, endpoint, 'cleanupEndpoint');
  if (!statusEndpoint.ok) {
    return await withSkillDownloadJobCleanup({ success: false, provider: endpoint.hostname, skillTool: tool.name || '', skillName: tool.skillName || '', jobId, error: statusEndpoint.error }, cleanupEndpoint, endpoint, tool);
  }
  if (!fileEndpoint.ok) {
    return await withSkillDownloadJobCleanup({ success: false, provider: endpoint.hostname, skillTool: tool.name || '', skillName: tool.skillName || '', jobId, error: fileEndpoint.error }, cleanupEndpoint, endpoint, tool);
  }

  const startedAt = Date.now();
  const deadline = startedAt + (tool.job?.timeoutMs || 90000);
  let waitNoticeSent = false;
  const notifyLongWait = data => {
    if (waitNoticeSent) return;
    // Elapsed-based: only notify after 30s of waiting, regardless of metadata.
    // Metadata only customizes the message, so fast jobs never over-promise.
    if (Date.now() - startedAt < 30000) return;
    const metadata = data?.metadata || {};
    const duration = Number(metadata.duration);
    const bytes = Number(metadata.filesize || metadata.filesize_approx);
    const longVideo = Number.isFinite(duration) && duration >= 120;
    const largeFile = Number.isFinite(bytes) && bytes >= 50 * 1024 * 1024;
    waitNoticeSent = true;
    // Only numeric metadata enters chat; provider titles and text stay untrusted.
    const size = largeFile ? `about ${Math.ceil(bytes / (1024 * 1024))} MB`
      : longVideo ? `about ${Math.ceil(duration / 60)} minutes long` : '';
    const message = size
      ? `This media is ${size}, so downloading and preparing the final file may take several minutes. I’ll keep waiting.`
      : 'The media is still downloading or being prepared. Larger files and longer videos can take several minutes. I’ll keep waiting.';
    try { ctx.onProgress?.(message); } catch { /* Chat updates must not interrupt delivery. */ }
  };
  const pollIntervalMs = tool.job?.pollIntervalMs || 1000;
  let lastStatus = create.data;
  while (Date.now() < deadline) {
    throwIfSkillAborted(signal);
    const poll = await fetchSkillJson(statusEndpoint.url, { method: 'GET' }, endpoint, tool, signal);
    if (!poll.success) return await withSkillDownloadJobCleanup({ ...poll, jobId }, cleanupEndpoint, endpoint, tool);
    lastStatus = poll.data;
    const status = String(poll.data?.status || '').toLowerCase();
    if (status === 'complete' || status === 'completed' || status === 'done' || status === 'success') break;
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      return await withSkillDownloadJobCleanup({
        success: false,
        provider: endpoint.hostname,
        skillTool: tool.name || '',
        skillName: tool.skillName || '',
        jobId,
        jobStatus: status,
        ...REMOTE_MEDIA_FAILURE_CONTEXT,
        error: providerError(502, poll.data, '') || `Skill download job ${jobId} failed.`,
      }, cleanupEndpoint, endpoint, tool);
    }
    notifyLongWait(lastStatus);
    await sleepAbortable(pollIntervalMs, signal);
  }
  throwIfSkillAborted(signal);

  const finalStatus = String(lastStatus?.status || '').toLowerCase();
  if (!(finalStatus === 'complete' || finalStatus === 'completed' || finalStatus === 'done' || finalStatus === 'success')) {
    // A polling deadline does not cancel the remote job. FreeSkillz rejects
    // DELETE while queued/running (409) and expires completed files via
    // MEDIA_TTL_SECONDS, so keep the identity for recovery instead of deleting.
    return {
      success: false,
      provider: endpoint.hostname,
      skillTool: tool.name || '',
      skillName: tool.skillName || '',
      jobId,
      jobStatus: finalStatus || 'unknown',
      statusUrl: statusEndpoint.url,
      fileUrl: fileEndpoint.url,
      ...REMOTE_MEDIA_FAILURE_CONTEXT,
      error: 'The wait limit was reached, but the remote job may still finish. Check statusUrl before starting another download.',
    };
  }

  let cleanup = null;
  let cleanupScheduled = false;
  try {
    throwIfSkillAborted(signal);
    const download = await downloadSkillFile(fileEndpoint.url, payload.filename, Math.min(tool.job?.timeoutMs || 90000, 120000), signal);
    const releaseToken = download.releaseToken || '';
    if (Object.prototype.hasOwnProperty.call(download, 'releaseToken')) delete download.releaseToken;
    const cleanupDeferred = cleanupEndpoint.ok && download.pending === true;
    cleanupScheduled = cleanupDeferred
      ? scheduleSkillDownloadCleanup(
        download.downloadId,
        cleanupEndpoint.url,
        endpoint,
        tool,
        { releaseToken },
      )
      : false;
    throwIfSkillAborted(signal);
    if (cleanupEndpoint.ok && !cleanupDeferred) cleanup = await cleanupSkillDownloadJob(cleanupEndpoint.url, endpoint, tool);
    if (!download.success) {
      return {
        success: false,
        provider: endpoint.hostname,
        skillTool: tool.name || '',
        skillName: tool.skillName || '',
        jobId,
        jobStatus: finalStatus,
        fileUrl: fileEndpoint.url,
        cleanup,
        ...(cleanupDeferred ? { cleanupDeferred: true } : {}),
        ...(cleanupDeferred ? { cleanupScheduled } : {}),
        ...download,
      };
    }
    return {
      success: true,
      status: 200,
      provider: endpoint.hostname,
      skillTool: tool.name || '',
      skillName: tool.skillName || '',
      jobId,
      jobStatus: finalStatus,
      fileUrl: fileEndpoint.url,
      cleanup,
      ...(lastStatus?.metadata ? { metadata: lastStatus.metadata } : {}),
      ...download,
    };
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') {
      // Stop must not wait for the provider to acknowledge deletion.
      if (cleanupEndpoint.ok && !cleanupScheduled) {
        void cleanupSkillDownloadJob(cleanupEndpoint.url, endpoint, tool).catch(() => {});
      }
      throw responseAbortError(signal);
    }
    if (cleanupEndpoint.ok && !cleanupScheduled) cleanup = await cleanupSkillDownloadJob(cleanupEndpoint.url, endpoint, tool);
    return { success: false, provider: endpoint.hostname, skillTool: tool.name || '', skillName: tool.skillName || '', jobId, fileUrl: fileEndpoint.url, cleanup, error: `Skill download failed: ${e.message}` };
  }
}

export async function executeHttpSkillTool(tool, args = {}, ctx = {}) {
  let endpoint;
  try {
    endpoint = new URL(tool?.endpoint || '');
  } catch {
    return { success: false, error: 'Skill tool has an invalid endpoint.' };
  }
  if (endpoint.protocol !== 'https:') {
    return { success: false, error: 'Skill tools currently require an https endpoint.' };
  }

  const method = String(tool.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const payload = { ...(tool.defaultArgs || {}), ...filterArgsToDeclaredParameters(args, tool) };
  if (tool.activeTabUrlArg && !payload[tool.activeTabUrlArg]) {
    payload[tool.activeTabUrlArg] = await currentTabUrl(ctx.tabId);
  }
  if (tool.inputUrlArg && payload[tool.inputUrlArg]) {
    const allowedUrl = await allowedSkillInputUrl(payload[tool.inputUrlArg], tool.allowedInputUrls || []);
    if (!allowedUrl) {
      return { success: false, error: `Skill tool input URL is outside its declared allowlist: ${tool.inputUrlArg}`, provider: endpoint.hostname };
    }
    payload[tool.inputUrlArg] = allowedUrl;
  }

  if (tool.kind === 'httpDownloadJob') {
    return await executeHttpDownloadJobSkillTool(tool, payload, endpoint, ctx);
  }

  const init = {
    method,
    headers: {},
    credentials: 'omit',
    redirect: 'manual',
  };
  const finalUrl = new URL(endpoint.href);
  if (method === 'POST') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload);
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (value == null) continue;
      finalUrl.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  const endpointUrlCheck = validateFetchUrl(finalUrl.href, { allowLocalNetwork: getAllowLocalNetwork() });
  if (!endpointUrlCheck.ok) {
    return {
      success: false,
      provider: endpoint.hostname,
      skillTool: tool.name || '',
      skillName: tool.skillName || '',
      finalUrl: finalUrl.href,
      error: `Skill tool endpoint is blocked: ${endpointUrlCheck.error}`,
    };
  }

  try {
    let requestUrl = finalUrl.href;
    const res = await fetch(requestUrl, init);
    // Browser manual redirects are opaqueredirect responses without an
    // inspectable Location header. Reject instead of replaying skill inputs.
    if (res?.type === 'opaqueredirect' || isHttpRedirectStatus(res?.status)) {
      return {
        success: false,
        status: res.status,
        provider: endpoint.hostname,
        skillTool: tool.name || '',
        skillName: tool.skillName || '',
        finalUrl: requestUrl,
        error: 'Skill tool redirects are not allowed because browser manual redirects cannot be validated before following.',
      };
    }

    const responseUrl = res.url || requestUrl;
    const responseUrlCheck = validateFetchUrl(responseUrl, { allowLocalNetwork: getAllowLocalNetwork() });
    if (!responseUrlCheck.ok) {
      return {
        success: false,
        status: res.status,
        provider: endpoint.hostname,
        skillTool: tool.name || '',
        skillName: tool.skillName || '',
        finalUrl: responseUrl,
        error: `Skill tool redirected to blocked URL: ${responseUrlCheck.error}`,
      };
    }
    const rawText = await res.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch (_) {}
    if (!res.ok) {
      return {
        success: false,
        status: res.status,
        provider: endpoint.hostname,
        skillTool: tool.name || '',
        skillName: tool.skillName || '',
        error: providerError(res.status, data, rawText),
      };
    }
    const body = data && typeof data === 'object' ? data : { text: rawText };
    return {
      success: true,
      status: res.status,
      provider: endpoint.hostname,
      skillTool: tool.name || '',
      skillName: tool.skillName || '',
      data: applySkillResponseLimits(body, tool.responseLimits || {}),
    };
  } catch (e) {
    return { success: false, provider: endpoint.hostname, skillTool: tool.name || '', skillName: tool.skillName || '', error: `Skill tool request failed: ${e.message}` };
  }
}

function apiReplayOptionsForFetch(rawUrl, opts = {}, ctx = {}) {
  const replayRequestId = opts.replayRequestId || opts.apiReplayRequestId;
  if (!replayRequestId) return { ok: true, opts };
  const replay = globalThis.__webbrainApiRequestReplay?.get(String(replayRequestId));
  if (!replay) {
    return { ok: false, error: `No captured API request replay data found for replayRequestId: ${replayRequestId}` };
  }
  if (ctx?.tabId != null && replay.tabId != null && Number(replay.tabId) !== Number(ctx.tabId)) {
    return { ok: false, error: 'Captured API request replay data belongs to a different tab.' };
  }
  try {
    const target = new URL(rawUrl);
    const captured = new URL(replay.url);
    if (target.origin !== captured.origin) {
      return { ok: false, error: `Captured API request replay data is scoped to ${captured.origin}, not ${target.origin}.` };
    }
  } catch (e) {
    return { ok: false, error: `Invalid captured API request replay URL: ${e.message}` };
  }
  const mergedHeaders = {
    ...(replay.headers || {}),
    ...(opts.headers || {}),
  };
  return {
    ok: true,
    opts: {
      ...opts,
      method: opts.method || replay.method || 'GET',
      headers: mergedHeaders,
      body: opts.body !== undefined ? opts.body : (replay.body ?? undefined),
    },
  };
}

// fetch_url never opens, shows, or activates a tab: it is a background request
// (or, for a captured API replay, a request issued inside the already-open
// page). Without saying so in the result, models reported these reads as
// having opened or visited the page for the user. `credentials` records
// whether the user's cookies for that site were actually sent.
function backgroundFetchRetrieval(cookiesSent) {
  return {
    retrieval: 'background_fetch',
    visibleTabOpened: false,
    activeTabChanged: false,
    credentials: cookiesSent ? 'same_site_cookies' : 'none',
  };
}

function formatTextFetchResult({ status, contentType, finalUrl, text, replayContext = null, cookiesSent = false }, opts = {}) {
  const normalizedContentType = (contentType || '').toLowerCase();
  const body = String(text ?? '');
  const success = Number(status) < 400;
  const error = success ? undefined : `Fetch returned HTTP ${status}`;
  const base = {
    success,
    ...(error ? { error } : {}),
    ...backgroundFetchRetrieval(cookiesSent),
    status,
    contentType: normalizedContentType,
    url: finalUrl,
    ...(replayContext ? { replayContext } : {}),
  };

  if (normalizedContentType.includes('json')) {
    let pretty = body;
    try { pretty = JSON.stringify(JSON.parse(body), null, 2); } catch (e) {}
    return constrainFetchTextResult({
      ...base,
      ...fetchTextWindow(pretty, opts, 'json'),
    }, 'json');
  }

  if (normalizedContentType.includes('html') || normalizedContentType.includes('xhtml')) {
    const { title, text: readableText } = htmlToText(body);
    return constrainFetchTextResult({
      ...base,
      title: title.slice(0, 500),
      ...fetchTextWindow(readableText, opts, 'text'),
    }, 'text');
  }

  if (normalizedContentType.startsWith('text/') ||
      normalizedContentType.includes('xml') ||
      normalizedContentType.includes('javascript') ||
      normalizedContentType.includes('csv') ||
      normalizedContentType.includes('markdown') ||
      normalizedContentType === '') {
    return constrainFetchTextResult({
      ...base,
      ...fetchTextWindow(body, opts, 'text'),
    }, 'text');
  }

  return constrainFetchTextResult({
    ...base,
    ...fetchTextWindow(body, opts, 'text'),
    note: 'Replay response was read as text because page-context replay cannot stream binary content back to the background.',
  }, 'text');
}

// Both functions are serialized into the extension's isolated page world.
// Keep them closure-free so Chrome and Firefox execute the same request policy.
function cancelPageReplay(requestId) {
  const registry = globalThis.__webbrainNetworkReplays ||= new Map();
  const active = registry.get(requestId);
  if (active?.abort) active.abort();
  else {
    const cancelled = { cancelled: true };
    registry.set(requestId, cancelled);
    setTimeout(() => {
      if (registry.get(requestId) === cancelled) registry.delete(requestId);
    }, 30000);
  }
}

async function performPageReplay(rawUrl, replayInit, { requestId, maxBytes, timeoutMs }) {
  const registry = globalThis.__webbrainNetworkReplays ||= new Map();
  const controller = new AbortController();
  if (registry.get(requestId)?.cancelled) controller.abort();
  registry.set(requestId, controller);
  const timer = setTimeout(() => controller.abort(new Error('Page-context replay request timed out.')), timeoutMs);
  let reader;
  let response;
  try {
    if (controller.signal.aborted) throw new Error('Page-context replay was cancelled.');
    const targetUrl = new URL(rawUrl, location.href);
    if (targetUrl.origin !== location.origin) {
      return { ok: false, error: 'Page-context replay target does not match page origin.', finalUrl: targetUrl.href };
    }
    const headers = {};
    for (const [name, value] of Object.entries(replayInit.headers || {})) {
      if (value != null) headers[name] = String(value);
    }
    response = await fetch(targetUrl.href, {
      method: replayInit.method || 'GET',
      headers,
      body: replayInit.body == null ? undefined : replayInit.body,
      credentials: 'include',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(response.status)) {
      return { ok: false, error: 'Page-context replay redirect was not followed; use an explicit destination URL.', status: response.status, finalUrl: targetUrl.href };
    }
    const finalUrl = response.url || targetUrl.href;
    if (new URL(finalUrl).origin !== location.origin) {
      return { ok: false, error: 'Page-context replay redirected outside the page origin; response body was discarded.', status: response.status, finalUrl };
    }
    let text = '';
    let bytesRead = 0;
    const decoder = new TextDecoder();
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) throw new Error('Page-context replay response exceeds ' + maxBytes + ' bytes.');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      if (new TextEncoder().encode(text).length > maxBytes) throw new Error('Page-context replay response is too large.');
    }
    return { ok: true, status: response.status, url: finalUrl, contentType: response.headers.get('content-type') || '', text };
  } catch (error) {
    return { ok: false, error: controller.signal.reason?.message || error?.message || String(error), cancelled: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
    registry.delete(requestId);
    controller.abort();
    try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}

async function fetchReplayInPageContext(url, opts = {}, ctx = {}, allowLocal = false) {
  const replayRequestId = opts.replayRequestId || opts.apiReplayRequestId;
  const api = globalThis.browser;
  if (!replayRequestId || ctx?.tabId == null || !api?.tabs?.get) return null;

  let target;
  try {
    const tab = await api.tabs.get(ctx.tabId);
    target = new URL(url);
    const page = new URL(tab?.url || '');
    if (page.origin !== target.origin) return null;
  } catch (_) {
    return null;
  }
  if (!api.tabs?.executeScript) {
    return {
      success: false,
      error: 'Page-context API replay is unavailable in this browser context.',
      replayContext: 'page',
    };
  }

  const requestId = crypto.randomUUID();
  const replayBounds = { requestId, maxBytes: FETCH_BODY_MAX_BYTES, timeoutMs: FETCH_REQUEST_TIMEOUT_MS };
  const onAbort = () => {
    api.tabs.executeScript(ctx.tabId, {
      code: `(${cancelPageReplay.toString()})(${JSON.stringify(requestId)})`, allFrames: false,
    }).catch(() => {});
  };

  const init = {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body ?? null,
  };
  const pageReplayScript = `(${performPageReplay.toString()})(${JSON.stringify(url)}, ${JSON.stringify(init)}, ${JSON.stringify(replayBounds)})`;


  let payload;
  try {
    if (ctx.signal?.aborted) throw responseAbortError(ctx.signal);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const results = await api.tabs.executeScript(ctx.tabId, { code: pageReplayScript, allFrames: false });
    payload = results?.[0];
    if (ctx.signal?.aborted) throw responseAbortError(ctx.signal);
  } catch (e) {
    return {
      success: false,
      error: `Page-context API replay failed: ${e.message}`,
      replayContext: 'page',
      ...(ctx.signal?.aborted ? { cancelled: true } : {}),
    };
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort);
  }

  if (!payload) {
    return { success: false, error: 'Page-context API replay produced no result.', replayContext: 'page' };
  }
  if (!payload.ok) {
    return {
      success: false,
      error: `Page-context API replay failed: ${payload.error || 'unknown error'}`,
      ...(payload.status != null ? { status: payload.status } : {}),
      ...(payload.finalUrl ? { url: payload.finalUrl, finalUrl: payload.finalUrl } : {}),
      replayContext: 'page',
    };
  }

  const finalUrl = payload.url || url;
  const v = validateFetchUrl(finalUrl, { allowLocalNetwork: allowLocal });
  if (!v.ok) {
    return { success: false, error: `Page-context replay redirected to blocked URL: ${v.error}`, finalUrl, replayContext: 'page' };
  }
  try {
    if (new URL(finalUrl).origin !== target.origin) {
      return {
        success: false,
        error: 'Page-context replay redirected outside the captured request origin; response body discarded.',
        finalUrl,
        replayContext: 'page',
      };
    }
  } catch (_) {}

  return formatTextFetchResult({
    status: payload.status,
    contentType: payload.contentType || '',
    finalUrl,
    text: payload.text || '',
    replayContext: 'page',
    // performPageReplay only fetches the page's own origin, credentials:'include'.
    cookiesSent: true,
  }, opts);
}

export function extractPageSourceAssets(html, baseUrl) {
  const out = { stylesheets: [], scripts: [] };
  const seen = { stylesheets: new Set(), scripts: new Set() };
  if (!html) return out;

  const add = (kind, raw) => {
    const value = decodeHtmlAttributeValue(raw).trim();
    if (!value || /^(data|javascript|mailto|tel):/i.test(value)) return;
    let resolved = value;
    try { resolved = new URL(value, baseUrl).href; } catch { /* keep raw */ }
    if (seen[kind].has(resolved) || out[kind].length >= 50) return;
    seen[kind].add(resolved);
    out[kind].push(resolved);
  };

  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    if (!/\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|[^\s>]*\bstylesheet\b[^\s>]*)/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    add('stylesheets', href && (href[1] || href[2] || href[3]));
  }

  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  while ((m = scriptRe.exec(html))) {
    add('scripts', m[1] || m[2] || m[3]);
  }

  return out;
}

const HTML_ATTRIBUTE_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtmlAttributeValue(raw) {
  return String(raw || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const codePoint = body[1].toLowerCase() === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint)) return match;
      try { return String.fromCodePoint(codePoint); } catch { return match; }
    }
    return HTML_ATTRIBUTE_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function slicePageSource(text, opts = {}) {
  const source = String(text || '');
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const requested = Number(opts.maxChars) || PAGE_SOURCE_DEFAULT_LIMIT;
  const maxChars = Math.max(PAGE_SOURCE_MIN_LIMIT, Math.min(PAGE_SOURCE_MAX_LIMIT, Math.floor(requested)));
  const end = Math.min(source.length, offset + maxChars);
  return {
    text: source.slice(offset, end),
    offset,
    maxChars,
    nextOffset: end < source.length ? end : null,
    truncated: end < source.length,
    originalLength: source.length,
  };
}

export function isPageSourceTextContentType(contentType) {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (!type) return true;
  return type.startsWith('text/') ||
    type.includes('html') ||
    type.includes('xml') ||
    type.includes('javascript') ||
    type.includes('json') ||
    type.includes('markdown') ||
    type.includes('csv');
}

export function validatePageSourceResponseHeaders(headers, maxBytes = PAGE_SOURCE_BODY_MAX_BYTES) {
  const contentType = String(headers?.get?.('content-type') || '').toLowerCase();
  const sizeBytes = parseContentLength(headers?.get?.('content-length'));
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  if (!isPageSourceTextContentType(contentType)) {
    return {
      ok: false,
      contentType,
      sizeBytes,
      error: `read_page_source only supports HTML/text responses; got ${contentType || 'non-text content'}. Use download_file for binary resources.`,
    };
  }
  if (limit && sizeBytes != null && sizeBytes > limit) {
    return {
      ok: false,
      contentType,
      sizeBytes,
      error: `read_page_source response is too large (${sizeBytes} bytes; max ${limit}). Use fetch_url for extracted text or download_file for the raw resource.`,
    };
  }
  return { ok: true, contentType, sizeBytes };
}

export async function readPageSourceResponseText(res, maxBytes = PAGE_SOURCE_BODY_MAX_BYTES, options = {}) {
  return readResponseText(res, { ...options, maxBytes });
}

async function readFetchResponseText(res, signal) {
  const read = await readResponseText(res, { signal, maxBytes: FETCH_BODY_MAX_BYTES });
  if (read.exceeded) {
    throw new Error(`fetch_url response exceeds ${FETCH_BODY_MAX_BYTES} bytes. Download the resource or request a smaller server-side result.`);
  }
  return read.text;
}

function networkRequestDeadline(ctx = {}) {
  // Only extension-owned context controls deadlines, never model-supplied options.
  const timeoutMs = Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0
    ? Math.min(ctx.timeoutMs, 120000)
    : FETCH_REQUEST_TIMEOUT_MS;
  return createRequestDeadline({ signal: ctx.signal, timeoutMs });
}

export function rejectNetworkRedirect(res) {
  if (res?.type === 'opaqueredirect' || isHttpRedirectStatus(res?.status)) {
    throw new Error('Redirect was not followed because its target cannot be validated before sending the request. Use an explicit destination URL.');
  }
}

function parseContentLength(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function constrainPageSourceResult(result, sourceLength = result?.originalLength, maxResultChars = PAGE_SOURCE_RESULT_MAX_CHARS) {
  const resultLimit = Math.max(0, Math.floor(Number(maxResultChars) || 0));
  if (!resultLimit) return result;

  let fitted = { ...result, assetUrls: { stylesheets: [], scripts: [] } };
  const assetBudget = Math.max(0, resultLimit - JSON.stringify(fitted).length - PAGE_SOURCE_RESULT_SAFETY_CHARS);
  const limitedAssets = limitPageSourceAssetUrls(result?.assetUrls, assetBudget);
  fitted = { ...result, assetUrls: limitedAssets.assetUrls };
  if (limitedAssets.omitted.stylesheets || limitedAssets.omitted.scripts) {
    fitted.assetUrlsOmitted = limitedAssets.omitted;
  }
  if (JSON.stringify(fitted).length <= resultLimit) return fitted;

  // Escaped HTML or long metadata can still exceed the agent result cap.
  // Shorten the delivered source and keep continuation metadata aligned.
  let best = null;
  let low = 0;
  let high = typeof fitted.text === 'string' ? fitted.text.length : 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = pageSourceResultWithTextLength(fitted, sourceLength, mid);
    if (JSON.stringify(candidate).length <= resultLimit) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best || pageSourceResultWithTextLength({
    ...fitted,
    assetUrls: { stylesheets: [], scripts: [] },
    assetUrlsOmitted: undefined,
  }, sourceLength, 0);
}

function limitPageSourceAssetUrls(assetUrls, maxChars) {
  const out = { stylesheets: [], scripts: [] };
  const omitted = { stylesheets: 0, scripts: 0 };
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0));
  let used = 0;
  for (const kind of PAGE_SOURCE_ASSET_KINDS) {
    const urls = Array.isArray(assetUrls?.[kind]) ? assetUrls[kind] : [];
    for (const url of urls) {
      const value = String(url || '');
      if (!value) continue;
      const cost = JSON.stringify(value).length + (out[kind].length ? 1 : 0);
      if (used + cost > budget) {
        omitted[kind] += 1;
        continue;
      }
      out[kind].push(value);
      used += cost;
    }
  }
  return { assetUrls: out, omitted };
}

function pageSourceResultWithTextLength(result, sourceLength, textLength) {
  const offset = Math.max(0, Math.floor(Number(result?.offset) || 0));
  const totalLength = Math.max(offset, Math.floor(Number(sourceLength ?? result?.originalLength) || 0));
  const text = String(result?.text || '').slice(0, Math.max(0, Math.floor(Number(textLength) || 0)));
  const deliveredEnd = offset + text.length;
  const nextOffset = deliveredEnd < totalLength ? deliveredEnd : null;
  return {
    ...result,
    text,
    maxChars: text.length,
    nextOffset,
    truncated: nextOffset != null,
  };
}

/**
 * Fetch the raw server-delivered page source. Unlike fetchUrl(), HTML is not
 * stripped to prose; this intentionally mirrors View Source semantics.
 */
export async function readPageSource(url, opts = {}, ctx = {}) {
  let targetUrl = String(url || '').trim();
  if (!targetUrl && ctx && ctx.tabId != null) {
    try {
      const tab = await browser.tabs.get(ctx.tabId);
      targetUrl = tab?.url || '';
    } catch {}
  }
  if (!targetUrl) return { success: false, error: 'read_page_source: no url provided and could not read the active tab URL.' };
  const restricted = firefoxRestrictedDomainFailure(targetUrl);
  if (restricted) return restricted;

  const allowLocal = getAllowLocalNetwork();
  const v = validateFetchUrl(targetUrl, { allowLocalNetwork: allowLocal });
  if (!v.ok) return { success: false, error: v.error };

  let attachCookies = false;
  let tabRegDomain = null;
  if (ctx && ctx.tabId != null) {
    try {
      const tab = await browser.tabs.get(ctx.tabId);
      if (tab && tab.url) {
        try {
          const tabHost = new URL(tab.url).hostname;
          const fetchHost = new URL(targetUrl).hostname;
          tabRegDomain = registrableDomain(tabHost);
          if (tabRegDomain && tabRegDomain === registrableDomain(fetchHost)) {
            attachCookies = true;
          }
        } catch {}
      }
    } catch {}
  }

  const deadline = networkRequestDeadline(ctx);
  const addresses = watchFetchAddresses(targetUrl, allowLocal);
  let res;
  try {
    const hostFailure = await resolvedHostFailure(targetUrl, allowLocal);
    if (hostFailure) return { success: false, error: hostFailure };
    if (deadline.signal.aborted) throw responseAbortError(deadline.signal);
    res = await fetch(targetUrl, {
      method: 'GET',
      credentials: attachCookies ? 'include' : 'omit',
      redirect: 'manual',
      signal: deadline.signal,
    });
    rejectNetworkRedirect(res);
    const addressFailure = await addresses?.settledFailure('fetch');
    if (addressFailure) return { success: false, error: addressFailure };

    if (res.url && res.url !== targetUrl) {
      const v2 = validateFetchUrl(res.url, { allowLocalNetwork: allowLocal });
      if (!v2.ok) {
        return { success: false, error: `Redirect to blocked URL: ${v2.error}`, finalUrl: res.url };
      }
      // Reject cross-eTLD+1 redirects unconditionally. Cookie attachment makes
      // cross-domain redirects dangerous (cookies sent to wrong host), but even
      // without cookies a silent host change is surprising and may expose data
      // from an unintended host. Surface finalUrl so the caller can re-invoke.
      try {
        const initialRegDomain = registrableDomain(new URL(targetUrl).hostname);
        const finalRegDomain = registrableDomain(new URL(res.url).hostname);
        if (initialRegDomain && finalRegDomain && finalRegDomain !== initialRegDomain) {
          return {
            success: false,
            error: `Redirect crossed registrable-domain boundary (${initialRegDomain} → ${finalRegDomain}); body discarded for safety. Re-call with the explicit final URL if needed.`,
            finalUrl: res.url,
          };
        }
      } catch {}
    }

    const headerCheck = validatePageSourceResponseHeaders(res.headers);
    if (!headerCheck.ok) {
      return {
        success: false,
        status: res.status,
        contentType: headerCheck.contentType,
        url: targetUrl,
        finalUrl: res.url || targetUrl,
        sizeBytes: headerCheck.sizeBytes,
        error: headerCheck.error,
      };
    }

    const read = await readPageSourceResponseText(res, PAGE_SOURCE_BODY_MAX_BYTES, { signal: deadline.signal });
    if (read.exceeded) {
      return {
        success: false,
        status: res.status,
        contentType: headerCheck.contentType,
        url: targetUrl,
        finalUrl: res.url || targetUrl,
        sizeBytes: read.bytesRead,
        error: `read_page_source response exceeded ${PAGE_SOURCE_BODY_MAX_BYTES} bytes while reading. Use fetch_url for extracted text or download_file for the raw resource.`,
      };
    }

    const contentType = headerCheck.contentType;
    const source = read.text;
    const slice = slicePageSource(source, opts);
    const assetUrls = extractPageSourceAssets(source, res.url || targetUrl);
    return constrainPageSourceResult({
      success: true,
      status: res.status,
      contentType,
      url: targetUrl,
      finalUrl: res.url || targetUrl,
      text: slice.text,
      offset: slice.offset,
      maxChars: slice.maxChars,
      nextOffset: slice.nextOffset,
      truncated: slice.truncated,
      originalLength: slice.originalLength,
      assetUrls,
      note: 'Raw server-delivered source only. This is not the live DOM or computed styles; use inspect_element_styles for rendered layout/CSS issues.',
    }, source.length);
  } catch (e) {
    return { success: false, error: `read_page_source failed: ${e.message}` };
  } finally {
    addresses?.close();
    deadline.dispose();
    try { Promise.resolve(res?.body?.cancel()).catch(() => {}); } catch {}
  }
}

/**
 * Agent-driven fetch. See chrome's copy for the full cookie/redirect policy.
 *   url   — target URL (validated)
 *   opts  — { method, headers, body } (LLM-controlled)
 *   ctx   — { tabId } (extension-supplied; used for cookie policy)
 */
export async function fetchUrl(url, opts = {}, ctx = {}) {
  if (!url) return { success: false, error: 'url is required' };
  const restricted = firefoxRestrictedDomainFailure(url);
  if (restricted) return restricted;
  const replay = apiReplayOptionsForFetch(url, opts, ctx);
  if (!replay.ok) return { success: false, error: replay.error };
  opts = replay.opts;
  const allowLocal = getAllowLocalNetwork();
  const v = validateFetchUrl(url, { allowLocalNetwork: allowLocal });
  if (!v.ok) return { success: false, error: v.error };

  const pageReplay = await fetchReplayInPageContext(url, opts, ctx, allowLocal);
  if (pageReplay) return pageReplay;

  let attachCookies = false;
  let tabRegDomain = null;
  if (ctx && ctx.tabId != null) {
    try {
      const tab = await browser.tabs.get(ctx.tabId);
      if (tab && tab.url) {
        try {
          tabRegDomain = registrableDomain(new URL(tab.url).hostname);
          if (tabRegDomain && tabRegDomain === registrableDomain(new URL(url).hostname)) {
            attachCookies = true;
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  const deadline = networkRequestDeadline(ctx);
  const addresses = watchFetchAddresses(url, allowLocal);
  let res;
  try {
    const hostFailure = await resolvedHostFailure(url, allowLocal);
    if (hostFailure) return { success: false, error: hostFailure };
    if (deadline.signal.aborted) throw responseAbortError(deadline.signal);
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body || undefined,
      credentials: attachCookies ? 'include' : 'omit',
      redirect: 'manual',
      signal: deadline.signal,
    });
    rejectNetworkRedirect(res);
    const addressFailure = await addresses?.settledFailure('fetch');
    if (addressFailure) return { success: false, error: addressFailure };

    if (res.url && res.url !== url) {
      const v2 = validateFetchUrl(res.url, { allowLocalNetwork: allowLocal });
      if (!v2.ok) {
        return { success: false, error: `Redirect to blocked URL: ${v2.error}`, finalUrl: res.url };
      }
      if (attachCookies && tabRegDomain) {
        try {
          const finalRegDomain = registrableDomain(new URL(res.url).hostname);
          if (finalRegDomain !== tabRegDomain) {
            return {
              success: false,
              error: `Redirect crossed registrable-domain boundary (${tabRegDomain} → ${finalRegDomain}); body discarded for safety. Re-call with the explicit final URL if needed.`,
              finalUrl: res.url,
            };
          }
        } catch (_) {}
      }
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const status = res.status;
    const finalUrl = res.url;
    const success = status < 400;
    const error = success ? undefined : `Fetch returned HTTP ${status}`;
    const responseMetadata = safeFetchResponseMetadata(res.headers);
    const retrieval = backgroundFetchRetrieval(attachCookies);

    if (contentType.includes('json')) {
      const text = await readFetchResponseText(res, deadline.signal);
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      return constrainFetchTextResult({
        success, ...(error ? { error } : {}), ...retrieval, status, contentType, url: finalUrl,
        ...responseMetadata,
        ...fetchTextWindow(pretty, opts, 'json'),
      }, 'json');
    }

    if (contentType.includes('html') || contentType.includes('xhtml')) {
      const html = await readFetchResponseText(res, deadline.signal);
      const { title, text } = htmlToText(html);
      return constrainFetchTextResult({
        success, ...(error ? { error } : {}), ...retrieval, status, contentType, url: finalUrl,
        title: title.slice(0, 500),
        ...responseMetadata,
        ...fetchTextWindow(text, opts, 'text'),
      }, 'text');
    }

    if (contentType.startsWith('text/') ||
        contentType.includes('xml') ||
        contentType.includes('javascript') ||
        contentType.includes('csv') ||
        contentType.includes('markdown') ||
        contentType === '') {
      const text = await readFetchResponseText(res, deadline.signal);
      return constrainFetchTextResult({
        success, ...(error ? { error } : {}), ...retrieval, status, contentType, url: finalUrl,
        ...responseMetadata,
        ...fetchTextWindow(text, opts, 'text'),
      }, 'text');
    }

    const len = res.headers.get('content-length');
    return {
      success, ...(error ? { error } : {}), ...retrieval, status, contentType, url: finalUrl,
      ...responseMetadata,
      note: 'Binary content not inlined. Use download_file({url}) then read_downloaded_file({downloadId}) if you need contents.',
      sizeBytes: len ? parseInt(len, 10) : null,
    };
  } catch (e) {
    return { success: false, error: `Fetch failed: ${e.message}` };
  } finally {
    addresses?.close();
    deadline.dispose();
    try { Promise.resolve(res?.body?.cancel()).catch(() => {}); } catch {}
  }
}

// The page renders in a real tab created with active:false (beside the source
// tab when known). It sits in the tab strip while the page loads and is read,
// but it is never activated, and researchUrl's finally block requests its
// removal before this result reaches the model. State exactly that, so the
// model neither claims it opened the page for the user nor denies a tab the
// user saw.
const BACKGROUND_TAB_RETRIEVAL = Object.freeze({
  retrieval: 'background_tab',
  backgroundTabOpened: true,
  backgroundTabActivated: false,
  backgroundTabCloseRequested: true,
  activeTabChanged: false,
});

// What a run keeps of its successful fetch_url and research_url reads, from
// the flags above: how each site was read and how many times. Only the host:
// a fetched URL's path or query can carry a token. Only a direct GET is a
// fetch_url read: a HEAD reads no content, and a write (any other method) or
// a captured API replay, which may be one, is no read.
// Returns `reads` itself when this result was no such read.
const BACKGROUND_READ_SITES = 20;
export function recordBackgroundRead(reads, name, args, result) {
  if (result?.success !== true || result.activeTabChanged !== false) return reads;
  const directGet = String(args?.method || 'GET').trim().toUpperCase() === 'GET'
    && !(args?.replayRequestId || args?.apiReplayRequestId || result.replayContext);
  const retrieval = name === 'fetch_url' && directGet && result.retrieval === 'background_fetch' && result.visibleTabOpened === false ? 'background_fetch'
    : name === 'research_url' && result.retrieval === 'background_tab' && result.backgroundTabActivated === false ? 'background_tab' : '';
  let host = '';
  try {
    const url = new URL(String(result.url || ''));
    if (url.protocol === 'http:' || url.protocol === 'https:') host = url.hostname;
  } catch {}
  if (!retrieval || !host) return reads;
  const list = Array.isArray(reads) ? reads : [];
  const index = list.findIndex(read => read.retrieval === retrieval && read.host === host);
  if (index >= 0) return list.map((read, i) => i === index ? { ...read, count: read.count + 1 } : read);
  return list.length < BACKGROUND_READ_SITES ? [...list, { retrieval, host, count: 1 }] : list;
}

// The line a final answer gets when the request said how pages were to be
// opened or read (agent.js, done): what this run's background reads did, by
// site, in the order the sites were first read. Empty without such a read.
// A fetch leaves the active tab alone, but the run may not have: the line
// says so only when the caller knows nothing else in the run may have
// changed that tab (completion-invariant.js changedRunTab). A research_url
// tab's close is requested, not confirmed, and the line says just that.
export function backgroundReadNote(reads, { activeTabUnchanged = false } = {}) {
  const list = Array.isArray(reads) ? reads : [];
  const sites = hosts => {
    const shown = hosts.length > 3 ? [...hosts.slice(0, 2), `${hosts.length - 2} other sites`] : hosts;
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  };
  const fetched = list.filter(read => read?.retrieval === 'background_fetch').map(read => read.host);
  const tabbed = list.filter(read => read?.retrieval === 'background_tab');
  const tabs = tabbed.reduce((sum, read) => sum + (Number(read.count) || 1), 0);
  const lines = [];
  if (fetched.length) {
    lines.push(`Read in the background from ${sites(fetched)}: fetched directly, without opening a tab${activeTabUnchanged === true ? ' or changing your active tab' : ''}.`);
  }
  if (tabbed.length) {
    lines.push(tabs === 1
      ? `Read in a background tab from ${sites(tabbed.map(read => read.host))}, which was never brought to the front and which WebBrain asked the browser to close after reading.`
      : `Read in background tabs from ${sites(tabbed.map(read => read.host))}, which were never brought to the front and which WebBrain asked the browser to close after reading.`);
  }
  return lines.join(' ');
}

export async function researchUrl(url, opts = {}) {
  if (!url) return { success: false, error: 'url is required' };
  const restricted = firefoxRestrictedDomainFailure(url);
  if (restricted) return restricted;
  // Same SSRF backstop as fetch_url / read_page_source: research_url opens
  // the URL in a hidden tab under the extension's <all_urls> host
  // permission, so the cloud-metadata / RFC1918 / localhost blocklist must
  // run before browser.tabs.create — the permission gate alone is not a
  // substitute (fetch_url still applies this check after a grant).
  const urlCheck = validateFetchUrl(url, { allowLocalNetwork: getAllowLocalNetwork() });
  if (!urlCheck.ok) return { success: false, error: `URL is blocked: ${urlCheck.error}` };
  const hostFailure = await resolvedHostFailure(url, getAllowLocalNetwork());
  if (hostFailure) return { success: false, error: `URL is blocked: ${hostFailure}` };
  const timeoutMs = Math.min(opts.timeout || 8000, 30000);
  // Addresses of the hidden tab's top-level responses, redirect hops
  // included. The tab id exists only after tabs.create() has started the
  // navigation, so record main frames by tab from the start.
  const addresses = watchResponseAddresses({ types: ['main_frame'] }, d => d.tabId, getAllowLocalNetwork());
  let createdTab = null;
  try {
    const createProps = { url, active: false };
    if (opts.sourceTabId != null) {
      try {
        const sourceTab = await browser.tabs.get(opts.sourceTabId);
        if (sourceTab?.windowId != null) createProps.windowId = sourceTab.windowId;
        if (typeof sourceTab?.index === 'number') createProps.index = sourceTab.index + 1;
        if (sourceTab?.id != null) createProps.openerTabId = sourceTab.id;
      } catch (_) {}
    }
    createdTab = await browser.tabs.create(createProps);
    const tabId = createdTab.id;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        browser.tabs.onUpdated.removeListener(listener);
        reject(new Error(`research_url timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === 'complete') {
          clearTimeout(t);
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      browser.tabs.onUpdated.addListener(listener);
    });

    await new Promise(r => setTimeout(r, 800));

    // browser.tabs.create follows redirects. Re-check the actual loaded URL
    // before reading the document so a permitted public URL cannot redirect
    // the hidden tab to cloud metadata, localhost, or an RFC1918 host.
    const loadedTab = await browser.tabs.get(tabId);
    const loadedRestricted = firefoxRestrictedDomainFailure(loadedTab?.url || '');
    if (loadedRestricted) return loadedRestricted;
    const loadedUrlCheck = validateFetchUrl(loadedTab?.url || '', {
      allowLocalNetwork: getAllowLocalNetwork(),
    });
    if (!loadedUrlCheck.ok) {
      return { success: false, error: `Redirect to blocked URL: ${loadedUrlCheck.error}`, finalUrl: loadedTab?.url || '' };
    }
    const loadedAddress = addresses?.failure(tabId);
    if (loadedAddress) return { success: false, error: loadedAddress, finalUrl: loadedTab?.url || '' };

    const code = `
      (() => {
        const title = document.title || '';
        const url = location.href;
        const main = document.querySelector('main, article, [role="main"]');
        let root = main || document.body;
        const clone = root.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, iframe, header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navigation, .header, .footer, .sidebar').forEach(el => el.remove());
        const text = (clone.innerText || clone.textContent || '').trim();
        const links = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 50)
          .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
          .filter(l => l.text && l.href && !l.href.startsWith('javascript:'));
        return { title, url, text, originalLength: text.length, links };
      })()
    `;
    const results = await browser.tabs.executeScript(tabId, { code });
    const result = results?.[0];
    if (!result) return { success: false, error: 'extraction returned nothing' };
    const resultRestricted = firefoxRestrictedDomainFailure(result.url || '');
    if (resultRestricted) return resultRestricted;
    // Close the navigation race between tabs.get() and executeScript(). SPAs
    // and meta-refreshes can still change location during extraction.
    const resultUrlCheck = validateFetchUrl(result.url || '', {
      allowLocalNetwork: getAllowLocalNetwork(),
    });
    if (!resultUrlCheck.ok) {
      return { success: false, error: `Redirect to blocked URL: ${resultUrlCheck.error}`, finalUrl: result.url || '' };
    }
    const resultAddress = addresses?.failure(tabId);
    if (resultAddress) return { success: false, error: resultAddress, finalUrl: result.url || '' };

    return {
      success: true,
      // Ahead of text/links: the agent's generic result cap chops the JSON
      // tail, and these flags must survive it.
      ...BACKGROUND_TAB_RETRIEVAL,
      url: result.url,
      title: result.title,
      text: (result.text || '').slice(0, FETCH_TEXT_LIMIT),
      truncated: (result.originalLength || 0) > FETCH_TEXT_LIMIT,
      originalLength: result.originalLength,
      links: result.links?.slice(0, 30) || [],
    };
  } catch (e) {
    return { success: false, error: `research_url failed: ${e.message}` };
  } finally {
    addresses?.close();
    if (createdTab?.id != null) {
      browser.tabs.remove(createdTab.id).catch(() => {});
    }
  }
}

// The browser's download history is the user's own: unrelated files, their
// source URLs and full local paths (which name the OS account). The model
// sees only the downloads its conversation produced (`downloadIds`, kept by
// the agent), and each file only by its basename.
export function downloadBasename(filename) {
  return String(filename || '').split(/[\\/]/).pop() || '';
}

export async function listDownloads(opts = {}, { downloadIds = [] } = {}) {
  try {
    const limit = Math.min(opts.limit || 10, 50);
    const ids = [...new Set(downloadIds)].filter(id => Number.isSafeInteger(id) && id >= 0).sort((a, b) => b - a);
    const items = [];
    for (const id of ids) {
      if (items.length >= limit) break;
      const found = (await browser.downloads.search({ id })).find(item => item.id === id);
      if (found && found.exists !== false) items.push(found);
    }
    return {
      success: true,
      count: items.length,
      ...(items.length ? {} : { note: 'No downloads from this conversation. Only files WebBrain downloaded, or that downloaded while it was working, in this conversation are listed; the browser\'s download history is not. If the user wants another downloaded file read, ask them to attach it.' }),
      downloads: items.map(d => ({
        id: d.id,
        url: d.url,
        filename: downloadBasename(d.filename),
        state: d.state,
        bytesReceived: d.bytesReceived,
        totalBytes: d.totalBytes,
        startTime: d.startTime,
        endTime: d.endTime || null,
        mime: d.mime || '',
        paused: d.paused || false,
      })),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const READ_FILE_TEXT_LIMIT = 16000;
const READ_FILE_BASE64_LIMIT = 32000;
const READ_FILE_TEXT_PREFIX_BYTES = READ_FILE_TEXT_LIMIT * 4 + 4;
const READ_FILE_BINARY_PREFIX_BYTES = READ_FILE_BASE64_LIMIT * 0.75 + 1;
const READ_FILE_PAYLOAD_MAX_BYTES = 25 * 1024 * 1024;

function downloadedFileIsText(item, contentType) {
  return contentType.startsWith('text/') || /json|xml|javascript|csv|markdown/.test(contentType)
    || /\.(txt|md|csv|json|xml|html|js|ts|py|css|log|yaml|yml|toml|ini|conf|sh)$/i.test(item.filename || '');
}

function downloadedFileReadStillActive(ctx) {
  if (ctx.signal?.aborted) throw ctx.signal.reason || new Error('Download read stopped.');
  if (typeof ctx.checkStillActive === 'function') ctx.checkStillActive();
}

function downloadedFileIdentity(item) {
  return JSON.stringify([item.id, item.state, item.filename, item.url, item.mime, item.fileSize, item.exists]);
}

function downloadedFileContent(item, payload, contentSource, savedFileVerified) {
  const size = payload?.size;
  if (payload?.exists !== true || payload.readable !== true || !Number.isSafeInteger(size) || size < 0
      || typeof payload.base64 !== 'string' || payload.base64.length > Math.ceil(READ_FILE_TEXT_PREFIX_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.base64)) {
    return { success: false, code: 'saved_download_unreadable', error: 'The completed download could not be read from its saved source.' };
  }
  const binary = atob(payload.base64), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length !== payload.dataBytesRead || bytes.length > size
      || payload.dataTruncated !== (bytes.length < size)) {
    return { success: false, code: 'saved_download_read_incomplete', error: 'The downloaded-file byte window could not be verified.' };
  }
  const ct = String(item.mime || payload.mimeType || '').toLowerCase();
  const common = { success: true, filename: downloadBasename(item.filename), contentType: ct, sizeBytes: size,
    contentSource, savedFileVerified, sourceRefetched: false, bytesRead: bytes.length };
  if (downloadedFileIsText(item, ct)) {
    // Do not invent the full character count of a bounded byte prefix. A
    // streaming decode also omits a partial UTF-8 character at its boundary.
    const text = new TextDecoder().decode(bytes, { stream: payload.dataTruncated });
    return { ...common, contentType: ct || 'text/plain', text: text.slice(0, READ_FILE_TEXT_LIMIT),
      truncated: payload.dataTruncated || text.length > READ_FILE_TEXT_LIMIT,
      originalLength: payload.dataTruncated ? null : text.length, originalLengthKnown: !payload.dataTruncated };
  }
  if (size > READ_FILE_BASE64_LIMIT * 0.75) {
    return { ...common, note: savedFileVerified
      ? `Binary file too large to inline (${size} bytes). It is saved as ${downloadBasename(item.filename)}.`
      : `Captured binary payload too large to inline (${size} bytes). Firefox cannot verify the current on-disk file.` };
  }
  if (payload.dataTruncated) return { success: false, code: 'saved_download_read_incomplete', error: 'The small binary payload was not read completely.' };
  return { ...common, base64: payload.base64 };
}

function immutableDownloadedDataPayload(value, prefixBytes) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'data:') throw new Error('An immutable captured data URL is required.');
  const serialized = parsed.href.slice(5, parsed.hash ? -parsed.hash.length : undefined);
  const comma = serialized.indexOf(',');
  if (comma < 0 || comma > 1024 || serialized.length > READ_FILE_PAYLOAD_MAX_BYTES * 3 + 1024) {
    throw new Error('The captured download payload exceeds the bounded reader.');
  }
  const header = serialized.slice(0, comma), source = serialized.slice(comma + 1);
  const mimeType = header.split(';')[0] || 'text/plain';
  let size, bytes;
  if (/;base64$/i.test(header)) {
    const data = source.replace(/[\t\n\f\r ]/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error('Invalid captured base64 payload.');
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    size = Math.floor(data.length * 3 / 4) - padding;
    if (size > READ_FILE_PAYLOAD_MAX_BYTES) throw new Error('The captured download payload exceeds the 25MB reader limit.');
    const chars = Math.min(data.length, Math.ceil(prefixBytes / 3) * 4);
    const binary = atob(data.slice(0, chars));
    bytes = Uint8Array.from(binary.slice(0, prefixBytes), char => char.charCodeAt(0));
  } else {
    const prefix = []; size = 0;
    for (let i = 0; i < source.length;) {
      let part;
      if (source[i] === '%') {
        if (!/^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) throw new Error('Invalid captured percent-encoded payload.');
        part = [parseInt(source.slice(i + 1, i + 3), 16)]; i += 3;
      } else {
        const char = String.fromCodePoint(source.codePointAt(i));
        part = new TextEncoder().encode(char); i += char.length;
      }
      for (const byte of part) { if (size < prefixBytes) prefix.push(byte); size++; }
      if (size > READ_FILE_PAYLOAD_MAX_BYTES) throw new Error('The captured download payload exceeds the 25MB reader limit.');
    }
    bytes = new Uint8Array(prefix);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { exists: true, readable: true, size, mimeType, base64: btoa(binary),
    dataBytesRead: bytes.length, dataTruncated: bytes.length < size };
}

export async function readDownloadedFile(downloadId, ctx = {}) {
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) return { success: false, error: 'A valid downloadId is required.' };
  try {
    downloadedFileReadStillActive(ctx);
    const items = await browser.downloads.search({ id: downloadId });
    downloadedFileReadStillActive(ctx);
    const item = items.find(value => value.id === downloadId);
    if (!item) return { success: false, error: `Download #${downloadId} not found` };
    if (item.state !== 'complete' || item.exists === false) {
      return { success: false, code: 'saved_download_unavailable', error: 'The completed download is missing, deleted or not yet complete.' };
    }
    // Firefox has no native saved-path reader. Only the immutable payload
    // already captured in this download record can be read without a network
    // substitution; this is explicitly not current on-disk byte verification.
    if (typeof item.url !== 'string' || !item.url.startsWith('data:')) {
      return { success: false, code: 'saved_download_read_unavailable', error: 'Firefox cannot read this saved HTTP(S) download. Only immutable captured data: payloads are supported; the source URL was not fetched.' };
    }
    const ct = String(item.mime || '').toLowerCase();
    const prefixBytes = downloadedFileIsText(item, ct) ? READ_FILE_TEXT_PREFIX_BYTES : READ_FILE_BINARY_PREFIX_BYTES;
    const payload = immutableDownloadedDataPayload(item.url, prefixBytes);
    const current = await browser.downloads.search({ id: downloadId });
    downloadedFileReadStillActive(ctx);
    if (current.length !== 1 || downloadedFileIdentity(current[0]) !== downloadedFileIdentity(item)
        || (Number.isSafeInteger(item.fileSize) && item.fileSize >= 0 && item.fileSize !== payload.size)) {
      return { success: false, code: 'saved_download_changed', error: 'The captured download payload changed or disappeared during the read.' };
    }
    return downloadedFileContent(item, payload, 'immutable_download_data_url', false);
  } catch (error) {
    return { success: false, code: ctx.signal?.aborted ? 'saved_download_read_cancelled' : 'saved_download_read_failed',
      error: ctx.signal?.aborted ? 'Download read stopped; no file bytes returned.' : String(error?.message || 'Captured download read failed.') };
  }
}

let genericDownloadStore = null;
let genericDownloadJobs = null;
async function prepareGenericDownload(url, ctx = {}) {
  try {
    if (!genericDownloadStore) {
      genericDownloadStore = createDiskDownloadStore();
      genericDownloadJobs = createAuthenticatedDownloadJobs(genericDownloadStore.stage, genericDownloadStore.release);
    }
    const currentDocument = document, timeOrigin = performance.timeOrigin;
    const context = { documentUrl: browser.runtime.getURL('src/background.html'),
      isCurrent: () => document === currentDocument && performance.timeOrigin === timeOrigin && !ctx.signal?.aborted };
    return await prepareAuthenticatedDownload(url, { api: browser, transport: genericDownloadJobs, context,
      validateUrl: value => validateFetchUrl(value, { allowLocalNetwork: getAllowLocalNetwork() }), signal: ctx.signal });
  } catch (error) { return { success: false, error: `Authenticated streaming download staging is unavailable: ${error.message}` }; }
}

function genericDownloadFilename(stage) {
  const attachment = filenameFromContentDisposition(stage.contentDisposition);
  if (attachment) return attachment;
  try {
    const basename = safeDownloadFilename(decodeURIComponent(new URL(stage.finalUrl).pathname.split('/').pop() || ''));
    if (basename) return basename;
  } catch (_) {}
  return defaultSkillDownloadFilename(stage.contentType)?.replace(/^public-media/, 'download') || 'download.bin';
}

function retainGenericDownloadStage(downloadId, releaseToken, signal) {
  if (!releaseToken) return;
  let finished = false;
  const finish = async () => {
    if (finished) return; finished = true;
    browser.downloads.onChanged.removeListener(listener);
    signal?.removeEventListener('abort', cancel);
    await genericDownloadStore.release(releaseToken);
  };
  const listener = delta => { if (delta.id === downloadId && ['complete', 'interrupted'].includes(delta.state?.current)) void finish(); };
  const cancel = async () => { if (await callBrowserDownloadAction('cancel', downloadId)) await finish(); };
  signal?.addEventListener('abort', cancel, { once: true });
  browser.downloads.onChanged.addListener(listener);
  if (signal?.aborted) void cancel();
  findDownloadItem(downloadId).then(item => { if (['complete', 'interrupted'].includes(item?.state)) void finish(); }).catch(() => {});
}

// download_resource_from_page reads the element's resource in the page. A
// blob is read into memory for chrome.downloads (which cannot follow blob:
// URLs), so it is bounded and cancelled past maxBytes. A streaming playlist
// (HLS .m3u8, DASH .mpd) is not the media it plays: saving it would save
// only its text, so it is refused. Runs in the page: self-contained.
export async function readPageResourceForDownload(selector, maxBytes) {
  const playlistError = 'This element plays a streaming playlist (HLS .m3u8 or DASH .mpd), not a media file: saving it would save only the playlist text. Tell the user this stream cannot be saved as one file, or use a media-download skill for the site if one is enabled.';
  const playlistType = /^(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/(?:x-)?mpegurl)\b/i;
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: 'element not found' };
  // Try every common URL-bearing attribute.
  const url = el.src || el.href || el.currentSrc ||
            el.getAttribute('data-src') || el.getAttribute('data-url') || '';
  if (!url) return { ok: false, error: 'element has no src/href/currentSrc/data-src' };
  if (/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url)) return { ok: false, streamingPlaylist: true, error: playlistError };
  if (url.startsWith('blob:')) {
    try {
      const res = await fetch(url);
      const type = res.headers.get('content-type') || '';
      if (playlistType.test(type)) return { ok: false, streamingPlaylist: true, error: playlistError };
      const tooLarge = { ok: false, tooLarge: true, error: `The blob is larger than ${Math.round(maxBytes / 1048576)} MB, more than WebBrain reads into memory; nothing was saved.` };
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
      const chunks = [];
      let total = 0;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            try { await reader.cancel(); } catch (e) {}
            return tooLarge;
          }
          chunks.push(value);
        }
      } else {
        const whole = await res.blob();
        if (whole.size > maxBytes) return tooLarge;
        chunks.push(whole);
      }
      const blob = new Blob(chunks, { type });
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      return { ok: true, url: dataUrl, isBlob: true, mime: blob.type, size: blob.size };
    } catch (e) {
      return { ok: false, error: 'failed to read blob URL: ' + e.message };
    }
  }
  // Flag cross-origin resources: the permission gate charged this
  // download to the PAGE host, but a cross-origin resource is fetched
  // from a different host — route those through download_files, which
  // gates on the resource's own host.
  let crossOrigin = false;
  try { crossOrigin = new URL(url, location.href).origin !== location.origin; } catch (e) {}
  return { ok: true, url, isBlob: false, crossOrigin };
}

const PAGE_BLOB_MAX_BYTES = 25 * 1024 * 1024;

export async function downloadResourceFromPage(tabId, args = {}, ctx = {}) {
  const { selector, filename } = args;
  if (!selector) return { success: false, error: 'selector is required' };
  try {
    const code = `(${readPageResourceForDownload.toString()})(${JSON.stringify(selector)}, ${PAGE_BLOB_MAX_BYTES})`;
    const results = await browser.tabs.executeScript(tabId, { code });
    const r = results?.[0];
    if (!r?.ok) {
      return { success: false, error: r?.error || 'extraction failed',
        ...(r?.streamingPlaylist ? { streamingPlaylist: true } : {}), ...(r?.tooLarge ? { tooLarge: true } : {}) };
    }
    if (!r.isBlob && r.crossOrigin) {
      return {
        success: false,
        error: `This resource is hosted on a different origin than the page, so it can't be downloaded under the current site's permission. Use download_files({urls:["${r.url}"]}) instead — that path checks download permission for the resource's own host.`,
      };
    }

    if (!r.isBlob) {
      const urlCheck = validateFetchUrl(r.url, { allowLocalNetwork: getAllowLocalNetwork() });
      if (!urlCheck.ok) return { success: false, blocked: true, error: urlCheck.error };
    }

    if (!r.isBlob) {
      const batch = await downloadFiles({ urls: [r.url], filename }, ctx);
      const result = batch.downloads?.[0] || batch;
      return { ...result, sourceUrl: r.url, blob: false, mime: null };
    }

    const downloadFilename = await filenameForConfiguredDownload(filename);
    const downloadId = await browser.downloads.download({
      url: r.url,
      filename: downloadFilename,
      conflictAction: 'uniquify',
    });
    const info = await resolveDownloadInfo(downloadId);
    const complete = info?.state === 'complete';
    return {
      success: complete,
      downloadId,
      sourceUrl: r.isBlob ? '[blob]' : r.url,
      mime: r.mime || null,
      blob: !!r.isBlob,
      ...(info?.filename ? { filename: info.filename } : {}),
      ...(info?.state ? { state: info.state } : {}),
      ...(info?.bytesReceived != null ? { bytesReceived: info.bytesReceived } : {}),
      ...(info?.totalBytes != null ? { totalBytes: info.totalBytes } : {}),
      ...(!complete ? {
        pending: info?.state !== 'interrupted',
        error: info?.state === 'interrupted'
          ? `Download interrupted${info.error ? `: ${info.error}` : ' before completion.'}`
          : `Download did not complete before timeout${info?.state ? ` (state: ${info.state})` : ''}.`,
      } : {}),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const DOWNLOAD_BATCH_CONCURRENCY = 3;
const DOWNLOAD_BATCH_MAX = 50;

// browser.downloads.download() resolves to an id immediately, before the local
// path is decided — so the freshly-returned result can't carry the filename.
// Poll for it. Returns the resolved on-disk path + state once the download
// reaches a terminal state, or the best-known info if it's still in progress
// when we time out. Best-effort: never throws.
async function resolveDownloadInfo(downloadId, timeoutMs = 15000, opts = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw responseAbortError(opts.signal);
    let items;
    try {
      items = await browser.downloads.search({ id: downloadId });
    } catch {
      return last;
    }
    const it = items && items[0];
    if (it) {
      last = summarizeDownloadItem(it);
      if (opts.expectedUrl) last = markUnsafeSkillDownload(last, opts.expectedUrl);
      if (last.finalUrlBlocked) return last;
      if (it.state === 'complete' || it.state === 'interrupted') return last;
    }
    await sleepAbortable(200, opts.signal || null);
  }
  return last; // timed out — return best-known (may still be in_progress)
}

export async function downloadFiles(args = {}, ctx = {}) {
  const urls = args.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return { success: false, error: 'urls array is required' };
  }
  if (urls.length > DOWNLOAD_BATCH_MAX) {
    return { success: false, error: `Too many URLs (max ${DOWNLOAD_BATCH_MAX})` };
  }

  const singleFilename = (urls.length === 1 && args.filename) ? args.filename : null;
  const results = new Array(urls.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const url = urls[i];
      let stage = null;
      try {
        const urlCheck = validateFetchUrl(url, { allowLocalNetwork: getAllowLocalNetwork() });
        if (!urlCheck.ok) {
          results[i] = { url, success: false, blocked: true, error: urlCheck.error };
          continue;
        }
        stage = await prepareGenericDownload(url, ctx);
        if (!stage.success) { results[i] = { url, ...stage, success: false }; continue; }
        if (ctx.signal?.aborted) {
          await genericDownloadStore.release(stage.releaseToken);
          results[i] = { url, success: false, cancelled: true, error: 'Download stopped before saving.' }; continue;
        }
        const filename = await filenameForConfiguredDownload(i === 0 && singleFilename ? singleFilename : genericDownloadFilename(stage));
        const opts = { url: stage.localUrl, conflictAction: 'uniquify' };
        if (filename) opts.filename = filename;
        const downloadId = await browser.downloads.download(opts);
        retainGenericDownloadStage(downloadId, stage.releaseToken, ctx.signal);
        results[i] = { url, downloadId, success: true, finalUrl: stage.finalUrl };
      } catch (e) {
        if (stage?.releaseToken) await genericDownloadStore.release(stage.releaseToken);
        results[i] = { url, success: false, error: e.message };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_BATCH_CONCURRENCY, urls.length) }, () => worker())
  );

  // Resolve browser-reported completion details AFTER the download workers
  // return so waiting on completion doesn't hold a concurrency slot. The
  // filename is for immediate verification/reporting only; durable context uses
  // the downloadId, not a page-influenced basename/path.
  await Promise.all(results.map(async (r) => {
    if (r && r.success && r.downloadId != null) {
      const info = await resolveDownloadInfo(r.downloadId);
      if (info) {
        if (info.filename) r.filename = info.filename;
        if (info.state) r.state = info.state;
        if (info.error) r.error = info.error;
        if (info.bytesReceived != null) r.bytesReceived = info.bytesReceived;
        if (info.totalBytes != null) r.totalBytes = info.totalBytes;
        if (ctx.signal?.aborted) { r.success = false; r.cancelled = true; r.savedBeforeStop = info.state === 'complete'; }
        if (info.state === 'interrupted') {
          r.success = false;
          r.error = info.error ? `Download interrupted: ${info.error}` : 'Download interrupted before completion.';
        }
      }
    }
  }));

  return {
    success: true,
    total: urls.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    downloads: results,
  };
}
