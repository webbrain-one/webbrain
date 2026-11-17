// An API-first action needs discovery reads (schema, current user, taxonomy,
// existing content) before it can write. Give a run a bounded allowance for
// distinct successful JSON endpoints. This is preparation, not evidence that
// the requested mutation happened, and never resets the observation streak.
const MAX_API_READS = 8;

function endpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    // Pagination, projections, searches and cache busters at the same path
    // must not repeatedly buy more preparation time. Do not retain secrets
    // from query strings, headers or response bodies in this bookkeeping.
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

export function recordApiReadProgress(state, args = {}, result = null) {
  const current = state || new Set();
  if (current.size >= MAX_API_READS
      || String(args.method || 'GET').trim().toUpperCase() !== 'GET'
      || result?.success !== true || result.error || result.noProgress === true
      || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300
      || !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(String(result.contentType || ''))
      || typeof result.json !== 'string' || !result.json.trim()) {
    return { state: current, madeProgress: false };
  }
  const key = endpoint(args.url);
  if (!key || key !== endpoint(result.url) || current.has(key)) {
    return { state: current, madeProgress: false };
  }
  current.add(key);
  return { state: current, madeProgress: true };
}
