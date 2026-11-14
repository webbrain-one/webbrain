import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const browser of ['chrome', 'firefox']) {
  const prefix = path.join(ROOT, 'src', browser, 'src');
  const { ADDITIONAL_PROVIDER_DEFAULTS, ADDITIONAL_PROVIDER_UI } = await import(
    pathToFileURL(path.join(prefix, 'providers', 'provider-catalog.js')).href
  );

  const apiRoute = ADDITIONAL_PROVIDER_DEFAULTS['api-route'];
  assert.equal(apiRoute.type, 'openai');
  assert.equal(apiRoute.baseUrl, 'https://global.api-route.com/v1');
  assert.equal(apiRoute.model, 'gpt-6.1-sol');
  assert.equal(apiRoute.contextWindow, 32768);
  assert.equal(apiRoute.enabled, false);
  assert.equal(apiRoute.apiKey, '');
  assert.equal(apiRoute.supportsVision, true);
  assert.equal(apiRoute.supportsTools, true);
  assert.equal(apiRoute.supportsAskStreaming, true);
  assert.deepEqual(ADDITIONAL_PROVIDER_UI['api-route'].suggestions, ['gpt-6.1-sol']);
  const { providerIconUrl } = await import(pathToFileURL(path.join(prefix, 'ui', 'provider-icons.js')).href);
  assert.ok(providerIconUrl('api-route').endsWith('/api-route.png'));

  const cloudgpu = ADDITIONAL_PROVIDER_DEFAULTS.cloudgpu;
  assert.equal(cloudgpu.type, 'openai', `${browser}: CloudGPU must use the OpenAI-compatible adapter`);
  assert.equal(cloudgpu.baseUrl, 'https://cloudgpu.app/v1', `${browser}: CloudGPU endpoint changed`);
  assert.equal(cloudgpu.model, 'deepseek-v4-flash');
  assert.equal(cloudgpu.contextWindow, 131072);
  assert.equal(cloudgpu.enabled, false);
  assert.equal(cloudgpu.apiKey, '');
  assert.equal(cloudgpu.supportsTools, true);
  assert.equal(cloudgpu.supportsAskStreaming, true);
  assert.ok(providerIconUrl('cloudgpu').endsWith('/cloudgpu.svg'));

  const standardcompute = ADDITIONAL_PROVIDER_DEFAULTS.standardcompute;
  assert.equal(standardcompute.type, 'openai', `${browser}: Standard Compute must use the OpenAI-compatible adapter`);
  assert.equal(standardcompute.baseUrl, 'https://api.stdcmpt.com/v1', `${browser}: Standard Compute endpoint changed`);
  assert.equal(standardcompute.model, 'StandardCompute');
  assert.equal(standardcompute.contextWindow, 1000000);
  assert.equal(standardcompute.enabled, false);
  assert.equal(standardcompute.apiKey, '');
  assert.equal(standardcompute.supportsTools, true);
  assert.equal(standardcompute.supportsAskStreaming, true);
  assert.ok(providerIconUrl('standardcompute').endsWith('/standardcompute.svg'));

  const runcrate = ADDITIONAL_PROVIDER_DEFAULTS.runcrate;
  assert.equal(runcrate.type, 'openai', `${browser}: Runcrate must use the OpenAI-compatible adapter`);
  assert.equal(runcrate.baseUrl, 'https://api.runcrate.ai/v1', `${browser}: Runcrate endpoint changed`);
  assert.equal(runcrate.model, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(runcrate.contextWindow, 1048576);
  assert.equal(runcrate.enabled, false);
  assert.equal(runcrate.apiKey, '');
  assert.equal(runcrate.supportsTools, true);
  assert.equal(runcrate.supportsAskStreaming, true);
  assert.ok(providerIconUrl('runcrate').endsWith('/runcrate.svg'));

  const ioNet = ADDITIONAL_PROVIDER_DEFAULTS['io-net'];
  assert.equal(ioNet.type, 'openai', `${browser}: IO.NET must use the OpenAI-compatible adapter`);
  assert.equal(ioNet.baseUrl, 'https://api.intelligence.io.solutions/api/v1', `${browser}: IO.NET endpoint changed`);
  assert.ok(ioNet.model, `${browser}: IO.NET needs a default model`);

  const synthetic = ADDITIONAL_PROVIDER_DEFAULTS.synthetic;
  assert.equal(synthetic.type, 'openai', `${browser}: Synthetic must use the OpenAI-compatible adapter`);
  assert.equal(synthetic.baseUrl, 'https://api.synthetic.new/openai/v1', `${browser}: Synthetic endpoint changed`);
  assert.ok(synthetic.model, `${browser}: Synthetic needs a default model`);

  const freebuff = ADDITIONAL_PROVIDER_DEFAULTS.freebuff2api;
  assert.equal(freebuff.type, 'openai', `${browser}: Freebuff2API must use the OpenAI-compatible adapter`);
  assert.equal(freebuff.category, 'local', `${browser}: Freebuff2API must be a local proxy card`);
  assert.equal(freebuff.baseUrl, 'http://127.0.0.1:8080/v1', `${browser}: Freebuff2API default endpoint changed`);
  assert.equal(freebuff.requiresModel, true, `${browser}: Freebuff2API must require a selected model`);
  assert.equal(freebuff.requiresApiKey, undefined, `${browser}: Freebuff2API API key must remain optional`);
  assert.equal(ADDITIONAL_PROVIDER_UI.freebuff2api.apiKeyPlaceholder, 'Optional proxy API key', `${browser}: Freebuff2API API key hint changed`);

  const manager = fs.readFileSync(path.join(prefix, 'providers', 'manager.js'), 'utf8');
  assert.match(manager, /LOCAL_MODEL_LIST_PROVIDER_IDS = \[[^\]]*'freebuff2api'/, `${browser}: Freebuff2API model discovery is not enabled`);

  // Exercise the upgrade/save/reload path and actual adapter transport. Adding
  // a catalog entry must make it available to existing installations without
  // replacing their selected model or requiring a storage reset.
  const originalChrome = globalThis.chrome;
  const originalBrowser = globalThis.browser;
  const originalFetch = globalThis.fetch;
  const stored = {
    activeProvider: 'openai',
    providers: { openai: { configured: true, apiKey: 'existing-test-key', model: 'gpt-5.6-terra' } },
  };
  globalThis.chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.map(key => [key, structuredClone(stored[key])])); },
      async set(values) { Object.assign(stored, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; },
    } },
  };
  globalThis.browser = globalThis.chrome;
  try {
    const { ProviderManager } = await import(pathToFileURL(path.join(prefix, 'providers', 'manager.js')).href);
    const providers = new ProviderManager();
    await providers.load();
    assert.equal(providers.activeProviderId, 'openai', `${browser}: new provider must not change the user's selection`);
    const added = providers.getAll().abliteration;
    assert.ok(added, `${browser}: existing installations receive Abliteration.ai`);
    assert.equal(added.configured, false);
    assert.equal(added.enabled, false);
    assert.equal(added.apiKey, '');
    assert.equal(added.model, 'abliterated-model-large-flash');
    assert.ok(ADDITIONAL_PROVIDER_UI.abliteration.suggestions.includes(added.model));

    await providers.updateProvider('abliteration', { apiKey: 'synthetic-abliteration-key' });
    assert.equal(providers.activeProviderId, 'openai', `${browser}: saving a provider does not select it`);
    await providers.setActive('abliteration');
    const reloaded = new ProviderManager();
    await reloaded.load();
    assert.equal(reloaded.activeProviderId, 'abliteration');
    const provider = reloaded.getActive();
    assert.equal(provider.config.configured, true);
    assert.equal(provider.model, 'abliterated-model-large-flash');
    assert.equal(provider.contextWindow, 1048576);
    assert.equal(provider.maxOutputTokens, 262144);
    assert.equal(provider.supportsVision, true);
    assert.equal(provider.supportsTools, true);
    assert.equal(provider.supportsAskStreaming, true);
    assert.equal(provider.maxImagesPerRequest, 4);
    assert.deepEqual(Object.entries(ADDITIONAL_PROVIDER_DEFAULTS)
      .filter(([, config]) => config.maxImagesPerRequest != null).map(([id]) => id), ['abliteration'],
    'The new image-count limit applies only to Abliteration');

    const requests = [];
    const tools = [{ type: 'function', function: { name: 'read_page', parameters: { type: 'object', properties: {} } } }];
    const toolCall = { id: 'test-read-page', type: 'function', function: { name: 'read_page', arguments: '{}' } };
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url: String(url), headers: new Headers(options.headers), body });
      return body.stream
        ? new Response('data: {"choices":[{"delta":{"content":"Ready"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        : Response.json({ choices: [{ message: { content: '', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] });
    };
    const messages = [{ role: 'user', content: 'Read the current page.' }];
    const result = await provider.chat(messages, { tools, toolChoice: 'auto', maxTokens: 256 });
    assert.deepEqual(result.toolCalls, [toolCall], `${browser}: native tool responses remain usable`);
    assert.deepEqual(requests[0].body.tools, tools);
    assert.equal(requests[0].body.tool_choice, 'auto');
    const chunks = [];
    for await (const chunk of provider.chatStream(messages, { maxTokens: 256 })) chunks.push(chunk);
    assert.equal(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join(''), 'Ready');
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, 'https://api.abliteration.ai/v1/chat/completions');
      assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-abliteration-key');
      assert.equal(request.body.model, 'abliterated-model-large-flash');
      assert.deepEqual(request.body.messages, messages);
    }
    assert.equal(requests[1].body.stream, true);
    assert.equal(Object.hasOwn(requests[1].body, 'stream_options'), false, 'Do not assume support for optional usage streaming');

    const images = count => Array.from({ length: count }, (_, index) => ({ role: 'user', content: [
      { type: 'text', text: `[UNTRUSTED USER ATTACHMENTS: image ${index + 1}]` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${index}` } },
    ] }));
    const fourImages = images(4);
    const fiveImages = images(5);
    const snapshot = JSON.stringify(fiveImages);
    const overLimit = error => error.code === 'provider_image_limit'
      && error.imageCount === 5 && error.maxImagesPerRequest === 4;
    for (const stream of [false, true]) {
      assert.deepEqual(provider._buildChatCompletionsBody(fourImages, {}, stream).messages, fourImages);
      assert.equal(provider._buildResponsesBody(fourImages, {}, stream).input.length, 4);
      assert.throws(() => provider._buildChatCompletionsBody(fiveImages, {}, stream), overLimit);
      assert.throws(() => provider._buildResponsesBody(fiveImages, {}, stream), overLimit);
    }
    // Both transports reject before fetch, leaving the user's image evidence
    // intact instead of hiding the fifth attachment from the model.
    await assert.rejects(() => provider.chat(fiveImages), overLimit);
    await assert.rejects(async () => { for await (const _ of provider.chatStream(fiveImages)) {} }, overLimit);
    assert.equal(requests.length, 2, 'An oversized request must never reach the network');
    assert.equal(JSON.stringify(fiveImages), snapshot, 'Image validation must not mutate history');

    const unlimited = new provider.constructor({ ...provider.config, providerName: 'openai', maxImagesPerRequest: undefined });
    assert.equal(unlimited.maxImagesPerRequest, null);
    assert.deepEqual(unlimited._buildChatCompletionsBody(fiveImages).messages, fiveImages,
      'Providers without a declared image-count limit keep their existing behavior');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = originalBrowser;
    globalThis.fetch = originalFetch;
  }
}

console.log('provider catalog integration tests passed');
