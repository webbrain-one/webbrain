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

const FETCH_TEXT_LIMIT = 8000;
const FETCH_JSON_LIMIT = 16000;

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

/**
 * Agent-driven fetch. See chrome's copy for the full cookie/redirect policy.
 *   url   — target URL (validated)
 *   opts  — { method, headers, body } (LLM-controlled)
 *   ctx   — { tabId } (extension-supplied; used for cookie policy)
 */
export async function fetchUrl(url, opts = {}, ctx = {}) {
  if (!url) return { success: false, error: 'url is required' };
  const allowLocal = getAllowLocalNetwork();
  const v = validateFetchUrl(url, { allowLocalNetwork: allowLocal });
  if (!v.ok) return { success: false, error: v.error };

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

  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body || undefined,
      credentials: attachCookies ? 'include' : 'omit',
      redirect: 'follow',
    });

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

    if (contentType.includes('json')) {
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      return {
        success: true, status, contentType, url: finalUrl,
        json: pretty.slice(0, FETCH_JSON_LIMIT),
        truncated: pretty.length > FETCH_JSON_LIMIT,
        originalLength: pretty.length,
      };
    }

    if (contentType.includes('html') || contentType.includes('xhtml')) {
      const html = await res.text();
      const { title, text } = htmlToText(html);
      return {
        success: true, status, contentType, url: finalUrl, title,
        text: text.slice(0, FETCH_TEXT_LIMIT),
        truncated: text.length > FETCH_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    if (contentType.startsWith('text/') ||
        contentType.includes('xml') ||
        contentType.includes('javascript') ||
        contentType.includes('csv') ||
        contentType.includes('markdown') ||
        contentType === '') {
      const text = await res.text();
      return {
        success: true, status, contentType, url: finalUrl,
        text: text.slice(0, FETCH_TEXT_LIMIT),
        truncated: text.length > FETCH_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    const len = res.headers.get('content-length');
    return {
      success: true, status, contentType, url: finalUrl,
      note: 'Binary content not inlined. Use download_file({url}) then read_downloaded_file({downloadId}) if you need contents.',
      sizeBytes: len ? parseInt(len, 10) : null,
    };
  } catch (e) {
    return { success: false, error: `Fetch failed: ${e.message}` };
  }
}

export async function researchUrl(url, opts = {}) {
  if (!url) return { success: false, error: 'url is required' };
  const timeoutMs = Math.min(opts.timeout || 8000, 30000);
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

    return {
      success: true,
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
    if (createdTab?.id != null) {
      browser.tabs.remove(createdTab.id).catch(() => {});
    }
  }
}

export async function listDownloads(opts = {}) {
  try {
    const limit = Math.min(opts.limit || 10, 50);
    const items = await browser.downloads.search({
      orderBy: ['-startTime'],
      limit,
      exists: true,
    });
    return {
      success: true,
      count: items.length,
      downloads: items.map(d => ({
        id: d.id,
        url: d.url,
        filename: d.filename,
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

export async function readDownloadedFile(downloadId, ctx = {}) {
  if (downloadId == null) return { success: false, error: 'downloadId is required' };
  try {
    const items = await browser.downloads.search({ id: downloadId });
    if (items.length === 0) return { success: false, error: `Download #${downloadId} not found` };
    const item = items[0];
    if (item.state !== 'complete') {
      return { success: false, error: `Download is in state: ${item.state}, not complete` };
    }

    const allowLocal = getAllowLocalNetwork();
    const v = validateFetchUrl(item.url, { allowLocalNetwork: allowLocal });
    if (!v.ok) return { success: false, error: v.error };

    let attachCookies = false;
    let tabRegDomain = null;
    if (ctx && ctx.tabId != null) {
      try {
        const tab = await browser.tabs.get(ctx.tabId);
        if (tab && tab.url) {
          try {
            tabRegDomain = registrableDomain(new URL(tab.url).hostname);
            if (tabRegDomain && tabRegDomain === registrableDomain(new URL(item.url).hostname)) {
              attachCookies = true;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    const res = await fetch(item.url, {
      credentials: attachCookies ? 'include' : 'omit',
      redirect: 'follow',
    });
    if (res.url && res.url !== item.url) {
      const v2 = validateFetchUrl(res.url, { allowLocalNetwork: allowLocal });
      if (!v2.ok) return { success: false, error: `Redirect to blocked URL: ${v2.error}`, finalUrl: res.url };
      if (attachCookies && tabRegDomain) {
        try {
          const finalRegDomain = registrableDomain(new URL(res.url).hostname);
          if (finalRegDomain !== tabRegDomain) {
            return { success: false, error: `Redirect crossed registrable-domain boundary; body discarded for safety.`, finalUrl: res.url };
          }
        } catch (_) {}
      }
    }
    if (!res.ok) {
      return { success: false, error: `Re-fetch failed with HTTP ${res.status}` };
    }
    const ct = (item.mime || res.headers.get('content-type') || '').toLowerCase();

    if (ct.startsWith('text/') ||
        ct.includes('json') ||
        ct.includes('xml') ||
        ct.includes('javascript') ||
        ct.includes('csv') ||
        ct.includes('markdown') ||
        /\.(txt|md|csv|json|xml|html|js|ts|py|css|log|yaml|yml|toml|ini|conf|sh)$/i.test(item.filename)) {
      const text = await res.text();
      return {
        success: true,
        filename: item.filename,
        contentType: ct || 'text/plain',
        text: text.slice(0, READ_FILE_TEXT_LIMIT),
        truncated: text.length > READ_FILE_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    const buf = await res.arrayBuffer();
    const sizeBytes = buf.byteLength;
    if (sizeBytes > READ_FILE_BASE64_LIMIT * 0.75) {
      return {
        success: true,
        filename: item.filename,
        contentType: ct,
        sizeBytes,
        note: `Binary file too large to inline (${sizeBytes} bytes). On disk at: ${item.filename}`,
      };
    }
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return {
      success: true,
      filename: item.filename,
      contentType: ct,
      sizeBytes,
      base64: btoa(bin),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function downloadResourceFromPage(tabId, args = {}) {
  const { selector, filename } = args;
  if (!selector) return { success: false, error: 'selector is required' };
  try {
    const code = `
      (async () => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'element not found' };
        let url = el.src || el.href || el.currentSrc ||
                  el.getAttribute('data-src') || el.getAttribute('data-url') || '';
        if (!url) return { ok: false, error: 'element has no src/href/currentSrc/data-src' };
        if (url.startsWith('blob:')) {
          try {
            const res = await fetch(url);
            const blob = await res.blob();
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
        return { ok: true, url, isBlob: false };
      })()
    `;
    const results = await browser.tabs.executeScript(tabId, { code });
    const r = results?.[0];
    if (!r?.ok) return { success: false, error: r?.error || 'extraction failed' };

    const downloadId = await browser.downloads.download({
      url: r.url,
      filename: filename || undefined,
      conflictAction: 'uniquify',
    });
    return {
      success: true,
      downloadId,
      sourceUrl: r.isBlob ? '[blob]' : r.url,
      mime: r.mime || null,
      blob: !!r.isBlob,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const DOWNLOAD_BATCH_CONCURRENCY = 3;
const DOWNLOAD_BATCH_MAX = 50;

export async function downloadFiles(args = {}) {
  const urls = args.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return { success: false, error: 'urls array is required' };
  }
  if (urls.length > DOWNLOAD_BATCH_MAX) {
    return { success: false, error: `Too many URLs (max ${DOWNLOAD_BATCH_MAX})` };
  }

  const results = new Array(urls.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const url = urls[i];
      try {
        const downloadId = await browser.downloads.download({
          url, conflictAction: 'uniquify',
        });
        results[i] = { url, downloadId, success: true };
      } catch (e) {
        results[i] = { url, success: false, error: e.message };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_BATCH_CONCURRENCY, urls.length) }, () => worker())
  );

  return {
    success: true,
    total: urls.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    downloads: results,
  };
}
