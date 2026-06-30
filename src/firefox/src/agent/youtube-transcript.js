const DEFAULT_MAX_CHARS = 6000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 6000;
const CAPTION_FETCH_TIMEOUT_MS = 15000;
const TRANSCRIPT_CACHE_TTL_MS = 10 * 60 * 1000;

const transcriptCache = new Map();
const transcriptInflight = new Map();

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function isYoutubeUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl || '')).hostname.toLowerCase();
    return host === 'youtu.be' ||
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com');
  } catch {
    return false;
  }
}

function youtubeVideoIdentity(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const host = url.hostname.toLowerCase();
    let videoId = '';
    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v') || '';
    } else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      videoId = match ? match[1] : '';
    }
    if (videoId) return `video:${videoId}`;
    return `page:${host}${url.pathname}${url.search}`;
  } catch {
    return `raw:${String(rawUrl || '')}`;
  }
}

function normalizedTrackArgs(args = {}) {
  const trackIndex = Number(args.trackIndex);
  const normalizedIndex = Number.isInteger(trackIndex) && trackIndex >= 0 ? String(trackIndex) : '';
  return [
    String(args.language || '').trim().toLowerCase(),
    String(args.track || 'default').trim().toLowerCase() || 'default',
    normalizedIndex,
  ].join('|');
}

export function youtubeTranscriptCacheKey(tabId, pageUrl, args = {}) {
  return `${tabId || ''}|${youtubeVideoIdentity(pageUrl)}|${normalizedTrackArgs(args)}`;
}

export function clearYoutubeTranscriptCache() {
  transcriptCache.clear();
  transcriptInflight.clear();
}

function isAllowedCaptionHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'youtube-nocookie.com' ||
    h.endsWith('.youtube-nocookie.com');
}

function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[lower] || match;
  });
}

function normalizeText(text) {
  return decodeEntities(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function attrValue(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, 'i');
  const match = String(attrs || '').match(re);
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function findJsonObjectAfterMarker(text, marker, fromIndex = 0) {
  const markerIndex = text.indexOf(marker, fromIndex);
  if (markerIndex < 0) return null;
  const open = text.indexOf('{', markerIndex);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: text.slice(open, i + 1), nextIndex: i + 1 };
    }
  }
  return null;
}

function looksLikePlayerResponse(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    (value.videoDetails || value.captions || value.streamingData || value.playabilityStatus)
  );
}

function compactPlayerResponse(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    videoDetails: value.videoDetails || null,
    captions: value.captions || null,
  };
}

export function extractYoutubePlayerResponseFromHtml(html) {
  const text = String(html || '');
  let from = 0;
  while (from < text.length) {
    const found = findJsonObjectAfterMarker(text, 'ytInitialPlayerResponse', from);
    if (!found) return null;
    from = found.nextIndex;
    try {
      const parsed = JSON.parse(found.json);
      if (looksLikePlayerResponse(parsed)) return compactPlayerResponse(parsed);
    } catch {
      // Keep scanning; YouTube pages can contain escaped copies too.
    }
  }
  return null;
}

function trackName(name) {
  if (!name) return '';
  if (typeof name.simpleText === 'string') return name.simpleText;
  if (Array.isArray(name.runs)) return name.runs.map(run => run?.text || '').join('');
  return '';
}

export function normalizeYoutubePlayerResponse(response, pageTitle = '') {
  const root = response?.captions?.playerCaptionsTracklistRenderer || {};
  const rawTracks = Array.isArray(root.captionTracks) ? root.captionTracks : [];
  const tracks = rawTracks
    .map((track, index) => ({
      index,
      baseUrl: typeof track.baseUrl === 'string' ? track.baseUrl : '',
      languageCode: String(track.languageCode || ''),
      name: normalizeText(trackName(track.name) || track.languageCode || `Track ${index + 1}`),
      kind: track.kind === 'asr' ? 'asr' : 'manual',
      vssId: String(track.vssId || ''),
      isTranslatable: !!track.isTranslatable,
    }))
    .filter(track => track.baseUrl);

  const details = response?.videoDetails || {};
  return {
    video: {
      id: details.videoId || '',
      title: normalizeText(details.title || pageTitle || ''),
      author: normalizeText(details.author || ''),
      lengthSeconds: details.lengthSeconds ? Number(details.lengthSeconds) : null,
    },
    tracks,
  };
}

export function extractYoutubeTranscriptDataFromHtml(html, pageTitle = '') {
  const response = extractYoutubePlayerResponseFromHtml(html);
  return normalizeYoutubePlayerResponse(response, pageTitle);
}

