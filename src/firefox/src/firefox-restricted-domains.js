// Firefox reserves a small set of Mozilla-owned origins from ordinary
// WebExtension access. Host permissions (including <all_urls>) do not let a
// content script run there, and extension-page fetch/XHR is blocked as well.
// Keep this list aligned with MDN's WebExtensions "Restricted domains" list.
const FIREFOX_RESTRICTED_DOMAINS = new Set([
  'accounts-static.cdn.mozilla.net',
  'accounts.firefox.com',
  'addons.cdn.mozilla.net',
  'addons.mozilla.org',
  'api.accounts.firefox.com',
  'content.cdn.mozilla.net',
  'discovery.addons.mozilla.org',
  'install.mozilla.org',
  'oauth.accounts.firefox.com',
  'profile.accounts.firefox.com',
  'support.mozilla.org',
  'sync.services.mozilla.com',
]);

function hostnameForUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function firefoxRestrictedDomainForUrl(rawUrl) {
  const hostname = hostnameForUrl(rawUrl);
  return FIREFOX_RESTRICTED_DOMAINS.has(hostname) ? hostname : null;
}

function accessFailure(hostname, rawUrl, errorCode, detail) {
  const host = hostname || 'this page';
  const explanation = detail || `Firefox protects ${host} from WebExtension access.`;
  return {
    success: false,
    errorCode,
    nonRetryable: true,
    nonRetryableScope: `firefox-host-access:${host}`,
    restrictedDomain: hostname || null,
    url: String(rawUrl || ''),
    recoveryTool: 'screenshot',
    error: `${explanation} WebBrain cannot inspect, interact with, or directly fetch this page. Opening the same URL in another tab or retrying another page/fetch tool will not grant access. If the page is the active run tab, use screenshot once for a read-only visual fallback; otherwise leave it open for manual use.`,
    stopMessage: `Stopped: ${explanation} WebBrain cannot inspect, interact with, or directly fetch this page. Opening another tab or retrying will not grant access. The page remains open for manual use.`,
  };
}

export function firefoxRestrictedDomainFailure(rawUrl) {
  const hostname = firefoxRestrictedDomainForUrl(rawUrl);
  if (!hostname) return null;
  return accessFailure(
    hostname,
    rawUrl,
    'firefox_restricted_domain',
    `Firefox protects ${hostname} from WebExtension access.`,
  );
}

export function firefoxHostPermissionFailure(rawUrl, rawError) {
  const message = String(rawError || '');
  if (!/(?:missing host permission|not allowed to access|cannot access contents of (?:the )?url|access to (?:the )?page (?:was )?denied)/i.test(message)) {
    return null;
  }
  const hostname = hostnameForUrl(rawUrl);
  return accessFailure(
    hostname,
    rawUrl,
    'firefox_host_access_denied',
    `Firefox denied extension access${hostname ? ` to ${hostname}` : ''}.`,
  );
}
