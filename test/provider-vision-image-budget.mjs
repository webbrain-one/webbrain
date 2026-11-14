import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: { getURL: value => `extension://test/${value}`, getManifest: () => ({ version: '0.0.0' }) },
};
globalThis.chrome ??= api;
globalThis.browser ??= api;

const image = value => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(value).toString('base64')}` } });
const countImages = messages => messages.reduce((sum, message) => sum + (Array.isArray(message.content)
  ? message.content.filter(block => ['image_url', 'image'].includes(block.type)).length : 0), 0);
const textOf = message => Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : String(message.content);

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { VISION_PROFILES } = await import(`../src/${build}/src/agent/vision-budget.js`);

  // Real session, diff planner, observation runtime, image pruning and
  // coordinate resolution; only browser capture/encoding are replaced.
  async function harness({ limit = 4, attachments = 0 } = {}) {
    const provider = { supportsVision: true, maxImagesPerRequest: limit };
    const state = { active: true, coordinates: 'pixel', profileId: 'anthropic' };
    const messages = attachments ? [{ role: 'user', content: [
      { type: 'text', text: '[UNTRUSTED USER ATTACHMENTS]' },
      ...Array.from({ length: attachments }, (_, index) => image(`attachment-${index}`)),
    ] }] : [];
    const width = 1000; const height = 800;
    const frame = {
      profile: VISION_PROFILES.anthropic,
      size: { width, height },
      probe: { cssWidth: width, cssHeight: height, devicePixelRatio: 1, scrollX: 0, scrollY: 0, url: 'https://owned.example.test/' },
      raster: { canvas: { width, height }, pixels: new Uint8ClampedArray(width * height * 4).fill(255) },
    };
    const agent = Object.create(Agent.prototype);
    Object.assign(agent, {
      conversations: new Map([[1, messages]]),
      _activeProvider: () => provider,
      _visionRunState: () => state,
      _visionCaptureSettled: async () => frame,
      _visionCaptureRetrying: async (_tab, read) => read(),
      _visionEncoding: async () => ({ mimeType: 'image/jpeg', quality: 0.8 }),
      _visionEncodeRegion: async () => ({ dataUrl: image('screen').image_url.url, bytes: 8, mimeType: 'image/jpeg' }),
      _visionEmitUpdate: () => {}, _visionTraceNote: () => {}, _visionReportUnredacted: () => {},
      _visionRecordObservation: async () => {},
    });
    const session = agent._visionSessionFor(1, state);
    await agent._visionPushKeyframe(1, messages, null, { state, frame });
    function change(x = 100, y = 100, color = 0) {
      frame.raster.pixels = new Uint8ClampedArray(frame.raster.pixels);
      for (let row = y; row < y + 32; row++) {
        for (let col = x; col < x + 48; col++) {
          const at = (row * width + col) * 4;
          frame.raster.pixels[at] = color;
          frame.raster.pixels[at + 1] = color;
          frame.raster.pixels[at + 2] = color;
        }
      }
    }
    function zoom() {
      const value = session.registerZoom({ x: 100, y: 100, width: 80, height: 80 }, 160, 160);
      session.pendingZooms.push({ id: value.id, kind: 'zoom', dataUrl: image(value.id).image_url.url, note: `[UNTRUSTED ZOOM ${value.id}]` });
      return value.id;
    }
    const observe = (tool = 'click_at') => agent._visionObserveAfterBatchOnce(1, messages, null, {
      state, toolCalls: [{ function: { name: tool } }],
    });
    return { agent, session, frame, messages, change, zoom, observe, request: () => agent._pruneOldImages(messages, provider) };
  }

  test(`${build}: provider image budget replaces the entire patch chain before the fifth image`, async () => {
    const h = await harness();
    for (let index = 0; index < 3; index++) {
      h.change(100 + 100 * index);
      assert.equal((await h.observe()).kind, 'patch');
      assert.equal(countImages(h.request()), index + 2);
    }
    const oldIds = [...h.session.images.keys()];
    h.change(500);
    assert.equal((await h.observe()).reason, 'provider_image_limit');
    assert.equal(countImages(h.request()), 1);
    assert.equal(h.session.patchChainLength, 0);
    assert.deepEqual(h.session.seenPixels, h.frame.raster.pixels, 'fresh frame includes the latest change');
    for (const id of oldIds) assert.equal(h.session.resolvePoint({ x: 1, y: 1, image: id }).code, 'stale_image');
    assert.match(textOf(h.messages.at(-1)), /full viewport \(provider image limit\)/);
  });

  test(`${build}: provider image budget counts every region of one screen update`, async () => {
    for (const limit of [null, 4]) {
      const h = await harness({ limit });
      for (const [x, y] of [[100, 100], [700, 100], [100, 600], [700, 600]]) h.change(x, y);
      const result = await h.observe();
      assert.equal(result.kind, limit ? 'keyframe' : 'patch');
      assert.equal(countImages(h.request()), limit ? 1 : 5);
    }
  });

  test(`${build}: provider image budget reserves all user attachments`, async () => {
    for (const attachments of [3, 4]) {
      const h = await harness({ attachments });
      const originalAttachments = structuredClone(h.messages[0]);
      h.change();
      assert.equal((await h.observe()).reason, 'provider_image_limit');
      assert.equal(countImages(h.request()), attachments + 1);
      assert.deepEqual(h.request()[0], originalAttachments, 'unavoidable attachment overflow remains for provider validation');
    }
  });

  test(`${build}: provider image budget retires pending zooms when the patch chain needs a fresh frame`, async () => {
    const h = await harness();
    h.change();
    await h.observe();
    const pending = Array.from({ length: 3 }, () => h.zoom());
    const result = await h.observe('zoom');
    assert.equal(result.reason, 'provider_image_limit');
    assert.equal(result.unchanged, true);
    assert.equal(countImages(h.request()), 1);
    for (const id of pending) {
      assert.equal(h.session.resolvePoint({ x: 1, y: 1, image: id }).code, 'stale_image');
      assert.match(textOf(h.messages.at(-1)), new RegExp(id));
    }
    const retried = Array.from({ length: 4 }, () => h.zoom());
    assert.equal((await h.observe('zoom')).kind, 'zoom');
    assert.equal(countImages(h.request()), 4);
    assert.equal(h.session.resolvePoint({ x: 1, y: 1, image: retried[0] }).code, 'stale_image');
    for (const id of retried.slice(1)) assert.equal(h.session.resolvePoint({ x: 1, y: 1, image: id }).ok, true);
  });

  test(`${build}: provider image budget keeps newest zooms and explicitly retires omitted ones`, async () => {
    const h = await harness({ attachments: 1 });
    const first = Array.from({ length: 3 }, () => h.zoom());
    await h.observe('zoom');
    assert.equal(countImages(h.request()), 4);
    assert.match(h.messages.map(textOf).join('\n'), new RegExp(`zoom ${first[0]} omitted`));
    assert.match(h.session.resolvePoint({ x: 1, y: 1, image: first[0] }).error, /provider accepts 4 images/);
    const newest = h.zoom();
    await h.observe('zoom');
    assert.equal(countImages(h.request()), 4);
    assert.equal(h.session.resolvePoint({ x: 1, y: 1, image: first[1] }).code, 'stale_image');
    for (const id of [first[2], newest]) assert.equal(h.session.resolvePoint({ x: 1, y: 1, image: id }).ok, true);
    h.change(400);
    assert.equal((await h.observe()).reason, 'provider_image_limit', 'retained zooms also consume the next patch budget');
    assert.equal(countImages(h.request()), 2);
  });

  test(`${build}: unlimited providers retain their patch chain and four zooms`, async () => {
    const h = await harness({ limit: null });
    for (let index = 0; index < 4; index++) {
      h.change(100 + index * 100);
      assert.equal((await h.observe()).kind, 'patch');
    }
    const zooms = Array.from({ length: 4 }, () => h.zoom());
    assert.equal((await h.observe('zoom')).kind, 'zoom');
    assert.equal(countImages(h.request()), 9);
    for (const id of zooms) assert.equal(h.session.resolvePoint({ x: 1, y: 1, image: id }).ok, true);
    assert.equal(h.session.epoch, 1);
  });

  test(`${build}: provider image budget explains when attachments leave no room for a zoom`, async () => {
    const h = await harness({ attachments: 3 });
    const id = h.zoom();
    await h.observe('zoom');
    assert.equal(countImages(h.request()), 4);
    assert.equal(h.session.resolvePoint({ x: 1, y: 1, image: id }).code, 'stale_image');
    assert.match(h.messages.map(textOf).join('\n'), /reduce image attachments or use a provider that accepts more images/);
    assert.equal(h.session.pendingZooms.length, 0);
  });
}