function languageMatches(track, language) {
  const wanted = String(language || '').trim().toLowerCase();
  if (!wanted) return true;
  const code = String(track.languageCode || '').toLowerCase();
  const vss = String(track.vssId || '').toLowerCase();
  return code === wanted || code.startsWith(`${wanted}-`) || vss === wanted || vss.includes(`.${wanted}`);
}

export function selectYoutubeCaptionTrack(tracks, opts = {}) {
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length) return null;

  const index = Number(opts.trackIndex);
  if (Number.isInteger(index) && index >= 0 && index < list.length) return list[index];

  const languageFiltered = opts.language
    ? list.filter(track => languageMatches(track, opts.language))
    : list.slice();
  const candidates = languageFiltered.length ? languageFiltered : list.slice();
  const preference = String(opts.track || 'default').toLowerCase();

  if (preference === 'manual') return candidates.find(track => track.kind !== 'asr') || null;
  if (preference === 'auto') return candidates.find(track => track.kind === 'asr') || null;
  if (preference === 'any') return candidates[0] || null;

  return candidates.find(track => track.kind !== 'asr' && /^en(-|$)/i.test(track.languageCode)) ||
    candidates.find(track => track.kind === 'asr' && /^en(-|$)/i.test(track.languageCode)) ||
    candidates.find(track => track.kind !== 'asr') ||
    candidates[0] ||
    null;
}

export function buildYoutubeCaptionFetchUrls(baseUrl, pageUrl) {
  const original = new URL(baseUrl, pageUrl).href;
  const parsed = new URL(original);
  if (!isAllowedCaptionHost(parsed.hostname)) {
    throw new Error(`YouTube caption URL host is not allowed: ${parsed.hostname}`);
  }

  const withFmt = (fmt) => {
    const variant = new URL(original);
    variant.searchParams.set('fmt', fmt);
    return variant.href;
  };
  // json3 (easiest to parse) → srv3 (timed XML) → the original baseUrl.
  return [...new Set([withFmt('json3'), withFmt('srv3'), original])];
}

function parseJson3CaptionPayload(payload) {
  const data = JSON.parse(payload);
  const events = Array.isArray(data.events) ? data.events : [];
  const segments = [];
  for (const event of events) {
    const text = Array.isArray(event.segs)
      ? normalizeText(event.segs.map(seg => seg?.utf8 || '').join(''))
      : '';
    if (!text) continue;
    segments.push({
      startMs: Number(event.tStartMs) || 0,
      durationMs: Number(event.dDurationMs) || 0,
      text,
    });
  }
  return segments;
}

function parseTextXmlCaptionPayload(payload) {
  const segments = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;
  while ((match = re.exec(payload))) {
    const attrs = match[1] || '';
    const body = normalizeText(String(match[2] || '').replace(/<[^>]+>/g, ' '));
    if (!body) continue;
    segments.push({
      startMs: Math.round((Number(attrValue(attrs, 'start')) || 0) * 1000),
      durationMs: Math.round((Number(attrValue(attrs, 'dur')) || 0) * 1000),
      text: body,
    });
  }
  return segments;
}

function parseSrv3CaptionPayload(payload) {
  const segments = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = re.exec(payload))) {
    const attrs = match[1] || '';
    const body = normalizeText(String(match[2] || '').replace(/<[^>]+>/g, ' '));
    if (!body) continue;
    segments.push({
      startMs: Number(attrValue(attrs, 't')) || 0,
      durationMs: Number(attrValue(attrs, 'd')) || 0,
      text: body,
    });
  }
  return segments;
}

function parseVttCaptionPayload(payload) {
  const segments = [];
  const lines = String(payload || '').split(/\r?\n/);
  const ts = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ts);
    if (!match) continue;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const millis = Number(match[4] || 0);
    const textLines = [];
    i++;
    while (i < lines.length && lines[i].trim()) {
      textLines.push(lines[i]);
      i++;
    }
    const text = normalizeText(textLines.join(' ').replace(/<[^>]+>/g, ' '));
    if (!text) continue;
    segments.push({
      startMs: (((hours * 60) + minutes) * 60 + seconds) * 1000 + millis,
      durationMs: 0,
      text,
    });
  }
  return segments;
}

