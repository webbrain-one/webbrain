import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { createMemcodeRecall, MEMCODE_CONNECTION_KEY, MEMCODE_RECALL_ENABLED_KEY } from '../src/chrome/src/agent/memcode-recall.js';
import { UNTRUSTED_CONTENT_TOOLS, capabilityFor, Capability, requiredHosts } from '../src/chrome/src/agent/permission-gate.js';
import { getToolsForMode } from '../src/chrome/src/agent/tools.js';

function setup({ tokenScope = 'memory:read', tokenResource = 'https://memory.memcode.in' } = {}) {
  const values = new Map();
  const requests = [];
  const storage = {
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = values.get(key);
      return result;
    },
    async set(data) { for (const [key, value] of Object.entries(data)) values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
  const identity = {
    getRedirectURL: () => 'https://test.chromiumapp.org/memcode',
    async launchWebAuthFlow({ url }) {
      const authorization = new URL(url);
      assert.equal(authorization.searchParams.get('resource'), 'https://memory.memcode.in');
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorization.searchParams.get('scope'), 'memory:read');
      return `https://test.chromiumapp.org/memcode?code=one-use-code&state=${authorization.searchParams.get('state')}&iss=https%3A%2F%2Fmemory.memcode.in%2F`;
    },
  };
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/register')) {
      assert.equal(JSON.parse(options.body).software_id, 'webbrain');
      return Response.json({ client_id: 'test-client' }, { status: 201 });
    }
    if (url.endsWith('/token')) return Response.json({
      access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'Bearer', expires_in: 3600,
      scope: tokenScope, resource: tokenResource,
    });
    if (url.endsWith('/userinfo')) return Response.json({
      sub: 'account-123', scope: 'memory:read', resource: 'https://memory.memcode.in',
    });
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
    if (url.endsWith('/v2/memory/search')) {
      const body = JSON.parse(options.body);
      assert.equal(body.mode, 'memories');
      assert.equal(body.include_original_chunks, false);
      return Response.json({ status: 'success', data: { results: [
        { domain: 'profile', content: 'Remembered: use short answers.' },
      ] } });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { values, requests, storage, identity, fetcher,
    client: createMemcodeRecall({ storage, identity, fetcher, cryptoApi: webcrypto }) };
}

test('MemCode recall is default-off, requires separate read opt-in, and disconnects', async () => {
  const { client, values, requests } = setup();
  assert.deepEqual(await client.status(), { connected: false, accountId: null, recallEnabled: false });
  assert.equal((await client.recall('preferences')).success, false);
  assert.equal(requests.length, 0);
  await client.connect();
  assert.deepEqual(await client.status(), { connected: true, accountId: 'account-123', recallEnabled: false });
  assert.equal((await client.recall('preferences')).success, false);
  assert.equal(requests.length, 3); // DCR, token, userinfo only; no memory fetch.
  values.set(MEMCODE_RECALL_ENABLED_KEY, true);
  const result = await client.recall('preferences');
  assert.equal(result.success, true);
  assert.match(result.results[0].content, /short answers/);
  assert.equal(requests.filter(request => request.url.endsWith('/v2/memory/search')).length, 1);
  assert.ok(requests.every(request => request.options.credentials === 'omit'));
  assert.equal(JSON.stringify(result).includes('private-access'), false);
  await client.disconnect();
  assert.equal(requests.at(-1).url.endsWith('/revoke'), true);
  assert.equal(values.has(MEMCODE_CONNECTION_KEY), false);
  assert.equal((await client.recall('preferences')).success, false);
});

test('MemCode tool is network-gated to the fixed host and its result is untrusted', () => {
  assert.equal(capabilityFor('recall_memcode', { query: 'test' }), Capability.NETWORK);
  assert.deepEqual(requiredHosts(Capability.NETWORK, { query: 'test' }, 'example.com', 'recall_memcode'), ['memory.memcode.in']);
  assert.equal(UNTRUSTED_CONTENT_TOOLS.has('recall_memcode'), true);
  assert.equal(getToolsForMode('ask').some(tool => tool.function.name === 'recall_memcode'), true);
  assert.equal(getToolsForMode('act', { tier: 'compact' }).some(tool => tool.function.name === 'recall_memcode'), false);
});

test('MemCode rejects a token with write scope or the wrong resource', async () => {
  for (const options of [
    { tokenScope: 'memory:read memory:write' },
    { tokenResource: 'https://mcp.memcode.in/mcp' },
  ]) {
    const { client, values, requests } = setup(options);
    await assert.rejects(client.connect(), /read-only token/);
    assert.equal(values.has(MEMCODE_CONNECTION_KEY), false);
    assert.equal(requests.some(request => request.url.endsWith('/v2/memory/search')), false);
  }
});
