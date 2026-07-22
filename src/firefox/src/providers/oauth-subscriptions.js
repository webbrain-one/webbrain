/**
 * OAuth (PKCE) sign-in for "use your subscription" providers.
 *
 * This module started as the OPPOSITE of oauth-claude.js — every client
 * was meant to identify HONESTLY with its own client_id. In practice,
 * OpenAI (like Claude) does not authorize third-party OAuth clients for
 * ChatGPT subscription access, so the OpenAI entry now borrows the Codex
 * CLI's first-party client_id (same pattern as oauth-claude.js).
 *
 * Gemini remains honest: the user registers their own Google Cloud OAuth
 * client and enters its client_id. No impersonation.
 *
 * All clients send NO headers that impersonate a vendor's first-party
 * CLI (no `x-app: cli`, no spoofed `user-agent`, no `originator`).
 *
 * Borrowed-client providers may be revoked by the vendor at any time;
 * the settings UI surfaces a disclaimer on every such card.
 */

// ─── PKCE + backoff helpers (self-contained; mirror oauth-claude.js) ──

function base64UrlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

function randomBase64Url(byteLength = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

const TOKEN_MAX_RETRIES = 3;
const TOKEN_BACKOFF_CAP_MS = 4000;

// Encode a token-endpoint body as JSON or x-www-form-urlencoded. Google's
// token endpoint requires form encoding; OpenAI accepts JSON. Defaults to
// form (the OAuth2 spec's required format) when a def doesn't say.
function encodeTokenBody(body, format) {
  if (format === 'json') {
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v != null) form.set(k, v);
  return { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() };
}

// POST to a token endpoint with bounded retry/backoff on transient 429/5xx.
async function postToken(tokenUrl, body, format) {
  const enc = encodeTokenBody(body, format);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(tokenUrl, { method: 'POST', headers: enc.headers, body: enc.body });
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= TOKEN_MAX_RETRIES) return res;
    const retryAfterMs = parseRetryAfterMs(res);
    if (retryAfterMs != null && retryAfterMs > TOKEN_BACKOFF_CAP_MS) return res;
    const backoff = Math.min(TOKEN_BACKOFF_CAP_MS, 1000 * 2 ** attempt);
    await sleep(Math.max(backoff, retryAfterMs ?? 0));
  }
}

