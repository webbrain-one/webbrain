import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

// ── 1. Unit tests: selectPreferredCompanionModel & ProviderManager defaults ──

for (const build of ['chrome', 'firefox']) {
  const prefix = join(ROOT, 'src', build, 'src');
  const { ProviderManager } = await import(pathToFileURL(join(prefix, 'providers', 'manager.js')).href);
  const { selectPreferredCompanionModel, COMPANION_PREFERRED_MODEL_PATTERNS } = await import(
    pathToFileURL(join(prefix, 'providers', 'companion-config.js')).href
  );

  test(`${build}: selectPreferredCompanionModel preference ranking`, () => {
    assert.equal(typeof selectPreferredCompanionModel, 'function');
    assert.equal(COMPANION_PREFERRED_MODEL_PATTERNS.length, 3);

    // haiku-5.5 ranks first even if later in the list
    assert.equal(
      selectPreferredCompanionModel(['gemini-3.8-flash', 'gpt-6.1-luna', 'claude-haiku-5-5']),
      'claude-haiku-5-5',
    );
    assert.equal(
      selectPreferredCompanionModel(['haiku-5.5', 'luna-6.1']),
      'haiku-5.5',
    );
    assert.equal(
      selectPreferredCompanionModel(['gemini-3.8-flash', 'claude-5.5-haiku']),
      'claude-5.5-haiku',
    );

    // luna-6.1 ranks second
    assert.equal(
      selectPreferredCompanionModel(['other-model', 'gemini-3.8-flash', 'gpt-6.1-luna-pro']),
      'gpt-6.1-luna-pro',
    );
    assert.equal(
      selectPreferredCompanionModel(['luna-6.1', 'gemini-3.8-flash']),
      'luna-6.1',
    );

    // gemini-3.8-flash ranks third
    assert.equal(
      selectPreferredCompanionModel(['unsloth-qwen', 'gemini-3.8-flash', 'llama-3']),
      'gemini-3.8-flash',
    );

    // Fallback to first model when no preference matches
    assert.equal(
      selectPreferredCompanionModel(['bonsai-2-27b', 'unsloth-qwen']),
      'bonsai-2-27b',
    );

    // Empty array returns empty string
    assert.equal(selectPreferredCompanionModel([]), '');
  });

  test(`${build}: webbrain_companion default config & visionMode handling`, async () => {
    const manager = new ProviderManager();
    manager.save = async () => {};
    const defaults = manager._defaultConfigs().webbrain_companion;
    assert.equal(defaults.baseUrl, 'http://127.0.0.1:8327/v1');
    assert.equal(defaults.visionMode, 'auto', 'visionMode must default to auto');
    assert.equal(defaults.supportsVision, undefined, 'legacy supportsVision must not be preset to false');

    // Create provider with default config
    const provider = manager._createProvider('webbrain_companion', defaults);
    assert.equal(provider.config.visionMode, 'auto');
    assert.equal(provider.config.supportsVision, undefined);

    // Verify vision sniffing works when visionMode is auto
    const claudeVision = manager._createProvider('webbrain_companion', {
      ...defaults,
      model: 'claude-haiku-5-5',
    });
    assert.equal(claudeVision.supportsVision, true, 'Haiku 5.5 should sniff as vision-capable');

    const textOnly = manager._createProvider('webbrain_companion', {
      ...defaults,
      model: 'deepseek-chat',
    });
    assert.equal(textOnly.supportsVision, false, 'text-only model should not sniff vision');

    // updateProvider migrating legacy supportsVision
    manager.providers.set('webbrain_companion', provider);
    await manager.updateProvider('webbrain_companion', { supportsVision: true });
    assert.equal(manager.providers.get('webbrain_companion').config.visionMode, 'on');

    await manager.updateProvider('webbrain_companion', { visionMode: 'off' });
    assert.equal(manager.providers.get('webbrain_companion').config.visionMode, 'off');
  });
}

// ── 2. UI tests: Card layout, Details section, & Auto-selection when collapsed ──

