// Decision models: Auto (default), On and Off.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const area = { get: async () => ({}), set: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) } };

const cache = await import('../src/chrome/src/providers/webgpu-model-cache.js');
const { WEBGPU_BONSAI2_VL_2B_MODEL_ID, WEBGPU_COMPASS_TINY_V2_MODEL_ID, WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID, WEBGPU_VISION_MODEL_ID } = await import('../src/chrome/src/providers/webgpu.js');
// Compass VLD (v6 2B, or Tiny v5), the in-browser chat model fine-tuned for decisions, and
// Ternary Bonsai 2 2B Vision, a chat model that reads screenshots but whose
// decisions failed validation.
const CHAT_DECISION_MARKER = cache.webgpuTextReadyMarkerUrl(cache.WEBGPU_LOCAL_ASSIST_MODEL_ID);
// Tiny v5 still answers where it is the only Compass VLD downloaded, so readiness
// looks for v6's marker and then v5's (decision-availability.js readyChatDecisionModel).
const V5_DECISION_MARKER = cache.webgpuTextReadyMarkerUrl(WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID);
const BONSAI_MARKER = cache.webgpuTextReadyMarkerUrl(WEBGPU_BONSAI2_VL_2B_MODEL_ID);
const COMPASS = { baseUrl: 'https://api.webbrain.one/v1', apiKey: 'managed' };
const NO_FEATURES = { done: false, watch: false, completion: false, classifications: false, browser: false, semantic: false };
const AUTO_LOCAL = { ...NO_FEATURES, done: true, watch: true, completion: true };

// Cache Storage as the WebGPU worker leaves it after finished downloads.
function withModelCache(downloaded, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const lookups = [];
  globalThis.caches = {
    async match(url, options = {}) {
      lookups.push(url);
      return options.cacheName === 'transformers-cache' && downloaded.includes(url) ? new Response('{}') : undefined;
    },
  };
  return Promise.resolve(fn(lookups)).finally(() => {
    if (saved) Object.defineProperty(globalThis, 'caches', saved); else delete globalThis.caches;
  });
}

