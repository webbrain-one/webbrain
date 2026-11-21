import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const browser of ['chrome', 'firefox']) {
  const prefix = path.join(ROOT, 'src', browser, 'src');
  const { BaseLLMProvider } = await import(pathToFileURL(path.join(prefix, 'providers', 'base.js')).href);
  const { inferContextWindow, inferMaxOutputTokens, resolveMaxOutputTokens } = await import(
    pathToFileURL(path.join(prefix, 'providers', 'context-windows.js')).href
  );

  assert.equal(new BaseLLMProvider({}).maxOutputTokens, 4096, `${browser}: legacy output fallback changed`);
  assert.equal(new BaseLLMProvider({ maxOutputTokens: 32768 }).maxOutputTokens, 32768, `${browser}: configured output budget ignored`);
  assert.equal(inferMaxOutputTokens({}), null, `${browser}: unknown model should not invent an output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'claude-sonnet-5' }), 128000, `${browser}: Sonnet 5 output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'claude-opus-5-5' }), 128000, `${browser}: Opus 5.5 output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'claude-sonnet-5-5' }), 128000, `${browser}: Sonnet 5.5 output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'claude-haiku-5-5' }), 128000, `${browser}: Haiku 5.5 output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'claude-haiku-4-5' }), 64000, `${browser}: Haiku 4.5 output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'anthropic.claude-haiku-4-5' }), 64000, `${browser}: Bedrock Haiku slug should match`);
  assert.equal(inferMaxOutputTokens({ model: 'gpt-6.2-sol' }), 128000, `${browser}: GPT-6.2 Sol output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'gpt-6.2-astra' }), 128000, `${browser}: GPT-6.2 Astra output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'gpt-6.1-sol' }), 128000, `${browser}: GPT-6.1 Sol output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'gemini-4-neon' }), 65536, `${browser}: Gemini 4 Neon output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'gemini-4-hydrogen' }), 65536, `${browser}: Gemini 4 Hydrogen output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'gemini-4-carbon' }), 65536, `${browser}: Gemini 4 Carbon output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'gpt-5.6-terra' }), 128000, `${browser}: GPT-5.6 output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'gpt-4o' }), 16384, `${browser}: GPT-4o output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'deepseek-v4-flash' }), 384000, `${browser}: DeepSeek V4 output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'deepseek-flash' }), 384000, `${browser}: current DeepSeek output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'deepseek/deepseek-v4.1-flash-1017' }), 384000, `${browser}: OpenRouter DeepSeek V4.1 snapshot output ceiling`);
  assert.equal(inferMaxOutputTokens({ model: 'deepseek-v4-pro' }), 8192, `${browser}: retired DeepSeek Pro stays conservative`);
  assert.equal(inferMaxOutputTokens({ model: 'deepseek-chat' }), 8192, `${browser}: legacy DeepSeek chat output ceiling`);
  assert.equal(inferContextWindow({ category: 'router', model: 'deepseek/deepseek-v4.1-flash-1017' }), 1000000, `${browser}: OpenRouter DeepSeek V4.1 snapshot context window`);
  assert.equal(inferContextWindow({ category: 'router', model: 'deepseek/deepseek-v4.1-flash' }), 1000000, `${browser}: OpenRouter DeepSeek V4.1 alias context window`);
  assert.equal(
    resolveMaxOutputTokens({ model: 'claude-haiku-4-5', maxOutputTokens: 128000 }),
    64000,
    `${browser}: card-wide Anthropic budget must not exceed Haiku's ceiling`,
  );
  assert.equal(
    resolveMaxOutputTokens({ model: 'claude-sonnet-5', maxOutputTokens: 128000 }),
    128000,
    `${browser}: default Anthropic model should keep the 128k budget`,
  );
  assert.equal(
    resolveMaxOutputTokens({ model: 'claude-haiku-4-5', maxOutputTokens: 4096 }),
    4096,
    `${browser}: a smaller user budget should still win`,
  );
  assert.equal(
    new BaseLLMProvider({ model: 'claude-haiku-4-5', maxOutputTokens: 128000 }).maxOutputTokens,
    64000,
    `${browser}: provider getter must clamp merged Anthropic default to Haiku`,
  );
  assert.equal(
    new BaseLLMProvider({ model: 'gpt-4o', maxOutputTokens: 128000 }).maxOutputTokens,
    16384,
    `${browser}: provider getter must clamp merged OpenAI default to GPT-4o`,
  );
  assert.equal(
    new BaseLLMProvider({ model: 'deepseek-chat', maxOutputTokens: 384000 }).maxOutputTokens,
    8192,
    `${browser}: provider getter must clamp merged DeepSeek default to legacy chat`,
  );

  const manager = fs.readFileSync(path.join(prefix, 'providers', 'manager.js'), 'utf8');
  const openai = manager.slice(manager.indexOf('      openai: {'), manager.indexOf('      anthropic: {'));
  assert.match(openai, /contextWindow: 272000/, `${browser}: OpenAI context window should default to the standard-price 272k threshold`);
  assert.match(openai, /maxOutputTokens: 128000/, `${browser}: OpenAI output budget should be 128k`);

  const anthropic = manager.slice(manager.indexOf('      anthropic: {'), manager.indexOf('      gemini: {'));
  assert.match(anthropic, /contextWindow: 1000000/, `${browser}: Anthropic context window should be 1M`);
  assert.match(anthropic, /maxOutputTokens: 128000/, `${browser}: Anthropic output budget should be 128k`);

  const deepseek = manager.slice(manager.indexOf('deepseek: {'), manager.indexOf('xai: {'));
  assert.match(deepseek, /contextWindow: 1000000/, `${browser}: DeepSeek context window should be 1M`);
  assert.match(deepseek, /maxOutputTokens: 384000/, `${browser}: DeepSeek output budget should be 384k`);
  assert.match(manager, /DUPLICATE_BLANK_CONFIG_KEYS[\s\S]*?'maxOutputTokens'/, `${browser}: duplicate providers should not inherit the output override`);

  const settings = fs.readFileSync(path.join(prefix, 'ui', 'settings.js'), 'utf8');
  assert.match(settings, /const MAX_OUTPUT_TOKENS_FIELD = \{[\s\S]*?key: 'maxOutputTokens'/, `${browser}: max output field missing`);
  assert.match(settings, /labelKey: 'st\.provider\.field\.max_output_tokens'/, `${browser}: max output field label is not translatable`);
  assert.match(settings, /if \(!keys\.has\('contextWindow'\)\) definition\.fields\.push\(CONTEXT_WINDOW_FIELD\)/, `${browser}: context window is not exposed globally`);
  assert.match(settings, /if \(!keys\.has\('maxOutputTokens'\)\) definition\.fields\.push\(MAX_OUTPUT_TOKENS_FIELD\)/, `${browser}: max output is not exposed globally`);

  const enLocale = fs.readFileSync(path.join(prefix, 'ui', 'locales', 'en.js'), 'utf8');
  assert.match(enLocale, /'st\.provider\.field\.max_output_tokens': 'Max output \(tokens\)'/, `${browser}: max output label key missing from en locale`);

  const agent = fs.readFileSync(path.join(prefix, 'agent', 'agent.js'), 'utf8');
  assert.match(agent, /const mainMaxTokens = this\._providerMaxOutputTokens\(provider\)/, `${browser}: provider output budget is not resolved`);
  assert.match(agent, /return resolveMaxOutputTokens\(config, fallback\)/, `${browser}: main generation does not clamp to the selected model`);
  assert.match(agent, /maxTokens: mainMaxTokens/, `${browser}: main generation ignores the provider output budget`);
  assert.doesNotMatch(agent, /const chatOpts = \{ tools:[^\n]+maxTokens: 4096 \}/, `${browser}: main generation still hard-codes 4k`);
}

console.log('provider model limit tests passed');
