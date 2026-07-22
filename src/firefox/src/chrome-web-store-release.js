import {
  getSubscriptionAccessToken,
  getSubscriptionStatus,
  refreshSubscription,
  signOutSubscription,
  startSubscriptionOAuth,
} from './providers/oauth-subscriptions.js';

export const CHROME_WEB_STORE_SKILL_ID = 'chrome-web-store-release';
export const CHROME_WEB_STORE_SKILL_PATH = 'skills/chrome-web-store-release.md';
export const CHROME_WEB_STORE_CONFIG_KEY = 'chromeWebStoreReleaseConfig';
export const CHROME_WEB_STORE_PACKAGE_KEY = 'chromeWebStoreReleasePackage';
export const CHROME_WEB_STORE_OAUTH_PROVIDER = 'chrome_web_store';
export const CHROME_WEB_STORE_REDIRECT_URI = 'http://localhost:1457/auth/callback';
export const CHROME_WEB_STORE_MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

const TRUSTED_TOOL_NAMES = new Set([
  'chrome_web_store_status',
  'chrome_web_store_upload',
  'chrome_web_store_publish',
]);

function extensionApi() { return globalThis.browser || globalThis.chrome; }
function clean(value, max = 300) { return String(value || '').trim().slice(0, max); }

export function normalizeChromeWebStoreConfig(value = {}) {
  return {
    publisherId: clean(value.publisherId, 128),
    itemId: clean(value.itemId, 128).toLowerCase(),
    oauthClientId: clean(value.oauthClientId, 512),
    oauthClientSecret: clean(value.oauthClientSecret, 512),
  };
}

export function chromeWebStoreConfigError(value) {
  const config = normalizeChromeWebStoreConfig(value);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(config.publisherId)) return 'Chrome Web Store publisher ID is missing or invalid. Configure it in Settings → Skills.';
  if (!/^[a-p]{32}$/.test(config.itemId)) return 'Chrome Web Store item ID must be the 32-character extension ID (letters a–p). Configure it in Settings → Skills.';
  return '';
}

function itemName(config) { return `publishers/${encodeURIComponent(config.publisherId)}/items/${encodeURIComponent(config.itemId)}`; }
export function chromeWebStoreEndpoint(toolName, config) {
  const name = itemName(normalizeChromeWebStoreConfig(config));
  if (toolName === 'chrome_web_store_upload') return `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`;
  if (toolName === 'chrome_web_store_publish') return `https://chromewebstore.googleapis.com/v2/${name}:publish`;
  return `https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`;
}

export function isTrustedChromeWebStoreSkillTool(tool) {
  return !!tool && tool.kind === 'chromeWebStore' && tool.skillId === CHROME_WEB_STORE_SKILL_ID
    && tool.sourceType === 'built-in' && tool.sourceUrl === CHROME_WEB_STORE_SKILL_PATH
    && TRUSTED_TOOL_NAMES.has(tool.name);
}

