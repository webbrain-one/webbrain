/**
 * Network & download tools for the WebBrain agent.
 *
 * These run in the background service worker context, so they have access
 * to fetch() (with the user's cookies via credentials:'include'), the
 * chrome.tabs API for hidden-tab research, and chrome.downloads for file
 * I/O. None of these tools touch the active page directly — they all run
 * "out of band" so they don't interfere with whatever the user is doing.
 *
 * NOTE: DOMParser is NOT available in MV3 service workers, so HTML→text
 * conversion uses regex-based stripping. It's not perfect but it's good
 * enough to feed an LLM the readable content of a page.
 */

// ─── HTML utilities ─────────────────────────────────────────────────────

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

/**
 * Strip HTML to plain text. Removes scripts, styles, noscript, svg.
 * Extracts <title>. Collapses whitespace. Good enough for LLM consumption.
 */
function htmlToText(html) {
  if (!html) return { title: '', text: '' };
  let s = html;
  // Title
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  // Strip noisy blocks
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
  s = s.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Insert newlines around block elements so paragraphs don't merge.
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|article|section|header|footer)[^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Collapse whitespace but preserve newlines
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: s };
}

// ─── fetch_url ──────────────────────────────────────────────────────────

// Per-call response size caps. The cost here is LLM context (and prompt-
// cache write on the first turn) — not browser memory — so we keep these
// generous enough to fit even long Wikipedia articles in a single call.
//   - TEXT (~192k chars ≈ 48k tokens) covers HTML stripped to readable text
//     plus text/* responses. Catches the long tail of Wikipedia articles,
//     biographies, big GitHub READMEs, etc.
//   - JSON (~96k chars ≈ 24k tokens) — JSON is denser per token (repeated
//     keys) so it scales sub-linearly with text.
// Modern frontier models have 200k+ context windows and prompt caching
// amortizes repeated reads, so the marginal cost of a generous cap is
// near-zero in practice. Most responses come in well under these limits;
// the cap only bites on the long tail.
const FETCH_TEXT_LIMIT = 192000;
const FETCH_JSON_LIMIT = 96000;

/**
 * Validate a URL before the agent fetches it.
 *
 * The LLM-callable fetch tools run in the background service worker with
 * <all_urls> host permissions. Without this gate, prompt-injected text on a
 * visited page can steer the agent into:
 *   - reading cloud instance-metadata endpoints (169.254.169.254, etc.),
 *   - probing the user's intranet / RFC1918 hosts,
 *   - fetching local services (Ollama, Grafana, internal admin panels),
 *   - using non-http schemes (file:, chrome-extension:, javascript:, data:).
 *
 * Returns { ok: true } if the URL is safe, or { ok: false, error } otherwise.
 *
 * Two tiers of blocks:
 *   - ALWAYS-BLOCKED: non-http schemes, cloud-metadata IPs/hostnames,
 *     link-local IPv6, multicast/reserved, *.internal/*.local. These are
 *     never relaxed.
 *   - LOCAL-NETWORK: loopback, RFC1918, unique-local IPv6, `localhost`,
 *     *.localhost. Relaxed when opts.allowLocalNetwork is true (the user
 *     opted in via the "Allow agent to access local network" setting).
 */