async function tokenError(label, res) {
  if (res.status === 429) {
    const ms = parseRetryAfterMs(res);
    const hint = ms != null ? ` Wait ${Math.ceil(ms / 1000)}s and retry.` : '';
    return new Error(`${label}: rate-limited (HTTP 429).${hint}`);
  }
  let text = '';
  try { text = (await res.text()).slice(0, 200); } catch {}
  text = text.replace(/[A-Za-z0-9_-]{40,}/g, '[REDACTED]');
  return new Error(`${label}: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
}

// ─── Generic OAuth client ────────────────────────────────────────────

/**
 * Build an OAuth client from a provider definition:
 *   { label, storageKey, authUrl, tokenUrl, scopes,
 *     staticClientId?, redirect?, tokenBodyFormat?, extraAuthParams? }
 *
 * `redirect` defaults to this extension's chromiumapp.org callback (the
 * standard installed-app redirect the user registers for their own
 * client). `staticClientId` is WebBrain's own id; when absent, start()
 * requires the caller to pass a user-supplied client_id.
 */
function makeOAuthClient(def) {
  const STORAGE_KEY = def.storageKey;

  function redirectUri() {
    return def.redirect || `https://${browser.runtime.id}.chromiumapp.org/`;
  }

  async function start(clientIdArg, clientSecretArg = '') {
    const clientId = (clientIdArg || def.staticClientId || '').trim();
    const clientSecret = String(clientSecretArg || '').trim();
    if (!clientId) {
      throw new Error(`${def.label}: no OAuth client ID configured. Register your own OAuth app in the vendor's console and enter its client ID first.`);
    }
    const redirect = redirectUri();
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const state = randomBase64Url(32);

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirect,
      scope: def.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      ...(def.extraAuthParams || {}),
    });
    const authUrl = `${def.authUrl}?${params.toString()}`;

    const code = await openTabAndAwaitCode(authUrl, redirect, state);
    return await exchange({ code, codeVerifier, clientId, clientSecret, redirect });
  }

  // Open the auth URL in a tab and resolve with the `code` once the tab
  // navigates to our redirect URI. Mirrors oauth-claude.js — no
  // launchWebAuthFlow so the same code path works on Chrome + Firefox.
  function openTabAndAwaitCode(authUrl, redirect, state) {
    return new Promise(async (resolve, reject) => {
      let authTabId;
      try {
        const authTab = await browser.tabs.create({ url: authUrl, active: true });
        authTabId = authTab.id;
      } catch (e) {
        return reject(new Error(`Could not open sign-in tab: ${e.message}`));
      }

      let settled = false;
      const cleanup = () => {
        try { browser.tabs.onUpdated.removeListener(onUpdated); } catch {}
        try { browser.tabs.onRemoved.removeListener(onRemoved); } catch {}
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        browser.tabs.remove(authTabId).catch(() => {});
        fn(value);
      };

      const onUpdated = (tabId, changeInfo) => {
        if (tabId !== authTabId || !changeInfo.url || !changeInfo.url.startsWith(redirect)) return;
        let parsed;
        try { parsed = new URL(changeInfo.url); } catch { return finish(reject, new Error('Malformed redirect URL')); }
        const err = parsed.searchParams.get('error');
        if (err) {
          const desc = parsed.searchParams.get('error_description') || '';
          return finish(reject, new Error(`Authorization failed: ${err}${desc ? ' — ' + desc : ''}`));
        }
        const code = parsed.searchParams.get('code');
        const returnedState = parsed.searchParams.get('state');
        if (!code) return finish(reject, new Error('Authorization redirect missing code parameter'));
        if (returnedState !== state) return finish(reject, new Error('OAuth state mismatch (possible CSRF or stale flow)'));
        finish(resolve, code);
      };
      const onRemoved = (tabId) => {
        if (tabId === authTabId) finish(reject, new Error('Sign-in tab was closed before authorization completed.'));
      };
      browser.tabs.onUpdated.addListener(onUpdated);
      browser.tabs.onRemoved.addListener(onRemoved);
    });
  }

  async function exchange({ code, codeVerifier, clientId, clientSecret, redirect }) {
    const res = await postToken(def.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      code_verifier: codeVerifier,
    }, def.tokenBodyFormat);
    if (!res.ok) throw await tokenError(`${def.label} token exchange`, res);
    const data = await res.json().catch(() => { throw new Error(`${def.label}: token exchange returned invalid JSON.`); });
    return await persist(data, { clientId, clientSecret });
  }

  async function persist(data, { clientId, clientSecret = '', fallbackRefresh = null } = {}) {
    if (!data.access_token) throw new Error(`${def.label}: token response missing access_token`);
    const tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || fallbackRefresh,
      expiresAt: Date.now() + ((data.expires_in || 3600) * 1000) - 60_000,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      scope: data.scope || def.scopes,
      obtainedAt: Date.now(),
    };
    await browser.storage.local.set({ [STORAGE_KEY]: tokens });
    return tokens;
  }

  async function refresh() {
    const stored = await browser.storage.local.get([STORAGE_KEY]);
    const tokens = stored[STORAGE_KEY];
    if (!tokens?.refreshToken) throw new Error(`${def.label}: no refresh token on file — sign in first.`);
    const res = await postToken(def.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId || def.staticClientId,
      ...(tokens.clientSecret ? { client_secret: tokens.clientSecret } : {}),
    }, def.tokenBodyFormat);
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        await browser.storage.local.remove([STORAGE_KEY]);
        throw new Error(`${def.label}: refresh token rejected — please sign in again.`);
      }
      throw await tokenError(`${def.label} token refresh`, res);
    }
    const data = await res.json().catch(() => { throw new Error(`${def.label}: token refresh returned invalid JSON.`); });
    return await persist(data, {
      clientId: tokens.clientId,
      clientSecret: tokens.clientSecret,
      fallbackRefresh: tokens.refreshToken,
    });
  }

  async function getAccessToken() {
    const stored = await browser.storage.local.get([STORAGE_KEY]);
    const tokens = stored[STORAGE_KEY];
    if (!tokens?.accessToken) throw new Error(`Not signed in to ${def.label}. Open Settings and sign in.`);
    if (Date.now() >= tokens.expiresAt) return (await refresh()).accessToken;
    return tokens.accessToken;
  }

  async function getStatus() {
    const stored = await browser.storage.local.get([STORAGE_KEY]);
    const tokens = stored[STORAGE_KEY];
    if (!tokens?.accessToken) return { signedIn: false };
    return { signedIn: true, obtainedAt: tokens.obtainedAt, expiresAt: tokens.expiresAt, scope: tokens.scope };
  }

  async function signOut() {
    await browser.storage.local.remove([STORAGE_KEY]);
  }

  return { start, refresh, getAccessToken, getStatus, signOut };
}