async function responsePayload(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 1000) }; }
}
function responseError(response, payload) {
  const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
  const details = payload?.error?.details;
  let raw = String(message);
  if (details != null) {
    const detailText = typeof details === 'string' ? details : JSON.stringify(details);
    if (detailText && detailText !== '[]' && detailText !== '{}') raw += ` Details: ${detailText}`;
  }
  return String(raw).replace(/[A-Za-z0-9_-]{40,}/g, '[REDACTED]').slice(0, 1000);
}
function decodeBase64(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function authorizedFetch(url, init, opts = {}, dispatchState = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Network access is unavailable.');
  let token = opts.accessToken || await getSubscriptionAccessToken(CHROME_WEB_STORE_OAUTH_PROVIDER);
  dispatchState.outcomeUnknown = init.method === 'POST';
  let response = await fetchImpl(url, { ...init, cache: 'no-store', credentials: 'omit', headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  dispatchState.outcomeUnknown = false;
  if (response.status === 401 && !opts.accessToken) {
    token = (await refreshSubscription(CHROME_WEB_STORE_OAUTH_PROVIDER)).accessToken;
    dispatchState.outcomeUnknown = init.method === 'POST';
    response = await fetchImpl(url, { ...init, cache: 'no-store', credentials: 'omit', headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    dispatchState.outcomeUnknown = false;
  }
  return response;
}

export async function executeChromeWebStoreSkillTool(tool, args = {}, opts = {}) {
  if (!isTrustedChromeWebStoreSkillTool(tool)) return { success: false, dispatched: false, noDispatch: true, error: 'Untrusted Chrome Web Store tool declaration rejected.' };
  const storage = opts.storage || extensionApi()?.storage?.local;
  if (!storage) return { success: false, dispatched: false, noDispatch: true, error: 'Extension storage is unavailable.' };
  const stored = await storage.get([CHROME_WEB_STORE_CONFIG_KEY, CHROME_WEB_STORE_PACKAGE_KEY]);
  const config = normalizeChromeWebStoreConfig(stored[CHROME_WEB_STORE_CONFIG_KEY]);
  const configError = chromeWebStoreConfigError(config);
  if (configError) return { success: false, dispatched: false, noDispatch: true, error: configError };
  const url = chromeWebStoreEndpoint(tool.name, config);
  let init = { method: 'GET', headers: { Accept: 'application/json' } };
  let packageInfo = null;
  if (tool.name === 'chrome_web_store_upload') {
    packageInfo = stored[CHROME_WEB_STORE_PACKAGE_KEY];
    if (!packageInfo?.base64 || !packageInfo?.name) return { success: false, dispatched: false, noDispatch: true, error: 'No release ZIP is selected. Choose one in Settings → Skills before uploading.' };
    if (!/\.zip$/i.test(packageInfo.name) || Number(packageInfo.size) > CHROME_WEB_STORE_MAX_PACKAGE_BYTES) return { success: false, dispatched: false, noDispatch: true, error: 'The selected release package is not a valid supported ZIP.' };
    init = { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/zip' }, body: decodeBase64(packageInfo.base64) };
  } else if (tool.name === 'chrome_web_store_publish') {
    const requestedPublishType = args.publish_type == null ? 'default' : String(args.publish_type);
    if (requestedPublishType !== 'default' && requestedPublishType !== 'staged') return {
      success: false, dispatched: false, noDispatch: true,
      error: 'publish_type must be either "default" or "staged".',
    };
    const publishType = requestedPublishType === 'staged' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH';
    const percentage = args.deploy_percentage == null ? null : Number(args.deploy_percentage);
    if (percentage != null && (!Number.isInteger(percentage) || percentage < 0 || percentage > 100)) return { success: false, dispatched: false, noDispatch: true, error: 'deploy_percentage must be an integer from 0 to 100.' };
    init = { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ publishType, blockOnWarnings: true, ...(percentage == null ? {} : { deployInfos: [{ deployPercentage: percentage }] }) }) };
  }
  const consequential = init.method === 'POST';
  const dispatchState = { outcomeUnknown: false };
  try {
    const response = await authorizedFetch(url, init, opts, dispatchState);
    const payload = await responsePayload(response);
    if (!response.ok) return { success: false, dispatched: consequential, ...(consequential ? { outcomeUnknown: response.status >= 500 } : { noDispatch: true }), status: response.status, error: responseError(response, payload) };
    return { success: true, dispatched: consequential, ...(tool.name === 'chrome_web_store_status' ? { observed: true } : {}), ...(packageInfo ? { package: { name: packageInfo.name, size: Number(packageInfo.size) || 0, sha256: clean(packageInfo.sha256, 128) } } : {}), result: payload };
  } catch (error) {
    const dispatched = consequential && dispatchState.outcomeUnknown;
    return { success: false, dispatched, ...(dispatched ? { outcomeUnknown: true } : { noDispatch: true }), error: clean(error?.message || error, 1000) };
  }
}

export async function startChromeWebStoreOAuth(config) {
  const normalized = normalizeChromeWebStoreConfig(config);
  if (!normalized.oauthClientId) throw new Error('Enter a Google OAuth client ID first.');
  return startSubscriptionOAuth(CHROME_WEB_STORE_OAUTH_PROVIDER, normalized.oauthClientId, normalized.oauthClientSecret);
}
export function getChromeWebStoreOAuthStatus() { return getSubscriptionStatus(CHROME_WEB_STORE_OAUTH_PROVIDER); }
export function signOutChromeWebStoreOAuth() { return signOutSubscription(CHROME_WEB_STORE_OAUTH_PROVIDER); }