export function validateFetchUrl(rawUrl, opts = {}) {
  const allowLocal = !!opts.allowLocalNetwork;

  let u;
  try { u = new URL(rawUrl); }
  catch (_) { return { ok: false, error: `Invalid URL: ${rawUrl}` }; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `Unsupported URL scheme: ${u.protocol} (only http/https allowed)` };
  }

  // URL.hostname keeps the [..] around IPv6 literals — strip them.
  let host = (u.hostname || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return { ok: false, error: 'URL has no hostname.' };

  // Always-blocked hostnames (cloud metadata aliases + intranet TLDs).
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
  // Local hostnames — relaxable.
  if (!allowLocal && (host === 'localhost' || host.endsWith('.localhost'))) {
    return { ok: false, error: `Blocked local hostname: ${host} (enable "Allow agent to access local network" in settings to permit)` };
  }

  // IPv4 literal.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const o = ipv4.slice(1).map((n) => parseInt(n, 10));
    if (o.some((n) => Number.isNaN(n) || n > 255)) {
      return { ok: false, error: `Invalid IPv4: ${host}` };
    }
    // Always-blocked IPv4 ranges (cloud metadata, CGNAT, multicast, 0/8).
    if (o[0] === 0) return { ok: false, error: `Blocked unspecified IPv4: ${host}` };
    if (o[0] === 169 && o[1] === 254) return { ok: false, error: `Blocked link-local IPv4 (cloud metadata): ${host}` };
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return { ok: false, error: `Blocked CGNAT IPv4: ${host}` };
    if (o[0] >= 224) return { ok: false, error: `Blocked multicast/reserved IPv4: ${host}` };
    // Local-network IPv4 ranges — relaxable.
    if (!allowLocal) {
      const localHint = ' (enable "Allow agent to access local network" in settings to permit)';
      if (o[0] === 10) return { ok: false, error: `Blocked private IPv4: ${host}${localHint}` };
      if (o[0] === 127) return { ok: false, error: `Blocked loopback IPv4: ${host}${localHint}` };
      if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return { ok: false, error: `Blocked private IPv4: ${host}${localHint}` };
      if (o[0] === 192 && o[1] === 168) return { ok: false, error: `Blocked private IPv4: ${host}${localHint}` };
    }
  }

  // IPv6 literal.
  if (host.includes(':')) {
    // Always-blocked IPv6 — link-local fe80::/10.
    if (/^fe[89ab][0-9a-f]?:/i.test(host)) {
      return { ok: false, error: `Blocked link-local IPv6: ${host}` };
    }
    // Always-blocked unspecified ::.
    if (host === '::') {
      return { ok: false, error: `Blocked unspecified IPv6: ${host}` };
    }
    // Local-network IPv6 — relaxable.
    if (!allowLocal) {
      const localHint = ' (enable "Allow agent to access local network" in settings to permit)';
      if (host === '::1' || /^0:0:0:0:0:0:0:[01]$/.test(host)) {
        return { ok: false, error: `Blocked loopback IPv6: ${host}${localHint}` };
      }
      // Unique-local fc00::/7 → first hextet fc.. or fd..
      if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) {
        return { ok: false, error: `Blocked unique-local IPv6: ${host}${localHint}` };
      }
    }
    // IPv4-mapped IPv6. URL parser normalizes `::ffff:127.0.0.1` to
    // `::ffff:7f00:1`, so match either form, decode the last two hextets,
    // and re-validate (passing through opts so allowLocal carries over).
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
 * Best-effort registrable-domain extractor (a.k.a. eTLD+1).
 *
 * Used to decide whether an agent-driven fetch should attach the user's
 * cookies: we attach cookies only when the fetch target shares the
 * registrable domain of the active tab the agent is operating on. That
 * way, a prompt-injected page on news.example.com can't steer the agent
 * into a cookied read of mail.google.com.
 *
 * This is NOT the full Public Suffix List — it covers common ccTLD
 * patterns and well-known multi-tenant hosts. For unknown multi-label
 * suffixes it falls back to "last 2 labels", which over-matches on rare
 * ccTLDs. If you need PSL-perfect accuracy, swap in a vetted PSL.
 */
const KNOWN_MULTI_LABEL_TLDS = new Set([
  // ccTLD patterns
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in', 'co.il', 'co.th',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'com.hk',
  'com.tw', 'com.ar', 'com.co', 'com.pe', 'com.ph', 'com.my', 'com.vn',
  'gov.uk', 'gov.au', 'gov.in', 'gov.cn',
  'ac.uk', 'ac.jp', 'ac.in', 'ac.kr',
  'org.uk', 'org.au', 'org.nz',
  'net.au', 'net.uk',
  // Known multi-tenant hosting (PSL "private" section)
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
  if (lower.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(lower)) return lower; // IP literal
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
  chrome.storage.local.get('agentAllowLocalNetwork').then((r) => {
    _allowLocalNetwork = !!r.agentAllowLocalNetwork;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.agentAllowLocalNetwork) {
      _allowLocalNetwork = !!changes.agentAllowLocalNetwork.newValue;
    }
  });
} catch (_) { /* storage not available (e.g. unit tests) — default false */ }

export function getAllowLocalNetwork() {
  return _allowLocalNetwork;
}

