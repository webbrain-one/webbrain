const PUBLIC_MEDIA_HOSTS = [
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  'redd.it',
  'facebook.com',
  'fb.com',
  'fb.watch',
  'pinterest.com',
  'pin.it',
  'linkedin.com',
  'threads.net',
];

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function hasPathId(path, pattern) {
  return pattern.test(path);
}

/**
 * Return true only for URLs that identify one concrete public media item.
 * Recognized hosts that do not match one of these permalink shapes are
 * feeds/profiles and require visual target resolution first.
 */
export function isDirectPublicMediaUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname || '/';

  if (host === 'youtu.be') return hasPathId(path, /^\/[^/?#]+/);
  if (hostMatches(host, 'youtube.com')) {
    return (
      hasPathId(path, /^\/(?:shorts|live|embed|v)\/[^/?#]+/i) ||
      (path === '/watch' && !!parsed.searchParams.get('v'))
    );
  }
  if (hostMatches(host, 'instagram.com')) return hasPathId(path, /^\/(?:p|reel|tv)\/[^/?#]+/i);
  if (hostMatches(host, 'tiktok.com')) return hasPathId(path, /^\/@[^/]+\/video\/[^/?#]+/i);
  if (hostMatches(host, 'x.com') || hostMatches(host, 'twitter.com')) {
    return hasPathId(path, /^\/[^/]+\/status\/[^/?#]+/i);
  }
  if (hostMatches(host, 'reddit.com')) {
    return hasPathId(path, /^\/(?:r\/[^/]+\/)?comments\/[^/?#]+/i);
  }
  if (host === 'redd.it' || host === 'fb.watch' || host === 'pin.it') {
    return hasPathId(path, /^\/[^/?#]+/);
  }
  if (hostMatches(host, 'pinterest.com')) return hasPathId(path, /^\/pin\/[^/?#]+/i);
  if (hostMatches(host, 'linkedin.com')) return hasPathId(path, /^\/(?:posts\/|feed\/update\/)/i);
  if (hostMatches(host, 'threads.net')) return hasPathId(path, /^\/@[^/]+\/post\/[^/?#]+/i);
  if (hostMatches(host, 'facebook.com') || hostMatches(host, 'fb.com')) {
    return (
      hasPathId(path, /^\/(?:reel|watch|videos)\/[^/?#]+/i) ||
      hasPathId(path, /^\/(?:groups\/[^/]+\/posts|[^/]+\/(?:posts|videos))\/[^/?#]+/i) ||
      hasPathId(path, /^\/share\/(?:r|v)\/[^/?#]+/i) ||
      parsed.searchParams.has('story_fbid') ||
      parsed.searchParams.has('fbid') ||
      parsed.searchParams.has('v')
    );
  }
  return false;
}

export function publicMediaUrlNeedsExplicitTarget(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  if (!PUBLIC_MEDIA_HOSTS.some((domain) => hostMatches(host, domain))) return false;
  return !isDirectPublicMediaUrl(rawUrl);
}