// D1 after a finished download: the experimental-model consent, the stored
// Load request and the package's ready marker in its OPFS directory.
async function withD1Download(pin, { consent = true, keepLoaded = true, marker = true } = {}, fn) {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedGet = area.get;
  const reads = [];
  area.get = async keys => {
    const wanted = keys == null ? [] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter(key => key === pin.D1_KEEP_LOADED_KEY && keepLoaded).map(key => [key, true]));
  };
  const directory = { async getFileHandle(name) {
    reads.push(name);
    if (!marker) throw new Error('NotFoundError');
    return { getFile: async () => ({ text: async () => JSON.stringify({ revision: pin.D1_RELEASE.revision, manifestSha256: pin.D1_RELEASE.manifestSha256 }) }) };
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) } } });
  try { return await fn({ reads, consent: consent ? { [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION } : {} }); } finally {
    area.get = savedGet;
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator); else delete globalThis.navigator;
  }
}

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/decision-config.js`);
  const availability = await import(`../src/${build}/src/agent/decision-availability.js`);
  const pin = await import(`../src/${build}/src/providers/d1-config.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  const scheduler = await import(`../src/${build}/src/agent/scheduler.js`);

  test(`${build}: Auto is the default; a saved mode wins and an enabled pre-mode profile reads as On`, () => {
    assert.equal(config.resolveDecisionMode({}), 'auto');
    assert.equal(config.resolveDecisionMode({ systemOneEnabled: false }), 'auto');
    assert.equal(config.resolveDecisionMode({ systemOneEnabled: true }), 'on');
    assert.equal(config.resolveDecisionMode({ systemOneEnabled: true, decisionMode: 'off' }), 'off');
    assert.equal(config.resolveDecisionMode({ systemOneEnabled: false, decisionMode: 'on' }), 'on');
    assert.equal(config.resolveDecisionMode({ decisionMode: '' }), 'auto', 'an unset mode from an import');
    assert.equal(config.resolveDecisionMode({ decisionMode: 'maybe', systemOneEnabled: true }), 'on');
    assert.ok(config.DECISION_SETTINGS_KEYS.includes('decisionMode'));
    for (const key of Object.values(config.DECISION_FEATURE_KEYS)) assert.ok(config.DECISION_SETTINGS_KEYS.includes(key), key);
  });

  test(`${build}: Auto without the in-browser model or Compass answers nothing but keeps the configured fields`, () => {
    const selected = config.resolveDecisionConfig({ decisionProvider: 'typesafe', typesafeApiKey: 'ts-key' });
    assert.equal(selected.mode, 'auto'); assert.equal(selected.source, 'none');
    assert.equal(selected.enabled, false); assert.equal(selected.doneEnabled, false);
    assert.deepEqual(selected.features, NO_FEATURES);
    assert.equal(selected.provider, 'typesafe'); assert.equal(selected.apiKey, 'ts-key');
    for (const feature of config.DECISION_FEATURES) assert.equal(config.decisionFeatureEnabled(selected, feature), false, feature);
  });

  test(`${build}: Auto with Compass and no D1 keeps its managed completion checks and semantic decisions only`, () => {
    const selected = config.resolveDecisionConfig({ systemOneFastBrowser: true, systemOneFastClassifications: true }, COMPASS, { localAssistReady: true });
    assert.equal(selected.provider, 'compass'); assert.equal(selected.source, 'compass'); assert.equal(selected.enabled, true);
    assert.deepEqual(selected.features, { ...NO_FEATURES, done: true, semantic: true });
    assert.equal(config.decisionFeatureEnabled(selected, 'browser'), false, 'stored fast switches need On');
  });

  test(`${build}: Off answers nothing, Compass included, whatever is downloaded`, () => {
    const off = config.resolveDecisionConfig({ decisionMode: 'off', systemOneEnabled: true, decisionProvider: 'local' }, COMPASS, { localAssistReady: true });
    assert.equal(off.enabled, false); assert.equal(off.source, 'off'); assert.notEqual(off.provider, 'compass');
    assert.deepEqual(off.features, NO_FEATURES);
  });

  test(`${build}: On answers every decision unless a switch is off; a pre-mode profile keeps its opt-in switches`, () => {
    const on = config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'local', systemOneFastBrowser: false });
    assert.equal(on.enabled, true); assert.equal(on.source, 'configured');
    assert.deepEqual(on.features, { done: true, watch: true, completion: true, classifications: true, browser: false, semantic: true });
    const legacy = config.resolveDecisionConfig({ systemOneEnabled: true, decisionProvider: 'local', systemOneWatchEnabled: true });
    assert.equal(legacy.mode, 'on');
    assert.deepEqual(legacy.features, { done: true, watch: true, completion: false, classifications: false, browser: false, semantic: true });
    const unconfigured = config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'openrouter' });
    assert.equal(unconfigured.enabled, false, 'a cloud provider still needs its key');
    const d1 = config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'webgpu_d1' });
    assert.equal(d1.enabled, false, 'D1 still needs its consent');
    assert.equal(config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'typesafe', typesafeApiKey: 'k' }, COMPASS).provider, 'compass',
      'On with Compass answers on Compass unless a local provider is chosen');
  });

  test(`${build}: imports carry the mode, reject unknown modes and keep old exports meaning what they meant`, () => {
    const roundTrip = transfer.parseConfigImport(JSON.stringify(transfer.createConfigExport({ decisionMode: 'off' }))).settings;
    assert.equal(roundTrip.decisionMode, 'off');
    assert.throws(() => transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { decisionMode: 'always' } })), /Invalid value/);
    assert.throws(() => transfer.parseConfigPatchImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { decisionMode: 1 } })), /Invalid value/);
    const old = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { systemOneEnabled: true, typesafeApiKey: 'legacy' } })).settings;
    assert.equal(old.decisionMode, '');
    assert.equal(config.resolveDecisionMode(old), 'on');
    assert.equal(config.resolveDecisionMode(transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: {} })).settings), 'auto');
  });

  test(`${build}: explicit On profile preserves implicit feature defaults across export and import`, () => {
    const onSparse = { decisionMode: 'on', decisionProvider: 'local' };
    const runtimeConfig = config.resolveDecisionConfig(onSparse);
    assert.equal(config.decisionFeatureEnabled(runtimeConfig, 'watch'), true);
    assert.equal(config.decisionFeatureEnabled(runtimeConfig, 'completion'), true);
    assert.equal(config.decisionFeatureEnabled(runtimeConfig, 'classifications'), true);
    assert.equal(config.decisionFeatureEnabled(runtimeConfig, 'browser'), true);

    const exported = transfer.createConfigExport(onSparse);
    assert.equal(exported.settings.systemOneWatchEnabled, true);
    assert.equal(exported.settings.systemOneCompletionEnabled, true);
    assert.equal(exported.settings.systemOneFastClassifications, true);
    assert.equal(exported.settings.systemOneFastBrowser, true);

    const imported = transfer.parseConfigImport(JSON.stringify(exported)).settings;
    assert.equal(imported.systemOneWatchEnabled, true);
    assert.equal(imported.systemOneCompletionEnabled, true);
    assert.equal(imported.systemOneFastClassifications, true);
    assert.equal(imported.systemOneFastBrowser, true);
    const importedConfig = config.resolveDecisionConfig(imported);
    assert.equal(config.decisionFeatureEnabled(importedConfig, 'watch'), true);
    assert.equal(config.decisionFeatureEnabled(importedConfig, 'completion'), true);
    assert.equal(config.decisionFeatureEnabled(importedConfig, 'classifications'), true);
    assert.equal(config.decisionFeatureEnabled(importedConfig, 'browser'), true);
  });

  test(`${build}: fresh or Auto profile preserves implicit On defaults across export and import`, () => {
    for (const autoProfile of [{}, { decisionMode: 'auto' }]) {
      const exported = transfer.createConfigExport(autoProfile);
      assert.equal(exported.settings.systemOneWatchEnabled, true);
      assert.equal(exported.settings.systemOneCompletionEnabled, true);
      assert.equal(exported.settings.systemOneFastClassifications, true);
      assert.equal(exported.settings.systemOneFastBrowser, true);

      const imported = transfer.parseConfigImport(JSON.stringify(exported)).settings;
      assert.equal(imported.systemOneWatchEnabled, true);
      assert.equal(imported.systemOneCompletionEnabled, true);
      assert.equal(imported.systemOneFastClassifications, true);
      assert.equal(imported.systemOneFastBrowser, true);

      // When the user later switches to On, all four features are enabled
      const onLater = config.resolveDecisionConfig({ ...imported, decisionMode: 'on', decisionProvider: 'local' });
      assert.equal(config.decisionFeatureEnabled(onLater, 'watch'), true);
      assert.equal(config.decisionFeatureEnabled(onLater, 'completion'), true);
      assert.equal(config.decisionFeatureEnabled(onLater, 'classifications'), true);
      assert.equal(config.decisionFeatureEnabled(onLater, 'browser'), true);
    }

    // But a legacy profile keeps its opt-in switches false
    const legacyExport = transfer.parseConfigImport(JSON.stringify({
      schema: transfer.CONFIG_SCHEMA,
      settings: { systemOneEnabled: true, typesafeApiKey: 'legacy' },
    })).settings;
    const legacyConfig = config.resolveDecisionConfig(legacyExport);
    assert.equal(config.decisionFeatureEnabled(legacyConfig, 'watch'), false);
    assert.equal(config.decisionFeatureEnabled(legacyConfig, 'completion'), false);
    assert.equal(config.decisionFeatureEnabled(legacyConfig, 'classifications'), false);
    assert.equal(config.decisionFeatureEnabled(legacyConfig, 'browser'), false);
  });

  test(`${build}: scheduled checks follow the mode`, async () => {
    let calls = 0;
    const judge = { evaluate: async () => { calls++; return { model: 'judge', answers: { condition_met: { noul: .95 }, task_complete: { noul: .95 }, task_completeness: { score: 2 } } }; } };
    const h = makeSchedulerHarness(scheduler, { systemOneJudge: judge });
    const evidence = { observations: [{ data: 'Status: done' }] };
    const run = (settings, source = 'watch', runMeta = {}) => h.manager._evaluateSystemOne({ source, prompt: 'Watch status', tabId: 77 }, '', 'success', { settings, evidence, ...runMeta });
    assert.equal((await run({ decisionMode: 'off', systemOneEnabled: true, typesafeApiKey: 'k', systemOneWatchEnabled: true })).reason, 'disabled');
    assert.equal((await run({ decisionMode: 'on', decisionProvider: 'typesafe', typesafeApiKey: 'k' })).decision, 'keep', 'On checks a watch with no switch saved');
    assert.equal((await run({ decisionMode: 'on', decisionProvider: 'typesafe', typesafeApiKey: 'k', systemOneCompletionEnabled: false }, 'scheduled')).reason, 'disabled');
    assert.equal((await run({ systemOneEnabled: true, typesafeApiKey: 'k' })).reason, 'disabled', 'a pre-mode profile keeps watches opt-in');
    assert.equal(calls, 1);
    await withModelCache([BONSAI_MARKER], async () => {
      const verdict = await run({});
      assert.equal(verdict.reason, 'disabled', 'a downloaded chat model that is not a decision model must not enable decision checks');
      const compassVerdict = await run({}, 'watch', { compass: COMPASS });
      assert.equal(compassVerdict.reason, 'disabled', 'Auto with Compass leaves watches to the main model');
      const compassProviderVerdict = await run({}, 'watch', { provider: { config: { providerName: 'webbrain-cloud', ...COMPASS } } });
      assert.equal(compassProviderVerdict.reason, 'disabled', 'Auto with active Compass provider leaves watches to the main model');
    });
    assert.equal(calls, 1);
  });

  test(`${build}: the current configuration looks for the in-browser decision model only when Auto could use it`, async () => {
    await withModelCache([CHAT_DECISION_MARKER], async lookups => {
      const auto = await availability.resolveCurrentDecisionConfig({});
      if (build === 'chrome') {
        assert.equal(auto.provider, 'webgpu_chat'); assert.equal(auto.source, 'local_assist'); assert.equal(auto.mode, 'auto');
        assert.equal(auto.model, config.WEBGPU_CHAT_DECISION_MODEL); assert.equal(auto.enabled, true); assert.equal(auto.local, true);
        assert.equal(auto.requiresIndependentSuccessConfirmation, true, 'a positive completion still needs independent proof');
        assert.deepEqual(auto.features, AUTO_LOCAL, 'fast classifications, fast browser actions and semantic decisions stay with On');
        assert.deepEqual(lookups, [CHAT_DECISION_MARKER], 'one ready-marker lookup, without the offscreen document or the GPU');
      } else {
        assert.equal(auto.enabled, false);
        assert.deepEqual(auto.features, NO_FEATURES);
        assert.deepEqual(lookups, [], 'Firefox has no in-browser chat model to look for');
      }
      lookups.length = 0;
      await availability.resolveCurrentDecisionConfig({}, COMPASS, { feature: 'semantic' });
      await availability.resolveCurrentDecisionConfig({ decisionMode: 'off' });
      await availability.resolveCurrentDecisionConfig({ decisionMode: 'on', decisionProvider: 'local' });
      assert.equal(lookups.length, 0, "Compass's own decisions, Off and On never read the cache");
      if (build === 'chrome') {
        const withCompass = await availability.resolveCurrentDecisionConfig({}, COMPASS, { feature: 'watch' });
        assert.equal(withCompass.provider, 'webgpu_chat', 'the downloaded model checks watches while Compass chats too');
      }
    });
    await withModelCache([BONSAI_MARKER], async lookups => {
      const auto = await availability.resolveCurrentDecisionConfig({});
      assert.equal(auto.enabled, false, 'another downloaded chat model never enables decisions');
      assert.deepEqual(auto.features, NO_FEATURES);
      assert.equal(lookups.includes(BONSAI_MARKER), false);
    });
    await withModelCache([], async () => {
      assert.equal((await availability.resolveCurrentDecisionConfig({})).enabled, false);
    });
  });

  // Compass VLD v6 2B is the decision model; Tiny v5 keeps answering where it
  // is the only Compass VLD downloaded, and a task on v5 shares it.
  test(`${build}: decisions go to the newest downloaded Compass VLD`, async () => {
    const V6 = config.WEBGPU_CHAT_DECISION_MODEL;
    if (build === 'firefox') {
      await withModelCache([CHAT_DECISION_MARKER, V5_DECISION_MARKER], async () => {
        // Firefox has no in-browser chat runtime, but the lookups behave the same.
        assert.equal(await availability.readyChatDecisionModel(), V6);
      });
      return;
    }
    await withModelCache([], async () => {
      assert.equal(await availability.readyChatDecisionModel(), null);
      assert.equal(await availability.chatDecisionModelReady(), false);
    });
    await withModelCache([V5_DECISION_MARKER], async () => {
      assert.equal(await availability.readyChatDecisionModel(), WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID);
      assert.equal(await availability.chatDecisionModelReady(), true, 'Tiny v5 alone still answers');
      assert.equal(await availability.chatDecisionModelFree([WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID]), true, 'a task on Tiny v5 shares it');
      assert.equal(await availability.chatDecisionModelFree([V6]), false);
    });
    await withModelCache([CHAT_DECISION_MARKER, V5_DECISION_MARKER], async () => {
      assert.equal(await availability.readyChatDecisionModel(), V6, 'v6 2B wins when both are downloaded');
      assert.equal(await availability.chatDecisionModelFree([WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID]), false, 'asking v6 would unload the task\'s v5');
    });
  });

  // The offscreen WebGPU worker holds one in-browser model at a time: a check
  // on the chat decision model would unload the task's own chat or screenshot
  // model, and its next turn or screenshot would load that again.
  test(`${build}: Auto asks the in-browser chat model only while the task keeps no other in-browser model loaded`, async () => {
    const CHAT = config.WEBGPU_CHAT_DECISION_MODEL;
    assert.equal(await availability.chatDecisionModelFree(), true, 'a task with no in-browser model');
    assert.equal(await availability.chatDecisionModelFree([]), true);
    assert.equal(await availability.chatDecisionModelFree([CHAT]), true, 'a task on the chat decision model itself shares it');
    assert.equal(await availability.chatDecisionModelFree([CHAT, WEBGPU_VISION_MODEL_ID]), false);
    assert.equal(await availability.chatDecisionModelFree(async () => [WEBGPU_COMPASS_TINY_V2_MODEL_ID]), false);
    assert.equal(await availability.chatDecisionModelFree(async () => { throw new Error('unreadable'); }), false,
      'when the task cannot say what it keeps loaded, the chat model is not asked');
    const asked = [];
    const models = list => async () => { asked.push(list); return list; };
    await withModelCache([CHAT_DECISION_MARKER], async () => {
      const busy = await availability.resolveCurrentDecisionConfig({}, null, { feature: 'done', inBrowserModels: models([WEBGPU_COMPASS_TINY_V2_MODEL_ID]) });
      assert.equal(busy.source, 'none', 'with another in-browser model serving the task, the check stays with the main model');
      const shared = await availability.resolveCurrentDecisionConfig({}, COMPASS, { feature: 'watch', inBrowserModels: models([CHAT]) });
      assert.equal(shared.provider, build === 'chrome' ? 'webgpu_chat' : 'compass');
      assert.equal(asked.length, build === 'chrome' ? 2 : 0, 'Firefox never asks');
      asked.length = 0;
      await availability.resolveCurrentDecisionConfig({ decisionMode: 'off' }, null, { inBrowserModels: models([]) });
      await availability.resolveCurrentDecisionConfig({ decisionMode: 'on', decisionProvider: 'local' }, null, { inBrowserModels: models([]) });
      await availability.resolveCurrentDecisionConfig({}, COMPASS, { feature: 'semantic', inBrowserModels: models([]) });
      assert.deepEqual(asked, [], 'only a check Auto could give the chat model reads them');
    });
    await withModelCache([], async () => {
      await availability.resolveCurrentDecisionConfig({}, null, { inBrowserModels: models([]) });
      assert.deepEqual(asked, [], 'nor without its download');
    });
    await withD1Download(pin, {}, async ({ consent }) => {
      await withModelCache([CHAT_DECISION_MARKER], async () => {
        const local = await availability.resolveCurrentDecisionConfig(consent, null, { feature: 'done', inBrowserModels: [WEBGPU_COMPASS_TINY_V2_MODEL_ID] });
        assert.equal(local.provider, 'webgpu_d1', 'D1, in its own worker, takes the checks instead');
      });
    });
  });

  test(`${build}: a task's in-browser models are its WebGPU chat model and the in-browser model reading its screenshots`, async () => {
    const CHAT = config.WEBGPU_CHAT_DECISION_MODEL;
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const routes = [];
    let route = { provider: { model: WEBGPU_VISION_MODEL_ID }, route: 'local_fallback' };
    const agent = new Agent({ getActive: () => ({ config: {} }), resolveVisionRoute: async provider => { routes.push(provider); return route; } });
    const webgpu = (model, supportsVision) => ({ name: 'webgpu', model, supportsVision, config: {} });
    const textOnly = { name: 'deepseek', model: 'deepseek-chat', supportsVision: false, config: {} };
    if (build === 'firefox') {
      assert.deepEqual(await agent._inBrowserModels(webgpu(WEBGPU_COMPASS_TINY_V2_MODEL_ID, false)), [], 'Firefox runs no in-browser models');
      assert.deepEqual(routes, []);
      return;
    }
    assert.deepEqual(await agent._inBrowserModels(null), []);
    assert.deepEqual(await agent._inBrowserModels(webgpu(CHAT, true)), [CHAT]);
    assert.deepEqual(await agent._inBrowserModels({ name: 'anthropic', model: 'claude', supportsVision: true, config: {} }), []);
    assert.deepEqual(routes, [], 'a provider that sees screenshots needs no reader');
    assert.deepEqual(await agent._inBrowserModels(webgpu(WEBGPU_COMPASS_TINY_V2_MODEL_ID, false)), [WEBGPU_COMPASS_TINY_V2_MODEL_ID, WEBGPU_VISION_MODEL_ID]);
    assert.deepEqual(await agent._inBrowserModels(textOnly), [WEBGPU_VISION_MODEL_ID], 'a text-only provider keeps its screenshot reader loaded');
    route = { provider: { model: 'gpt-4o-mini' }, route: 'explicit_override', rawImage: false };
    assert.deepEqual(await agent._inBrowserModels(textOnly), [], 'an external endpoint reads them outside the browser');
    // Auto's completion checks follow them.
    await withModelCache([CHAT_DECISION_MARKER], async () => {
      assert.equal(await agent._jevSettings(1, webgpu(WEBGPU_COMPASS_TINY_V2_MODEL_ID, false), 'done'), null,
        'a check would unload the chat model the task runs on');
      assert.equal((await agent._jevSettings(1, webgpu(CHAT, true), 'done'))?.decisionConfig.provider, 'webgpu_chat');
    });
  });

  test(`${build}: scheduled checks leave the in-browser chat model alone while the task keeps another in-browser model loaded`, async () => {
    const judge = { evaluate: async () => { throw new Error('no decision model is in use'); } };
    const h = makeSchedulerHarness(scheduler, { systemOneJudge: judge });
    const providers = [];
    h.manager.agent._inBrowserModels = async provider => { providers.push(provider); return [WEBGPU_COMPASS_TINY_V2_MODEL_ID]; };
    const provider = { name: 'webgpu', model: WEBGPU_COMPASS_TINY_V2_MODEL_ID, config: {} };
    await withModelCache([CHAT_DECISION_MARKER], async () => {
      const verdict = await h.manager._evaluateSystemOne({ source: 'watch', prompt: 'Watch status', tabId: 77 }, '', 'success',
        { settings: {}, evidence: { observations: [{ data: 'Status: done' }] }, provider });
      assert.equal(verdict.reason, 'disabled');
      assert.deepEqual(providers, build === 'chrome' ? [provider] : []);
    });
  });

  test(`${build}: Auto uses the downloaded chat decision model for its own checks, before D1 and never over a saved choice`, async () => {
    const ready = config.resolveDecisionConfig({ decisionVisionMode: 'off', decisionProvider: 'openrouter', systemOneFastBrowser: true }, null, { chatAssistReady: true });
    if (build === 'firefox') {
      assert.equal(ready.source, 'none', 'Firefox has no in-browser chat model');
      assert.equal(config.decisionNeedsChatAssist({}), false);
      return;
    }
    assert.equal(ready.provider, 'webgpu_chat'); assert.equal(ready.source, 'local_assist');
    assert.equal(ready.supportsVision, true, "another provider's image setting does not blind the model");
    assert.deepEqual(ready.features, AUTO_LOCAL);
    assert.equal(ready.dtype, config.WEBGPU_CHAT_DECISION_DTYPE);
    const both = config.resolveDecisionConfig({ [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION }, null, { chatAssistReady: true, localAssistReady: true });
    assert.equal(both.provider, 'webgpu_chat', 'the chat model answers before D1');
    assert.equal(config.resolveDecisionConfig({ decisionMode: 'off' }, null, { chatAssistReady: true }).enabled, false);
    const on = config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'typesafe', typesafeApiKey: 'ts-key' }, null, { chatAssistReady: true });
    assert.equal(on.provider, 'typesafe'); assert.equal(on.source, 'configured');
    for (const feature of ['done', 'watch', 'completion']) {
      assert.equal(config.decisionNeedsChatAssist({}, COMPASS, feature), true, feature);
      assert.equal(config.resolveDecisionConfig({}, COMPASS, { chatAssistReady: true, feature }).provider, 'webgpu_chat', feature);
    }
    for (const feature of ['semantic', 'classifications', 'browser']) {
      assert.equal(config.decisionNeedsChatAssist({}, COMPASS, feature), false, feature);
      assert.equal(config.resolveDecisionConfig({}, COMPASS, { chatAssistReady: true, feature }).provider, 'compass', feature);
    }
    await withD1Download(pin, {}, async ({ reads, consent }) => {
      await withModelCache([CHAT_DECISION_MARKER], async () => {
        assert.equal((await availability.resolveCurrentDecisionConfig(consent)).provider, 'webgpu_chat');
        assert.deepEqual(reads, [], "D1's marker is read only when the chat model is not downloaded");
      });
    });
  });

  test(`${build}: Auto uses a downloaded D1 for completion and scheduled checks only, Compass included, never over a saved choice`, async () => {
    const consent = { [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION };
    const local = config.resolveDecisionConfig({ ...consent, decisionVisionMode: 'off', decisionProvider: 'openrouter', systemOneFastBrowser: true }, null, { localAssistReady: true });
    assert.equal(local.provider, 'webgpu_d1'); assert.equal(local.source, 'local_assist'); assert.equal(local.mode, 'auto');
    assert.equal(local.model, pin.D1_MODEL_ID); assert.equal(local.enabled, true); assert.equal(local.local, true);
    assert.equal(local.supportsVision, true, "another provider's image setting does not blind D1");
    assert.equal(local.requiresIndependentSuccessConfirmation, true, 'a positive D1 completion still needs independent proof');
    assert.deepEqual(local.features, { ...NO_FEATURES, done: true, watch: true, completion: true },
      'fast classifications, fast browser actions and semantic decisions stay with On');
    assert.equal(local.threshold, .9);
    // The download alone, or consent alone, is not enough; Off and On keep their own answer.
    assert.equal(config.resolveDecisionConfig(consent).source, 'none');
    assert.equal(config.resolveDecisionConfig({}, null, { localAssistReady: true }).source, 'none', 'no consent, no D1');
    assert.equal(config.resolveDecisionConfig({ ...consent, decisionMode: 'off' }, null, { localAssistReady: true }).enabled, false);
    const on = config.resolveDecisionConfig({ ...consent, decisionMode: 'on', decisionProvider: 'typesafe', typesafeApiKey: 'ts-key' }, null, { localAssistReady: true });
    assert.equal(on.provider, 'typesafe'); assert.equal(on.source, 'configured');
    assert.equal(config.decisionNeedsLocalAssist(consent), true);
    for (const [stored, compass] of [[{}, null], [{}, COMPASS], [{ ...consent, decisionMode: 'on' }, null], [{ ...consent, decisionMode: 'off' }, COMPASS], [{ ...consent, systemOneEnabled: true }, null]]) {
      assert.equal(config.decisionNeedsLocalAssist(stored, compass), false, JSON.stringify([stored, compass]));
    }
    // While Compass is the chat provider, a downloaded D1 is Auto's decision
    // model for the checks it answers; Compass's managed model keeps the rest.
    const withCompass = config.resolveDecisionConfig(consent, COMPASS, { localAssistReady: true });
    assert.equal(withCompass.provider, 'webgpu_d1'); assert.equal(withCompass.source, 'local_assist');
    assert.deepEqual(withCompass.features, local.features);
    for (const feature of ['done', 'watch', 'completion']) {
      assert.equal(config.decisionNeedsLocalAssist(consent, COMPASS, feature), true, feature);
      const answered = config.resolveDecisionConfig(consent, COMPASS, { localAssistReady: true, feature });
      assert.equal(answered.provider, 'webgpu_d1', feature);
      assert.equal(config.decisionFeatureEnabled(answered, feature), true, feature);
    }
    for (const feature of ['semantic', 'classifications', 'browser']) {
      assert.equal(config.decisionNeedsLocalAssist(consent, COMPASS, feature), false, feature);
      assert.equal(config.resolveDecisionConfig(consent, COMPASS, { localAssistReady: true, feature }).provider, 'compass', feature);
    }
    assert.equal(config.decisionFeatureEnabled(config.resolveDecisionConfig(consent, COMPASS, { localAssistReady: true, feature: 'semantic' }), 'semantic'), true,
      "semantic decisions stay on Compass's managed model");
    // Without Compass, D1 answers only its own checks whatever is asked.
    assert.equal(config.decisionNeedsLocalAssist(consent, null, 'semantic'), true);
    assert.equal(config.decisionFeatureEnabled(config.resolveDecisionConfig(consent, null, { localAssistReady: true, feature: 'semantic' }), 'semantic'), false);
  });

  test(`${build}: the current configuration reads D1's download only when Auto could use it`, async () => {
    await withD1Download(pin, {}, async ({ reads, consent }) => {
      const auto = await availability.resolveCurrentDecisionConfig(consent);
      assert.equal(auto.provider, 'webgpu_d1'); assert.equal(auto.source, 'local_assist');
      assert.deepEqual(reads, ['ready.json'], 'one marker read, no Worker or GPU');
      reads.length = 0;
      // While Compass is the chat provider, D1 answers Auto's checks too.
      assert.equal((await availability.resolveCurrentDecisionConfig(consent, COMPASS)).provider, 'webgpu_d1');
      assert.equal((await availability.resolveCurrentDecisionConfig(consent, COMPASS, { feature: 'done' })).provider, 'webgpu_d1');
      assert.deepEqual(reads, ['ready.json', 'ready.json']);
      reads.length = 0;
      assert.equal((await availability.resolveCurrentDecisionConfig(consent, COMPASS, { feature: 'semantic' })).provider, 'compass');
      await availability.resolveCurrentDecisionConfig({ ...consent, decisionMode: 'off' });
      await availability.resolveCurrentDecisionConfig({ ...consent, decisionMode: 'on', decisionProvider: 'local' });
      assert.equal((await availability.resolveCurrentDecisionConfig({})).source, 'none');
      assert.deepEqual(reads, [], "Compass's own decisions, Off, On and a profile without consent never look");
    });
    await withD1Download(pin, { keepLoaded: false }, async ({ reads, consent }) => {
      assert.equal((await availability.resolveCurrentDecisionConfig(consent)).source, 'none', 'Unload, Remove and Off end what Auto uses');
      assert.deepEqual(reads, []);
    });
    await withD1Download(pin, { marker: false }, async ({ consent }) => {
      assert.equal((await availability.resolveCurrentDecisionConfig(consent)).source, 'none', 'a download that never finished');
    });
    await withModelCache([BONSAI_MARKER], async lookups => {
      await availability.resolveCurrentDecisionConfig({ [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION });
      assert.deepEqual(lookups, build === 'chrome' ? [CHAT_DECISION_MARKER, V5_DECISION_MARKER] : [], 'only the chat decision models are looked up, never another chat or vision model');
    });
  });

  test(`${build}: scheduled checks use the downloaded chat decision model in Chrome only`, async () => {
    let calls = 0;
    const judge = { evaluate: async args => {
      calls++;
      assert.equal(args.config.provider, 'webgpu_chat');
      assert.equal(args.config.model, config.WEBGPU_CHAT_DECISION_MODEL);
      return { model: args.config.model, answers: { condition_met: { noul: .95 }, task_complete: { noul: .95 }, task_completeness: { score: 2 } } };
    } };
    const h = makeSchedulerHarness(scheduler, { systemOneJudge: judge });
    const evidence = { observations: [{ data: 'Status: done' }] };
    const run = (source, runMeta = {}) => h.manager._evaluateSystemOne({ source, prompt: 'Watch status', tabId: 77 }, '', 'success', { settings: {}, evidence, ...runMeta });
    await withModelCache([CHAT_DECISION_MARKER], async () => {
      if (build === 'chrome') {
        assert.equal((await run('watch')).decision, 'keep', 'Auto checks a watch with the downloaded chat model');
        assert.equal((await run('scheduled')).decision, 'keep');
        assert.equal((await run('watch', { compass: COMPASS })).decision, 'keep', 'it checks watches while Compass chats too');
        assert.equal(calls, 3);
      } else {
        assert.equal((await run('watch')).reason, 'disabled');
        assert.equal(calls, 0);
      }
    });
  });

  test(`${build}: scheduled checks and agent decisions use Auto's D1 for its own checks only`, async () => {
    let calls = 0;
    const judge = { evaluate: async args => { calls++; assert.equal(args.config.provider, 'webgpu_d1'); return { model: pin.D1_MODEL_ID, answers: { condition_met: { noul: .95 }, task_complete: { noul: .95 }, task_completeness: { score: 2 } } }; } };
    const h = makeSchedulerHarness(scheduler, { systemOneJudge: judge });
    const evidence = { observations: [{ data: 'Status: done' }] };
    await withD1Download(pin, {}, async ({ consent }) => {
      const run = (source, runMeta = {}) => h.manager._evaluateSystemOne({ source, prompt: 'Watch status', tabId: 77 }, '', 'success', { settings: consent, evidence, ...runMeta });
      assert.equal((await run('watch')).decision, 'keep', 'Auto checks a watch with the downloaded D1');
      assert.equal((await run('scheduled')).decision, 'keep');
      assert.equal((await run('watch', { compass: COMPASS })).decision, 'keep', 'D1 checks watches while Compass chats too');
      assert.equal((await run('scheduled', { compass: COMPASS })).decision, 'keep');
      assert.equal(calls, 4);
    });
    const saved = globalThis.chrome;
    const store = { [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION };
    try {
      await withD1Download(pin, {}, async () => {
        const download = globalThis.chrome.storage.local.get;
        const local = { get: async keys => ({ ...store, ...await download(keys) }), set: async values => Object.assign(store, values) };
        globalThis.chrome = globalThis.browser = { ...saved, storage: { local, session: local } };
        const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
        const agent = new Agent({ getActive: () => ({ config: {} }) });
        assert.equal((await agent._jevSettings(1, { config: {} }, 'done'))?.decisionConfig.provider, 'webgpu_d1');
        for (const feature of ['semantic', 'classifications', 'browser']) assert.equal(await agent._jevSettings(1, { config: {} }, feature), null, feature);
        const compassProvider = { config: { providerName: 'webbrain-cloud', baseUrl: COMPASS.baseUrl } };
        assert.equal((await agent._jevSettings(1, compassProvider, 'watch'))?.decisionConfig.provider, 'webgpu_d1', 'D1 first, Compass or not');
        assert.equal((await agent._jevSettings(1, compassProvider, 'semantic'))?.decisionConfig.provider, 'compass',
          "Compass's managed model keeps semantic decisions");
        for (const feature of ['classifications', 'browser']) assert.equal(await agent._jevSettings(1, compassProvider, feature), null, feature);
      });
    } finally {
      globalThis.chrome = globalThis.browser = saved;
    }
  });

  test(`${build}: agent decision paths ask for their own decision`, async () => {
    const saved = globalThis.chrome;
    const store = { decisionMode: 'on', decisionProvider: 'local', systemOneFastBrowser: false };
    const local = { get: async () => ({ ...store }), set: async values => Object.assign(store, values) };
    globalThis.chrome = globalThis.browser = { ...saved, storage: { local, session: local } };
    try {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const agent = new Agent({ getActive: () => ({ config: {} }) });
      assert.ok(await agent._jevSettings(1, { config: {} }, 'semantic'));
      assert.ok(await agent._jevSettings(1, { config: {} }, 'classifications'));
      assert.equal(await agent._jevSettings(1, { config: {} }, 'browser'), null, 'a switched-off decision');
      store.decisionMode = 'auto';
      await withModelCache([CHAT_DECISION_MARKER, BONSAI_MARKER], async () => {
        assert.equal(await agent._jevSettings(1, { config: {} }, 'semantic'), null, 'Auto leaves semantic decisions to the main model');
        assert.equal(await agent._jevSettings(1, { config: {} }, 'classifications'), null);
        assert.equal((await agent._jevSettings(1, { config: {} }, 'done'))?.decisionConfig.provider, build === 'chrome' ? 'webgpu_chat' : undefined,
          'the downloaded chat decision model answers completion checks in Chrome');
      });
      store.decisionMode = 'off';
      assert.equal(await agent._jevSettings(1, { config: { providerName: 'webbrain-cloud', baseUrl: COMPASS.baseUrl } }, 'semantic'), null, 'Off turns Compass off too');
    } finally {
      globalThis.chrome = globalThis.browser = saved;
    }
  });
}

test('Firefox imports a Chrome On selection of the Chrome-only chat model in Auto', async () => {
  const transfer = await import('../src/firefox/src/config-transfer.js');
  const chromeExport = { schema: transfer.CONFIG_SCHEMA, settings: { decisionMode: 'on', decisionProvider: 'webgpu_chat', systemOneEnabled: true } };
  const restored = transfer.parseConfigImport(JSON.stringify(chromeExport)).settings;
  assert.equal(restored.decisionMode, 'auto'); assert.equal(restored.systemOneEnabled, false); assert.equal(restored.decisionProvider, '');
  const patch = transfer.parseConfigPatchImport(JSON.stringify(chromeExport)).settings;
  assert.equal(patch.decisionMode, 'auto');
  const off = transfer.parseConfigImport(JSON.stringify({ ...chromeExport, settings: { ...chromeExport.settings, decisionMode: 'off' } })).settings;
  assert.equal(off.decisionMode, 'off', 'an explicit Off stays off');
});

test('a provider-only Chrome patch leaves the Firefox mode alone', async () => {
  const transfer = await import('../src/firefox/src/config-transfer.js');
  const sparse = (settings) => transfer.parseConfigPatchImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings })).settings;
  const providerOnly = sparse({ decisionProvider: 'webgpu_chat' });
  assert.deepEqual(providerOnly, {}, 'the unusable provider is dropped and nothing else is invented');
  // Merged over an existing On or Off profile, nothing about the mode changes.
  for (const mode of ['on', 'off']) {
    const stored = { decisionMode: mode, systemOneEnabled: mode === 'on', decisionProvider: 'openrouter' };
    assert.deepEqual({ ...stored, ...transfer.mergeConfigPatchSettings(stored, providerOnly) }, stored, `${mode} profile unchanged`);
  }
  // A patch that names the mode still downgrades On, and keeps an explicit Off.
  const named = sparse({ decisionProvider: 'webgpu_chat', decisionMode: 'on', systemOneEnabled: true });
  assert.equal(named.decisionMode, 'auto'); assert.equal(named.systemOneEnabled, false);
  assert.equal(sparse({ decisionProvider: 'webgpu_chat', decisionMode: 'off' }).decisionMode, 'off');
  assert.equal(Object.hasOwn(sparse({ decisionProvider: 'webgpu_chat', decisionMode: 'off' }), 'systemOneEnabled'), false);
});