/**
 * Agent-driven fetch.
 *
 *   url   — target URL (validated against validateFetchUrl)
 *   opts  — { method, headers, body } (LLM-controlled)
 *   ctx   — { tabId } (extension-supplied; used to decide cookie policy)
 *
 * Cookie policy: cookies are attached only when the fetch target shares the
 * registrable domain (eTLD+1) of the active tab the agent is operating on.
 * On a github.com tab, fetches to api.github.com get cookies; fetches to
 * mail.google.com do not. This prevents prompt-injected pages from steering
 * the agent into authenticated cross-origin reads.
 *
 * Redirect policy: redirects ARE followed (so http→https and similar work),
 * but the final URL is re-validated against validateFetchUrl. If a redirect
 * lands on a blocked host, or — when cookies were attached — crosses the
 * eTLD+1 boundary, the body is discarded and an error is returned.
 */
export async function fetchUrl(url, opts = {}, ctx = {}) {
  if (!url) return { success: false, error: 'url is required' };
  const allowLocal = getAllowLocalNetwork();
  const v = validateFetchUrl(url, { allowLocalNetwork: allowLocal });
  if (!v.ok) return { success: false, error: v.error };

  // Decide cookie policy based on active tab origin (if any).
  let attachCookies = false;
  let tabRegDomain = null;
  if (ctx && ctx.tabId != null) {
    try {
      const tab = await chrome.tabs.get(ctx.tabId);
      if (tab && tab.url) {
        try {
          const tabHost = new URL(tab.url).hostname;
          const fetchHost = new URL(url).hostname;
          tabRegDomain = registrableDomain(tabHost);
          if (tabRegDomain && tabRegDomain === registrableDomain(fetchHost)) {
            attachCookies = true;
          }
        } catch (_) { /* unparseable tab URL */ }
      }
    } catch (_) { /* tab gone */ }
  }

  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body || undefined,
      credentials: attachCookies ? 'include' : 'omit',
      redirect: 'follow',
    });

    // Re-validate the final URL after redirects. If a redirect landed on a
    // blocked host, discard the body. If cookies were attached and the
    // redirect crossed the registrable-domain boundary, also discard — we
    // only surface authenticated content for the same eTLD+1 as the tab.
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

    // JSON
    if (contentType.includes('json')) {
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      return {
        success: true,
        status, contentType, url: finalUrl,
        json: pretty.slice(0, FETCH_JSON_LIMIT),
        truncated: pretty.length > FETCH_JSON_LIMIT,
        originalLength: pretty.length,
      };
    }

    // HTML — strip to readable text
    if (contentType.includes('html') || contentType.includes('xhtml')) {
      const html = await res.text();
      const { title, text } = htmlToText(html);
      return {
        success: true,
        status, contentType, url: finalUrl, title,
        text: text.slice(0, FETCH_TEXT_LIMIT),
        truncated: text.length > FETCH_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    // Plain text family
    if (contentType.startsWith('text/') ||
        contentType.includes('xml') ||
        contentType.includes('javascript') ||
        contentType.includes('csv') ||
        contentType.includes('markdown') ||
        contentType === '') {
      const text = await res.text();
      return {
        success: true,
        status, contentType, url: finalUrl,
        text: text.slice(0, FETCH_TEXT_LIMIT),
        truncated: text.length > FETCH_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    // Binary or unknown — don't bloat the conversation; tell the model how to get it
    const len = res.headers.get('content-length');
    return {
      success: true,
      status, contentType, url: finalUrl,
      note: 'Binary content not inlined. Use download_file({url}) to save it, then read_downloaded_file({downloadId}) if you need to inspect contents.',
      sizeBytes: len ? parseInt(len, 10) : null,
    };
  } catch (e) {
    return { success: false, error: `Fetch failed: ${e.message}` };
  }
}

// ─── research_url (hidden tab + JS rendering) ───────────────────────────

export async function researchUrl(url, opts = {}) {
  if (!url) return { success: false, error: 'url is required' };
  const timeoutMs = Math.min(opts.timeout || 8000, 30000);
  let createdTab = null;
  try {
    const createProps = { url, active: false };
    if (opts.sourceTabId != null) {
      try {
        const sourceTab = await chrome.tabs.get(opts.sourceTabId);
        if (sourceTab?.windowId != null) createProps.windowId = sourceTab.windowId;
        if (typeof sourceTab?.index === 'number') createProps.index = sourceTab.index + 1;
        if (sourceTab?.id != null) createProps.openerTabId = sourceTab.id;
      } catch (_) {}
    }
    createdTab = await chrome.tabs.create(createProps);
    const tabId = createdTab.id;

    // Wait for the tab to finish loading.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`research_url timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === 'complete') {
          clearTimeout(t);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // Give SPAs a beat to hydrate after onload.
    await new Promise(r => setTimeout(r, 800));

    // Extract content via injected script. Strips chrome (header/nav/footer)
    // so we get the actual article/main content rather than navigation.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const title = document.title || '';
        const url = location.href;
        // Prefer <main> or <article> if present, otherwise body minus chrome.
        const main = document.querySelector('main, article, [role="main"]');
        let root = main || document.body;
        const clone = root.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, iframe, header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navigation, .header, .footer, .sidebar').forEach(el => el.remove());
        const text = (clone.innerText || clone.textContent || '').trim();
        // Also collect outbound links so the model can do follow-up research.
        const links = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 50)
          .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
          .filter(l => l.text && l.href && !l.href.startsWith('javascript:'));
        return { title, url, text, originalLength: text.length, links };
      },
    });

    const result = results?.[0]?.result;
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
      chrome.tabs.remove(createdTab.id).catch(() => {});
    }
  }
}

