import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  for (const model of ['meta/muse-spark-1.3-contributor', 'meta/muse-wonder']) {
  const config = { providerName: 'webbrain_me', baseUrl: 'https://openrouter.ai/api/v1', model };
  const tools = ['read_page', 'done'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
  test(`${browser}: Muse uses auto and preserves restricted tools in chat and streaming`, () => {
    const provider = new OpenAICompatibleProvider(config);
    for (const stream of [false, true]) {
      for (const choice of [undefined, 'auto', 'required']) {
        const body = provider._buildChatCompletionsBody([], { tools, toolChoice: choice }, stream);
        assert.equal(body.tool_choice, 'auto');
        assert.deepEqual(body.tools, tools);
      }
      const body = provider._buildChatCompletionsBody([], { tools, toolChoice: { type: 'function', function: { name: 'done' } } }, stream);
      assert.equal(body.tool_choice, 'auto');
      assert.deepEqual(body.tools, [tools[1]]);
      const none = provider._buildChatCompletionsBody([], { tools, toolChoice: 'none' }, stream);
      assert.equal(Object.hasOwn(none, 'tools'), false);
      assert.equal(Object.hasOwn(none, 'tool_choice'), false);
    }
    assert.throws(() => provider._buildChatCompletionsBody([], { tools, toolChoice: { function: { name: 'missing' } } }), /not available/);
  });
  test(`${browser}: other models/endpoints retain their tool choices`, () => {
    const named = { type: 'function', function: { name: 'done' } };
    for (const other of [{ ...config, model: 'other-model' }, { ...config, baseUrl: 'https://api.example.com/v1' }, { ...config, baseUrl: 'https://openrouter.ai.example.com/v1' }]) {
      const body = new OpenAICompatibleProvider(other)._buildChatCompletionsBody([], { tools, toolChoice: named });
      assert.deepEqual(body.tool_choice, named);
      assert.deepEqual(body.tools, tools);
    }
    const variant = new OpenAICompatibleProvider({ ...config, model: config.model + ':nitro' });
    assert.equal(variant._buildChatCompletionsBody([], { tools, toolChoice: 'required' }).tool_choice, 'auto');
  });
  test(`${browser}: Muse Responses builder applies the same tool restriction`, () => {
    const provider = new OpenAICompatibleProvider(config);
    const body = provider._buildResponsesBody([], { tools, toolChoice: { function: { name: 'done' } } });
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, 'done');
  });
  test(`${browser}: Muse classifiers use minimal reasoning and sufficient output budget`, () => {
    const provider = new OpenAICompatibleProvider(config);
    for (const stream of [false, true]) {
      for (const maxTokens of [24, 64, 2048]) {
        const body = provider._buildChatCompletionsBody([], { maxTokens, toolChoice: 'none' }, stream);
        assert.equal(body.max_tokens, 2048);
        assert.deepEqual(body.reasoning, { effort: 'minimal' });
        assert.equal(Object.hasOwn(body, 'tool_choice'), false);
      }
      const disabled = provider._buildChatCompletionsBody([], { maxTokens: 4096, extraBody: { reasoning: { enabled: false } } }, stream);
      assert.deepEqual(disabled.reasoning, { effort: 'minimal' });
      assert.equal(disabled.max_tokens, 4096);
      const toolCall = provider._buildChatCompletionsBody([], { maxTokens: 64, tools, toolChoice: 'required' }, stream);
      assert.equal(toolCall.max_tokens, 64);
      assert.equal(Object.hasOwn(toolCall, 'reasoning'), false);
      const regular = new OpenAICompatibleProvider({ ...config, model: 'other-model' })._buildChatCompletionsBody([], { maxTokens: 64 });
      assert.equal(regular.max_tokens, 64);
      assert.equal(Object.hasOwn(regular, 'reasoning'), false);
    }
  });
  }
}