// YouTube answers a caption request with an HTML page (a consent gate,
// cookie-rotation, or bot-check) and HTTP 200 when the request is missing the
// right session context. Detect that so it never reaches the timed-text
// parsers — an HTML page is full of <p> tags and would otherwise yield bogus
// or empty "segments" while masking the real cause.
function looksLikeHtmlDocument(text) {
  const head = String(text || '').slice(0, 600).toLowerCase().trimStart();
  if (!head) return false;
  return head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.includes('<head>') ||
    head.includes('<body') ||
    head.includes('accounts.youtube.com') ||
    head.includes('rotatecookiespage') ||
    head.includes('consent.youtube.com') ||
    head.includes('/consent');
}

function isHtmlCaptionResponse(result) {
  if (!result) return false;
  if (String(result.contentType || '').toLowerCase().includes('text/html')) return true;
  return looksLikeHtmlDocument(result.text || '');
}

export function parseYoutubeCaptionPayload(payload, contentType = '') {
  const text = String(payload || '').trim();
  if (!text) return [];
  const type = String(contentType || '').toLowerCase();
  if (text[0] === '{' || type.includes('json')) {
    try {
      const segments = parseJson3CaptionPayload(text);
      if (segments.length) return segments;
    } catch {
      // Fall through to XML/VTT parsing.
    }
  }
  // Reject HTML interstitials unless they carry a real timed-text root, so a
  // consent/cookie-rotation page can't be misparsed as captions.
  if ((type.includes('html') || looksLikeHtmlDocument(text)) && !/<\/?(?:timedtext|transcript|tt)\b/i.test(text)) {
    return [];
  }
  // Require timing attributes so stray <text>/<p> tags in markup don't match.
  if (/<text\b[^>]*\bstart\s*=/i.test(text)) return parseTextXmlCaptionPayload(text);
  if (/<p\b[^>]*\bt\s*=/i.test(text)) return parseSrv3CaptionPayload(text);
  if (text.toUpperCase().includes('WEBVTT') || text.includes('-->')) return parseVttCaptionPayload(text);
  return [];
}

export function formatYoutubeTranscriptText(segments, opts = {}) {
  const includeTimestamps = opts.includeTimestamps !== false;
  return (Array.isArray(segments) ? segments : [])
    .map(segment => includeTimestamps ? `${formatTimestamp(segment.startMs)} ${segment.text}` : segment.text)
    .join('\n')
    .trim();
}

function clampInteger(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function collectYoutubeTranscriptSnapshot() {
  const compact = (value) => {
    if (!value || typeof value !== 'object') return null;
    return {
      videoDetails: value.videoDetails || null,
      captions: value.captions || null,
    };
  };
  const looksLikePlayerResponse = (value) => !!(
    value &&
    typeof value === 'object' &&
    (value.videoDetails || value.captions || value.streamingData || value.playabilityStatus)
  );
  const findJsonObjectAfterMarker = (text, marker, fromIndex = 0) => {
    const markerIndex = text.indexOf(marker, fromIndex);
    if (markerIndex < 0) return null;
    const open = text.indexOf('{', markerIndex);
    if (open < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return { json: text.slice(open, i + 1), nextIndex: i + 1 };
      }
    }
    return null;
  };
  const extractFromHtml = (html) => {
    const text = String(html || '');
    let from = 0;
    while (from < text.length) {
      const found = findJsonObjectAfterMarker(text, 'ytInitialPlayerResponse', from);
      if (!found) return null;
      from = found.nextIndex;
      try {
        const parsed = JSON.parse(found.json);
        if (looksLikePlayerResponse(parsed)) return compact(parsed);
      } catch {}
    }
    return null;
  };
  const readPlayerResponse = (sourceWindow) => {
    try {
      const value = sourceWindow && sourceWindow.ytInitialPlayerResponse;
      if (!looksLikePlayerResponse(value)) return null;
      return compact(JSON.parse(JSON.stringify(value)));
    } catch {
      return null;
    }
  };

  let playerResponse = null;
  try {
    playerResponse = readPlayerResponse(window.wrappedJSObject);
  } catch {}
  if (!playerResponse) playerResponse = readPlayerResponse(window);
  if (!playerResponse) {
    try {
      playerResponse = extractFromHtml(document.documentElement ? document.documentElement.innerHTML : '');
    } catch {}
  }
  return {
    pageUrl: location.href,
    pageTitle: document.title || '',
    playerResponse,
  };
}

async function executeSnapshotScript(tabId) {
  const results = await browser.tabs.executeScript(tabId, {
    code: `(${collectYoutubeTranscriptSnapshot.toString()})()`,
  });
  const first = results?.[0];
  return first?.result || first || null;
}

