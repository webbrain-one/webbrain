/**
 * Loop-detection bucketing for URL-family tool calls.
 *
 * The agent's loop detector keys on (toolName, argsHash). For most tools
 * the args hash is just JSON.stringify(args), which is fine — identical
 * args = identical call.
 *
 * For URL-fetching tools that's too strict: the agent can fetch the same
 * logical resource through 4–8 different URL forms (raw.githubusercontent.com,
 * api.github.com /repos/.../contents/, /repos/.../git/blobs/<sha>, /blob/main/,
 * etc.) without the loop detector firing. Real example from a 65-step trace:
 * the agent fetched `web/build/locales/en.json` 8 different ways without
 * ever recognizing the pattern.
 *
 * This module reduces a URL to a "resource bucket" so all those forms
 * collapse to one key. Pure JS, no chrome.* / browser.* deps — kept here
 * so the test runner can exercise the exact prod code.
 *
 * ─── DESIGN TRADE-OFF: aggressive bucketing ─────────────────────────────
 *
 * The four GitHub URL forms (raw / contents-API / git-blobs / blob-page)
 * return DIFFERENT response shapes — raw JSON, base64-wrapped envelope,
 * base64 blob, HTML page — even when they're "the same file". A purist
 * read would keep them in distinct buckets.
 *
 * We deliberately collapse them anyway. The bucket isn't asserting
 * "these responses are byte-identical." It's asserting "these are likely
 * the same INTENT — read the contents of this file." For loop detection
 * that's the relevant signal: an agent that fetches the raw URL, gets
 * truncated content, then "tries" the contents API hoping for more, then
 * tries git/blobs, then tries blob/, is thrashing — and the bucketing
 * catches it.
 *
 * The known false-positive pattern is a legitimate three-step flow:
 *   1. GET raw.githubusercontent.com/.../foo → read content
 *   2. GET api.github.com/.../contents/foo  → get the SHA
 *   3. PUT api.github.com/.../contents/foo  → edit the file
 * Step 2 collapses to step 1's bucket here. We accept this for two
 * reasons: (a) what fires is a NUDGE injected into the next tool result,
 * not a hard stop — the agent can ignore it and proceed; (b) step 3 has
 * a different `method` (PUT, not GET), and `bucketArgsKey` includes
 * method in the key, so the loop counter resets on the legitimate write.
 * The git/blobs API is also intentionally kept in its OWN bucket because
 * by the time the agent has the blob SHA it has demonstrably progressed
 * past the "read this file" intent.
 *
 * Cost asymmetry: a recoverable false-positive nudge costs one line of
 * model context. A false negative costs the kind of $5, 65-step,
 * zero-output run that prompted this whole module. We err toward
 * over-collapsing.
 *
 * If real legit flows start hitting the nudge in production, the next
 * refinement is to add the request `Accept` header to the bucket key
 * (e.g. `accept:application/vnd.github.raw+json` vs `.v3+json`) so the
 * agent can ask for raw vs envelope as distinct calls. ~5 lines of
 * change here.
 */

/**
 * Tools whose args contain a `url` we should bucket by resource. Other
 * tools (click_ax, type_ax, scroll, etc.) keep the default exact-args
 * hashing because their args don't have multiple equivalent forms.
 */
export const URL_FAMILY_TOOLS = new Set([
  'fetch_url', 'research_url', 'read_page_source', 'download_file', 'read_downloaded_file',
]);

/**
 * Reduce a URL to a "resource bucket" string. Two URLs that fetch the
 * same logical file should produce the same bucket; URLs to different
 * resources should produce different buckets.
 *
 * Heuristics:
 *   - GitHub family hosts (raw.githubusercontent.com, api.github.com,
 *     github.com, gist.github.com, codeload.github.com,
 *     *.githubusercontent.com) all normalize to "github.com".
 *   - GitHub URL prefixes that route to the same underlying file get
 *     stripped: /repos/o/r/contents/, /repos/o/r/git/blobs/, /repos/o/r/
 *     git/trees/, /repos/o/r/git/refs/, /o/r/blob/<ref>/, /o/r/raw/<ref>/,
 *     /o/r/edit/<ref>/, /o/r/tree/<ref>/, /o/r/commits/<ref>/,
 *     /o/r/commit/<ref>/.
 *   - For everything else we keep the lowercased hostname and the last
 *     three path segments. That's a backstop, not authoritative — it
 *     trades some over-bucketing (different files in the same /a/b/foo/
 *     directory may collide) for catching cross-host thrashing.
 */