// ─── list_downloads ─────────────────────────────────────────────────────

export async function listDownloads(opts = {}) {
  try {
    const limit = Math.min(opts.limit || 10, 50);
    const items = await chrome.downloads.search({
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

// ─── read_downloaded_file ───────────────────────────────────────────────

const READ_FILE_TEXT_LIMIT = 16000;
const READ_FILE_BASE64_LIMIT = 32000;

export async function readDownloadedFile(downloadId, ctx = {}) {
  if (downloadId == null) return { success: false, error: 'downloadId is required' };
  try {
    const items = await chrome.downloads.search({ id: downloadId });
    if (items.length === 0) return { success: false, error: `Download #${downloadId} not found` };
    const item = items[0];
    if (item.state !== 'complete') {
      return { success: false, error: `Download is in state: ${item.state}, not complete` };
    }

    // Re-fetch the source URL. Validate first; apply same cookie policy as
    // fetchUrl (eTLD+1 of active tab), and re-validate after redirects.
    const allowLocal = getAllowLocalNetwork();
    const v = validateFetchUrl(item.url, { allowLocalNetwork: allowLocal });
    if (!v.ok) return { success: false, error: v.error };

    let attachCookies = false;
    let tabRegDomain = null;
    if (ctx && ctx.tabId != null) {
      try {
        const tab = await chrome.tabs.get(ctx.tabId);
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

    // Text-y types — return as text
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

    // Binary
    const buf = await res.arrayBuffer();
    const sizeBytes = buf.byteLength;
    if (sizeBytes > READ_FILE_BASE64_LIMIT * 0.75) {
      return {
        success: true,
        filename: item.filename,
        contentType: ct,
        sizeBytes,
        note: `Binary file too large to inline (${sizeBytes} bytes). It is on disk at: ${item.filename}`,
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

// ─── download_resource_from_page ────────────────────────────────────────

export async function downloadResourceFromPage(tabId, args = {}) {
  const { selector, filename } = args;
  if (!selector) return { success: false, error: 'selector is required' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'element not found' };
        // Try every common URL-bearing attribute.
        let url = el.src || el.href || el.currentSrc ||
                  el.getAttribute('data-src') || el.getAttribute('data-url') || '';
        if (!url) return { ok: false, error: 'element has no src/href/currentSrc/data-src' };

        // Blob URLs need to be read into a data URL because chrome.downloads
        // can't follow blob:// from background context.
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
      },
      args: [selector],
    });
    const r = results?.[0]?.result;
    if (!r?.ok) return { success: false, error: r?.error || 'extraction failed' };

    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: r.url,
        filename: filename || undefined,
        conflictAction: 'uniquify',
      }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
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

// ─── download_files (batch with concurrency 3) ──────────────────────────

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

  const singleFilename = (urls.length === 1 && args.filename) ? args.filename : null;

  const results = new Array(urls.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const url = urls[i];
      try {
        const opts = { url, conflictAction: 'uniquify' };
        if (i === 0 && singleFilename) opts.filename = singleFilename;
        const downloadId = await new Promise((resolve, reject) => {
          chrome.downloads.download(opts, (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
          });
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