// Firefox MV2: inject code into the YouTube tab so the caption fetch is a
// same-origin request (real referrer + session), avoiding the HTML consent
// page that a background-context fetch receives.
async function fetchCaptionViaPage(tabId, urls) {
  const code = `(async () => {
    const urls = ${JSON.stringify(Array.isArray(urls) ? urls : [])};
    const out = [];
    for (const url of urls) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        const text = await res.text();
        out.push({ url, status: res.status, contentType: res.headers.get('content-type') || '', text });
        const head = (text || '').trim()[0];
        if (res.status < 400 && (head === '{' || head === '<')) break;
      } catch (error) {
        out.push({ url, status: null, contentType: '', text: '', error: String((error && error.message) || error) });
      }
    }
    return out;
  })()`;
  const results = await browser.tabs.executeScript(tabId, { code });
  const value = results?.[0];
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function bytesToBase64(bytes) {
  if (typeof btoa === 'function') return btoa(String.fromCharCode.apply(null, bytes));
  return Buffer.from(bytes).toString('base64');
}

// Build the get_transcript `params` (base64 protobuf) the way YouTube's own
// clients do, instead of scraping a (often stale) value off the page. Layout
// matches the documented working recipe:
//   inner  = field1:"asr"|""  field2:<languageCode>  field3:<empty>
//   params = field1:<videoId> field2:<urlencoded base64(inner)> field3(varint):1
export function buildYoutubeTranscriptParams(videoId, languageCode = '', kind = '') {
  if (!videoId) return '';
  const te = new TextEncoder();
  const field = (tag, bytes) => {
    const out = [tag];
    let len = bytes.length;
    do { let b = len & 0x7f; len >>>= 7; if (len) b |= 0x80; out.push(b); } while (len);
    for (const value of bytes) out.push(value);
    return out;
  };
  const kindStr = kind === 'asr' ? 'asr' : '';
  const inner = [
    ...field(0x0a, Array.from(te.encode(kindStr))),
    ...field(0x12, Array.from(te.encode(String(languageCode || '')))),
    0x1a, 0x00,
  ];
  const innerB64Url = encodeURIComponent(bytesToBase64(inner));
  const outer = [
    ...field(0x0a, Array.from(te.encode(String(videoId)))),
    ...field(0x12, Array.from(te.encode(innerB64Url))),
    0x18, 0x01,
  ];
  return bytesToBase64(outer);
}

function innertubeRunsText(snippet) {
  if (!snippet || typeof snippet !== 'object') return '';
  if (typeof snippet.simpleText === 'string') return snippet.simpleText;
  if (Array.isArray(snippet.runs)) return snippet.runs.map(run => (run && run.text) || '').join('');
  // IOS / elements client returns the line as a flat string instead of runs.
  if (snippet.elementsAttributedString && typeof snippet.elementsAttributedString.content === 'string') {
    return snippet.elementsAttributedString.content;
  }
  return '';
}

// Walk the get_transcript response (the structure changes shape between YouTube
// revisions, so find the segment/cue renderers wherever they live) and flatten
// them into the same {startMs, durationMs, text} shape as the caption parsers.
export function parseInnertubeTranscript(root) {
  const segments = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const seg = node.transcriptSegmentRenderer;
    if (seg && typeof seg === 'object') {
      const text = normalizeText(innertubeRunsText(seg.snippet));
      if (text) {
        const startMs = Number(seg.startMs) || 0;
        const endMs = Number(seg.endMs) || 0;
        segments.push({ startMs, durationMs: endMs > startMs ? endMs - startMs : 0, text });
      }
    }
    const cue = node.transcriptCueRenderer;
    if (cue && typeof cue === 'object') {
      const text = normalizeText(innertubeRunsText(cue.cue));
      if (text) segments.push({ startMs: Number(cue.startOffsetMs) || 0, durationMs: Number(cue.durationMs) || 0, text });
    }
    for (const key of Object.keys(node)) {
      if (key === 'transcriptSegmentRenderer' || key === 'transcriptCueRenderer') continue;
      visit(node[key]);
    }
  };
  visit(root);
  segments.sort((a, b) => a.startMs - b.startMs);
  const out = [];
  for (const segment of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.startMs === segment.startMs && prev.text === segment.text) continue;
    out.push(segment);
  }
  return out;
}

