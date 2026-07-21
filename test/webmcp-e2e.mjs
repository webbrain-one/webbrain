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
const EXTENSION_PATH = path.resolve(__dirname, '..', 'src', 'chrome');
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

async function runProtocolSmoke(context, fixtureUrl) {
  const browser = context.browser();
  assert.ok(browser, 'WebMCP smoke test lost its browser connection.');
  const chromeVersion = browser.version();
  const majorVersion = Number.parseInt(chromeVersion, 10);
  assert.ok(
    Number.isFinite(majorVersion) && majorVersion >= 149,
    `WebMCP smoke test requires Chrome 149 or newer; launched ${chromeVersion || 'an unknown version'}.`,
  );

  const page = await context.newPage();
  try {
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
    await page.close();
  }
}

async function initializeExtensionAgent(harness, tabId) {
  return harness.evaluate(async targetTabId => {
    const { Agent } = await import(chrome.runtime.getURL('src/agent/agent.js'));
    const agent = new Agent({});
    globalThis.__webMCPAgentSmoke = agent;
    const disabledCatalog = await agent.executeTool(targetTabId, 'list_webmcp_tools', {});
    agent.setWebMCPEnabled(true);
    return disabledCatalog;
  }, tabId);
}

async function listToolsThroughExtension(harness, tabId) {
  return harness.evaluate(async targetTabId => {
    return globalThis.__webMCPAgentSmoke.executeTool(
      targetTabId,
      'list_webmcp_tools',
      { page_size: 25 },
    );
  }, tabId);
}

async function prepareToolThroughExtension(harness, tabId, toolId, input) {
  return harness.evaluate(async ({ targetTabId, targetToolId, targetInput }) => {
    return globalThis.__webMCPAgentSmoke._prepareWebMCPToolCall(
      targetTabId,
      'execute_webmcp_tool',
      {
        tool_id: targetToolId,
        input: targetInput,
        // Model-authored private metadata must never survive preparation.
        _webMcpFrameId: 'forged-frame',
        _webMcpTargetUrl: 'https://attacker.invalid/',
        _webMcpDeclaredReadOnly: true,
      },
    );
  }, { targetTabId: tabId, targetToolId: toolId, targetInput: input });
}

async function setExtensionAgentMode(harness, tabId, mode) {
  await harness.evaluate(({ targetTabId, targetMode }) => {
    globalThis.__webMCPAgentSmoke.conversationModes.set(targetTabId, targetMode);
  }, { targetTabId: tabId, targetMode: mode });
}

async function invokePreparedToolThroughExtension(harness, tabId, preparedArgs) {
  return harness.evaluate(async ({ targetTabId, targetArgs }) => {
    return globalThis.__webMCPAgentSmoke.executeTool(
      targetTabId,
      'execute_webmcp_tool',
      targetArgs,
    );
  }, { targetTabId: tabId, targetArgs: preparedArgs });
}

async function waitForExtensionTabId(harness, targetUrl) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tabId = await harness.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(tab => tab.url === url)?.id || null;
    }, targetUrl);
    if (tabId) return tabId;
    await harness.waitForTimeout(25);
  }
  assert.fail(`Timed out resolving the extension tab ID for ${targetUrl}.`);
}

async function waitForExtensionCatalog(harness, tabId, predicate, label) {
  const deadline = Date.now() + 5_000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await listToolsThroughExtension(harness, tabId);
    if (predicate(latest)) return latest;
    await harness.waitForTimeout(25);
  }
  assert.fail(`Timed out waiting for ${label}; latest catalog: ${JSON.stringify(latest)}`);
}

