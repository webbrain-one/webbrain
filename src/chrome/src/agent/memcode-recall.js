// Optional, extension-owned MemCode connection. Never expose tokens to the
// model, a skill manifest, page scripts, or the portable settings export.
export const MEMCODE_CONNECTION_KEY = 'wb_memcode_oauth_v1';
export const MEMCODE_RECALL_ENABLED_KEY = 'wb_memcode_recall_enabled';
const ISSUER = 'https://memory.memcode.in';
const RESOURCE = 'https://memory.memcode.in';
const ENDPOINT = 'https://memory.memcode.in/v2/memory/search';
const SCOPES = 'memory:read';

function base64url(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(cryptoApi, length = 32) {
  return base64url(cryptoApi.getRandomValues(new Uint8Array(length)));
}

async function checkedJson(response) {
  if (!response.ok) throw new Error(`MemCode returned HTTP ${response.status}.`);
  return response.json();
}

export function createMemcodeRecall({ storage, identity, fetcher = fetch, cryptoApi = crypto, now = Date.now }) {
  let refreshInFlight = null;
  const read = async () => (await storage.get(MEMCODE_CONNECTION_KEY))[MEMCODE_CONNECTION_KEY] || null;
  const write = async value => storage.set({ [MEMCODE_CONNECTION_KEY]: value });

  async function tokenRequest(fields) {
    return checkedJson(await fetcher(`${ISSUER}/auth/mcp/oauth/token`, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, resource: RESOURCE }),
    }));
  }

  function tokenBundle(clientId, redirectUri, data) {
    if (!data?.access_token || !data?.refresh_token || data?.token_type?.toLowerCase() !== 'bearer') {
      throw new Error('MemCode returned an incomplete OAuth token response.');
    }
    if (data.resource !== RESOURCE || data.scope !== SCOPES) {
      throw new Error('MemCode did not return a read-only token for the expected resource.');
    }
    return {
      clientId, redirectUri, accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now() + Math.max(0, Number(data.expires_in) || 0) * 1000,
    };
  }

  async function connect() {
    const redirectUri = identity.getRedirectURL('memcode');
    if (!redirectUri?.startsWith('https://')) throw new Error('A secure browser-extension redirect is required.');
    const client = await checkedJson(await fetcher(`${ISSUER}/auth/mcp/oauth/register`, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'WebBrain', software_id: 'webbrain', redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none', application_type: 'native', scope: SCOPES,
      }),
    }));
    if (!client?.client_id) throw new Error('MemCode did not register the OAuth client.');
    const verifier = randomValue(cryptoApi, 48);
    const challenge = base64url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = randomValue(cryptoApi);
    const url = new URL('https://app.memcode.in/oauth/authorize');
    url.search = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      scope: SCOPES, resource: RESOURCE, state,
      code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    const callback = new URL(await identity.launchWebAuthFlow({ url: url.href, interactive: true }));
    const expected = new URL(redirectUri);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || callback.searchParams.get('state') !== state) throw new Error('MemCode OAuth redirect did not match this connection.');
    if (callback.searchParams.get('iss') !== `${ISSUER}/`) throw new Error('MemCode OAuth issuer did not match.');
    if (callback.searchParams.has('error')) throw new Error('MemCode sign-in was denied or cancelled.');
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('MemCode OAuth redirect contained no code.');
    const data = await tokenRequest({
      grant_type: 'authorization_code', code, client_id: client.client_id,
      redirect_uri: redirectUri, code_verifier: verifier,
    });
    const bundle = tokenBundle(client.client_id, redirectUri, data);
    const account = await checkedJson(await fetcher(`${ISSUER}/auth/mcp/oauth/userinfo`, {
      method: 'GET', credentials: 'omit', headers: { Authorization: `Bearer ${bundle.accessToken}` },
    }));
    if (!account?.sub || account.resource !== RESOURCE || account.scope !== SCOPES) {
      throw new Error('MemCode did not confirm the expected read-only account.');
    }
    bundle.accountId = String(account.sub).slice(0, 128);
    await write(bundle);
    // A new connection does not silently enable recall or remote writes.
    return status();
  }

  async function disconnect() {
    const connection = await read();
    let revocationFailed = false;
    if (connection?.refreshToken && connection?.clientId) {
      try {
        const response = await fetcher(`${ISSUER}/auth/mcp/oauth/revoke`, {
          method: 'POST', credentials: 'omit',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: connection.refreshToken,
            client_id: connection.clientId, token_type_hint: 'refresh_token' }),
        });
        revocationFailed = !response.ok;
      } catch { revocationFailed = true; }
    }
    await storage.remove(MEMCODE_CONNECTION_KEY);
    await storage.set({ [MEMCODE_RECALL_ENABLED_KEY]: false });
    return { connected: false, recallEnabled: false, revocationFailed };
  }

  async function status() {
    const [connection, setting] = await Promise.all([
      read(), storage.get(MEMCODE_RECALL_ENABLED_KEY),
    ]);
    return { connected: !!connection, accountId: connection?.accountId || null,
      recallEnabled: !!connection && setting[MEMCODE_RECALL_ENABLED_KEY] === true };
  }

  async function accessToken() {
    const connection = await read();
    if (!connection) throw new Error('Connect MemCode in Settings first.');
    if (connection.expiresAt > now() + 60_000) return connection.accessToken;
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const data = await tokenRequest({ grant_type: 'refresh_token',
            refresh_token: connection.refreshToken, client_id: connection.clientId });
          const next = tokenBundle(connection.clientId, connection.redirectUri, data);
          const current = await read();
          if (!current || current.refreshToken !== connection.refreshToken) {
            throw new Error('MemCode connection changed during token refresh.');
          }
          next.accountId = connection.accountId || null;
          await write(next);
          return next.accessToken;
        } catch (error) {
          // Permanent invalid-grant failures need reconnection; temporary
          // network failures keep the refresh credential for a later retry.
          if (/HTTP (400|401)\b/.test(error.message || '')) {
            await storage.remove(MEMCODE_CONNECTION_KEY);
            await storage.set({ [MEMCODE_RECALL_ENABLED_KEY]: false });
          }
          throw error;
        }
      })().finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  async function recall(query) {
    const current = await status();
    if (!current.recallEnabled) return { success: false, error: 'MemCode recall is disabled in Settings.' };
    const text = String(query || '').trim();
    if (!text || text.length > 300) return { success: false, error: 'Recall query must be 1–300 characters.' };
    try {
      const token = await accessToken();
      const response = await checkedJson(await fetcher(ENDPOINT, {
        method: 'POST', credentials: 'omit',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, mode: 'memories', top_k: 5,
          include_original_chunks: false }),
      }));
      if (response?.status === 'error') throw new Error('MemCode recall failed.');
      const results = response?.data?.results;
      if (!Array.isArray(results)) throw new Error('MemCode returned an invalid search response.');
      const snippets = results.slice(0, 5).map(item => ({
        domain: String(item?.domain || 'memory').slice(0, 32),
        content: String(item?.content || '').slice(0, 800),
      }));
      return { success: true, source: 'MemCode', results: snippets };
    } catch (error) {
      return { success: false, error: error.message || 'MemCode recall is unavailable.' };
    }
  }

  return { connect, disconnect, status, recall };
}
