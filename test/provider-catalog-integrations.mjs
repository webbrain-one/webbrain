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
}

console.log('provider catalog integration tests passed');