async function runExtensionClientSmoke(context, fixtureUrl) {
  const browser = context.browser();
  assert.ok(browser, 'WebMCP extension smoke test lost its browser connection.');
  const browserCdp = await browser.newBrowserCDPSession();
  let extensionId = '';
  let harness = null;
  let fixture = null;
  let tabId = null;

  try {
    const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: EXTENSION_PATH });
    extensionId = String(loaded.id || '');
    assert.match(extensionId, /^[a-p]{32}$/, 'Chrome did not return a valid unpacked extension ID.');
    const installed = await browserCdp.send('Extensions.getExtensions');
    const webBrain = installed.extensions.find(extension => extension.id === extensionId);
    assert.equal(webBrain?.enabled, true, 'Chrome loaded the WebBrain extension in a disabled state.');
    assert.equal(path.resolve(webBrain.path), EXTENSION_PATH);

    harness = await context.newPage();
    await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
    let worker = context.serviceWorkers().find(candidate => candidate.url().includes(extensionId));
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', {
        predicate: candidate => candidate.url().includes(extensionId),
        timeout: 10_000,
      });
    }
    assert.match(worker.url(), new RegExp(`^chrome-extension://${extensionId}/`));

    fixture = await context.newPage();
    await fixture.goto(fixtureUrl, { waitUntil: 'networkidle' });
    await fixture.waitForFunction(() => window.webMCPFixture?.ready === true);
    tabId = await waitForExtensionTabId(harness, fixtureUrl);

    const disabledCatalog = await initializeExtensionAgent(harness, tabId);
    assert.equal(disabledCatalog.success, false);
    assert.equal(disabledCatalog.noDispatch, true);
    assert.equal(disabledCatalog.featureDisabled, true);

    const catalog = await listToolsThroughExtension(harness, tabId);
    assert.equal(catalog.success, true);
    assert.equal(catalog.total, 2);
    const inventory = catalog.tools.find(tool => tool.name === 'lookup_inventory');
    assert.match(inventory.tool_id, /^wmcp_[a-z0-9]+$/);
    assert.doesNotMatch(inventory.tool_id, /lookup|inventory/);
    assert.deepEqual(inventory.input_schema.required, ['sku']);
    assert.equal(inventory.frame_url, fixtureUrl);

    const askBlocked = await prepareToolThroughExtension(
      harness,
      tabId,
      inventory.tool_id,
      { sku: 'ASK-MUST-NOT-RUN' },
    );
    assert.equal(askBlocked.error?.requiresActMode, true);
    assert.equal(askBlocked.error?.noDispatch, true);
    assert.equal(await fixture.locator('#status').innerText(), 'ready');

    await setExtensionAgentMode(harness, tabId, 'act');
    const preparedInventory = await prepareToolThroughExtension(
      harness,
      tabId,
      inventory.tool_id,
      { sku: 'AGENT-42' },
    );
    assert.equal(preparedInventory.error, undefined);
    assert.notEqual(preparedInventory.args._webMcpFrameId, 'forged-frame');
    assert.equal(preparedInventory.args._webMcpTargetUrl, fixtureUrl);
    assert.equal(preparedInventory.args._webMcpDeclaredReadOnly, false);

    const invoked = await invokePreparedToolThroughExtension(harness, tabId, preparedInventory.args);
    assert.equal(invoked.success, true);
    assert.equal(invoked.dispatched, true);
    assert.deepEqual(invoked.output.structuredContent, { sku: 'AGENT-42', available: 7 });
    assert.equal(await fixture.locator('#status').innerText(), 'invoked');

    const failing = catalog.tools.find(tool => tool.name === 'fail_predictably');
    const preparedFailure = await prepareToolThroughExtension(harness, tabId, failing.tool_id, {});
    assert.equal(preparedFailure.error, undefined);
    const rejected = await invokePreparedToolThroughExtension(harness, tabId, preparedFailure.args);
    assert.equal(rejected.success, false);
    assert.equal(rejected.dispatched, true);
    assert.equal(rejected.outcomeUnknown, true);
    assert.match(rejected.error, /fixture failure/);

    await fixture.evaluate(() => window.webMCPFixture.unregister());
    const emptyCatalog = await waitForExtensionCatalog(
      harness,
      tabId,
      candidate => candidate.total === 0,
      'the extension CDP client to remove every unregistered tool',
    );
    assert.deepEqual(emptyCatalog.tools, []);
    const stalePreparation = await prepareToolThroughExtension(
      harness,
      tabId,
      inventory.tool_id,
      { sku: 'STALE-MUST-NOT-RUN' },
    );
    assert.equal(stalePreparation.error?.staleToolId, true);
    assert.equal(stalePreparation.error?.noDispatch, true);

    console.log(
      `PASS: WebBrain extension ${webBrain.version} enforced feature/mode gates and exercised `
      + 'WebMCP discovery, invocation, failure, and stale IDs through Agent + CDPClient.',
    );
  } finally {
    if (harness && tabId) {
      await harness.evaluate(async targetTabId => {
        const agent = globalThis.__webMCPAgentSmoke;
        if (agent) {
          agent.conversationModes.delete(targetTabId);
          agent.setWebMCPEnabled(false);
          delete globalThis.__webMCPAgentSmoke;
        }
        const { cdpClient } = await import(chrome.runtime.getURL('src/cdp/cdp-client.js'));
        await cdpClient.disableWebMCP(targetTabId);
        await cdpClient.detach(targetTabId);
      }, tabId).catch(() => {});
    }
    if (fixture) await fixture.close().catch(() => {});
    if (harness) await harness.close().catch(() => {});
    if (extensionId) await browserCdp.send('Extensions.uninstall', { id: extensionId }).catch(() => {});
  }
}

async function main() {
  const fixtureServer = await startFixtureServer();
  let context = null;
  try {
    const launchTarget = await chromeLaunchTarget();
    try {
      context = await chromium.launchPersistentContext('', {
        ...launchTarget,
        headless: true,
        // Playwright disables extensions by default. Keep them enabled so the
        // browser-level Extensions.loadUnpacked command can load the real build.
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [
          `--enable-features=${FEATURE_FLAGS}`,
          '--enable-unsafe-extension-debugging',
        ],
      });
    } catch (error) {
      throw new Error(
        `Could not launch Google Chrome. Install Chrome 149+ or set WEBMCP_CHROME_PATH. ${error?.message || error}`,
      );
    }
    await runProtocolSmoke(context, fixtureServer.url);
    await runExtensionClientSmoke(context, fixtureServer.url);
  } finally {
    if (context) await context.close();
    await fixtureServer.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
