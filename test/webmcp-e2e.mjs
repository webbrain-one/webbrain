#!/usr/bin/env node
/**
 * Real-Chrome WebMCP/CDP smoke test.
 *
 * Starts a loopback fixture server, launches Chrome with WebMCP enabled, and
 * verifies discovery, invocation, errors, UI updates, and unregistration.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'webmcp-page.html');
const FIXTURE_ROUTE = '/test/fixtures/webmcp-page.html';
const FEATURE_FLAGS = 'WebMCPTesting,DevToolsWebMCPSupport';
const EXPECTED_TOOL_NAMES = ['fail_predictably', 'lookup_inventory'];

async function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return '';
}

async function chromeLaunchTarget() {
  if (process.env.WEBMCP_CHROME_PATH) {
    return { executablePath: process.env.WEBMCP_CHROME_PATH };
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  const executablePath = await firstExistingPath(candidates);
  return executablePath ? { executablePath } : { channel: 'chrome' };
}

async function startFixtureServer() {
  const fixtureHtml = await readFile(FIXTURE_PATH);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname === FIXTURE_ROUTE) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(fixtureHtml);
      return;
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'Fixture server did not expose a TCP address.');
  return {
    url: `http://127.0.0.1:${address.port}${FIXTURE_ROUTE}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function waitForEntry(page, entries, predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = entries.find(predicate);
    if (found !== undefined) return found;
    await page.waitForTimeout(25);
  }
  assert.fail(`Timed out waiting for ${label}; received: ${JSON.stringify(entries)}`);
}

async function waitForToolNames(page, entries, expectedNames, label) {
  const expected = new Set(expectedNames);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const received = new Set(entries.map(tool => String(tool?.name || '')));
    if ([...expected].every(name => received.has(name))) return;
    await page.waitForTimeout(25);
  }
  assert.fail(`Timed out waiting for ${label}; received: ${JSON.stringify(entries)}`);
}

async function runSmoke(browser, fixtureUrl) {
  const chromeVersion = browser.version();
  const majorVersion = Number.parseInt(chromeVersion, 10);
  assert.ok(
    Number.isFinite(majorVersion) && majorVersion >= 149,
    `WebMCP smoke test requires Chrome 149 or newer; launched ${chromeVersion || 'an unknown version'}.`,
  );

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.webMCPFixture?.ready === true);
    assert.equal(await page.locator('#status').innerText(), 'ready');

    const cdp = await context.newCDPSession(page);
    const added = [];
    const removed = [];
    const responses = [];
    cdp.on('WebMCP.toolsAdded', event => added.push(...(event.tools || [])));
    cdp.on('WebMCP.toolsRemoved', event => removed.push(...(event.tools || [])));
    cdp.on('WebMCP.toolResponded', event => responses.push(event));

    let webMcpEnabled = false;
    try {
      await cdp.send('WebMCP.enable');
      webMcpEnabled = true;
      await waitForToolNames(page, added, EXPECTED_TOOL_NAMES, 'complete WebMCP tool discovery');

      const inventory = added.find(tool => tool.name === 'lookup_inventory');
      assert.deepEqual(inventory.inputSchema.required, ['sku']);
      assert.ok(inventory.frameId);

      const invocation = await cdp.send('WebMCP.invokeTool', {
        frameId: inventory.frameId,
        toolName: inventory.name,
        input: { sku: 'SKU-42' },
      });
      const completed = await waitForEntry(
        page,
        responses,
        event => event.invocationId === invocation.invocationId,
        'successful tool response',
      );
      assert.equal(completed.status, 'Completed');
      assert.deepEqual(completed.output.structuredContent, { sku: 'SKU-42', available: 7 });
      assert.equal(
        await page.locator('#result').evaluate(element => element.value),
        '{"sku":"SKU-42","available":7}',
      );
      assert.equal(await page.locator('#status').innerText(), 'invoked');

      const failing = added.find(tool => tool.name === 'fail_predictably');
      const failedInvocation = await cdp.send('WebMCP.invokeTool', {
        frameId: failing.frameId,
        toolName: failing.name,
        input: {},
      });
      const failed = await waitForEntry(
        page,
        responses,
        event => event.invocationId === failedInvocation.invocationId,
        'failed tool response',
      );
      assert.equal(failed.status, 'Error');
      const failureText = failed.errorText || failed.exception?.description || '';
      assert.match(failureText, /fixture failure/);
      await waitForEntry(
        page,
        pageErrors,
        error => error.includes('fixture failure'),
        'fixture page error',
      );

      await page.evaluate(() => window.webMCPFixture.unregister());
      // Chrome can emit one toolsRemoved event per registration. Wait for the
      // complete set instead of assuming both tools arrive in the first batch.
      await waitForToolNames(page, removed, EXPECTED_TOOL_NAMES, 'complete WebMCP tool removal');
      const unexpectedPageErrors = pageErrors.filter(error => !error.includes('fixture failure'));
      assert.deepEqual(unexpectedPageErrors, []);

      console.log(
        `PASS: Chrome ${chromeVersion} discovered, invoked, rejected, and removed `
        + `WebMCP tools via CDP (${added.length} added, ${removed.length} removed).`,
      );
    } finally {
      if (webMcpEnabled) await cdp.send('WebMCP.disable').catch(() => {});
    }
  } finally {
    await context.close();
  }
}

async function main() {
  const fixtureServer = await startFixtureServer();
  let browser = null;
  try {
    const launchTarget = await chromeLaunchTarget();
    try {
      browser = await chromium.launch({
        ...launchTarget,
        headless: true,
        args: [`--enable-features=${FEATURE_FLAGS}`],
      });
    } catch (error) {
      throw new Error(
        `Could not launch Google Chrome. Install Chrome 149+ or set WEBMCP_CHROME_PATH. ${error?.message || error}`,
      );
    }
    await runSmoke(browser, fixtureServer.url);
  } finally {
    if (browser) await browser.close();
    await fixtureServer.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