const server = createServer(async (req, res) => {
  try {
    const file = resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(ROOT + sep)) throw Error();
    res.setHeader('Content-Type', ({
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.html': 'text/html',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    })[extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: Companion provider card layout and auto-selection when collapsed`, async (t) => {
    let browser;
    try {
      browser = await engine.launch();
    } catch (e) {
      t.skip(`${build} browser unavailable: ${e.message.split('\n')[0]}`);
      return;
    }

    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));

      await page.addInitScript(({ build }) => {
        localStorage.setItem('wbLocale', 'en');
        const data = {
          wbLocale: 'en',
          providers: {
            webbrain_cloud: { type: 'cloud', category: 'cloud', label: 'WebBrain Compass', configured: true },
            webbrain_companion: {
              type: 'openai',
              category: 'local',
              label: 'Your Existing Subscription',
              providerName: 'webbrain-companion',
              baseUrl: 'http://127.0.0.1:8327/v1',
              model: '',
              visionMode: 'auto',
              configured: false,
            },
          },
          activeProvider: 'webbrain_cloud',
        };
        window.testStore = data;
        window.companionMockModels = ['gemini-3.8-flash', 'claude-haiku-5-5'];

        const storage = {
          async get(keys) {
            return keys == null ? { ...data } : Object.fromEntries(
              (Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys))
                .map(k => [k, data[k]]),
            );
          },
          async set(values) { Object.assign(data, values); },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
          },
        };

        window.chrome = window.browser = {
          storage: { local: storage, onChanged: { addListener() {} } },
          runtime: {
            getURL: path => `${location.origin}/src/${build}/${path}`,
            getManifest: () => ({ version: '44.0.2' }),
            onMessage: { addListener() {} },
            sendMessage(msg, callback) {
              if (msg.action === 'get_providers') {
                const res = { providers: data.providers, active: data.activeProvider };
                callback?.(res);
                return Promise.resolve(res);
              }
              if (msg.action === 'list_provider_models' && msg.providerId === 'webbrain_companion') {
                const res = { ok: true, models: window.companionMockModels, baseUrl: 'http://127.0.0.1:8327/v1' };
                callback?.(res);
                return Promise.resolve(res);
              }
              if (msg.action === 'update_provider') {
                Object.assign(data.providers[msg.providerId], msg.config);
                if (msg.markConfigured) data.providers[msg.providerId].configured = true;
                const res = { ok: true, activeProviderId: data.activeProvider };
                callback?.(res);
                return Promise.resolve(res);
              }
              const res = { ok: true };
              callback?.(res);
              return Promise.resolve(res);
            },
          },
          commands: { getAll: async () => [] },
          tabs: { create: async () => ({}) },
        };
      }, { build });

      await page.goto(`${origin}/src/${build}/src/ui/settings.html#llm`);

      const card = page.locator('.provider-card[data-provider-id="webbrain_companion"]');
      await card.waitFor();

      // 1. Verify card started collapsed
      assert.ok(await card.evaluate(el => el.classList.contains('collapsed')), 'card must start collapsed');

      // 2. Verify auto-selection when collapsed:
      // It probes Companion models, picks preferred 'claude-haiku-5-5' (over 'gemini-3.8-flash'),
      // marks card configured, and renders the model badge and active badge in header.
      await page.waitForFunction(() => {
        const c = document.querySelector('.provider-card[data-provider-id="webbrain_companion"]');
        return c?.classList.contains('configured') && c?.querySelector('.provider-model')?.textContent === 'claude-haiku-5-5';
      }, null, { timeout: 5000 });

      assert.equal(
        await card.locator('.provider-model').textContent(),
        'claude-haiku-5-5',
        'header must display auto-selected model',
      );
      assert.equal(
        await card.locator('.provider-status-badge.active').textContent(),
        'ACTIVE',
        'header must show Active status badge',
      );

      // 3. Expand the card and verify layout
      await card.locator('.provider-header').click();
      assert.ok(await card.evaluate(el => el.classList.contains('expanded')), 'card should expand on header click');

      // Top level fields: Title, Model, Share queries
      const topInputs = await card.locator('> .provider-body > .field input, > .provider-body > .field select').evaluateAll(
        els => els.map(el => el.dataset.key),
      );
      assert.ok(topInputs.includes('label'), 'title input must be at top level');
      assert.ok(topInputs.includes('model'), 'model input must be at top level');
      assert.ok(topInputs.includes('shareQueriesForResearch'), 'shareQueries checkbox must be at top level');
      assert.ok(!topInputs.includes('baseUrl'), 'baseUrl must NOT be at top level');
      assert.ok(!topInputs.includes('contextWindow'), 'contextWindow must NOT be at top level');
      assert.ok(!topInputs.includes('visionMode'), 'visionMode must NOT be at top level');

      // Model input must contain the auto-selected model
      assert.equal(
        await card.locator('input[data-key="model"]').inputValue(),
        'claude-haiku-5-5',
      );

      // Details section
      const details = card.locator('details.provider-companion-details');
      assert.equal(await details.count(), 1, 'Details collapsible must exist');
      assert.equal(
        await details.locator('> summary .provider-compatibility-title').textContent(),
        'Details',
        'Details summary title must be "Details"',
      );

      // Inside Details: baseUrl, apiKey, contextWindow, visionMode, promptTier, maxOutputTokens, compatibilitySettings
      const detailKeys = await details.locator('.provider-compatibility-body [data-key]').evaluateAll(
        els => els.map(el => el.dataset.key),
      );
      assert.ok(detailKeys.includes('baseUrl'), 'baseUrl inside Details');
      assert.ok(detailKeys.includes('apiKey'), 'apiKey inside Details');
      assert.ok(detailKeys.includes('contextWindow'), 'contextWindow inside Details');
      assert.ok(detailKeys.includes('visionMode'), 'visionMode inside Details');
      assert.ok(detailKeys.includes('promptTier'), 'promptTier inside Details');
      assert.ok(detailKeys.includes('maxOutputTokens'), 'maxOutputTokens inside Details');

      // visionMode must be a selectbox with 'auto' preselected, with options auto, on, off
      const visionSelect = details.locator('select[data-key="visionMode"]');
      assert.equal(await visionSelect.count(), 1, 'visionMode select must exist');
      assert.equal(await visionSelect.inputValue(), 'auto', 'visionMode must default to auto');
      const visionOptions = await visionSelect.locator('option').evaluateAll(opts => opts.map(o => o.value));
      assert.deepEqual(visionOptions, ['auto', 'on', 'off'], 'visionMode options must be auto, on, off');

      // Compatibility settings details must be present inside companion Details
      assert.equal(
        await details.locator('.provider-compatibility[data-provider-id="webbrain_companion"]').count(),
        1,
        'Compatibility settings must be nested inside Details',
      );

      // 4. Test re-collapsing with updated available models (e.g. proxy rotated models)
      await page.evaluate(() => {
        window.companionMockModels = ['gpt-6.1-luna', 'gemini-3.8-flash'];
        // Clear current model to trigger auto-reselection
        window.testStore.providers.webbrain_companion.model = '';
      });
      await card.locator('.provider-header').click();
      assert.ok(await card.evaluate(el => el.classList.contains('collapsed')), 'card should re-collapse on header click');

      // Auto-selection runs and selects luna-6.1
      await page.waitForFunction(() => {
        const c = document.querySelector('.provider-card[data-provider-id="webbrain_companion"]');
        return c?.querySelector('.provider-model')?.textContent === 'gpt-6.1-luna';
      }, null, { timeout: 5000 });

      assert.equal(
        await card.locator('.provider-model').textContent(),
        'gpt-6.1-luna',
        'header must display updated auto-selected model',
      );

      assert.deepEqual(errors, [], 'no uncaught page errors');
    } finally {
      await browser.close();
    }
  });
}

test.after(() => {
  server.close();
});
