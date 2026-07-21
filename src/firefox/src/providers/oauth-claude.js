/**
 * Claude Pro/Max OAuth flow (Firefox).
 *
 * See `src/chrome/src/providers/oauth-claude.js` for the full design
 * notes — this file is a near-mirror that uses `browser.*` instead of
 * `chrome.*`. Re-read the Chrome file's header comment for context on:
 *   - Why we re-use Claude Code's client_id
 *   - Why the system prompt MUST be prefixed with the Claude Code preamble
 *   - Why we open a tab + listen for redirects instead of using
 *     browser.identity.launchWebAuthFlow
 *   - How tokens are stored
 *   - The legal posture (Anthropic restricts third-party clients;
 *     this is a grey area; client may be revoked at any time).
 */

const CLIENT_ID  = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL   = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL  = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT   = 'https://platform.claude.com/oauth/code/callback';
const SCOPES     = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

const STORAGE_KEY = 'anthropicOauthTokens';
const REFRESH_WINDOW_MS = 60_000;

export const CLAUDE_CODE_SYSTEM_PREAMBLE =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// ─── PKCE helpers ────────────────────────────────────────────────────

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
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64UrlEncode(bytes);
}

// ─── Public API ──────────────────────────────────────────────────────

export async function startClaudeOAuth() {
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomBase64Url(32);

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;

  const authTab = await browser.tabs.create({ url: authUrl, active: true });
  const authTabId = authTab.id;

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      try { browser.tabs.onUpdated.removeListener(onUpdated); } catch {}
      try { browser.tabs.onRemoved.removeListener(onRemoved); } catch {}
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      browser.tabs.remove(authTabId).catch(() => {});
      fn(value);
    };

    const onUpdated = (tabId, changeInfo) => {
      if (tabId !== authTabId || !changeInfo.url) return;
      const url = changeInfo.url;
      if (!url.startsWith(REDIRECT)) return;

      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        return settle(reject, new Error('Malformed redirect URL'));
      }

      const error = parsed.searchParams.get('error');
      if (error) {
        const desc = parsed.searchParams.get('error_description') || '';
        return settle(reject, new Error(`Authorization failed: ${error}${desc ? ' — ' + desc : ''}`));
      }

      const code = parsed.searchParams.get('code');
      const returnedState = parsed.searchParams.get('state');
      if (!code) return settle(reject, new Error('Authorization redirect missing code parameter'));
      if (returnedState !== state) {
        return settle(reject, new Error('OAuth state mismatch (possible CSRF or stale flow)'));
      }

      cleanup();
      browser.tabs.remove(authTabId).catch(() => {});
      settled = true;
      exchangeCodeForTokens(code, codeVerifier).then(resolve, reject);
    };

    const onRemoved = (tabId) => {
      if (tabId !== authTabId) return;
      settle(reject, new Error('Sign-in window was closed before authorization completed.'));
    };

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
  });
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
    state: '',
  };
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let errMsg = '';
    try { errMsg = (await res.text()).slice(0, 200); } catch {}
    errMsg = errMsg.replace(/[A-Za-z0-9_-]{40,}/g, '[REDACTED]');
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${errMsg}`);
  }
  let data;
  try { data = await res.json(); } catch {
    throw new Error('Token exchange returned invalid JSON.');
  }
  return await persistTokens(data);
}

async function persistTokens(data, fallbackRefreshToken = null) {
  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    expiresAt: Date.now() + ((data.expires_in || 3600) * 1000) - REFRESH_WINDOW_MS,
    scope: data.scope || SCOPES,
    tokenType: data.token_type || 'Bearer',
    obtainedAt: Date.now(),
  };
  if (!tokens.accessToken) throw new Error('Token response missing access_token');
  if (!tokens.refreshToken) throw new Error('Token response missing refresh_token');
  await browser.storage.local.set({ [STORAGE_KEY]: tokens });
  return tokens;
}

// All callers are deduplicated onto one in-flight request: Anthropic
// rotates refresh tokens on every refresh, so two concurrent refreshes
// would present the SAME refresh token twice — the first succeeds, the
// second gets HTTP 400, and the error handler would then wipe the
// freshly-persisted tokens, spuriously signing the user out.
let _inflightRefresh = null;

export function refreshClaudeAccessToken() {
  if (!_inflightRefresh) {
    _inflightRefresh = _doRefreshClaudeAccessToken().finally(() => {
      _inflightRefresh = null;
    });
  }
  return _inflightRefresh;
}

async function _doRefreshClaudeAccessToken() {
  const stored = await browser.storage.local.get([STORAGE_KEY]);
  const tokens = stored[STORAGE_KEY];
  if (!tokens?.refreshToken) throw new Error('No Claude refresh token on file — sign in first.');

  const body = {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
  };
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 || res.status === 401) {
      await browser.storage.local.remove([STORAGE_KEY]);
      throw new Error('Claude refresh token rejected — please sign in again.');
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const waitHint = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
      throw new Error(`Token refresh rate-limited (HTTP 429)${waitHint}. Try again in a moment.`);
    }
    const safeText = text.slice(0, 200).replace(/[A-Za-z0-9_-]{40,}/g, '[REDACTED]');
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${safeText}`);
  }
  let data;
  try { data = await res.json(); } catch {
    throw new Error('Token refresh returned invalid JSON.');
  }
  return await persistTokens(data, tokens.refreshToken);
}

export async function getClaudeAccessToken() {
  const stored = await browser.storage.local.get([STORAGE_KEY]);
  const tokens = stored[STORAGE_KEY];
  if (!tokens?.accessToken) throw new Error('Not signed in to Claude. Open Settings → Claude (Pro/Max) → Sign in.');
  if (Date.now() >= tokens.expiresAt) {
    const refreshed = await refreshClaudeAccessToken();
    return refreshed.accessToken;
  }
  return tokens.accessToken;
}

export async function getClaudeOAuthStatus() {
  const stored = await browser.storage.local.get([STORAGE_KEY]);
  const tokens = stored[STORAGE_KEY];
  if (!tokens?.accessToken) return { signedIn: false };
  return {
    signedIn: true,
    expiresAt: tokens.expiresAt,
    obtainedAt: tokens.obtainedAt,
    scope: tokens.scope,
  };
}

export async function signOutClaude() {
  await browser.storage.local.remove([STORAGE_KEY]);
}
