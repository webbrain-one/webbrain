#!/usr/bin/env node
// Live API checks using WebBrain's production provider. Tool observations are
// supplied fixtures; this is not an end-to-end browser automation benchmark.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const argument = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (args.includes('--help')) {
  console.log('OPENROUTER_API_KEY=... npm run test:frontier:live\nOptional: GEMINI_API_KEY for the direct Google route. Use -- --browser firefox to check Firefox.\nFilter retries with --model MODEL --probe PROBE.\nRuns paid text, streaming, tool round-trip, screenshot and classifier API probes. Prints no credentials.');
  process.exit(0);
}
const browser = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : 'chrome';
assert.ok(['chrome', 'firefox'].includes(browser), 'Browser must be chrome or firefox');
const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
const { plannerRequestBody } = await import(`../src/${browser}/src/providers/provider-compatibility.js`);
const targets = [];
if (process.env.OPENROUTER_API_KEY) {
  for (const model of ['google/gemini-4-argon', 'meta/muse-wonder', 'meta/muse-spark-open']) {
    targets.push({ providerName: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model, apiKey: process.env.OPENROUTER_API_KEY });
  }
}
if (process.env.GEMINI_API_KEY) targets.push({
  providerName: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-4-argon', apiKey: process.env.GEMINI_API_KEY,
});
if (!targets.length) {
  console.error('No live calls made: set OPENROUTER_API_KEY and/or GEMINI_API_KEY, or pass a key file with node --env-file=/path/to/file.');
  process.exit(2);
}
if (argument('--model')) assert.ok(targets.some(config => config.model === argument('--model')), 'Requested model has no configured test key');
if (argument('--probe')) assert.ok([
  'text', 'streaming', 'tool_round_trip', 'streaming_tool_round_trip', 'screenshot', 'short_classifier',
].includes(argument('--probe')), 'Unknown probe');
const image = 'data:image/png;base64,' + (await readFile(new URL('../src/chrome/assets/vision-connection-test.png', import.meta.url))).toString('base64');
const tools = [{ type: 'function', function: {
  name: 'read_page', description: 'Read the currently selected page title.', parameters: { type: 'object', properties: {}, additionalProperties: false },
} }];
let failures = 0;
for (const config of targets) {
  if (argument('--model') && argument('--model') !== config.model) continue;
  const provider = new OpenAICompatibleProvider(config);
  const probe = async (name, fn) => {
    if (argument('--probe') && argument('--probe') !== name) return;
    const started = Date.now();
    try {
      await fn();
      console.log(JSON.stringify({ browser, provider: config.providerName, model: config.model, probe: name, passed: true, latencyMs: Date.now() - started }));
    } catch (error) {
      failures++;
      // Extract only the error message; metadata can contain account IDs.
      let detail = String(error.message || error.name);
      if (error.httpStatus) {
        try {
          const parsed = JSON.parse(detail.slice(detail.indexOf('{')));
          const raw = parsed.error?.metadata?.raw;
          detail = (typeof raw === 'string' ? JSON.parse(raw)?.error?.message : null)
            || parsed.error?.message || `HTTP ${error.httpStatus}`;
        } catch { detail = `HTTP ${error.httpStatus}`; }
      }
      console.log(JSON.stringify({ browser, provider: config.providerName, model: config.model, probe: name, passed: false,
        error: detail.replaceAll(config.apiKey, '[REDACTED]').replace(/sk-or-v1-[a-zA-Z0-9]+/g, '[REDACTED]').slice(0, 600) }));
    }
  };
  const options = () => ({ maxTokens: 4096, signal: AbortSignal.timeout(180000) });
  await probe('text', async () => {
    const nonce = `WB_${randomUUID()}`;
    const result = await provider.chat([{ role: 'user', content: `Reply with exactly ${nonce}` }], options());
    assert.ok(result.content.includes(nonce), 'Visible text must contain the requested nonce');
  });
  await probe('streaming', async () => {
    const nonce = `WB_${randomUUID()}`;
    let text = '', terminal = false;
    for await (const chunk of provider.chatStream([{ role: 'user', content: `Reply with exactly ${nonce}` }], options())) {
      if (chunk.type === 'text') text += chunk.content;
      if (chunk.type === 'done') terminal = true;
    }
    assert.ok(terminal && text.includes(nonce), 'Stream must finish and contain the requested nonce');
  });
  for (const stream of [false, true]) await probe(stream ? 'streaming_tool_round_trip' : 'tool_round_trip', async () => {
    const messages = [{ role: 'user', content: 'Call read_page once, then repeat its returned page title exactly.' }];
    const callOptions = { ...options(), tools, toolChoice: 'required' };
    const result = stream
      ? await new Agent({})._chatStreamWithCostAllowance(provider, messages, callOptions, null)
      : await provider.chat(messages, callOptions);
    assert.equal(result.toolCalls?.length, 1, 'Must return one native call');
    const call = result.toolCalls[0];
    assert.equal(call.function?.name, 'read_page');
    assert.deepEqual(JSON.parse(call.function.arguments), {});
    const title = `WebBrain probe ${randomUUID()}`;
    const assistant = Agent.prototype._withResponseItems(
      { role: 'assistant', content: result.content || '', tool_calls: result.toolCalls },
      result.responseItems, result.reasoningContent, provider,
    );
    messages.push(assistant,
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ title }) });
    const followUp = await provider.chat(messages, { ...options(), tools, toolChoice: 'none' });
    assert.ok(followUp.content.includes(title), 'Follow-up must read the supplied tool result');
  });
  await probe('screenshot', async () => {
    assert.equal(provider.supportsVision, true);
    const result = await provider.chat([{ role: 'user', content: [
      { type: 'text', text: 'Read the code printed in this image. Reply only with the code.' },
      { type: 'image_url', image_url: { url: image } },
    ] }], options());
    assert.match(result.content, /\bWB7\b/i, 'Must read the image-only code');
  });
  await probe('short_classifier', async () => {
    const result = await provider.chat([{ role: 'user', content: 'Return only this JSON object: {"ready":true}' }], {
      ...options(), maxTokens: 24, toolChoice: 'none', extraBody: plannerRequestBody(config),
    });
    const json = result.content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    assert.deepEqual(JSON.parse(json), { ready: true });
  });
}
process.exitCode = failures ? 1 : 0;