// Injected into the page: replicate YouTube's own "Show transcript" panel by
// calling the InnerTube get_transcript endpoint. This path does NOT need the
// PoToken that the caption baseUrl now requires. `builtParams` is constructed
// by buildYoutubeTranscriptParams in the extension and passed in; the page's
// own scraped params is used as a secondary candidate. window.wrappedJSObject
// is used on Firefox (content-script world) and is undefined in Chrome's MAIN
// world, where window already is the page.
function collectYoutubeTranscriptViaInnertube(builtParams) {
  return (async () => {
    try {
      const w = (typeof window !== 'undefined' && window.wrappedJSObject) || (typeof window !== 'undefined' ? window : null);
      if (!w) return { ok: false, error: 'No page window available.' };

      const cfg = w.ytcfg;
      let apiKey = null;
      let context = null;
      try {
        if (cfg && typeof cfg.get === 'function') {
          apiKey = cfg.get('INNERTUBE_API_KEY');
          context = cfg.get('INNERTUBE_CONTEXT');
        }
      } catch {}
      if ((!apiKey || !context) && cfg && cfg.data_) {
        apiKey = apiKey || cfg.data_.INNERTUBE_API_KEY;
        context = context || cfg.data_.INNERTUBE_CONTEXT;
      }
      // Public WEB InnerTube key — stable fallback when ytcfg isn't readable.
      apiKey = apiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

      // WEB context triggers "FAILED_PRECONDITION" on get_transcript now (it
      // wants a PoToken). The IOS / ANDROID InnerTube clients are exempt and
      // serve the transcript anonymously, so we prefer those — constructed in
      // code rather than reusing the page's WEB context.
      let safeWeb = null;
      try { safeWeb = JSON.parse(JSON.stringify(context)); } catch {}
      const hl = (safeWeb && safeWeb.client && safeWeb.client.hl) || 'en';
      const gl = (safeWeb && safeWeb.client && safeWeb.client.gl) || 'US';
      const iosContext = { client: { clientName: 'IOS', clientVersion: '20.11.6', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83', hl, gl, timeZone: 'UTC', userAgent: 'com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)' } };
      const androidContext = { client: { clientName: 'ANDROID', clientVersion: '20.11.36', androidSdkVersion: 34, hl, gl, timeZone: 'UTC', userAgent: 'com.google.android.youtube/20.11.36 (Linux; U; Android 14) gzip' } };

      const findParams = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 12) return null;
        if (node.getTranscriptEndpoint && node.getTranscriptEndpoint.params) return node.getTranscriptEndpoint.params;
        for (const key in node) {
          const found = findParams(node[key], depth + 1);
          if (found) return found;
        }
        return null;
      };
      const scraped = findParams(w.ytInitialData, 0) || (w.ytInitialPlayerResponse ? findParams(w.ytInitialPlayerResponse, 0) : null);

      // Ordered plan: mobile clients + constructed params first (anonymous),
      // then the page's WEB context as a last resort.
      const plan = [];
      if (builtParams) {
        plan.push({ context: iosContext, params: builtParams, creds: 'omit', clientName: '5', clientVersion: '20.11.6' });
        plan.push({ context: androidContext, params: builtParams, creds: 'omit', clientName: '3', clientVersion: '20.11.36' });
        if (safeWeb) plan.push({ context: safeWeb, params: builtParams, creds: 'omit' });
      }
      if (scraped && safeWeb) {
        plan.push({ context: safeWeb, params: scraped, creds: 'omit' });
        plan.push({ context: safeWeb, params: scraped, creds: 'include' });
      }
      if (!plan.length) return { ok: false, error: 'No get_transcript params/context available (constructed and scraped both empty).' };

      const url = 'https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false' + (apiKey ? '&key=' + encodeURIComponent(apiKey) : '');
      const hasTranscript = (json) => {
        try { const s = JSON.stringify(json); return s.indexOf('transcriptSegmentRenderer') !== -1 || s.indexOf('transcriptCueRenderer') !== -1; }
        catch { return false; }
      };

      let last = { ok: false, status: null, json: null, error: 'get_transcript was not attempted.' };
      for (const step of plan) {
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (step.clientName) {
            headers['X-Youtube-Client-Name'] = step.clientName;
            headers['X-Youtube-Client-Version'] = step.clientVersion;
          }
          const res = await fetch(url, {
            method: 'POST',
            credentials: step.creds,
            headers,
            body: JSON.stringify({ context: step.context, params: step.params }),
          });
          const status = res.status;
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          const good = status < 400 && hasTranscript(json);
          const apiErr = json && json.error && (json.error.message || json.error.status)
            ? ((json.error.status ? json.error.status + ': ' : '') + (json.error.message || '')).trim()
            : null;
          last = {
            ok: good,
            status,
            json: good ? json : null,
            error: good ? null : (apiErr || ('get_transcript HTTP ' + status + (text ? ' ' + text.slice(0, 160) : ''))),
            variant: (step.context.client && step.context.client.clientName) + '/' + step.creds,
          };
          if (good) return last;
        } catch (error) {
          last = { ok: false, status: null, json: null, error: String((error && error.message) || error) };
        }
      }
      return last;
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  })();
}