for (const build of ['chrome', 'firefox']) {
  test(`${build}: leaving a pre-mode On profile writes its switches down before the explicit mode`, async () => {
    const config = await import(`../src/${build}/src/agent/decision-config.js`);
    const legacy = { systemOneEnabled: true, decisionApiKey: 'sk-or-v1-test', systemOneWatchEnabled: true };
    const before = config.resolveDecisionConfig(legacy).features;
    assert.equal(before.watch, true); assert.equal(before.completion, false); assert.equal(before.browser, false);
    const written = config.materializeLegacyDecisionFeatures(legacy);
    assert.deepEqual(Object.keys(written).sort(), ['systemOneDoneEnabled', 'systemOneCompletionEnabled', 'systemOneFastBrowser', 'systemOneFastClassifications'].sort(), 'only the missing switches are written');
    for (const [feature, key] of Object.entries(config.DECISION_FEATURE_KEYS)) {
      if (key in written) assert.equal(written[key], before[feature], `${feature} is stored as it was resolved`);
    }
    // Auto, Off, then back to On: the switches stay as they were shown.
    let stored = { ...legacy, ...written, decisionMode: 'auto', systemOneEnabled: false };
    stored = { ...stored, decisionMode: 'on', systemOneEnabled: true };
    const after = config.resolveDecisionConfig(stored).features;
    for (const feature of ['done', 'watch', 'completion', 'classifications', 'browser']) assert.equal(after[feature], before[feature], `${feature} unchanged`);
    // Without the materialization the modern reading would have enabled them.
    const naive = config.resolveDecisionConfig({ ...legacy, decisionMode: 'on', systemOneEnabled: true }).features;
    assert.equal(naive.completion, true);
    // Nothing to write for a profile that already has a mode, or was not On.
    assert.deepEqual(config.materializeLegacyDecisionFeatures({ decisionMode: 'auto', systemOneEnabled: false }), {});
    assert.deepEqual(config.materializeLegacyDecisionFeatures({ systemOneEnabled: false }), {});
    assert.deepEqual(config.materializeLegacyDecisionFeatures({ decisionMode: 'on', systemOneEnabled: true }), {});
    assert.deepEqual(config.materializeLegacyDecisionFeatures(null), {});
  });

  test(`${build}: the Settings mode switch stores the legacy switches together with the mode`, async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL(`../src/${build}/src/ui/settings.js`, import.meta.url), 'utf8');
    const api = build === 'chrome' ? 'chrome' : 'browser';
    assert.match(source, new RegExp(`materializeLegacyDecisionFeatures\\(await ${api}\\.storage\\.local\\.get\\(DECISION_SETTINGS_KEYS\\)\\);\\s*await ${api}\\.storage\\.local\\.set\\(\\{ \\.\\.\\.legacyFeatures, \\[DECISION_MODE_KEY\\]: mode, systemOneEnabled: mode === 'on' \\}\\)`));
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: exporting an Off profile keeps the latent On defaults`, async () => {
    const transfer = await import(`../src/${build}/src/config-transfer.js`);
    const config = await import(`../src/${build}/src/agent/decision-config.js`);
    const keys = Object.values(config.DECISION_FEATURE_KEYS);
    const roundTrip = (stored) => transfer.parseConfigImport(JSON.stringify(transfer.createConfigExport(stored))).settings;
    for (const stored of [{ decisionMode: 'off' }, { decisionMode: 'auto' }, { decisionMode: 'on' }, { systemOneEnabled: false }, {}]) {
      const restored = roundTrip(stored);
      for (const key of keys) assert.equal(restored[key], true, `${JSON.stringify(stored)}: ${key} stays on by default`);
      const features = config.resolveDecisionConfig({ ...restored, decisionMode: 'on', systemOneEnabled: true }).features;
      for (const feature of ['watch', 'completion', 'classifications', 'browser']) assert.equal(features[feature], true);
    }
    // Explicit values are never overwritten, and a pre-mode On profile keeps its old (off) reading.
    assert.equal(roundTrip({ decisionMode: 'off', systemOneWatchEnabled: false }).systemOneWatchEnabled, false);
    const legacyOn = roundTrip({ systemOneEnabled: true });
    for (const key of keys.filter((k) => k !== 'systemOneDoneEnabled')) assert.equal(legacyOn[key], false, `pre-mode On: ${key} stays off`);
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: a pre-mode On profile exports its resolved completion default`, async () => {
    const transfer = await import(`../src/${build}/src/config-transfer.js`);
    const config = await import(`../src/${build}/src/agent/decision-config.js`);
    const roundTrip = (stored) => transfer.parseConfigImport(JSON.stringify(transfer.createConfigExport(stored))).settings;
    for (const stored of [
      { systemOneEnabled: true, decisionProvider: 'webgpu_chat' },
      { systemOneEnabled: true, decisionProvider: 'webgpu_d1' },
      { systemOneEnabled: true, decisionApiKey: 'sk-or-v1-test' },
    ]) {
      const before = config.resolveDecisionConfig(stored).features;
      const restored = roundTrip(stored);
      if (restored.decisionProvider !== stored.decisionProvider) continue; // Firefox drops the Chrome-only provider and goes Auto
      const after = config.resolveDecisionConfig(restored).features;
      for (const feature of ['done', 'watch', 'completion', 'classifications', 'browser']) {
        assert.equal(after[feature], before[feature], `${JSON.stringify(stored)}: ${feature} survives the round trip`);
      }
    }
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: a cached decision-model answer is not reused after the mode or model changes`, async () => {
    const saved = globalThis.chrome;
    const store = { decisionMode: 'on', decisionProvider: 'local', decisionModel: 'kev-latest', decisionBaseUrl: 'http://127.0.0.1:8009' };
    const local = { get: async () => ({ ...store }), set: async values => Object.assign(store, values) };
    globalThis.chrome = globalThis.browser = { ...saved, storage: { local, session: local } };
    try {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const { SEMANTIC_QUESTIONS } = await import(`../src/${build}/src/agent/semantic-decisions.js`);
      const kind = Object.keys(SEMANTIC_QUESTIONS)[0];
      const choice = SEMANTIC_QUESTIONS[kind].authorizing?.[0] || Object.keys(SEMANTIC_QUESTIONS[kind].choices || {})[0] || 'yes';
      const agent = new Agent({ getActive: () => ({ config: {} }) });
      const provider = { config: {} }; // no chat model: whatever is not cached is "unavailable"
      agent._sha256TextSync = () => 'fixed';
      agent._semanticDecisionCache = new Map();
      const ask = () => agent._semanticDecision(1, kind, { request: 'q', page: {} }, { provider });
      const seed = async (answeredBy) => agent._semanticDecisionCache.set('fixed', {
        choice, evidence: '', answeredBy,
        decisionKey: answeredBy === 'decision_model' ? agent._semanticDecisionKey(await agent._jevSettings(1, provider)) : '',
      });
      await seed('decision_model');
      assert.equal((await ask()).source, 'cache', 'still On with the same model');
      store.decisionMode = 'off';
      assert.equal((await ask()).source, 'unavailable', 'Off does not continue on the earlier model\'s answer');
      store.decisionMode = 'on';
      assert.equal((await ask()).source, 'cache', 'back On with the same model');
      store.decisionModel = 'another-model';
      assert.equal((await ask()).source, 'unavailable', 'another decision model asks again');
      store.decisionModel = 'kev-latest';
      // An answer the main model gave does not depend on the decision model.
      await seed('main_model');
      store.decisionMode = 'off';
      assert.equal((await ask()).source, 'cache', 'a main-model answer survives Off');
      // The batch form follows the same rule.
      store.decisionMode = 'on';
      await seed('decision_model');
      agent._sha256TextSync = () => 'fixed';
      const batch = () => agent._semanticDecisions(1, kind, { request: 'q', items: [{ a: 1 }] }, { provider });
      assert.equal((await batch())[0].source, 'cache');
      store.decisionMode = 'off';
      assert.notEqual((await batch())[0].source, 'cache');
    } finally {
      globalThis.chrome = globalThis.browser = saved;
    }
  });
}
