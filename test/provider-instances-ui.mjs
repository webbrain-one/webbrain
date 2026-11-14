import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const output = resolve(process.env.PROVIDER_UI_OUTPUT || '.build/provider-instances-ui');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + sep)) throw new Error('outside root');
    res.setHeader('Content-Type', ({
      '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
      '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    })[extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    if (process.env.PROVIDER_UI_BROWSER && process.env.PROVIDER_UI_BROWSER !== build) continue;
    const browser = await engine.launch();
    try {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ build }) => {
          localStorage.setItem('wbLocale', 'en');
          const data = JSON.parse(sessionStorage.getItem('provider-test-store') || '{}');
          window.testStore = data;
          const storage = {
            async get(keys) {
              return keys == null ? { ...data } : Object.fromEntries(
                (Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys))
                  .map(key => [key, data[key]]),
              );
            },
            async set(values) {
              Object.assign(data, structuredClone(values));
              sessionStorage.setItem('provider-test-store', JSON.stringify(data));
            },
            async remove(keys) {
              for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
            },
          };
          let managerPromise;
          const runtime = {
            id: 'provider-ui-test',
            getURL: path => `${location.origin}/src/${build}/${path}`,
            getManifest: () => ({ version: '39.1.3' }),
            getPlatformInfo: async () => ({ os: 'test', arch: 'x64' }),
            onMessage: { addListener() {} },
            sendMessage(msg, callback) {
              managerPromise ||= import(`/src/${build}/src/providers/manager.js`).then(async ({ ProviderManager }) => {
                const manager = new ProviderManager();
                if (!data.providers) {
                  const defaults = manager._defaultConfigs();
                  data.providers = {
                    llamacpp: { ...defaults.llamacpp, configured: true, model: 'qwen' },
                    openai: { ...defaults.openai, configured: true, apiKey: 'synthetic-key' },
                  };
                  data.activeProvider = 'llamacpp';
                }
                await manager.load();
                window.testManager = manager;
                return manager;
              });
              const pending = managerPromise.then(async manager => {
                if (msg.action === 'get_providers') return { providers: manager.getAll(), active: manager.activeProviderId };
                if (msg.action === 'update_provider') {
                  await manager.updateProvider(msg.providerId, msg.config, { markConfigured: msg.markConfigured !== false });
                  return { activeProviderId: manager.activeProviderId };
                }
                if (msg.action === 'duplicate_provider') return manager.duplicateProvider(msg.providerId);
                if (msg.action === 'remove_duplicate_provider') return manager.removeDuplicateProvider(msg.providerId);
                if (msg.action === 'set_active_provider') await manager.setActive(msg.providerId);
                return {};
              }).catch(error => ({ error: error.message }));
              pending.then(result => callback?.(result));
              return pending;
            },
          };
          window.chrome = window.browser = {
            storage: { local: storage, onChanged: { addListener() {} } },
            runtime, commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
          };
        }, { build });
        await page.goto(`${origin}/src/${build}/src/ui/settings.html#llm`);
        const card = id => page.locator(`.provider-card[data-provider-id="${id}"]`);
        const rootCard = card('llamacpp');
        await rootCard.locator('input[data-key="label"]').waitFor();
        const companionCard = card('webbrain_companion');
        await companionCard.locator('.provider-header').click();
        assert.equal(
          await companionCard.locator('input[data-key="baseUrl"]').inputValue(),
          'http://127.0.0.1:8327/v1',
        );
        assert.equal(await companionCard.locator('.btn-load-models').count(), 1);
        // The Companion relays cloud subscriptions, so it runs at Full, and a
        // tier counts only once picked in its menu: saving the card with the
        // menu untouched records no choice (the menu's Mid used to be saved).
        const companionTier = companionCard.locator('select[data-key="promptTier"]');
        assert.equal(await companionTier.inputValue(), 'full');
        await companionCard.locator('.btn-save').click();
        await page.waitForFunction(() => testStore.providers?.webbrain_companion);
        assert.equal(await page.evaluate(() => testStore.providers.webbrain_companion.promptTierChosen), undefined);
        assert.equal(await page.evaluate(() => testManager.providers.get('webbrain_companion').promptTier), 'full');
        await companionCard.locator('details.provider-companion-details > summary').click();
        await companionTier.selectOption('mid');
        // The pick is a draft until Save. Rebuilding the list before then
        // (provider search, opening and closing another card) must keep it,
        // and Save must still record it as chosen: the relay's tier counts
        // only with promptTierChosen, so it used to snap back to Full.
        await page.locator('#input-provider-search').fill('companion');
        await page.locator('#input-provider-search').fill('');
        await card('ollama').locator('.provider-header').click();
        await card('ollama').locator('.provider-header').click();
        assert.equal(await companionTier.inputValue(), 'mid');
        assert.equal(await companionTier.getAttribute('data-tier-chosen'), 'true');
        await companionCard.locator('.btn-save').click();
        await page.waitForFunction(() => testStore.providers.webbrain_companion.promptTierChosen === true);
        assert.equal(await page.evaluate(() => testStore.providers.webbrain_companion.promptTier), 'mid');
        assert.equal(await page.evaluate(() => testManager.providers.get('webbrain_companion').promptTier), 'mid');
        const companionDownloads = await companionCard.locator('.provider-companion-guide a').evaluateAll(
          links => links.map(link => link.href),
        );
        assert.equal(companionDownloads.length, 4);
        assert.ok(companionDownloads.every(href => href.includes('/releases/download/systray-v0.1.2/')));
        await rootCard.locator('input[data-key="label"]').fill('   ');
        await rootCard.locator('.btn-save').click();
        await rootCard.locator('.test-result.fail.show').waitFor();
        assert.equal(await page.evaluate(() => testManager.getAll().llamacpp.label), 'llama.cpp (Local)');
        await rootCard.locator('input[data-key="label"]').fill('strata (flash next)');
        assert.equal(await rootCard.locator('.btn-duplicate').isDisabled(), true);
        await rootCard.locator('.btn-save').click();
        await page.waitForFunction(() => testStore.providers.llamacpp.label === 'strata (flash next)');
        assert.equal(await rootCard.locator('.provider-name').innerText(), 'strata (flash next)');
        assert.equal(await rootCard.locator('.btn-duplicate').isEnabled(), true);

        await card('openai').locator('.provider-header').click();
        await card('openai').locator('input[data-key="apiKey"]').fill('unsaved-draft-key');
        await rootCard.locator('.btn-duplicate').click();
        const first = card('llamacpp__duplicate');
        await first.locator('input[data-key="label"]').waitFor();
        assert.equal(await card('openai').locator('input[data-key="apiKey"]').inputValue(), 'unsaved-draft-key');
        assert.equal(await first.locator('input[data-key="baseUrl"]').inputValue(), '');
        assert.equal(await first.locator('.btn-duplicate').isDisabled(), true);
        const customTitle = '<Personal & local>';
        await first.locator('input[data-key="label"]').fill(customTitle);
        await first.locator('input[data-key="baseUrl"]').fill('http://localhost:8081');
        await first.locator('.btn-save').click();
        await page.waitForFunction(() => testStore.providers.llamacpp__duplicate.configured);
        assert.equal(await first.locator('.provider-name').innerText(), customTitle);
        assert.equal(await first.locator('.provider-name > *').count(), 0, 'titles render as text');
        await page.locator('.provider-filter-pill[data-filter="active"]').click();
        await page.locator('#input-provider-search').fill('personal');
        await first.locator('.btn-duplicate').click();
        await card('llamacpp__duplicate_2').locator('input[data-key="label"]').waitFor();
        assert.equal(await page.locator('#input-provider-search').inputValue(), '');
        assert.equal(await page.locator('.provider-filter-pill.active').getAttribute('data-filter'), 'all');
        await rootCard.locator('.btn-duplicate').click();
        await card('llamacpp__duplicate_3').locator('input[data-key="label"]').waitFor();
        const longTitle = 'W'.repeat(120);
        await card('llamacpp__duplicate_3').locator('input[data-key="label"]').fill(longTitle);
        await card('llamacpp__duplicate_3').locator('.btn-save').click();
        await page.waitForFunction(() => testStore.providers.llamacpp__duplicate_3.label.length === 120);
        await card('llamacpp__duplicate_3').scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(output, `${build}-${width}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'long names must fit the viewport');

        await page.reload();
        await rootCard.locator('input[data-key="label"]').waitFor();
        assert.equal(await rootCard.locator('.provider-name').innerText(), 'strata (flash next)');
        assert.equal(await first.locator('.provider-name').innerText(), customTitle);
        assert.equal(await card('llamacpp__duplicate_2').count(), 1);
        assert.equal(await card('llamacpp__duplicate_3').locator('.provider-name').innerText(), longTitle);
        await first.locator('.provider-header').click();
        await first.locator('.btn-activate').click();
        await page.waitForFunction(() => testStore.activeProvider === 'llamacpp__duplicate');
        page.once('dialog', dialog => dialog.accept());
        await first.locator('.btn-remove-duplicate').click();
        await first.waitFor({ state: 'detached' });
        assert.equal(await card('llamacpp__duplicate_2').count(), 1);
        assert.equal(await card('llamacpp__duplicate_3').count(), 1);
        assert.equal(await page.evaluate(() => testStore.activeProvider), 'llamacpp');
        assert.deepEqual(errors, []);
        console.log(`PASS ${build} ${width}px: rename, duplicate, drafts, reload, selection, removal`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