export function resourceBucket(rawUrl) {
  if (!rawUrl) return '';
  let u;
  try { u = new URL(rawUrl); } catch (_) { return rawUrl; }

  const rawHost = (u.hostname || '').toLowerCase();
  const rawPath = (u.pathname || '/').replace(/\/+$/, '');

  // GitHub family — extract the (owner, repo, intra-repo-resource) triple
  // so different URL shapes for the same resource collapse to one bucket
  // AND different repos / different files stay distinct. Each GH host has
  // its own URL shape:
  //   raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>
  //   api.github.com/repos/<owner>/<repo>/contents/<path>
  //   api.github.com/repos/<owner>/<repo>/git/blobs/<sha>
  //   github.com/<owner>/<repo>/blob|raw|edit|tree|commits|commit/<ref>/<path>
  //   codeload.github.com/<owner>/<repo>/(zip|tar)/refs/heads/<branch>
  // Gists live at gist.github.com/<user>/<gist-id>/... — we keep the full
  // path because the gist id is the resource identity.
  const ghBucket = _ghResourceBucket(rawHost, rawPath);
  if (ghBucket !== null) return `github.com::${ghBucket}`;

  // Non-GitHub: keep the lowercased hostname and the last 3 path segments.
  // Loose by design — trades some over-bucketing (siblings in the same
  // /a/b/foo/ directory may collide) for catching cross-host thrashing.
  const segments = rawPath.split('/').filter(Boolean);
  const tail = segments.slice(-3).join('/');
  return `${rawHost}::${tail}`;
}

function _ghResourceBucket(host, path) {
  let m;
  if (host === 'raw.githubusercontent.com' || host.endsWith('.githubusercontent.com')) {
    // /owner/repo/<branch>/<path>  →  owner/repo/<path>
    m = path.match(/^\/([^/]+)\/([^/]+)\/[^/]+\/(.*)$/);
    if (m) return `${m[1]}/${m[2]}/${m[3]}`;
    return null;
  }
  if (host === 'api.github.com') {
    // /repos/o/r/contents/<path>, /repos/o/r/git/blobs/<sha>, /repos/o/r/git/trees/<sha>, /repos/o/r/git/refs/<ref>
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(?:contents|git\/blobs|git\/trees|git\/refs)\/?(.*)$/);
    if (m) return `${m[1]}/${m[2]}/${m[3]}`;
    return null;
  }
  if (host === 'github.com') {
    // /owner/repo/blob|raw|edit|tree|commits|commit/<ref>/<path>
    m = path.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw|edit|tree|commits|commit)\/[^/]+\/?(.*)$/);
    if (m) return `${m[1]}/${m[2]}/${m[3]}`;
    return null;
  }
  if (host === 'gist.github.com') {
    // Keep path verbatim — gist id is the identity.
    return path.replace(/^\//, '');
  }
  if (host === 'codeload.github.com') {
    m = path.match(/^\/([^/]+)\/([^/]+)\/(?:zip|tar)\/refs\/heads\/(.*)$/);
    if (m) return `${m[1]}/${m[2]}/zip/${m[3]}`;
    return null;
  }
  return null; // not a GitHub host
}

/**
 * Build the loop-detector key for a tool call. URL-family tools bucket
 * by resource + method; other tools fall back to exact JSON args.
 *
 * Returns the args-portion of the loop key. Caller appends `|name|errored`.
 */
export function bucketArgsKey(name, args) {
  if (URL_FAMILY_TOOLS.has(name) && args && args.url) {
    const bucket = resourceBucket(args.url);
    const method = (args.method || 'GET').toUpperCase();
    const pageSourceRange = name === 'read_page_source' ? _pageSourceRangeKey(args) : '';
    const fetchTextWindow = name === 'fetch_url' ? _fetchTextWindowKey(args) : '';
    return `url:${bucket}|${method}${pageSourceRange}${fetchTextWindow}`;
  }
  return JSON.stringify(args || {});
}

function _pageSourceRangeKey(args) {
  const offset = _nonNegativeInteger(args.offset, 0);
  const maxChars = args.maxChars == null ? '' : _nonNegativeInteger(args.maxChars, 0);
  return `|offset:${offset}|maxChars:${maxChars}`;
}

function _fetchTextWindowKey(args) {
  const find = String(args.find ?? '').trim().toLowerCase().slice(0, 200);
  if (find) return `|find:${find}`;
  return `|offset:${_nonNegativeInteger(args.offset, 0)}`;
}

function _nonNegativeInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}
