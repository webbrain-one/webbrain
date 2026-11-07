// How much of the open page an Ask answer was read from.
//
// The model sees a long page one part at a time: a page observation is cut to
// fit the context, get_accessibility_tree returns the tree in pages, and
// read_page returns the page text in windows. A summary written from the
// first part reads like a summary of the whole page. This file records, for
// one run, whether the page content the model was given was cut off and
// whether a later read reached the end of the page. When an Ask answer is
// about the whole page (semantic-decisions.js page_read_scope, never a word
// list) and the rest was not read, the answer is sent back once with the
// exact read that continues it (read-coverage-incomplete in guard-policy.js);
// an answer given again without reading on ends with a note that only part of
// the page was read. Short pages, whose content is never cut, questions about
// one part of a page, and pages whose content was read through a reader of
// its own source (a video's transcript, a PDF) are not affected.
//
// Shared byte for byte by the Chrome and Firefox builds.
import { READ_PAGE_MAX_LIMIT, fitReadPageWindowResult, isReadPageWindowResult } from './read-page-window.js';

// Ends page content that was cut to fit a tool result or an observation.
export const PAGE_CONTENT_TRUNCATED_MARKER = '[...page content truncated]';
// The first read_page window of a page's text, in the largest windows
// read_page returns, so a long page takes as few reads as it can.
export const WHOLE_PAGE_READ_ARGS = Object.freeze({ includeChrome: false, limit: READ_PAGE_MAX_LIMIT });
export const PAGE_COVERAGE_CAVEAT = 'Only part of the page was read, so this answer may leave out later parts of it.';
const MAX_DOCUMENTS = 8;

// Readers of what a page shows from its own source rather than from the
// page's text: the video's transcript, the PDF, the documents framed in the
// page, the page's own address fetched directly. Each says by its own fields
// (has_more_text, hasMore, truncated) how far it read and how to read on, and
// the page text's coverage is no measure of what they read. Once one has read
// content of the open page, that page's text coverage is not checked: a
// summary of a video written from its transcript is not sent back to read the
// page around it. Each entry says whether a call reads the open page.
const PAGE_SOURCE_READERS = Object.freeze({
  // Without a url it reads the tab's own video. A url, and the video_id the
  // provider reports, must name the open page's video.
  read_youtube_transcript: (args, page, result) => {
    const video = youTubeVideoId(page);
    if (args.url && !(video ? youTubeVideoId(args.url) === video : documentUrl(args.url) === page)) return false;
    const reported = String(transcriptData(result).video_id ?? result.video_id ?? '').trim();
    return !reported || reported === video;
  },
  // Without a url it reads the tab's own PDF.
  read_pdf: (args, page) => !args.url || documentUrl(args.url) === page,
  // The framed documents' text; a selector reads a few controls of them.
  iframe_read: args => !args.selector || String(args.selector).trim() === 'body',
  fetch_url: (args, page, result) => [args.url, result.url, result.finalUrl].some(url => documentUrl(url) === page),
  research_url: (args, page, result) => [args.url, result.url, result.finalUrl].some(url => documentUrl(url) === page),
});

function documentUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

// The video a YouTube address shows: youtu.be/<id>, /shorts/<id>, /live/<id>
// and /embed/<id> carry it in the path, a watch page in ?v=.
function youTubeVideoId(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    if (host === 'youtu.be') return path.replace(/^\//, '').split('/')[0] || '';
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return '';
    return /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(path)?.[1] || url.searchParams.get('v') || '';
  } catch {
    return '';
  }
}

