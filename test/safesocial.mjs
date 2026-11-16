import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/safesocial/config.js`);
  const configTransfer = await import(`../src/${build}/src/config-transfer.js`);
  const { installSafeSocialBackground } = await import(`../src/${build}/src/safesocial/background.js`);
  const { createSafeSocialHost } = await import(`../src/${build}/src/safesocial/host.js`);
  test(`${build}: opt-in defaults, score selection, strict URL boundaries and training preprocessing`, () => {
    const defaults = config.normalizeSettings();
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.threshold, .95);
    assert.deepEqual(config.matchingLabels({ luxury_status: .96, social_fomo: .99, none: 1 }, defaults), ['luxury_status']);
    assert.deepEqual(config.matchingLabels({ luxury_status: NaN, travel_lifestyle: 4 }, defaults), []);
    assert.equal(config.normalizeSettings({ enabled: 'true', threshold: NaN, action: 'script' }).enabled, false);
    assert.equal(config.normalizeSettings({ threshold: NaN }).threshold, .95);
    assert.equal(config.isInstagramUrl('https://www.instagram.com/p/1'), true);
    assert.equal(config.isMediaUrl('https://scontent.cdninstagram.com/image.jpg'), true);
    for (const url of ['http://cdninstagram.com/x', 'https://cdninstagram.com.evil.test/x', 'https://localhost/x',
      'https://a:secret@cdninstagram.com/x', 'https://cdninstagram.com:8443/x', 'data:image/png,abc']) {
      assert.equal(config.isMediaUrl(url), false, url);
    }
    assert.equal(config.isInstagramUrl('https://instagram.com.evil.test/'), false);
    assert.deepEqual(config.centerCrop(512, 256, { image_size: 224, resize: 256 }), { x: 144, y: 16, size: 224 });
    const pixels = config.normalizedPixels([255, 0, 128, 255], { image_size: 1, mean: [0, .5, 0], std: [1, .5, 1] });
    assert.equal(pixels[0], 1); assert.equal(pixels[1], -1); assert.ok(Math.abs(pixels[2] - 128 / 255) < 1e-7);
  });
  test(`${build}: configuration transfer preserves normalized SafeSocial settings`, () => {
    const exported = configTransfer.createConfigExport({
      [config.SETTINGS_KEY]: {
        enabled: true,
        action: 'hide',
        threshold: 2,
        labels: { social_fomo: true, luxury_status: false },
      },
    });
    assert.deepEqual(exported.settings[config.SETTINGS_KEY], config.normalizeSettings({
      enabled: true,
      action: 'hide',
      threshold: 2,
      labels: { social_fomo: true, luxury_status: false },
    }));
    const restored = configTransfer.parseConfigImport(JSON.stringify(exported));
    assert.deepEqual(restored.settings[config.SETTINGS_KEY], exported.settings[config.SETTINGS_KEY]);
    const patch = configTransfer.parseConfigPatchImport(JSON.stringify({
      ...exported,
      settings: { [config.SETTINGS_KEY]: { enabled: true, threshold: 0 } },
    }));
    assert.deepEqual(patch.settings[config.SETTINGS_KEY], config.normalizeSettings({ enabled: true, threshold: 0 }));
    assert.throws(() => configTransfer.parseConfigImport(JSON.stringify({
      ...exported,
      settings: { [config.SETTINGS_KEY]: true },
    })), /safeSocialSettings/);
  });
  function harness() {
    let settings = config.normalizeSettings();
    let onChange;
    const calls = [];
    const api = {
      runtime: { id: 'wb', getURL: p => `chrome-extension://wb/${p}`, onMessage: { addListener() {} } },
      storage: { local: { get: async () => ({ [config.SETTINGS_KEY]: settings }) },
        onChanged: { addListener: fn => { onChange = fn; } } },
    };
    let implementation = async command => command === 'classify' ? { scores: { luxury_status: .98 } } : { status: 'idle' };
    const controller = installSafeSocialBackground(api, async (...args) => { calls.push(args); return implementation(...args); });
    return { calls, controller, setHost: fn => { implementation = fn; },
      set(value) { settings = config.normalizeSettings(value); onChange({ [config.SETTINGS_KEY]: { newValue: settings } }, 'local'); } };
  }
  const settingsSender = { id: 'wb', url: 'chrome-extension://wb/src/ui/settings.html#safesocial', tab: { id: 2 }, frameId: 0 };
  const contentSender = { id: 'wb', url: 'https://www.instagram.com/', tab: { id: 1 }, frameId: 0 };
  const classify = { command: 'classify', url: 'https://scontent.cdninstagram.com/image.jpg' };
  test(`${build}: disabled and unauthorized callers never start inference or download`, async () => {
    const h = harness();
    assert.equal((await h.controller.handle({ command: 'prepare' }, settingsSender)).disabled, true);
    assert.equal((await h.controller.handle(classify, contentSender)).disabled, true);
    assert.equal(h.calls.length, 0);
    h.set({ enabled: true });
    for (const sender of [{ ...contentSender, url: 'https://evil.test/' }, { ...contentSender, frameId: 3 },
      { ...contentSender, id: 'other' }, { ...contentSender, tab: undefined }]) {
      await assert.rejects(h.controller.handle(classify, sender));
    }
    await assert.rejects(h.controller.handle({ command: 'prepare' }, contentSender));
    await assert.rejects(h.controller.handle({ ...classify, url: 'https://localhost/x' }, contentSender));
    assert.ok(h.calls.every(([command]) => command === 'stop'));
    const result = await h.controller.handle(classify, contentSender);
    assert.deepEqual(result.labels, ['luxury_status']);
    assert.equal(result.action, 'blur');
  });
  test(`${build}: disabled-in-flight results and changed categories are never applied`, async () => {
    const h = harness();
    let finish;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    h.setHost(async command => {
      if (command !== 'classify') return {};
      entered(); return new Promise(resolve => { finish = resolve; });
    });
    h.set({ enabled: true });
    const pending = h.controller.handle(classify, contentSender);
    await started;
    h.set({ enabled: false });
    finish({ scores: { luxury_status: .99 } });
    assert.equal((await pending).disabled, true);
    h.setHost(async () => ({ scores: { luxury_status: .99 } }));
    h.set({ enabled: true, labels: { luxury_status: false } });
    assert.deepEqual((await h.controller.handle(classify, contentSender)).labels, []);
    await assert.rejects(h.controller.handle({ command: 'remove' }, settingsSender), /Disable/);
  });
  test(`${build}: host is lazy, shares a worker and terminates pending work on disable`, async () => {
    const workers = [];
    class FakeWorker {
      constructor() { workers.push(this); this.messages = []; }
      postMessage(message) { this.messages.push(message); }
      terminate() { this.stopped = true; }
    }
    const host = createSafeSocialHost({ WorkerClass: FakeWorker });
    await host.handle('status'); await host.handle('stop');
    assert.equal(workers.length, 0);
    const preparing = host.handle('prepare');
    const inference = host.handle('classify', { url: classify.url });
    assert.equal(workers.length, 1);
    const rejected = Promise.all([assert.rejects(preparing, /stopped/), assert.rejects(inference, /stopped/)]);
    await host.handle('stop'); await rejected;
    assert.equal(workers[0].stopped, true);
    workers[0].onmessage({ data: { state: { status: 'ready' } } });
    assert.equal((await host.handle('status')).status, 'idle');
    const restarted = host.handle('prepare');
    const message = workers[1].messages[0];
    workers[1].onmessage({ data: { id: message.id, result: {} } });
    await restarted; await host.handle('stop');
  });
}

test('browser builds share the classifier, settings and locale implementation', async () => {
  for (const path of ['safesocial/config.js', 'safesocial/worker.js', 'safesocial/host.js', 'safesocial/background.js',
    'safesocial/content.js', 'safesocial/content.css', 'ui/safesocial-settings.js', 'ui/locales/safesocial-copy.mjs']) {
    assert.equal(await readFile(`src/chrome/src/${path}`, 'utf8'), await readFile(`src/firefox/src/${path}`, 'utf8'), path);
  }
});
