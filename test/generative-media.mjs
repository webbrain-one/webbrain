import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const workflow = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } };

for (const build of ['chrome', 'firefox']) {
  const media = await import(`../src/${build}/src/agent/generative-media.js`);
  const legacyMedia = await import(`../src/${build}/src/agent/fal-media.js`);
  const config = await import(`../src/${build}/src/agent/media-config.js`);
  const gate = await import(`../src/${build}/src/agent/permission-gate.js`);
  const journal = await import(`../src/${build}/src/run-ui-journal.js`);

  test(`${build}: generated assets survive the actual background broadcast and bounded replay`, async () => {
    const source = await readFile(`src/${build}/src/background.js`, 'utf8');
    const start = source.indexOf('function sendAgentUpdate(');
    // End at the function's own closing brace; top-level declarations may follow it.
    const sendSource = source.slice(start, source.indexOf('\n}\n', start) + 2);
    const runJournal = new journal.RunUiJournal();
    runJournal.begin(11, 'media-run');
    const delivered = [];
    const api = { runtime: { sendMessage: async message => { delivered.push(message); } } };
    const send = new Function('recordRunUiEvent', 'agent', 'chrome', 'browser', 'notifyPlanReview',
      'clearPlanReviewAttention', 'planReviewAttentionByTab', `return (${sendSource});`)(
      (...args) => runJournal.record(...args), { currentRunId: new Map() }, api, api,
      () => {}, () => {}, new Map(),
    );
    const results = [
      { success: true, provider: 'fal', model: 'fal-ai/flux/schnell', url: 'https://cdn.example/image.png' },
      { success: true, provider: 'comfyrouter', model: 'luma/ray-2', url: 'https://cdn.example/video.mp4' },
      { success: true, provider: 'comfyui', model: 'ComfyUI workflow', url: 'http://127.0.0.1:8188/view?filename=image.png&type=output' },
      { success: true, provider: 'openrouter', model: 'image-model', inlineMedia: true, mediaId: 'f0c21b19-32d0-44f4-93cd-1031c6bb9a4d', mimeType: 'image/png' },
    ];
    for (const result of results) send(11, 'media-run', 'tool_result', { name: 'generate_image', result });
    assert.deepEqual(delivered.map(message => message.data.result), results);
    const persisted = journal.compactRunUiSnapshotForPersist(runJournal.get(11), { tight: true });
    assert.ok(JSON.stringify(persisted).length < journal.RUN_UI_PERSIST_RETRY_BUDGET);
    assert.equal(persisted.discardedBeforeSeq, 0);
    const restored = new journal.RunUiJournal();
    restored.restore(11, structuredClone(persisted));
    assert.deepEqual(restored.get(11).events.map(event => event.data.result), results);
    assert.equal(journal.compactRunUiData('tool_result', { name: 'read_page', result: { success: true, url: 'https://secret.example', mediaId: 'private' } }).result.url, undefined);
  });

  test(`${build}: old fal settings and selected provider hosts remain correctly scoped`, () => {
    assert.equal(config.mediaProvider({ apiKey: 'k', model: 'fal-ai/flux/schnell' }), 'fal');
    assert.equal(config.isImageGenConfigured({ apiKey: 'k', model: 'fal-ai/flux/schnell' }), true);
    assert.equal(config.isImageGenConfigured({ provider: 'other', apiKey: 'k', model: 'x' }), false);
    for (const [provider, host] of [['fal', 'queue.fal.run'], ['openrouter', 'openrouter.ai'], ['comfyrouter', 'api.comfy.org'], ['comfyui', '127.0.0.1']]) {
      assert.equal(gate.hostForCapability(gate.Capability.NETWORK, { _generativeMediaUrl: config.mediaPermissionUrl({ provider }) }, 'evil.example', 'generate_image'), host);
    }
    assert.equal(gate.hostForCapability(gate.Capability.NETWORK, { url: 'https://evil.example', provider: 'fal' }, 'example.com', 'generate_image'), '');
    for (const baseUrl of ['https://evil.example', 'http://localhost.evil.test:8188', 'http://user:pass@localhost:8188', 'http://localhost:8188?x=1', 'file:///tmp/x']) assert.throws(() => config.comfyBaseUrl(baseUrl));
    assert.equal(config.comfyBaseUrl('http://[::1]:8188/'), 'http://[::1]:8188');
    assert.equal(config.isImageGenConfigured({ provider: 'comfyui', workflow }), true);
    assert.throws(() => config.validateMediaConfig({ provider: 'comfyui', workflow: { nodes: [] } }), /API format/);
    assert.throws(() => config.validateMediaConfig({ provider: 'comfyui', workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'fixed' } } } }), /positive prompt/);
  });

  test(`${build}: image and video model settings may be left empty, and are checked when filled`, () => {
    for (const settings of [
      { provider: 'openrouter', apiKey: 'k' }, { provider: 'fal', apiKey: 'k', model: '', videoModel: '' },
      { provider: 'comfyrouter', apiKey: 'k', videoModel: 'luma/ray-2', videoParameters: '{"duration":"5s"}' },
      { provider: 'comfyui', videoWorkflow: workflow },
    ]) assert.equal(config.isImageGenConfigured(settings), true, JSON.stringify(settings));
    for (const [settings, error] of [
      [{ provider: 'openrouter', model: 'image-model' }, /API Key is required/],
      [{ provider: 'fal', apiKey: 'k', videoModel: '../escape' }, /video model ID is not valid/],
      [{ provider: 'comfyrouter', apiKey: 'k', videoModel: 'single' }, /provider\/model/],
      [{ provider: 'comfyrouter', apiKey: 'k', videoParameters: '{' }, /Video model input must be valid JSON/],
      [{ provider: 'comfyui' }, /ComfyUI workflow must be a JSON object/],
      [{ provider: 'comfyui', workflow, videoWorkflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'fixed' } } } }, /video workflow with \{\{prompt\}\}/],
    ]) assert.throws(() => config.validateMediaConfig(settings), error, JSON.stringify(settings));
  });

  test(`${build}: the fal.ai video resolution is 480p unless 720p is saved`, () => {
    assert.deepEqual(['', '480p', '720p', '720P', ' 720p ', '1080p', 720, null, undefined].map(videoResolution => config.falVideoResolution({ videoResolution })),
      ['480p', '480p', '720p', '720p', '720p', '480p', '480p', '480p', '480p']);
    assert.equal(config.falVideoResolution(undefined), '480p');
    // An imported or hand-edited value that is not offered falls back; it does not disable media generation.
    assert.equal(config.isImageGenConfigured({ provider: 'fal', apiKey: 'k', videoResolution: '1080p' }), true);
  });

  test(`${build}: each request uses the image or the video model, or the provider's default`, async () => {
    // The first submission shows which model (or workflow) a request uses. It
    // fails, so nothing is generated.
    const submission = async (settings, kind) => {
      let seen = null;
      await assert.rejects(media.runMediaGeneration({ prompt: 'red apple', media: kind, config: settings, pollIntervalMs: 1, fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/images/models')) return json({ data: [{ id: 'google/gemini-2.5-flash-image' }, { id: 'image-model' }] });
        if (url.endsWith('/videos/models')) return json({ data: [{ id: 'x-ai/grok-imagine-video-1.5-lite' }, { id: 'video-model' }] });
        assert.equal(init.method, 'POST', url);
        seen = { url, body: JSON.parse(init.body) };
        return json({ error: 'not generated in this test' }, 500);
      } }), /HTTP 500/);
      return seen;
    };
    const fal = { provider: 'fal', apiKey: 'k', model: 'fal-ai/flux/dev' };
    assert.equal((await submission(fal, 'image')).url, 'https://queue.fal.run/fal-ai/flux/dev');
    assert.equal((await submission(fal, null)).url, 'https://queue.fal.run/fal-ai/flux/dev', 'a call that does not say gets an image');
    assert.equal((await submission(fal, 'video')).url, 'https://queue.fal.run/xai/grok-imagine-video/v1.5/lite/text-to-video');
    assert.equal((await submission({ provider: 'fal', apiKey: 'k' }, 'image')).url, 'https://queue.fal.run/fal-ai/flux/schnell');
    assert.equal((await submission({ ...fal, videoModel: 'fal-ai/veo3/fast' }, 'video')).url, 'https://queue.fal.run/fal-ai/veo3/fast');

    // Comfy Router: each model with its own input.
    const comfy = { provider: 'comfyrouter', apiKey: 'k', model: 'bfl/flux-2-pro', parameters: { steps: 20, prompt: '{{prompt}}' } };
    assert.deepEqual(await submission(comfy, 'image'), { url: 'https://api.comfy.org/v2/models/bfl/flux-2-pro/requests', body: { steps: 20, prompt: 'red apple' } });
    assert.deepEqual(await submission(comfy, 'video'), { url: 'https://api.comfy.org/v2/models/xai/grok-imagine-video-1.5-lite/requests', body: { prompt: 'red apple' } });
    assert.deepEqual(await submission({ ...comfy, videoModel: 'luma/ray-2', videoParameters: '{"duration":"5s"}' }, 'video'),
      { url: 'https://api.comfy.org/v2/models/luma/ray-2/requests', body: { duration: '5s', prompt: 'red apple' } });

    // ComfyUI: each kind's workflow, or the only one saved.
    const videoWorkflow = { '3': { class_type: 'TextEncode', inputs: { text: 'video of {{prompt}}' } }, '8': { class_type: 'SaveVideo', inputs: {} } };
    const textOf = seen => Object.values(seen.body.prompt).map(node => node.inputs.text).filter(Boolean);
    assert.deepEqual(textOf(await submission({ provider: 'comfyui', workflow, videoWorkflow }, 'video')), ['video of red apple']);
    assert.deepEqual(textOf(await submission({ provider: 'comfyui', workflow, videoWorkflow }, 'image')), ['red apple']);
    assert.deepEqual(textOf(await submission({ provider: 'comfyui', workflow }, 'video')), ['red apple']);
    assert.deepEqual(textOf(await submission({ provider: 'comfyui', videoWorkflow }, 'image')), ['video of red apple']);

    // OpenRouter: an empty model is the default; a saved video model makes videos.
    const openrouter = { provider: 'openrouter', apiKey: 'k' };
    assert.deepEqual(await submission(openrouter, null), { url: 'https://openrouter.ai/api/v1/images', body: { model: 'google/gemini-2.5-flash-image', prompt: 'red apple' } });
    assert.equal((await submission({ ...openrouter, model: 'image-model' }, 'video')).body.model, 'x-ai/grok-imagine-video-1.5-lite');
    assert.equal((await submission({ ...openrouter, model: 'image-model', videoModel: 'video-model' }, 'video')).body.model, 'video-model');
    // A video model saved as the only model, before there were two: a call that
    // does not say gets a video from it; an image request gets the default.
    assert.deepEqual(await submission({ ...openrouter, model: 'video-model' }, null), { url: 'https://openrouter.ai/api/v1/videos', body: { model: 'video-model', prompt: 'red apple' } });
    assert.equal((await submission({ ...openrouter, model: 'video-model' }, 'video')).body.model, 'video-model');
    assert.deepEqual(await submission({ ...openrouter, model: 'video-model' }, 'image'), { url: 'https://openrouter.ai/api/v1/images', body: { model: 'google/gemini-2.5-flash-image', prompt: 'red apple' } });
    // A saved video model takes over from the only model.
    assert.equal((await submission({ ...openrouter, model: 'image-model', videoModel: 'video-model' }, null)).body.model, 'image-model');
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', media: 'audio', config: openrouter, fetchImpl: async url => assert.fail(url) }), /media must be "image" or "video"/);
  });

  test(`${build}: a video model's lengths, ratios and resolutions are read from its published schema`, () => {
    // Shaped like the OpenAPI documents fal.ai and Comfy Router publish per model.
    const fal = (input, extra = {}) => ({
      openapi: '3.0.4',
      paths: {
        '/fal-ai/model/requests/{request_id}/status': { get: {} },
        '/fal-ai/model': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ModelInput' } } } } } },
      },
      components: { schemas: { ModelInput: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, ...input } }, ...extra } },
    });
    const caps = openapi => {
      const entry = media.videoInputCapabilities(openapi);
      return entry && { ...entry, encodeDuration: undefined, encoded: entry.supported_durations?.map(seconds => entry.encodeDuration(seconds)) };
    };
    const lengths = duration => {
      const entry = caps(fal({ duration }));
      return [entry.supported_durations, entry.encoded];
    };
    const seconds = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    // A range of whole seconds, sent as numbers (fal.ai's Grok Imagine).
    assert.deepEqual(caps(fal({
      duration: { type: 'integer', minimum: 1, maximum: 15, default: 6 },
      aspect_ratio: { type: 'string', enum: ['16:9', '4:3', '1:1', '9:16'] },
      resolution: { type: 'string', enum: ['480p', '720p', '1080p'] },
    })), {
      inputs: ['prompt', 'duration', 'aspect_ratio', 'resolution'], encodeDuration: undefined,
      supported_durations: seconds(1, 15), encoded: seconds(1, 15),
      supported_aspect_ratios: ['16:9', '4:3', '1:1', '9:16'], supported_resolutions: ['480p', '720p', '1080p'],
    });
    // A fractional range covers its whole seconds (MiniMax H3 Max).
    assert.deepEqual(lengths({ type: 'number', minimum: 0.92, maximum: 6 }), [seconds(1, 6), seconds(1, 6)]);
    // Listed lengths are sent as listed: "8s" (Veo), "10" (Hailuo 02), 10 (LTX).
    assert.deepEqual(lengths({ type: 'string', enum: ['4s', '6s', '8s'] }), [[4, 6, 8], ['4s', '6s', '8s']]);
    assert.deepEqual(lengths({ type: 'string', enum: ['6', '10'], default: '6' }), [[6, 10], ['6', '10']]);
    assert.deepEqual(lengths({ type: 'integer', enum: [6, 8, 10] }), [[6, 8, 10], [6, 8, 10]]);
    // "auto" is not a length; the range or the other listed values are (FLUX.3, Seedance).
    assert.deepEqual(lengths({ enum: ['auto', 5, 6, 7] }), [[5, 6, 7], [5, 6, 7]]);
    assert.deepEqual(lengths({ oneOf: [{ type: 'integer', minimum: 4, maximum: 6 }, { type: 'string', enum: ['auto'] }] }), [[4, 5, 6], [4, 5, 6]]);
    assert.deepEqual(lengths({ anyOf: [{ enum: [-1] }, { minimum: 2, maximum: 4 }] }), [[2, 3, 4], [2, 3, 4]]);
    assert.deepEqual(lengths({ anyOf: [{ type: 'integer', minimum: 2, maximum: 3 }, { type: 'null' }] }), [[2, 3], [2, 3]]);
    // Exclusive bounds and steps.
    assert.deepEqual(lengths({ type: 'integer', exclusiveMinimum: 2, exclusiveMaximum: 6 }), [[3, 4, 5], [3, 4, 5]]);
    assert.deepEqual(lengths({ type: 'number', minimum: 2, exclusiveMinimum: true, maximum: 6, exclusiveMaximum: true }), [[3, 4, 5], [3, 4, 5]]);
    assert.deepEqual(lengths({ type: 'integer', minimum: 5, maximum: 15, multipleOf: 5 }), [[5, 10, 15], [5, 10, 15]]);
    // Lengths start at 1 s.
    assert.deepEqual(lengths({ type: 'integer', maximum: 3 }), [[1, 2, 3], [1, 2, 3]]);
    assert.deepEqual(lengths({ type: 'number', minimum: 0, maximum: 2 }), [[1, 2], [1, 2]]);
    // A listed set is the set, whatever bounds it also states; a range is read up to an hour.
    assert.deepEqual(lengths({ type: 'integer', enum: [6, 8, 10], minimum: 6, maximum: 10 }), [[6, 8, 10], [6, 8, 10]]);
    assert.deepEqual(lengths({ type: 'integer', minimum: 1, maximum: 1e9 })[0].slice(-2), [3599, 3600]);
    // Without an upper bound, or as text, a length is unknown.
    assert.deepEqual(lengths({ type: 'integer', minimum: 1 }), [undefined, undefined]);
    assert.deepEqual(lengths({ type: 'string', maximum: 10 }), [undefined, undefined]);
    // An enum lists the values in their own case and type ("768P").
    assert.deepEqual(caps(fal({ resolution: { type: 'string', enum: ['480P', '768P', null] } })).supported_resolutions, ['480P', '768P']);
    // Comfy Router: the body schema inline, choices behind $ref and anyOf (Luma).
    const comfy = (schema, schemas = {}) => ({
      openapi: '3.0.2',
      paths: { '/v2/models/provider/model': { post: { requestBody: { content: { 'application/json': { schema } } } } } },
      components: { schemas },
    });
    const luma = caps(comfy({
      required: ['prompt', 'duration'],
      properties: { prompt: { type: 'string' }, duration: { $ref: '#/components/schemas/Duration' }, aspect_ratio: { allOf: [{ $ref: '#/components/schemas/Ratio' }], nullable: true }, resolution: { type: 'string' } },
    }, { Duration: { anyOf: [{ type: 'string', enum: ['5s', '9s'] }, { type: 'string' }] }, Ratio: { type: 'string', enum: ['16:9', '9:16'] } }));
    assert.deepEqual([luma.supported_durations, luma.encoded, luma.supported_aspect_ratios, luma.supported_resolutions], [[5, 9], ['5s', '9s'], ['16:9', '9:16'], undefined]);
    // The generation's body is the one that takes the prompt.
    const upload = caps({
      ...comfy({ properties: { prompt: { type: 'string' }, duration: { enum: ['5s'] } } }),
      paths: {
        '/storage/upload': { post: { requestBody: { content: { 'application/json': { schema: { properties: { file_name: { type: 'string' }, duration: { enum: [30] } } } } } } } },
        '/v2/models/provider/model': { post: { requestBody: { content: { 'application/json': { schema: { properties: { prompt: { type: 'string' }, duration: { enum: ['5s'] } } } } } } } },
      },
    });
    assert.deepEqual([upload.inputs, upload.encoded], [['prompt', 'duration'], ['5s']]);
    // A body that takes its prompt inside another field, or is made of parts.
    const content = caps(comfy({ properties: { content: { type: 'array' }, duration: { type: 'integer', minimum: 4, maximum: 6 }, ratio: { enum: ['16:9'] } } }));
    assert.deepEqual([content.inputs, content.supported_durations], [['content', 'duration', 'ratio'], [4, 5, 6]]);
    // allOf parts must all hold: a part narrows the base's range or values.
    const narrowed = caps(comfy({ allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { duration: { minimum: 5, maximum: 10 } } }] },
      { Base: { properties: { prompt: { type: 'string' }, duration: { type: 'integer', minimum: 1, maximum: 15 } } } }));
    assert.deepEqual([narrowed.inputs, narrowed.supported_durations], [['prompt', 'duration'], seconds(5, 10)]);
    assert.deepEqual(lengths({ allOf: [{ type: 'integer', minimum: 1, maximum: 15 }, { minimum: 5, maximum: 10 }] }), [seconds(5, 10), seconds(5, 10)]);
    assert.deepEqual(lengths({ allOf: [{ enum: ['5', '10', '15'] }, { enum: ['10', '15', '20'] }] }), [[10, 15], ['10', '15']]);
    assert.deepEqual(lengths({ allOf: [{ enum: [5, 10] }, { const: 10 }] }), [[10], [10]]);
    assert.deepEqual(lengths({ type: 'integer', minimum: 1, maximum: 15, anyOf: [{ maximum: 3 }, { enum: [10, 20] }] }), [[1, 2, 3, 10], [1, 2, 3, 10]]);
    // anyOf or oneOf variants of a body: a length any of them takes.
    const variants = caps(comfy({ oneOf: [{ properties: { prompt: { type: 'string' }, duration: { enum: [5] } } }, { properties: { prompt: { type: 'string' }, duration: { enum: [10] } } }] }));
    assert.deepEqual([variants.inputs, variants.supported_durations, variants.encoded], [['prompt', 'duration'], [5, 10], [5, 10]]);
    // Nothing to read: an open body, no paths, an error instead of a document.
    assert.equal(media.videoInputCapabilities(comfy({ type: 'object', additionalProperties: true })), null);
    assert.equal(media.videoInputCapabilities({ openapi: '3.0.4', paths: {} }), null);
    assert.equal(media.videoInputCapabilities({ error: { code: 'expansion_failed' } }), null);
    assert.equal(media.videoInputCapabilities(null), null);
  });

  test(`${build}: unbounded video duration schemas preserve valid defaults and input types`, () => {
    const entryFor = duration => media.videoInputCapabilities({
      openapi: '3.0.4', paths: { '/model': { post: { requestBody: { content: { 'application/json': { schema: {
        type: 'object', properties: { prompt: { type: 'string' }, duration },
      } } } } } } },
    });
    for (const [duration, expected, encoded] of [
      [{ type: 'integer', default: 5 }, 5, 5],
      [{ type: 'number', default: 6 }, 6, 6],
      [{ type: 'string', default: '5s' }, 5, '5s'],
      [{ type: 'string', default: '6.0' }, 6, '6.0'],
      [{ allOf: [{ type: 'integer', default: 6 }, { minimum: 5, multipleOf: 2 }] }, 6, 6],
    ]) {
      const entry = entryFor(duration);
      assert.equal(entry.supported_durations, undefined);
      assert.equal(entry.default_duration, expected);
      assert.equal(entry.encodeDuration(expected), encoded);
    }
    for (const duration of [
      { type: 'integer', default: 0 }, { type: 'number', default: -5 }, { type: 'number', default: 5.5 },
      { type: 'integer', default: '5' }, { type: 'string', default: 5 }, { type: 'string', default: 'auto' },
      { type: 'integer', default: 5, minimum: 6 }, { type: 'integer', default: 5, multipleOf: 2 },
      { type: 'integer', default: Number.MAX_SAFE_INTEGER + 1 },
    ]) assert.equal(entryFor(duration).default_duration, undefined, JSON.stringify(duration));
    assert.equal(entryFor({ type: 'string' }).encodeDuration(8), '8');
    assert.equal(entryFor({ type: ['string', 'null'] }).encodeDuration(8), '8');
    assert.equal(entryFor({ anyOf: [{ type: 'string' }, { type: 'null' }] }).encodeDuration(8), '8');
    assert.equal(entryFor({ type: 'integer' }).encodeDuration(8), 8);
    assert.equal(entryFor({ anyOf: [{ type: 'string' }, { type: 'number' }] }).encodeDuration(8), 8);
    assert.equal(entryFor({ type: 'string', default: '5s' }).encodeDuration(8), '8', 'no units are invented');
    const bounded = entryFor({ type: 'integer', minimum: 5, maximum: 6, default: 5 });
    assert.deepEqual(bounded.supported_durations, [5, 6]);
    assert.equal(bounded.default_duration, undefined, 'bounded durations remain authoritative');
  });

  test(`${build}: OpenRouter Image API returns inline media without a chat request`, async () => {
    const calls = [];
    const result = await media.runMediaGeneration({ prompt: 'red apple', config: { provider: 'openrouter', apiKey: 'or-key', model: 'google/gemini-2.5-flash-image' }, fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.headers.Authorization, 'Bearer or-key');
      assert.equal(init.redirect, 'error');
      if (url.endsWith('/images/models')) return json({ data: [{ id: 'google/gemini-2.5-flash-image' }] });
      assert.deepEqual(JSON.parse(init.body), { model: 'google/gemini-2.5-flash-image', prompt: 'red apple' });
      return json({ data: [{ b64_json: 'YWJj', media_type: 'image/webp' }] });
    } });
    assert.deepEqual(calls, ['https://openrouter.ai/api/v1/images/models', 'https://openrouter.ai/api/v1/images']);
    assert.equal(result.url, 'data:image/webp;base64,YWJj');
    assert.equal(media.extractMediaUrl({ data: [{ b64_json: 'YWJj', media_type: 'image/svg+xml' }] }), '');
    assert.equal(media.extractMediaUrl({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }] }), 'data:image/png;base64,YWJj');
    assert.equal(media.extractMediaUrl({ status_url: 'https://api.example/status' }), '');
    assert.equal(media.safeMediaUrl('javascript:alert(1)'), '');
    assert.equal(media.safeMediaUrl('https://key@evil.example/x'), '');
  });

  test(`${build}: legacy media entry points bind statically to the provider implementation`, () => {
    assert.equal(legacyMedia.testImageGenProvider, media.testImageGenProvider);
    assert.equal(legacyMedia.generateImage, media.generateImage);
  });

  test(`${build}: OpenRouter Hailuo video polls and downloads through authenticated trusted paths`, async () => {
    const calls = [];
    const responses = [
      json({ data: [] }), json({ data: [{ id: 'minimax/hailuo-3-max' }] }),
      json({ id: 'job-1', status: 'pending', polling_url: 'https://evil.example/status' }, 202),
      json({ status: 'pending' }), json({ status: 'in_progress' }),
      json({ status: 'completed', unsigned_urls: ['https://evil.example/content'] }),
      new Response('abc', { headers: { 'Content-Type': 'video/mp4' } }),
    ];
    const result = await media.runMediaGeneration({ prompt: 'a moving red apple', config: { provider: 'openrouter', apiKey: 'or-key', model: 'minimax/hailuo-3-max' }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(init.headers.Authorization, 'Bearer or-key');
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      if (init.method === 'POST') assert.deepEqual(JSON.parse(init.body), { model: 'minimax/hailuo-3-max', prompt: 'a moving red apple' });
      return responses.shift();
    } });
    assert.deepEqual(result, { url: 'data:video/mp4;base64,YWJj', model: 'minimax/hailuo-3-max' });
    assert.deepEqual(calls, [
      'https://openrouter.ai/api/v1/images/models', 'https://openrouter.ai/api/v1/videos/models', 'https://openrouter.ai/api/v1/videos',
      ...Array(3).fill('https://openrouter.ai/api/v1/videos/job-1'), 'https://openrouter.ai/api/v1/videos/job-1/content?index=0',
    ]);
  });

  test(`${build}: OpenRouter completed video downloads even without unsigned URLs`, async () => {
    const responses = [json({ data: [] }), json({ data: [{ id: 'video-model' }] }), json({ id: 'job-1' }, 202), json({ status: 'completed' }), new Response('abc', { headers: { 'Content-Type': 'video/mp4' } })];
    const result = await media.runMediaGeneration({ prompt: 'apple', config: { provider: 'openrouter', apiKey: 'k', model: 'video-model' }, pollIntervalMs: 1, fetchImpl: async () => responses.shift() });
    assert.equal(result.url, 'data:video/mp4;base64,YWJj');
  });

  test(`${build}: OpenRouter rejects invalid jobs and terminal failures without downloading media`, async () => {
    for (const [submit, status, expected] of [
      [{ id: '../another-job' }, null, /invalid video job ID/],
      [{ id: 'job-1' }, { status: 'failed', error: 'Content policy violation' }, /Content policy violation/],
      [{ id: 'job-1' }, { status: 'failed' }, /failed/],
      [{ id: 'job-1' }, { status: 'cancelled' }, /cancelled/],
      [{ id: 'job-1' }, { status: 'expired' }, /expired/],
      [{ id: 'job-1' }, {}, /unknown status/],
    ]) {
      const calls = [];
      const responses = [json({ data: [] }), json({ data: [{ id: 'video-model' }] }), json(submit, 202), json(status)];
      await assert.rejects(media.runMediaGeneration({ prompt: 'apple', config: { provider: 'openrouter', apiKey: 'k', model: 'video-model' }, pollIntervalMs: 1, fetchImpl: async url => { calls.push(url); return responses.shift(); } }), expected);
      assert.ok(!calls.some(url => url.includes('/content')));
      assert.equal(calls.length, status ? 4 : 3);
    }
  });

  test(`${build}: OpenRouter rejects non-media models before paid submission`, async () => {
    const calls = [];
    await assert.rejects(media.runMediaGeneration({ prompt: 'apple', config: { provider: 'openrouter', apiKey: 'k', model: 'text-only' }, fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.method, undefined); return json({ data: [] });
    } }), /image or video generation catalog/);
    assert.equal(calls.length, 2);
  });

  test(`${build}: OpenRouter video cancellation stops polling and aborts in-flight downloads`, async () => {
    for (const phase of ['poll', 'download']) {
      const controller = new AbortController();
      const calls = [];
      const responses = [json({ data: [] }), json({ data: [{ id: 'video-model' }] }), json({ id: 'job-1' }, 202)];
      await assert.rejects(media.runMediaGeneration({ prompt: 'apple', config: { provider: 'openrouter', apiKey: 'k', model: 'video-model' }, signal: controller.signal, pollIntervalMs: 1, fetchImpl: async (url, init) => {
        calls.push(url);
        if (responses.length) return responses.shift();
        if (phase === 'download' && !url.includes('/content')) return json({ status: 'completed' });
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          controller.abort(new Error('Stopped video generation.'));
        });
      } }), /Stopped video generation/);
      assert.equal(calls.length, phase === 'poll' ? 4 : 5);
    }
  });

  test(`${build}: Comfy Router binds native inputs and polls trusted job paths`, async () => {
    const calls = [];
    const result = await media.runMediaGeneration({ prompt: 'an apple "quoted"', config: { provider: 'comfyrouter', apiKey: 'comfyui-key', model: 'bfl/flux-2-pro', parameters: JSON.stringify({ content: [{ text: '{{prompt}}', type: 'text' }], steps: 20 }) }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.headers['X-API-Key'], 'comfyui-key');
      if (calls.length === 1) {
        assert.match(init.headers['Idempotency-Key'], /^[\da-f-]{36}$/);
        assert.deepEqual(JSON.parse(init.body), { content: [{ text: 'an apple "quoted"', type: 'text' }], steps: 20 });
        return json({ request_id: 'job-1', status_url: 'https://evil.example/status', response_url: 'https://evil.example/result', cancel_url: 'https://evil.example/cancel' }, 201);
      }
      if (calls.length === 2) return json({ status: 'COMPLETED' });
      return json({ result: { sample: 'https://cdn.example/apple.png' } });
    } });
    assert.equal(result.url, 'https://cdn.example/apple.png');
    assert.deepEqual(calls, ['https://api.comfy.org/v2/models/bfl/flux-2-pro/requests', 'https://api.comfy.org/v2/models/bfl/flux-2-pro/requests/job-1/status', 'https://api.comfy.org/v2/models/bfl/flux-2-pro/requests/job-1']);
  });

  test(`${build}: Comfy Router native assets return the final video without cancelling a completed job`, async () => {
    const calls = [];
    const result = await media.runMediaGeneration({ prompt: 'red apple', config: { provider: 'comfyrouter', apiKey: 'k', model: 'luma/ray-2', parameters: { aspect_ratio: '16:9', duration: '5s', resolution: '720p' } }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (calls.length === 1) return json({ request_id: 'luma-1' }, 201);
      if (calls.length === 2) return json({ status: 'COMPLETED' });
      return json({ assets: { image: 'https://cdn.example/preview.jpg', progress_video: 'https://cdn.example/progress.mp4', video: 'https://cdn.example/final.mp4' }, status_url: 'https://api.example/status' });
    } });
    assert.equal(result.url, 'https://cdn.example/final.mp4');
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => !call.url.endsWith('/cancel')));
    assert.equal(media.extractMediaUrl({ assets: { image: 'https://cdn.example/final.png' } }), 'https://cdn.example/final.png');
    assert.equal(media.extractMediaUrl({ result: { video: 'https://cdn.example/final.mp4' } }), 'https://cdn.example/final.mp4');
    assert.equal(media.extractMediaUrl({ assets: { progress_video: 'https://cdn.example/progress.mp4' }, status_url: 'https://api.example/status' }), '');
    for (const value of ['javascript:alert(1)', 'file:///tmp/private', 'https://key@cdn.example/final.mp4']) {
      assert.equal(media.extractMediaUrl({ assets: { video: value } }), '');
    }
  });

  test(`${build}: failed Comfy Router completion cannot become a successful image`, async () => {
    const calls = [];
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', config: { provider: 'comfyrouter', apiKey: 'k', model: 'bfl/flux-2-pro' }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (calls.length === 1) return json({ request_id: 'j' }, 201);
      return json({ status: 'COMPLETED', error_type: 'content_policy_violation' });
    } }), /content_policy_violation/);
    assert.equal(calls.at(-1).method, 'PUT');
    assert.ok(calls.at(-1).url.endsWith('/j/cancel'));
  });

  test(`${build}: local workflow prompts and saved file query are transported correctly`, async () => {
    const original = JSON.stringify(workflow);
    const calls = [];
    const result = await media.runMediaGeneration({ prompt: 'red apple "with quotes"', config: { provider: 'comfyui', workflow, baseUrl: 'http://localhost:8188/' }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.headers?.Authorization, undefined);
      if (calls.length === 1) {
        const body = JSON.parse(init.body); assert.equal(body.prompt['6'].inputs.text, 'red apple "with quotes"');
        assert.equal(body.prompt['9'].class_type, 'SaveImage'); return json({ prompt_id: 'local-1' });
      }
      if (calls.length === 2) return json({});
      return json({ 'local-1': { status: { completed: true }, outputs: { '9': { images: [{ filename: 'apple #1.png', subfolder: 'my folder', type: 'output' }] } } } });
    } });
    assert.equal(JSON.stringify(workflow), original);
    const url = new URL(result.url); assert.equal(url.origin, 'http://localhost:8188');
    assert.equal(url.pathname, '/view'); assert.equal(url.searchParams.get('filename'), 'apple #1.png');
    assert.equal(url.searchParams.get('subfolder'), 'my folder');
  });

  test(`${build}: cancellation deletes only the local queued job`, async () => {
    const controller = new AbortController(); const calls = [];
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', config: { provider: 'comfyui', workflow }, signal: controller.signal, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/prompt')) { controller.abort(new Error('stopped')); return json({ prompt_id: 'mine' }); }
      return json({});
    } }), /stopped/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'http://127.0.0.1:8188/queue');
    assert.deepEqual(JSON.parse(calls[1].init.body), { delete: ['mine'] });
    assert.ok(!calls.some(call => call.url.includes('/interrupt')));
  });

  test(`${build}: timeouts abort in-flight generation`, async () => {
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', config: { provider: 'openrouter', apiKey: 'k', model: 'image-model' }, timeoutMs: 10,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
    }), /timed out/);
  });

  test(`${build}: actual tool batch uses the same provider snapshot for permission and dispatch`, async () => {
    const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
    let selected = { provider: 'openrouter', apiKey: 'saved-key', model: 'image-model' };
    const area = { get: async () => ({ imageGenModel: structuredClone(selected) }), set: async () => {}, remove: async () => {} };
    const api = {
      storage: { local: area, session: area }, runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
      tabs: { get: async id => ({ id, url: 'https://example.com', title: 'Example' }), sendMessage: async () => ({}) },
      scripting: { executeScript: async () => [{ result: null }] },
    };
    globalThis.chrome = globalThis.browser = api;
    try {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const provider = { supportsVision: false, promptTier: 'full' };
      const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
      agent._ensureGateSetting = async () => {};
      agent._persist = () => {};
      agent._skipPermissionGate = false;
      const hosts = []; let dispatched = false;
      agent.permissions.check = host => {
        hosts.push(host);
        // A settings change during approval must not move this request to another host.
        selected = { provider: 'comfyrouter', apiKey: 'other-key', model: 'bfl/flux-2-pro' };
        return { allowed: true };
      };
      agent.executeTool = async (_tab, name, args, _update, context) => {
        assert.equal(name, 'generate_image'); assert.equal(args.prompt, 'red apple');
        assert.deepEqual(context.imageGenConfig, { provider: 'openrouter', apiKey: 'saved-key', model: 'image-model' });
        dispatched = true;
        return { success: true, provider: 'openrouter', model: 'image-model', url: 'data:image/png;base64,' + 'YWJj'.repeat(4000) };
      };
      const messages = [];
      await agent._executeToolBatch(11, [{ id: 'spoof-call', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'red apple', _generativeMediaUrl: 'https://evil.example' }) } }], messages, () => {}, provider, '', new Set(['generate_image']), 1);
      assert.equal(dispatched, false); assert.match(messages[0].content, /invalid_tool_arguments/);
      messages.length = 0;
      await agent._executeToolBatch(11, [{ id: 'media-call', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'red apple' }) } }], messages, () => {}, provider, '', new Set(['generate_image']), 1);
      assert.equal(dispatched, true, JSON.stringify(messages)); assert.deepEqual(hosts, ['openrouter.ai']);
      assert.ok(messages[0].content.includes('inlineMedia'));
      assert.ok(!messages[0].content.includes('YWJj'));
      assert.ok(!messages[0].content.includes('saved-key'));
      const handleResult = agent._limitToolResult({ success: true, provider: 'openrouter', inlineMedia: true, mediaId: 'private-asset-id', mimeType: 'image/png' });
      assert.ok(handleResult.includes('do not invent a hosted URL'));
      assert.ok(!handleResult.includes('private-asset-id'));
    } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
  });

  test(`${build}: connection tests are authenticated read-only probes with provider validation`, async () => {
    const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
    let selected;
    const api = { storage: { local: { get: async () => ({ imageGenModel: selected }) } } };
    globalThis.chrome = globalThis.browser = api;
    try {
      const orImages = json({ data: [{ id: 'image-model' }, { id: 'google/gemini-2.5-flash-image' }] });
      const orVideos = () => json({ data: [{ id: 'minimax/hailuo-3-max' }, { id: 'x-ai/grok-imagine-video-1.5-lite' }] });
      // [provider, settings, responses, probed URLs, image and video models reported]
      for (const [provider, values, responses, urls, models] of [
        ['fal', { apiKey: 'k', model: 'fal-ai/flux/schnell' }, [json({})], ['https://api.fal.ai/v1/workflows?limit=1'],
          ['fal-ai/flux/schnell', 'xai/grok-imagine-video/v1.5/lite/text-to-video']],
        ['fal', { apiKey: 'k', model: '', videoModel: 'fal-ai/veo3/fast' }, [json({})], ['https://api.fal.ai/v1/workflows?limit=1'],
          ['fal-ai/flux/schnell', 'fal-ai/veo3/fast']],
        // Both OpenRouter models are checked in their catalogs; an empty one is the default.
        ['openrouter', { apiKey: 'k', model: 'image-model' }, [json({ data: {} }), orImages, orVideos()],
          ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/images/models', 'https://openrouter.ai/api/v1/videos/models'],
          ['image-model', 'x-ai/grok-imagine-video-1.5-lite']],
        // A video model saved as the only model makes the videos; images use the default.
        ['openrouter', { apiKey: 'k', model: 'minimax/hailuo-3-max' }, [json({ data: {} }), json({ data: [{ id: 'google/gemini-2.5-flash-image' }] }), orVideos()],
          ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/images/models', 'https://openrouter.ai/api/v1/videos/models'],
          ['google/gemini-2.5-flash-image', 'minimax/hailuo-3-max']],
        ['comfyrouter', { apiKey: 'k', model: 'bfl/flux-2-pro' }, [json({ id: 'bfl/flux-2-pro' }), json({ id: 'xai/grok-imagine-video-1.5-lite' })],
          ['https://api.comfy.org/v2/models/bfl/flux-2-pro', 'https://api.comfy.org/v2/models/xai/grok-imagine-video-1.5-lite'],
          ['bfl/flux-2-pro', 'xai/grok-imagine-video-1.5-lite']],
        ['comfyui', { workflow }, [json({ system: {}, devices: [] })], ['http://127.0.0.1:8188/system_stats'], [undefined, undefined]],
      ]) {
        selected = { provider, ...values }; const calls = [];
        const result = await legacyMedia.testImageGenProvider(async (url, init) => { assert.ok(!init.method || init.method === 'GET'); calls.push(url); return responses.shift(); });
        assert.equal(result.ok, true, result.error); assert.deepEqual(calls, urls);
        assert.deepEqual([result.imageModel, result.videoModel], models, provider);
        assert.equal((await media.testImageGenProvider(async () => json({}, 401))).ok, false);
      }
      // Comfy Router must confirm the video model too.
      selected = { provider: 'comfyrouter', apiKey: 'k', model: 'bfl/flux-2-pro', videoModel: 'luma/ray-2' };
      const comfyResponses = [json({ id: 'bfl/flux-2-pro' }), json({ id: 'other/model' })];
      assert.match((await legacyMedia.testImageGenProvider(async () => comfyResponses.shift())).error, /did not confirm luma\/ray-2/);
      // A video model setting that names an image model is caught before any video is made.
      selected = { provider: 'openrouter', apiKey: 'k', model: 'image-model', videoModel: 'image-model' };
      const swapped = [json({ data: {} }), json({ data: [{ id: 'image-model' }] }), json({ data: [] })];
      assert.match((await legacyMedia.testImageGenProvider(async () => swapped.shift())).error, /image-model makes images/);
      selected = { provider: 'openrouter', apiKey: 'k', model: 'text-only' };
      const responses = [json({ data: {} }), json({ data: [{ id: 'image-model' }] }), json({ data: [] })];
      assert.match((await legacyMedia.testImageGenProvider(async () => responses.shift())).error, /image or video generation catalog/);
    } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
  });

  test(`${build}: locale keys preserve placeholders and neutral media titles`, async () => {
    const { LANGUAGES } = await import(`../src/${build}/src/ui/i18n.js`);
    const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    assert.equal(english['st.imagegen.heading'], 'Generative Media');
    for (const lang of LANGUAGES) {
      const dictionary = (await import(`../src/${build}/src/ui/locales/${lang.code}.js`)).default;
      for (const key of Object.keys(english).filter(key => key.startsWith('st.imagegen.'))) {
        assert.equal(typeof dictionary[key], 'string', `${lang.code}: ${key}`);
        assert.deepEqual([...dictionary[key].matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort(), [...english[key].matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort(), `${lang.code}: ${key}`);
      }
      assert.ok(!dictionary['st.imagegen.heading'].includes('fal.ai'));
      // The image and video model settings are translated in every language.
      if (lang.code !== 'en') {
        for (const key of ['st.imagegen.image_model', 'st.imagegen.video_model', 'st.imagegen.video_workflow', 'st.imagegen.connected_models', 'st.imagegen.hint.openrouter']) {
          assert.notEqual(dictionary[key], english[key], `${lang.code}: ${key} is translated`);
        }
      }
    }

  });
}
