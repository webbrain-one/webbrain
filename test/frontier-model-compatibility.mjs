import { test } from 'node:test';
import assert from 'node:assert/strict';

const models = ['google/gemini-4-argon', 'meta/muse-wonder', 'meta/muse-spark-open'];
const tools = [{ type: 'function', function: { name: 'read_page', parameters: { type: 'object', properties: {} } } }];

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const { inferMaxOutputTokens, inferContextWindow } = await import(`../src/${browser}/src/providers/context-windows.js`);
  const { plannerRequestBody } = await import(`../src/${browser}/src/providers/provider-compatibility.js`);
  const router = model => ({ providerName: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model });

  test(`${browser}: launch models expose vision, tools and full context with overrides intact`, () => {
    for (const model of models) {
      const config = router(model);
      const provider = new OpenAICompatibleProvider(config);
      assert.equal(provider.supportsVision, true, model);
      assert.equal(provider.supportsTools, true, model);
      assert.equal(provider.contextWindow, 1048576, model);
      assert.equal(new OpenAICompatibleProvider({ ...config, visionMode: 'off' }).supportsVision, false);
      assert.equal(new OpenAICompatibleProvider({ ...config, supportsVision: false }).supportsVision, false);
      assert.equal(new OpenAICompatibleProvider({ ...config, contextWindow: 16384 }).contextWindow, 16384);
      assert.equal(inferContextWindow({ ...config, category: 'local' }), 16384);
      assert.equal(new OpenAICompatibleProvider(router(`${model}:nitro`)).supportsVision, true);
      assert.equal(inferMaxOutputTokens(config), model.includes('argon') ? 65536 : 943718);
    }
    assert.equal(new OpenAICompatibleProvider(router('meta/muse-voice-transcribe')).supportsVision, false);
    assert.equal(new OpenAICompatibleProvider(router('meta/muse-wonderful')).supportsVision, false);
  });

  test(`${browser}: mandatory reasoning survives classifier overrides without disabling native tools`, () => {
    for (const model of models) {
      const config = router(model);
      const provider = new OpenAICompatibleProvider(config);
      for (const stream of [false, true]) {
        const classifier = provider._buildChatCompletionsBody([], {
          maxTokens: 24, toolChoice: 'none', extraBody: plannerRequestBody(config),
        }, stream);
        assert.equal(classifier.reasoning.effort, model === 'meta/muse-wonder' ? 'minimal' : 'low');
        assert.equal(Object.hasOwn(classifier.reasoning, 'enabled'), false);
        assert.equal(classifier.max_tokens, model.includes('argon') ? 32768 : 2048);
        const body = provider._buildChatCompletionsBody([], { tools, toolChoice: 'required' }, stream);
        assert.equal(body.tool_choice, model === 'meta/muse-wonder' ? 'auto' : 'required');
        assert.deepEqual(body.tools, tools);
        assert.equal(body.stream, stream);
      }
    }
  });

  test(`${browser}: classifier disabling overrides inherited high reasoning`, () => {
    for (const model of models) {
      for (const inherited of [
        { reasoningEffort: 'high' },
        { compat: { reasoningEffort: 'high' } },
        { extraBody: { reasoning: { effort: 'high' } } },
      ]) {
        const config = { ...router(model), ...inherited };
        const provider = new OpenAICompatibleProvider(config);
        for (const stream of [false, true]) {
          const body = provider._buildChatCompletionsBody([], {
            maxTokens: 24, toolChoice: 'none', extraBody: plannerRequestBody(config),
          }, stream);
          assert.equal(body.reasoning.effort, model === 'meta/muse-wonder' ? 'minimal' : 'low', model);
          assert.equal(Object.hasOwn(body.reasoning, 'enabled'), false);
          assert.equal(body.max_tokens, model.includes('argon') ? 32768 : 2048);
          const normal = provider._buildChatCompletionsBody([], { tools, maxTokens: 4096 }, stream);
          assert.equal(normal.reasoning.effort, 'high', 'Normal tool calls retain the configured effort');
        }
      }
    }
  });

  test(`${browser}: Argon normalizes sampling and effort after all custom body merges`, () => {
    const configs = [router(models[0]), {
      providerName: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-4-argon',
    }];
    for (const config of configs) {
      const provider = new OpenAICompatibleProvider({ ...config, reasoningEffort: 'off', extraBody: { temperature: 0.2, top_p: 0.9, top_k: 5 } });
      const body = provider._buildChatCompletionsBody([], { maxTokens: 128000 });
      assert.equal(body.max_tokens, 65536);
      for (const key of ['temperature', 'top_p', 'top_k']) assert.equal(Object.hasOwn(body, key), false);
      assert.equal(config.providerName === 'gemini' ? body.reasoning_effort : body.reasoning.effort, 'low');
      const high = provider._buildChatCompletionsBody([], { extraBody: { reasoning_effort: 'max' } });
      assert.equal(config.providerName === 'gemini' ? high.reasoning_effort : high.reasoning.effort, 'high');
    }
  });

  test(`${browser}: endpoint-scoped launch workarounds preserve unrelated and local contracts`, () => {
    for (const config of [router('other-model'), { ...router(models[0]), baseUrl: 'https://openrouter.ai.example/v1' }, {
      providerName: 'local', category: 'local', model: 'muse-spark-open', baseUrl: 'http://localhost:8000/v1',
    }]) {
      const body = new OpenAICompatibleProvider(config)._buildChatCompletionsBody([], {
        maxTokens: 24, temperature: 0.2, extraBody: { reasoning: { enabled: false } },
      });
      assert.equal(body.max_tokens, 24);
      assert.equal(body.temperature, 0.2);
      assert.deepEqual(body.reasoning, { enabled: false });
    }
  });

  test(`${browser}: nonstream tool calls retain provider signatures for the next request`, async () => {
    const provider = new OpenAICompatibleProvider(router(models[0]));
    const call = { id: 'call-1', type: 'function', function: { name: 'read_page', arguments: '{}' }, extra_content: { google: { thought_signature: 'opaque-test-signature' } } };
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }] }), { headers: { 'Content-Type': 'application/json' } });
    try {
      const result = await provider.chat([{ role: 'user', content: 'Read this page.' }], { tools });
      const body = provider._buildChatCompletionsBody([
        { role: 'assistant', content: '', tool_calls: result.toolCalls },
        { role: 'tool', tool_call_id: call.id, content: 'Page title: Example' },
      ], { tools });
      assert.deepEqual(body.messages[0].tool_calls[0], call);
      assert.equal(body.messages[1].tool_call_id, call.id);
    } finally { globalThis.fetch = original; }
  });

  test(`${browser}: streamed signed calls survive the actual Ask accumulator and replay`, async () => {
    const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
    const agent = new Agent({});
    agent._checkCostAllowance = async () => null;
    agent._recordCostUsage = async () => null;
    const provider = new OpenAICompatibleProvider(router(models[0]));
    const original = globalThis.fetch;
    const deltas = [
      { index: 0, id: 'signed-call', type: 'function', function: { name: 'read_page', arguments: '' }, extra_content: { google: { thought_signature: 'opaque-signature' } } },
      { index: 0, function: { arguments: '{}' } },
    ];
    const events = deltas.map(call => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`).join('')
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = async () => new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
    try {
      const result = await agent._chatStreamWithCostAllowance(provider, [], { tools }, {});
      const body = provider._buildChatCompletionsBody([{ role: 'assistant', content: '', tool_calls: result.toolCalls }], { tools });
      assert.equal(body.messages[0].tool_calls[0].extra_content.google.thought_signature, 'opaque-signature');
      assert.equal(body.messages[0].tool_calls[0].function.arguments, '{}');
    } finally { globalThis.fetch = original; }
  });

  test(`${browser}: OpenRouter reasoning details survive native tool turns with endpoint and model ownership`, async () => {
    const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
    const { serializeConversationForSession } = await import(`../src/${browser}/src/agent/conversation-persistence.js`);
    const agent = new Agent({});
    const config = router(models[0]);
    const provider = new OpenAICompatibleProvider(config);
    const call = { id: 'encrypted-call', type: 'function', function: { name: 'read_page', arguments: '{}' } };
    const details = [{ type: 'reasoning.encrypted', data: 'opaque-block', id: call.id, format: 'google-gemini-v1', index: 0 }];
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [call], reasoning_details: details }, finish_reason: 'tool_calls' }] }));
    try {
      const result = await provider.chat([], { tools });
      const message = agent._withResponseItems({ role: 'assistant', content: '', tool_calls: result.toolCalls }, result.responseItems, '', provider);
      const stored = serializeConversationForSession([message, { role: 'tool', tool_call_id: call.id, content: 'Example' }]).messages;
      const body = provider._buildChatCompletionsBody(stored, { tools });
      assert.deepEqual(body.messages[0].reasoning_details, details);
      assert.equal(Object.hasOwn(body.messages[0], '_reasoning_replay'), false);
      for (const changed of [{ ...config, model: models[1] }, { ...config, baseUrl: 'https://api.example.test/v1' }]) {
        const foreign = new OpenAICompatibleProvider(changed)._buildChatCompletionsBody(stored, { tools });
        assert.equal(Object.hasOwn(foreign.messages[0], 'reasoning_details'), false);
        assert.equal(Object.hasOwn(foreign.messages[0], '_reasoning_replay'), false);
      }
      const edited = structuredClone(stored);
      edited[0].tool_calls[0].id = 'replacement-call';
      assert.equal(Object.hasOwn(provider._buildChatCompletionsBody(edited, { tools }).messages[0], 'reasoning_details'), false);
    } finally { globalThis.fetch = original; }
  });

  test(`${browser}: streamed OpenRouter encrypted fragments reassemble before the tool follow-up`, async () => {
    const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
    const agent = new Agent({});
    agent._checkCostAllowance = async () => null;
    agent._recordCostUsage = async () => null;
    const provider = new OpenAICompatibleProvider(router(models[0]));
    const original = globalThis.fetch;
    const deltas = [
      { reasoning_details: [{ type: 'reasoning.encrypted', data: 'first-', index: 0 }] },
      { reasoning_details: [{ type: 'reasoning.encrypted', data: 'second', index: 0 }], tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_page', arguments: '{}' } }] },
    ];
    const events = deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join('')
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = async () => new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
    try {
      const result = await agent._chatStreamWithCostAllowance(provider, [], { tools }, {});
      const message = agent._withResponseItems({ role: 'assistant', content: '', tool_calls: result.toolCalls }, result.responseItems, '', provider);
      const body = provider._buildChatCompletionsBody([message], { tools });
      assert.deepEqual(body.messages[0].reasoning_details, [{ type: 'reasoning.encrypted', data: 'first-second', index: 0 }]);
    } finally { globalThis.fetch = original; }
  });
}
