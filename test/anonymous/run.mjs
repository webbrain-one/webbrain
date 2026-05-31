#!/usr/bin/env node
// Anonymous-site end-to-end scenarios.
//
// Launches Chromium with the WebBrain Chrome extension loaded into a
// persistent profile, opens each scenario's URL, fires a chat message at
// the extension's background service worker, waits for the agent's final
// response, and runs the scenario's `check`.
//
// First run: the browser opens, you configure a provider + API key in the
// extension's Settings page, then close the browser. Subsequent runs re-use
// the same profile (./.test-profile/) so keys stick.
//
// Run: npm run test:anonymous [-- --scenario=wikipedia-alan-turing]

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const extensionPath = path.join(root, 'src', 'chrome');
const profileDir = path.join(__dirname, '.test-profile');
const scenariosPath = path.join(__dirname, 'scenarios.json');

const args = process.argv.slice(2);
const only = args.find(a => a.startsWith('--scenario='))?.split('=')[1];
const setupOnly = args.includes('--setup');
const interactiveSetup = setupOnly || (process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

async function main() {
  const scenarios = JSON.parse(await readFile(scenariosPath, 'utf-8'));
  const picked = only ? scenarios.filter(s => s.name === only) : scenarios;
  if (only && !picked.length) {
    console.error(`no scenario named "${only}"`);
    process.exit(2);
  }

  console.log(`launching chromium with extension at ${extensionPath}`);
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
  } catch (e) {
    console.error('\n  Failed to launch Chromium for anonymous scenarios.');
    console.error(`  Profile: ${profileDir}`);
    console.error('  If a previous run was interrupted, close any Chromium window using this profile and retry.');
    throw e;
  }

  // Grab the extension's service worker — spin-wait up to 10s for MV3 to boot.
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const swUrl = sw.url();
  const extensionId = new URL(swUrl).host;
  console.log(`extension loaded, id=${extensionId}`);

  // Verify an active provider is configured. Providers are persisted as
  // { providers: { id: config, ... }, activeProvider: id } in chrome.storage.local.
  const providerCheck = await sw.evaluate(async () => {
    const { providers, activeProvider } = await chrome.storage.local.get(['providers', 'activeProvider']);
    if (!providers || !activeProvider) return { ok: false, reason: 'no providers saved yet' };
    const cfg = providers[activeProvider];
    if (!cfg) return { ok: false, reason: `activeProvider="${activeProvider}" not in providers map` };
    if (cfg.enabled === false) return { ok: false, reason: `activeProvider="${activeProvider}" is disabled` };
    return { ok: true, activeProvider, label: cfg.label || activeProvider };
  });
  if (!providerCheck.ok) {
    console.log(`\n  No active provider configured (${providerCheck.reason}).`);
    console.log(`  Opening Settings — enable a provider, set it active, then close the browser and re-run.`);
    await context.newPage().then(p => p.goto(`chrome-extension://${extensionId}/src/ui/settings.html`));
    if (interactiveSetup) {
      console.log('  Waiting for the browser to close...');
      await context.waitForEvent('close', { timeout: 0 });
    } else {
      console.log('  Non-interactive run detected; exiting instead of waiting forever.');
      console.log('  Run `npm run test:anonymous -- --setup` from a desktop terminal to configure the test profile.');
      await context.close();
      process.exit(2);
    }
    return;
  }
  console.log(`active provider: ${providerCheck.label} (${providerCheck.activeProvider})`);

  // Open a hidden extension page as a messaging harness. sendMessage from the
  // service worker back to itself doesn't trigger its own onMessage listener,
  // so we dispatch `chat` messages from an extension-page context instead.
  // settings.html is a convenient host: it's part of the build and doesn't
  // auto-fire any agent calls.
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  if (setupOnly) {
    console.log('providers already configured; nothing to do.');
    await context.close();
    return;
  }

  let passed = 0, failed = 0;
  for (const scenario of picked) {
    console.log(`\n▶ ${scenario.name}`);
    const page = await context.newPage();
    try {
      await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Wait for Playwright's tabId to be registered in chrome.tabs.
      const tabId = await sw.evaluate(async (targetUrl) => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find(x => x.url && x.url.includes(new URL(targetUrl).host));
        return t?.id;
      }, scenario.url);
      if (!tabId) throw new Error('could not resolve tabId for navigated page');

      const result = await harness.evaluate(({ tabId, text, mode }) => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { target: 'background', action: 'chat', tabId, text, mode },
            (resp) => resolve(resp),
          );
        });
      }, { tabId, text: scenario.prompt, mode: scenario.mode || 'ask' });

      if (result?.error) throw new Error(`agent error: ${result.error}`);
      const content = String(result?.content || '');
      const ok = runCheck(scenario.check, { content, page });
      if (ok) {
        console.log(`  ✓ pass — "${truncate(content, 120)}"`);
        passed++;
      } else {
        console.log(`  ✗ fail — check did not match. agent said: "${truncate(content, 200)}"`);
        failed++;
      }
    } catch (e) {
      console.log(`  ✗ error — ${e.message}`);
      failed++;
    } finally {
      await page.close();
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed (${picked.length} total)`);
  await context.close();
  process.exit(failed > 0 ? 1 : 0);
}

function runCheck(check, { content }) {
  if (!check) return true;
  if (check.type === 'contains') {
    const hay = (check.field === 'content' ? content : '').toLowerCase();
    const needle = String(check.value || '').toLowerCase();
    if (check.minLength && hay.length < check.minLength) return false;
    if (!needle) return true; // minLength-only check
    return hay.includes(needle);
  }
  if (check.type === 'regex') {
    return new RegExp(check.value, check.flags || '').test(content);
  }
  console.log(`  ! unknown check type: ${check.type}`);
  return false;
}

function truncate(s, n) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

main().catch(e => { console.error(e); process.exit(1); });