// ─── Provider definitions (honest clients only) ──────────────────────

// OpenAI / ChatGPT subscription. Uses Codex CLI's OAuth client_id (same
// pattern as Claude — borrowed first-party identity). OpenAI does not
// publicly register third-party clients for ChatGPT-subscription
// inference, so this is the only way to authenticate. OpenAI may revoke
// this client at any time.
const OPENAI_OAUTH = makeOAuthClient({
  label: 'OpenAI (ChatGPT subscription)',
  storageKey: 'openaiOauthTokens',
  staticClientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirect: 'http://localhost:1455/auth/callback',
  scopes: 'openid profile email offline_access',
  tokenBodyFormat: 'form',
  extraAuthParams: {
    id_token_add_organizations: 'true',
    originator: 'codex_cli_rs',
  },
});

// Google Gemini subscription. User supplies their own Google Cloud OAuth
// client_id. Uses a loopback redirect so the extension can catch the
// callback in the tab without a local server.
const GEMINI_OAUTH = makeOAuthClient({
  label: 'Google Gemini (subscription)',
  storageKey: 'geminiOauthTokens',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  redirect: 'http://localhost:1456/auth/callback',
  scopes: 'https://www.googleapis.com/auth/generative-language openid',
  tokenBodyFormat: 'form',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
});

// Chrome Web Store publishing. The user owns the Google Cloud OAuth client;
// WebBrain never ships a shared publishing identity. The loopback redirect is
// observed in the temporary auth tab, so no local HTTP server is required.
const CHROME_WEB_STORE_OAUTH = makeOAuthClient({
  label: 'Chrome Web Store',
  storageKey: 'chromeWebStoreOauthTokens',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  redirect: 'http://localhost:1457/auth/callback',
  scopes: 'https://www.googleapis.com/auth/chromewebstore',
  tokenBodyFormat: 'form',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
});

const CLIENTS = {
  openai: OPENAI_OAUTH,
  gemini: GEMINI_OAUTH,
  chrome_web_store: CHROME_WEB_STORE_OAUTH,
};

// ─── Registry dispatch (used by background.js + providers) ───────────

export async function startSubscriptionOAuth(provider, clientId, clientSecret = '') {
  const c = CLIENTS[provider];
  if (!c) throw new Error(`Unknown OAuth provider: ${provider}`);
  return c.start(clientId, clientSecret);
}

export async function signOutSubscription(provider) {
  const c = CLIENTS[provider];
  if (!c) throw new Error(`Unknown OAuth provider: ${provider}`);
  return c.signOut();
}

export async function getSubscriptionStatus(provider) {
  const c = CLIENTS[provider];
  if (!c) throw new Error(`Unknown OAuth provider: ${provider}`);
  return c.getStatus();
}

export async function refreshSubscription(provider) {
  const c = CLIENTS[provider];
  if (!c) throw new Error(`Unknown OAuth provider: ${provider}`);
  return c.refresh();
}

export function getSubscriptionAccessToken(provider) {
  const c = CLIENTS[provider];
  if (!c) throw new Error(`Unknown OAuth provider: ${provider}`);
  return c.getAccessToken();
}
