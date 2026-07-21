/**
 * Claude Pro/Max OAuth flow.
 *
 * Lets a user sign their browser into their personal Claude.ai
 * subscription and use it as an LLM backend, in lieu of an API key.
 * Inference goes through `https://api.anthropic.com/v1/messages` with a
 * `Bearer` access token + the `anthropic-beta: oauth-2025-04-20` header,
 * not the usual `x-api-key`.
 *
 * ─── Important caveats ─────────────────────────────────────────────
 *
 * 1. **Anthropic's terms restrict third-party clients.** The OAuth
 *    `client_id` we use here is the one Claude Code (Anthropic's own
 *    CLI) ships with. Re-using it from another tool is a grey area:
 *    Anthropic can revoke the client at any time, and a Pro/Max sub
 *    is technically meant for personal use through Anthropic's own
 *    products. The settings UI surfaces a disclaimer.
 *
 * 2. **System-prompt prefix is mandatory.** Anthropic's OAuth gate
 *    rejects (or flags) `/v1/messages` requests whose system prompt
 *    does not begin with "You are Claude Code, Anthropic's official
 *    CLI for Claude." `AnthropicOAuthProvider._convertMessages` injects
 *    that prefix; do NOT remove it.
 *
 * 3. **Why not `chrome.identity.launchWebAuthFlow`?** That API requires
 *    the redirect URI to be `https://<extension-id>.chromiumapp.org/`.
 *    Claude Code's `client_id` is registered with redirect_uri
 *    `https://platform.claude.com/oauth/code/callback`, which is what
 *    Anthropic's authorization server will accept. There is no way for
 *    a third-party client to register a different redirect URI without
 *    going through Anthropic. So we open the auth URL in a normal tab
 *    and intercept the redirect via `tabs.onUpdated`.
 *
 * 4. **Tokens are stored in `chrome.storage.local`, plaintext.** Same
 *    posture as the API keys we already store. The settings UI calls
 *    this out in the disclaimer.
 */

// Claude Code's public OAuth client_id. Constants — not secrets — but
// changing them will break the flow, so don't touch unless Anthropic
// rotates their CLI's client.
const CLIENT_ID  = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL   = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL  = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT   = 'https://platform.claude.com/oauth/code/callback';
const SCOPES     = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

// Storage key. Kept in `chrome.storage.local` separately from provider
// configs so `manager.getAll()` (which returns provider configs to the
// settings UI for rendering) doesn't accidentally leak refresh tokens
// into the DOM.
const STORAGE_KEY = 'anthropicOauthTokens';

// Refresh-ahead window: kick off a refresh this many milliseconds
// before the access token's `expires_at`. Anthropic's tokens are
// typically 1h, so a 60s window leaves plenty of safety margin.
const REFRESH_WINDOW_MS = 60_000;

/**
 * Mandatory anti-abuse prefix for OAuth-mode system prompts. See
 * `AnthropicOAuthProvider._convertMessages` for where this is applied.
 * Exported so the provider can import it from one place.
 */
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

/**
 * Kick off the Claude OAuth flow. Opens a new tab with Anthropic's
 * authorization URL, waits for the redirect to land at
 * `platform.claude.com/oauth/code/callback?code=…&state=…`, exchanges
 * the code for tokens, and persists them in `chrome.storage.local`.
 *
 * Resolves with the persisted token bundle. Rejects if the user closes
 * the auth tab, the auth server returns an error, the state token
 * doesn't match, or the token exchange fails.
 *
 * Implementation notes:
 *   - We use `chrome.tabs.onUpdated` (not webRequest, not webNavigation,
 *     not launchWebAuthFlow) because both Chrome and Firefox already
 *     have the `tabs` permission and can see URL changes on tabs we
 *     spawn under our `<all_urls>` host permission.
 *   - The listener fires on the `changeInfo.url` change, which Chrome
 *     emits before the page's HTML has rendered. So the user only sees
 *     a brief flash of console.anthropic.com before we close the tab.
 *   - We also listen for `tabs.onRemoved` so cancellation (user closes
 *     the tab) rejects the promise instead of hanging forever.
 */
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

  const authTab = await chrome.tabs.create({ url: authUrl, active: true });
  const authTabId = authTab.id;

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch {}
      try { chrome.tabs.onRemoved.removeListener(onRemoved); } catch {}
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Best-effort tab close; we don't fail the flow if it's already gone.
      chrome.tabs.remove(authTabId).catch(() => {});
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

      // Got a code — close the tab now, then do the token exchange.
      // Closing first means the user doesn't stare at console.anthropic.com
      // while we're talking to the token endpoint.
      cleanup();
      chrome.tabs.remove(authTabId).catch(() => {});
      settled = true;
      exchangeCodeForTokens(code, codeVerifier).then(resolve, reject);
    };

    const onRemoved = (tabId) => {
      if (tabId !== authTabId) return;
      settle(reject, new Error('Sign-in window was closed before authorization completed.'));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
    state: '', // Anthropic's token endpoint ignores state but some servers require the field.
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
    // Anthropic rotates refresh tokens; if the response omits one, keep
    // the previous so the next refresh still works.
    refreshToken: data.refresh_token || fallbackRefreshToken,
    expiresAt: Date.now() + ((data.expires_in || 3600) * 1000) - REFRESH_WINDOW_MS,
    scope: data.scope || SCOPES,
    tokenType: data.token_type || 'Bearer',
    obtainedAt: Date.now(),
  };
  if (!tokens.accessToken) throw new Error('Token response missing access_token');
  if (!tokens.refreshToken) throw new Error('Token response missing refresh_token');
  await chrome.storage.local.set({ [STORAGE_KEY]: tokens });
  return tokens;
}

/**
 * Refresh the access token using the stored refresh token. Used by the
 * provider on 401 and by the background alarm before expiry.
 *
 * On a hard failure (refresh token invalid / revoked), wipes the stored
 * tokens and throws — the caller should surface a "please sign in
 * again" state in the UI.
 *
 * All callers are deduplicated onto one in-flight request: Anthropic
 * rotates refresh tokens on every refresh, so two concurrent refreshes
 * would present the SAME refresh token twice — the first succeeds, the
 * second gets HTTP 400, and the error handler would then wipe the
 * freshly-persisted tokens, spuriously signing the user out.
 */
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
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
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
    // 400/401 from the token endpoint means the refresh is dead. Wipe
    // so the UI can prompt for re-auth instead of looping on a bad
    // token.
    if (res.status === 400 || res.status === 401) {
      await chrome.storage.local.remove([STORAGE_KEY]);
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

/**
 * Get a valid access token, refreshing if needed. Used by
 * AnthropicOAuthProvider on every chat call.
 */
export async function getClaudeAccessToken() {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const tokens = stored[STORAGE_KEY];
  if (!tokens?.accessToken) throw new Error('Not signed in to Claude. Open Settings → Claude (Pro/Max) → Sign in.');
  if (Date.now() >= tokens.expiresAt) {
    const refreshed = await refreshClaudeAccessToken();
    return refreshed.accessToken;
  }
  return tokens.accessToken;
}

/**
 * UI status query. Returns an object the settings page can render
 * without ever touching the raw refresh token.
 */
export async function getClaudeOAuthStatus() {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
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
  await chrome.storage.local.remove([STORAGE_KEY]);
}