// A skill tool's provider body is in `data`.
function transcriptData(result) {
  return result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : result;
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Whether a page-source reader returned any of the page's content.
function pageSourceContent(toolName, result) {
  if (toolName === 'read_youtube_transcript') {
    const data = transcriptData(result);
    return hasText(data.text) || (Array.isArray(data.segments) && data.segments.length > 0);
  }
  if (toolName === 'read_pdf') {
    return !!result._attachDocument || (Array.isArray(result.pages) && result.pages.some(hasText));
  }
  if (toolName === 'iframe_read') return Array.isArray(result.frames) && result.frames.some(frame => hasText(frame?.text));
  return hasText(result.text);
}

/** True for a tool that can read the open page's content from its own source. */
export function readsPageSource(toolName) {
  return Object.prototype.hasOwnProperty.call(PAGE_SOURCE_READERS, toolName);
}

function serializedLength(value) {
  try { return JSON.stringify(value).length; } catch { return Infinity; }
}

// A prefix of `content` at most `limit` long, ending at a line break when one
// is in its second half, so a tree line is not split.
function prefixAtLine(content, limit) {
  const prefix = content.slice(0, limit);
  if (prefix.length === content.length) return prefix;
  const lineEnd = prefix.lastIndexOf('\n');
  return lineEnd >= prefix.length / 2 ? prefix.slice(0, lineEnd) : prefix;
}

/**
 * A page-content result (a tree read, a gated article's text, a page
 * observation) too large for a tool result of `maxChars`, with its
 * pageContent cut so the whole result stays valid JSON. Every other field is
 * kept except the tree's own continuation and the slice's end, which would
 * skip or misplace the text cut here; `notice` names the read that covers
 * the rest instead: read_page for the page, or the same element read in
 * smaller pages for a subtree (`args` of a read by ref_id). Null when there is
 * no pageContent or not even an empty one fits.
 */
export function fitPageContentResult(result, maxChars = 8000, { args = null } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.pageContent !== 'string') return null;
  const content = result.pageContent;
  const { continuationArgs, nextPage: _nextPage, notice: _notice, chunkEnd: _chunkEnd, ...rest } = result;
  const refId = [flatArgs(args).ref_id, continuationArgs?.ref_id].find(value => typeof value === 'string' && value.trim());
  const readOn = refId
    ? `To read the rest of it, call get_accessibility_tree again with ref_id ${JSON.stringify(refId)} and a smaller `
      + 'maxChars, and follow each returned continuationArgs until hasMore is false.'
    : `To read the whole page, call read_page(${JSON.stringify(WHOLE_PAGE_READ_ARGS)}) and repeat with each returned `
      + 'continuationArgs until hasMore is false.';
  const build = limit => {
    const shown = prefixAtLine(content, limit);
    return {
      ...rest,
      pageContent: `${shown}${shown ? '\n' : ''}${PAGE_CONTENT_TRUNCATED_MARKER}`,
      truncated: true,
      hasMore: true,
      pageContentTruncated: true,
      notice: `Only the first ${shown.length} of ${content.length} characters of this ${refId ? 'part of the page' : 'page content'} `
        + `fit in the result. ${readOn}`,
    };
  };
  let best = build(0);
  if (serializedLength(best) > maxChars) return null;
  let low = 1;
  let high = content.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(mid);
    if (serializedLength(candidate) <= maxChars) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** True when the model is shown only part of this page-content result. */
export function pageContentDeliveredInPart(result, maxChars = 8000) {
  if (!result || typeof result !== 'object' || typeof result.pageContent !== 'string') return false;
  return result.hasMore === true || result.truncated === true || serializedLength(result) > maxChars;
}

/**
 * `scope` is known in advance for a request that is about the whole page or
 * one part of it by construction (a recommended action); otherwise it is
 * asked when needed (page_read_scope).
 */
export function createPageReadCoverage({ url = '', scope = null } = {}) {
  return {
    url: documentUrl(url),
    // 'whole_page' or 'part' once decided, 'unknown' when no sure answer came.
    scope: scope === 'whole_page' || scope === 'part' ? scope : null,
    documents: new Map(),
    gap: null,
  };
}

function documentEntry(state, url) {
  const key = documentUrl(url) || state.url;
  let entry = state.documents.get(key);
  if (!entry && state.documents.size < MAX_DOCUMENTS) {
    entry = { partial: false, complete: false, sourceRead: false, texts: new Map(), tree: null, treeNext: null };
    state.documents.set(key, entry);
  }
  return entry || null;
}

function mergeRange(ranges, start, end) {
  const merged = [];
  for (const range of [...ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function flatArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const nested = args.continuationArgs && typeof args.continuationArgs === 'object' ? args.continuationArgs : {};
  const { continuationArgs: _continuationArgs, ...own } = args;
  return { ...nested, ...own };
}

/**
 * Page content shown to the model without a read tool: a page observation
 * the runtime attached (a tree of the visible page, a gated article's text).
 * Only content that was cut off is recorded.
 */
export function recordPageObservation(state, url, result, maxChars = 8000) {
  if (!state || !result || result.error || result.success === false) return state;
  if (!pageContentDeliveredInPart(result, maxChars)) return state;
  const entry = documentEntry(state, url || result.url || result.refScopeUrl);
  if (entry) entry.partial = true;
  return state;
}

/**
 * A read tool's result, as the model was shown it in a tool result of
 * `maxChars`. read_page windows that join up from the start of the page text
 * to its end, or full-depth tree slices of the whole document that do, complete
 * the page. A page-source reader's content of the open page (`pageUrl`, the
 * run's page when unknown) leaves that page unchecked.
 */
export function recordPageRead(state, toolName, args = {}, result = null, maxChars = 8000, { pageUrl = '' } = {}) {
  if (!state || !result || typeof result !== 'object' || result.error || result.success === false) return state;
  if (readsPageSource(toolName)) {
    const page = documentUrl(result.pageUrl) || documentUrl(pageUrl) || state.url;
    if (!page || !PAGE_SOURCE_READERS[toolName](flatArgs(args), page, result) || !pageSourceContent(toolName, result)) return state;
    const entry = documentEntry(state, page);
    if (entry) entry.sourceRead = true;
    return state;
  }
  if (toolName === 'read_page') {
    if (!isReadPageWindowResult(result)) return state;
    const delivered = fitReadPageWindowResult(result, maxChars);
    const start = Number(delivered.textOffset);
    const length = Number(delivered.originalLength);
    const end = start + delivered.text.length;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0 || end > length) return state;
    const entry = documentEntry(state, delivered.url);
    if (!entry) return state;
    const includeChrome = delivered.includeChrome === true;
    const text = entry.texts.get(includeChrome) || { ranges: [], length };
    // Live pages change length as counters and timestamps update; the latest
    // reading's length is the one the next window is read against.
    text.length = length;
    text.ranges = end > start ? mergeRange(text.ranges, start, end) : text.ranges;
    entry.texts.set(includeChrome, text);
    if (delivered.hasMore === true) entry.partial = true;
    const first = text.ranges[0];
    if (length === 0 || (first && first[0] === 0 && first[1] >= length)) entry.complete = true;
    return state;
  }
  if (toolName !== 'get_accessibility_tree' || typeof result.pageContent !== 'string') return state;
  const read = flatArgs(args);
  // A subtree says nothing about how much of the page was read.
  if (typeof read.ref_id === 'string' && read.ref_id.trim()) return state;
  const entry = documentEntry(state, result.refScopeUrl || result.url);
  if (!entry) return state;
  const cut = serializedLength(result) > maxChars;
  const paged = result.hasMore === true || result.truncated === true;
  if (cut || paged) entry.partial = true;
  const filter = String(read.filter || 'all');
  const maxDepth = read.maxDepth == null ? 15 : Number(read.maxDepth);
  // A walk that left out content below its depth (depthTruncated,
  // accessibility-tree.js) read less than the page however far its slices
  // reach, and its next slice cannot reach that content either, so the rest
  // is read through read_page.
  if (filter !== 'all' || !Number.isFinite(maxDepth) || maxDepth < 15 || cut || result.depthTruncated === true) return state;
  const sliced = result.page != null || result.chunkStart != null || read.page != null;
  if (!sliced) {
    // The whole full-depth tree in one result.
    if (!paged) entry.complete = true;
    return state;
  }
  // Tree pages are slices of one text; their positions add up across page
  // sizes. Slices are separated by one line break.
  const total = Number(result.totalChars);
  const start = Number(result.chunkStart);
  const end = Number(result.chunkEnd);
  if (![total, start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > total) return state;
  const key = `${maxDepth}|${total}`;
  if (!entry.tree || entry.tree.key !== key) entry.tree = { key, ranges: [] };
  entry.tree.ranges = mergeRange(entry.tree.ranges, start, Math.min(total, end + 1));
  const first = entry.tree.ranges[0];
  if (first[0] === 0 && first[1] >= total) entry.complete = true;
  if (paged && result.continuationArgs && typeof result.continuationArgs === 'object') entry.treeNext = result.continuationArgs;
  return state;
}

function nextRead(entry, tools) {
  const available = name => !(tools instanceof Set) || tools.has(name);
  // Text windows already read continue where the text read from its start ends.
  const [includeChrome, text] = entry.texts.entries().next().value || [];
  if (text && available('read_page')) {
    const first = text.ranges[0];
    const offset = first && first[0] === 0 ? first[1] : 0;
    return { tool: 'read_page', args: offset > 0
      ? { offset, limit: READ_PAGE_MAX_LIMIT, includeChrome }
      : { includeChrome, limit: READ_PAGE_MAX_LIMIT } };
  }
  if (entry.treeNext && available('get_accessibility_tree')) return { tool: 'get_accessibility_tree', args: entry.treeNext };
  if (available('read_page')) return { tool: 'read_page', args: { ...WHOLE_PAGE_READ_ARGS } };
  return null;
}

/**
 * The unread rest of the page at `url` (the run's page when unknown): null
 * when nothing shown was cut off, a read reached the end, a page-source reader
 * read it, or none of the `tools` can read further. Otherwise
 * `{ nextRead: { tool, args } }`.
 */
export function pageReadCoverageGap(state, url = '', { tools = null } = {}) {
  if (!state?.documents?.size) return null;
  const entry = state.documents.get(documentUrl(url) || state.url) || null;
  if (!entry?.partial || entry.complete || entry.sourceRead) return null;
  const read = nextRead(entry, tools);
  return read ? { nextRead: read } : null;
}

/** The note an Ask answer about the whole page gets while its rest is unread. */
export function pageReadCoverageBlock(gap) {
  if (!gap?.nextRead) return null;
  const call = `${gap.nextRead.tool}(${JSON.stringify(gap.nextRead.args)})`;
  return '[WHOLE PAGE NOT READ: The user asked about the whole page, but the page content you were given was cut off '
    + 'and the rest of the page has not been read. Do not present this answer as covering the whole page yet. '
    + `Call ${call} now and repeat with each returned continuationArgs while hasMore is true, then answer from `
    + 'everything read. If the page is too long to finish, read as far as is reasonable and say in the answer which '
    + 'part of the page it covers.]';
}