async function fetchTranscriptViaInnertube(tabId, video, track) {
  const builtParams = buildYoutubeTranscriptParams(video && video.id, track && track.languageCode, track && track.kind);
  const results = await browser.tabs.executeScript(tabId, {
    code: `(${collectYoutubeTranscriptViaInnertube.toString()})(${JSON.stringify(builtParams || '')})`,
  });
  const first = results?.[0];
  return first?.result || first || null;
}

// Token-free last resort: drive YouTube's own "Show transcript" panel and read
// the rendered segments. YouTube fetches those with its own valid PoToken, so
// this works even when every API path is precondition/pot-gated. Runs against
// the page DOM, which both Chrome (MAIN world) and Firefox (content script)
// share, so the function body is identical on both.
function collectTranscriptFromDom() {
  return (async () => {
    try {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const parseTs = (raw) => {
        const m = String(raw || '').trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
        if (!m) return 0;
        const h = Number(m[1] || 0); const mn = Number(m[2] || 0); const s = Number(m[3] || 0);
        return ((h * 60 + mn) * 60 + s) * 1000;
      };
      const readSegments = () => {
        const out = [];
        document.querySelectorAll('ytd-transcript-segment-renderer').forEach((node) => {
          const tsEl = node.querySelector('.segment-timestamp');
          const txtEl = node.querySelector('.segment-text') || node.querySelector('yt-formatted-string.segment-text');
          const text = ((txtEl ? txtEl.textContent : node.textContent) || '').replace(/\s+/g, ' ').trim();
          if (!text) return;
          out.push({ startMs: parseTs(tsEl ? tsEl.textContent : ''), durationMs: 0, text });
        });
        return out;
      };
      const clickByLabel = (words) => {
        const els = document.querySelectorAll('button, a, tp-yt-paper-button, yt-button-shape, ytd-button-renderer, ytd-menu-service-item-renderer, #expand');
        for (const el of els) {
          let label = '';
          try { label = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || el.textContent || '').trim().toLowerCase(); } catch {}
          if (label && words.some((wd) => label.includes(wd))) {
            try { el.click(); return true; } catch {}
          }
        }
        return false;
      };

      let segments = readSegments();
      if (segments.length) return { ok: true, opened: false, segments };

      // Expand the description, then open the transcript (English + Turkish labels).
      clickByLabel(['...more', 'show more', 'daha fazla', 'devamını']);
      await sleep(350);
      const opened = clickByLabel(['show transcript', 'transcript', 'transkripti göster', 'transkript', 'altyazı dökümü']);

      for (let i = 0; i < 24 && !segments.length; i++) {
        await sleep(250);
        segments = readSegments();
      }
      if (segments.length) return { ok: true, opened, segments };
      return { ok: false, opened, segments: [], error: opened ? 'Transcript panel opened but rendered no segments in time.' : 'Could not find a Show transcript control on the page.' };
    } catch (error) {
      return { ok: false, segments: [], error: String((error && error.message) || error) };
    }
  })();
}

async function fetchTranscriptViaDom(tabId) {
  const results = await browser.tabs.executeScript(tabId, {
    code: `(${collectTranscriptFromDom.toString()})()`,
  });
  const first = results?.[0];
  return first?.result || first || null;
}

