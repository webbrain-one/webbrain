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
// the page was read. Short pages, whose content is never cut, and questions
// about one part of a page are not affected.
//
// Shared byte for byte by the Chrome and Firefox builds.
import { fitReadPageWindowResult, isReadPageWindowResult } from './read-page-window.js';

// Ends page content that was cut to fit a tool result or an observation.
export const PAGE_CONTENT_TRUNCATED_MARKER = '[...page content truncated]';
// The first read_page window of a page's text, as the Summarize this page
// action reads it.
export const WHOLE_PAGE_READ_ARGS = Object.freeze({ includeChrome: false });
export const PAGE_COVERAGE_CAVEAT = 'Only part of the page was read, so this answer may leave out later parts of it.';
const MAX_DOCUMENTS = 8;

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
 * kept except the tree's own continuation, which would skip the text cut
 * here; `notice` names the read that covers the whole page instead. Null when
 * there is no pageContent or not even an empty one fits.
 */
export function fitPageContentResult(result, maxChars = 8000) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.pageContent !== 'string') return null;
  const content = result.pageContent;
  const { continuationArgs: _continuationArgs, nextPage: _nextPage, notice: _notice, ...rest } = result;
  const build = limit => {
    const shown = prefixAtLine(content, limit);
    return {
      ...rest,
      pageContent: `${shown}${shown ? '\n' : ''}${PAGE_CONTENT_TRUNCATED_MARKER}`,
      truncated: true,
      hasMore: true,
      pageContentTruncated: true,
      notice: `Only the first ${shown.length} of ${content.length} characters of this page content fit in the result. `
        + `To read the whole page, call read_page(${JSON.stringify(WHOLE_PAGE_READ_ARGS)}) and repeat with each returned `
        + 'continuationArgs until hasMore is false.',
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

export function createPageReadCoverage({ url = '', wholePage = false } = {}) {
  return {
    url: documentUrl(url),
    // 'whole_page' or 'part' once decided, 'unknown' when no sure answer came.
    scope: wholePage === true ? 'whole_page' : null,
    documents: new Map(),
    gap: null,
  };
}

function documentEntry(state, url) {
  const key = documentUrl(url) || state.url;
  let entry = state.documents.get(key);
  if (!entry && state.documents.size < MAX_DOCUMENTS) {
    entry = { partial: false, complete: false, texts: new Map(), tree: null, treeNext: null };
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
 * the page.
 */
export function recordPageRead(state, toolName, args = {}, result = null, maxChars = 8000) {
  if (!state || !result || typeof result !== 'object' || result.error || result.success === false) return state;
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
    const text = entry.texts.get(includeChrome) || { ranges: [], length, limit: null };
    // Live pages change length as counters and timestamps update; the latest
    // reading's length is the one the next window is read against.
    text.length = length;
    text.ranges = end > start ? mergeRange(text.ranges, start, end) : text.ranges;
    const limit = Number(delivered.textLimit);
    text.limit = Number.isSafeInteger(limit) && limit > 0 ? limit : text.limit;
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
  if (filter !== 'all' || !Number.isFinite(maxDepth) || maxDepth < 15 || cut) return state;
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
      ? { offset, ...(text.limit ? { limit: text.limit } : {}), includeChrome }
      : { includeChrome } };
  }
  if (entry.treeNext && available('get_accessibility_tree')) return { tool: 'get_accessibility_tree', args: entry.treeNext };
  if (available('read_page')) return { tool: 'read_page', args: { ...WHOLE_PAGE_READ_ARGS } };
  return null;
}

/**
 * The unread rest of the page at `url` (the run's page when unknown): null
 * when nothing shown was cut off, a read reached the end, or none of the
 * `tools` can read further. Otherwise `{ nextRead: { tool, args } }`.
 */
export function pageReadCoverageGap(state, url = '', { tools = null } = {}) {
  if (!state?.documents?.size) return null;
  const entry = state.documents.get(documentUrl(url) || state.url) || null;
  if (!entry?.partial || entry.complete) return null;
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
