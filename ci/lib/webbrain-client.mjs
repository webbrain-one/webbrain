import fs from 'node:fs/promises';
import path from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'aborted', 'needs_user_input']);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WebBrainCloudClient {
  constructor({ apiKey, baseUrl = 'https://webbrain.cloud', fetchImpl = globalThis.fetch }) {
    if (!apiKey) throw new Error('WEBBRAIN_API_KEY is required.');
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async request(method, route, body) {
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    if (!response.ok) {
      const error = new Error(value?.error || `WebBrain Cloud returned HTTP ${response.status}.`);
      error.status = response.status;
      error.body = value;
      throw error;
    }
    return value;
  }

  async createIncognitoBrowser({ name, settings = {} }) {
    const response = await this.request('POST', '/api/browser-sessions', {
      type: 'incognito',
      display_name: name,
      webbrain_config: {
        schema: 'webbrain-config/1',
        settings,
      },
    });
    return response.browser_session;
  }

  async waitForBrowser(sessionId, { timeoutMs = 600_000, intervalMs = 4_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      const response = await this.request('GET', `/api/browser-sessions/${encodeURIComponent(sessionId)}`);
      latest = response.browser_session;
      if (latest.status === 'ready' && latest.runtime_ready !== false) return latest;
      if (['failed', 'ended'].includes(latest.status)) {
        throw new Error(`Browser provisioning ${latest.status}: ${latest.error || 'unknown error'}`);
      }
      await sleep(intervalMs);
    }
    throw new Error(`Browser did not become ready within ${timeoutMs}ms (last status: ${latest?.status || 'unknown'}).`);
  }

  async startRun(sessionId, { task, outputSchema, timeoutMs, capture = 'video' }) {
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs`, {
      task,
      output_schema: outputSchema,
      timeout_ms: timeoutMs,
      capture,
      wait: false,
    });
  }

  async waitForRun(sessionId, runId, { timeoutMs = 900_000, intervalMs = 3_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await this.request(
        'GET',
        `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
      );
      if (TERMINAL.has(latest.status)) return latest;
      await sleep(intervalMs);
    }
    const error = new Error(`Cloud run did not finish within ${timeoutMs}ms.`);
    error.latest = latest;
    throw error;
  }

  async exportTrace(sessionId, runId) {
    return await this.request(
      'GET',
      `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/export`,
    );
  }

  async destroyBrowser(sessionId) {
    return await this.request('DELETE', `/api/browser-sessions/${encodeURIComponent(sessionId)}`);
  }

  async downloadsAccess(sessionId) {
    return await this.request(
      'POST',
      `/api/browser-sessions/${encodeURIComponent(sessionId)}/downloads-access`,
      {},
    );
  }

  async downloadCapture(sessionId, runId, destination, { timeoutMs = 90_000 } = {}) {
    const access = await this.downloadsAccess(sessionId);
    const expected = `webbrain-ci-${runId}.webm`;
    const deadline = Date.now() + timeoutMs;
    const headers = {
      authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString('base64')}`,
    };
    while (Date.now() < deadline) {
      const listingResponse = await this.fetch(access.url, {
        headers: { ...headers, accept: 'application/json' },
      });
      if (listingResponse.ok) {
        const listing = await listingResponse.json();
        const entry = listing.entries?.find((candidate) => candidate.name === expected);
        if (entry) {
          const fileResponse = await this.fetch(new URL(encodeURIComponent(expected), access.url), { headers });
          if (!fileResponse.ok) throw new Error(`Capture download returned HTTP ${fileResponse.status}.`);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, Buffer.from(await fileResponse.arrayBuffer()), { mode: 0o600 });
          return { name: expected, size: Number(entry.size) || 0 };
        }
      }
      await sleep(2_000);
    }
    throw new Error(`Capture ${expected} was not synchronized within ${timeoutMs}ms.`);
  }
}

export class GnippetsE2EClient {
  constructor({ baseUrl, controlToken, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.controlToken = controlToken;
    this.fetch = fetchImpl;
  }

  async request(method, route, body) {
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (compatible; WebBrainCloudE2E/1.0; +https://webbrain.cloud)',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : {}; } catch { value = {}; }
    if (!response.ok) {
      const header = (name) => String(response.headers?.get?.(name) || 'unknown')
        .replace(/\s+/g, ' ')
        .slice(0, 160);
      let preview = text;
      if (this.controlToken) preview = preview.split(this.controlToken).join('[redacted]');
      preview = preview
        .replace(/Bearer\s+[^\s<]+/gi, 'Bearer [redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      const diagnostics = {
        server: header('server'),
        cf_ray: header('cf-ray'),
        cf_mitigated: header('cf-mitigated'),
        content_type: header('content-type'),
        body_preview: preview,
      };
      const summary = Object.entries(diagnostics)
        .filter(([, diagnostic]) => diagnostic && diagnostic !== 'unknown')
        .map(([name, diagnostic]) => `${name}=${diagnostic}`)
        .join('; ');
      const error = new Error(
        value.error || `Gnippets E2E returned HTTP ${response.status}${summary ? ` (${summary})` : ''}.`,
      );
      error.status = response.status;
      error.body = diagnostics;
      throw error;
    }
    return value;
  }

  createRun(scenario) {
    if (!this.controlToken) throw new Error('GNIPPETS_E2E_CONTROL_TOKEN is required for isolated Gnippets scenarios.');
    return this.request('POST', '/api/e2e/v1/runs', { scenario });
  }

  getRun(runId) {
    return this.request('GET', `/api/e2e/v1/runs/${encodeURIComponent(runId)}`);
  }

  deleteRun(runId) {
    return this.request('DELETE', `/api/e2e/v1/runs/${encodeURIComponent(runId)}`);
  }
}