async function fetchCaptionText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTION_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.url) {
      const finalUrl = new URL(res.url);
      if (!isAllowedCaptionHost(finalUrl.hostname)) {
        return {
          success: false,
          status: res.status,
          error: `Caption fetch redirected outside YouTube (${finalUrl.hostname}); body discarded.`,
        };
      }
    }
    return {
      success: res.status < 400,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      url: res.url || url,
      text: await res.text(),
    };
  } catch (error) {
    return { success: false, error: error?.name === 'AbortError' ? 'Caption fetch timed out.' : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCaptionSegments(track, pageUrl, tabId, video) {
  const attempts = [];
  const urls = buildYoutubeCaptionFetchUrls(track.baseUrl, pageUrl);

  // Try the caption baseUrl directly via `fetchOne`. Stops at the first HTML
  // body: when YouTube gates a track behind a PoToken it returns the same
  // HTML/empty page for every fmt variant, so retrying the others is wasted.
  const tryDirect = async (via, fetchOne) => {
    for (const url of urls) {
      const result = await fetchOne(url);
      const html = isHtmlCaptionResponse(result);
      const ok = typeof result.success === 'boolean'
        ? result.success
        : (typeof result.status === 'number' ? result.status < 400 : false);
      attempts.push({
        via,
        status: result.status || null,
        ok,
        contentType: result.contentType || '',
        html,
        error: result.error || null,
      });
      if (html) break;
      if (!result.text) continue;
      const segments = parseYoutubeCaptionPayload(result.text, result.contentType);
      if (segments.length) {
        return { success: true, segments, status: result.status, contentType: result.contentType, via };
      }
    }
    return null;
  };

  // 1) Background fetch of the caption baseUrl (fast path; works when the track
  //    isn't PoToken-gated).
  const background = await tryDirect('background', (url) => fetchCaptionText(url));
  if (background) return background;

  // 2) InnerTube get_transcript — the API behind YouTube's own "Show transcript"
  //    panel. It does NOT require the PoToken that the caption baseUrl now needs,
  //    so it's the reliable path for pot-gated tracks (the HTML-200 case).
  if (Number.isInteger(tabId)) {
    let inner = null;
    try {
      inner = await fetchTranscriptViaInnertube(tabId, video, track);
    } catch (error) {
      attempts.push({ via: 'innertube', status: null, ok: false, contentType: '', html: false, error: String(error?.message || error) });
    }
    if (inner) {
      attempts.push({ via: 'innertube', status: inner.status || null, ok: !!inner.ok, contentType: 'application/json', html: false, error: inner.error || null });
      const segments = inner.json ? parseInnertubeTranscript(inner.json) : [];
      if (segments.length) {
        return { success: true, segments, status: inner.status || 200, contentType: 'application/json', via: 'innertube' };
      }
    }
  }

  // 3) DOM scrape of YouTube's own transcript panel. Token-free: it reads what
  //    the player rendered with its real PoToken, so it survives the pot /
  //    precondition gating that blocks every API path.
  if (Number.isInteger(tabId)) {
    let dom = null;
    try {
      dom = await fetchTranscriptViaDom(tabId);
    } catch (error) {
      attempts.push({ via: 'dom', status: null, ok: false, contentType: '', html: false, error: String(error?.message || error) });
    }
    if (dom) {
      attempts.push({ via: 'dom', status: dom.ok ? 200 : null, ok: !!dom.ok, contentType: 'text/dom', html: false, error: dom.error || null });
      if (dom.segments && dom.segments.length) {
        return { success: true, segments: dom.segments, status: 200, contentType: 'text/dom', via: 'dom' };
      }
    }
  }

  // 4) Same-origin page fetch of the baseUrl. Covers consent / cookie-rotation
  //    cases where a background request (no youtube.com referrer) is the only
  //    thing being turned away.
  if (Number.isInteger(tabId)) {
    const page = await tryDirect('page', async (url) => {
      const arr = await fetchCaptionViaPage(tabId, [url]);
      const r = arr[0] || {};
      return {
        success: typeof r.status === 'number' ? r.status < 400 : false,
        status: r.status,
        contentType: r.contentType,
        text: r.text,
        error: r.error,
      };
    });
    if (page) return page;
  }

  const sawHtml = attempts.some(a => a.html);
  const anyOk = attempts.some(a => a.ok);
  const innerErr = attempts.find(a => a.via === 'innertube' && a.error)?.error;
  const domErr = attempts.find(a => a.via === 'dom' && a.error)?.error;
  let error;
  if (sawHtml) {
    error = 'YouTube gated this caption track behind a Proof-of-Origin token, so the baseUrl returns an HTML/empty page, and the fallbacks returned no segments.'
      + (innerErr ? ` get_transcript: ${innerErr}` : '')
      + (domErr ? ` transcript panel: ${domErr}` : '');
  } else if (anyOk) {
    error = 'Caption track was fetched but no transcript segments could be parsed.';
  } else {
    error = attempts.find(a => a.error)?.error || 'Caption track could not be fetched.';
  }
  return { success: false, error, attempts };
}

function publicTrack(track) {
  return {
    index: track.index,
    languageCode: track.languageCode,
    name: track.name,
    kind: track.kind,
    isTranslatable: track.isTranslatable,
  };
}

function publicTrackList(tracks) {
  return tracks.map(({ index, languageCode, name, kind, isTranslatable }) => ({ index, languageCode, name, kind, isTranslatable }));
}

function buildTranscriptResult(entry, args = {}, cached = false) {
  const fullText = formatYoutubeTranscriptText(entry.segments, { includeTimestamps: args.includeTimestamps !== false });
  const offset = clampInteger(args.offset, 0, 0, Math.max(0, fullText.length));
  const maxChars = clampInteger(args.maxChars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS);
  const text = fullText.slice(offset, offset + maxChars);
  const nextOffset = offset + text.length;

  return {
    success: true,
    source: 'youtube_captionTracks.baseUrl',
    cached,
    pageUrl: entry.pageUrl,
    video: entry.video,
    track: entry.track,
    availableTracks: entry.availableTracks,
    text,
    offset,
    maxChars,
    nextOffset: nextOffset < fullText.length ? nextOffset : null,
    hasMore: nextOffset < fullText.length,
    originalLength: fullText.length,
    segmentCount: entry.segments.length,
    note: nextOffset < fullText.length
      ? 'Transcript chunk returned. Call read_youtube_transcript again with offset=nextOffset to read the next chunk before summarizing the whole video.'
      : 'Transcript read from YouTube captionTracks mechanically; summarize from this transcript instead of inferring from the title or comments.',
  };
}

async function loadYoutubeTranscriptEntry(tabId, args, tab, pageUrl) {
  let snapshot = null;
  try {
    snapshot = await executeSnapshotScript(tabId);
  } catch (error) {
    return { success: false, error: `read_youtube_transcript: could not inspect the YouTube page (${error.message}).` };
  }

  const data = normalizeYoutubePlayerResponse(snapshot?.playerResponse, snapshot?.pageTitle || tab?.title || '');
  if (!data.tracks.length) {
    return {
      success: false,
      pageUrl,
      video: data.video,
      error: 'No YouTube captionTracks were exposed on this page. The video may have captions disabled or YouTube has not loaded the player response yet.',
    };
  }

  const selected = selectYoutubeCaptionTrack(data.tracks, args);
  if (!selected) {
    return {
      success: false,
      pageUrl,
      video: data.video,
      availableTracks: publicTrackList(data.tracks),
      error: `No caption track matched language=${args.language || '(any)'} track=${args.track || 'default'}.`,
    };
  }

  let fetched;
  try {
    fetched = await fetchCaptionSegments(selected, pageUrl, tabId, data.video);
  } catch (error) {
    return { success: false, pageUrl, video: data.video, error: `Caption fetch failed: ${error.message}` };
  }
  if (!fetched.success) {
    return {
      success: false,
      pageUrl,
      video: data.video,
      track: publicTrack(selected),
      error: fetched.error,
      attempts: fetched.attempts,
    };
  }

  return {
    success: true,
    pageUrl,
    video: data.video,
    track: publicTrack(selected),
    availableTracks: publicTrackList(data.tracks),
    segments: fetched.segments,
    fetchedAt: Date.now(),
  };
}

async function getYoutubeTranscriptEntry(tabId, args = {}) {
  let tab = null;
  try {
    tab = await browser.tabs.get(tabId);
  } catch (error) {
    return { success: false, error: `read_youtube_transcript: could not read active tab (${error.message}).` };
  }
  const pageUrl = tab?.url || '';
  if (!isYoutubeUrl(pageUrl)) {
    return { success: false, error: 'read_youtube_transcript is only available on YouTube watch/shorts pages.' };
  }

  const key = youtubeTranscriptCacheKey(tabId, pageUrl, args);
  const cached = transcriptCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TRANSCRIPT_CACHE_TTL_MS) {
    return { ...cached, cacheHit: true };
  }

  const existing = transcriptInflight.get(key);
  if (existing) {
    const entry = await existing;
    return entry.success ? { ...entry, cacheHit: true } : entry;
  }

  const promise = loadYoutubeTranscriptEntry(tabId, args, tab, pageUrl)
    .then(entry => {
      if (entry.success) transcriptCache.set(key, entry);
      return entry;
    })
    .finally(() => transcriptInflight.delete(key));
  transcriptInflight.set(key, promise);
  return await promise;
}

export async function prewarmYoutubeTranscript(tabId, args = {}) {
  const entry = await getYoutubeTranscriptEntry(tabId, args || {});
  if (!entry.success) return { ...entry, prefetched: false };
  return {
    success: true,
    prefetched: true,
    cached: !!entry.cacheHit,
    pageUrl: entry.pageUrl,
    video: entry.video,
    track: entry.track,
    availableTracks: entry.availableTracks,
    segmentCount: entry.segments.length,
  };
}

export async function readYoutubeTranscript(tabId, args = {}) {
  const entry = await getYoutubeTranscriptEntry(tabId, args || {});
  if (!entry.success) return entry;
  return buildTranscriptResult(entry, args || {}, !!entry.cacheHit);
}
