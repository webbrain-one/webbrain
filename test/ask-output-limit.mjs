import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { supplyReadOnlyCloudIntent } from './lib/cloud-intent-fixture.mjs';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://fixture/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.invalid/', title: 'Fixture' }),
    query: async () => [{ id: 7, url: 'https://example.invalid/', title: 'Fixture' }],
    update: async () => {}, sendMessage: async () => ({}), executeScript: async () => [null] },
  scripting: { executeScript: async () => [{ result: null }] }, webNavigation: { getAllFrames: async () => [] },
};
globalThis.chrome = globalThis.browser = api;
let nextTab = 8200;
const limits = [
  { finishReason: 'length' }, { finishReason: 'max_tokens' }, { finishReason: 'max_output_tokens' },
  { finishReason: 'max_completion_tokens' }, { finishReason: 'output_limit' },
  { finish_reason: 'length' }, { stopReason: 'max_tokens' }, { stop_reason: 'max_tokens' },
  { raw: { choices: [{ finish_reason: 'length' }] } }, { outputTruncated: true },
];

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createCloudRunController } = await import(`../src/${build}/src/cloud-runs.js`);
  const { outputLimitNotice, outputLimitedAnswer } = await import(`../src/${build}/src/agent/model-output-diagnostics.js`);
  const { normalizeErrorCode } = await import(`../src/${build}/src/trace/error-codes.js`);
  const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);

  test(`${build}: content-free trace export preserves the output-limit outcome`, () => {
    assert.equal(normalizeErrorCode('OUTPUT_LIMIT'), 'OUTPUT_LIMIT');
    assert.deepEqual(projectTraceEventData('turn_end', {
      status: 'partial', code: 'OUTPUT_LIMIT', outputLimited: true,
      content: 'Private answer', finishReason: 'private-provider-detail',
    }), { status: 'partial', code: 'OUTPUT_LIMIT', outputLimited: true });
  });

  function harness(reply, { stream = false, strict = true, locale = 'en', allowance = null } = {}) {
    const requests = [], updates = [], traces = [], dispatched = [];
    const content = reply.content ?? 'alpha beta ga';
    const provider = { name: 'fixture', model: 'fixture', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false,
      chat: async () => { requests.push('chat'); return { content, toolCalls: [], ...reply }; },
      chatStream: async function* () {
        requests.push('stream');
        if (content) yield { type: 'text', content };
        if (allowance) yield { type: 'usage', usage: { completion_tokens: 1 } };
        yield { type: 'done', ...reply };
      },
    };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    supplyReadOnlyCloudIntent(agent);
    agent.strictGuards = strict;
    agent.maxSteps = 4;
    agent._skipPermissionGate = true;
    agent._hydrate = async () => {};
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    // Start a trace in both entry points without making a second model call
    // for the unrelated read-scope classifier.
    agent._readCompletenessNeedsScopeClassification = () => true;
    agent._runReadScopeClassifier = async () => ({ proceed: true, readScope: 'visible_page' });
    agent._startTraceRun = async () => 'output-limit-fixture';
    agent._endTraceRun = async () => {};
    const terminalPayload = agent._traceTurnEndPayload.bind(agent);
    agent._traceTurnEndPayload = (...args) => {
      const payload = terminalPayload(...args);
      traces.push(payload);
      return payload;
    };
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, value) => ({ role: 'user', content: value });
    agent._manageContext = async () => {};
    agent._checkCostAllowance = async () => null;
    agent._recordCostUsage = async () => allowance;
    agent._currentUrl = async () => 'https://example.invalid/';
    agent._maybeReinjectAdapter = async () => {};
    agent._ensureProgressSessionForCurrentTask = async () => ({ mode: 'inactive' });
    agent.executeTool = async (_tab, name) => { dispatched.push(name); throw new Error('Unexpected browser dispatch'); };
    const original = agent.processMessage.bind(agent);
    agent.processMessage = (tab, message, update, mode, attachments, options) => {
      const publish = (type, data) => { updates.push({ type, data }); update(type, data); };
      const opts = { ...options, locale };
      return stream ? agent.processMessageStream(tab, message, publish, mode, { ...opts, attachments })
        : original(tab, message, publish, mode, attachments, opts);
    };
    const controller = createCloudRunController({ chromeApi: api, agent, ensureOffscreen: async () => {} });
    return { agent, provider, requests, updates, traces, dispatched,
      async run() {
        const started = await controller.startRun({ tabId: nextTab++, task: 'Return this supplied sequence verbatim: alpha beta gamma', mode: 'ask' });
        for (let i = 0; i < 200; i++) {
          const snapshot = await controller.status({ runId: started.runId });
          if (!['running', 'aborting'].includes(snapshot.status)) return snapshot;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail('Output-limit finalization must be bounded');
      } };
  }

  for (const stream of [false, true]) {
    for (const strict of [false, true]) {
      test(`${build}: ${stream ? 'streaming' : 'normal'} output-limit finals stay partial (strict=${strict})`, async () => {
        for (const limit of limits) {
          const h = harness(limit, { stream, strict });
          const result = await h.run();
          assert.equal(result.status, 'failed', JSON.stringify(limit)); // Cloud API maps partial outcomes to failed, retaining their result.
          assert.match(result.error, /\(partial\)/);
          assert.equal(result.result, outputLimitedAnswer('alpha beta ga'));
          assert.equal(h.requests.length, 1, 'No automatic regeneration or replay');
          assert.deepEqual(h.dispatched, []);
          assert.equal(h.updates.filter(update => update.type === 'warning' && update.data?.code === 'OUTPUT_LIMIT').length, 1);
          assert.equal(h.updates.filter(update => update.type === 'run_status' && update.data?.status === 'partial').length, 1);
          const terminal = h.traces.at(-1);
          assert.equal(terminal.status, 'partial');
          assert.equal(terminal.code, 'OUTPUT_LIMIT');
          assert.equal(terminal.outputLimited, true);
        }
      });
    }

    test(`${build}: ${stream ? 'streaming' : 'normal'} normal stops and content-filter finals keep existing behavior`, async () => {
      for (const reply of [{ finishReason: 'stop' }, { finishReason: 'end_turn' }, { finishReason: 'content_filter' }, {}]) {
        const h = harness({ ...reply, content: 'A complete answer.' }, { stream });
        const result = await h.run();
        assert.equal(result.status, 'completed');
        assert.equal(result.result, 'A complete answer.');
        assert.equal(h.updates.some(update => update.data?.code === 'OUTPUT_LIMIT'), false);
      }
    });

    test(`${build}: ${stream ? 'streaming' : 'normal'} cut-off text, code fences, and allowance notice are retained`, async () => {
      const content = '```js\nconst item =';
      const allowance = 'Fixture cost allowance reached.';
      const h = harness({ content, finishReason: 'length', costAllowanceMessage: allowance }, { stream, locale: 'tr-TR', allowance });
      const result = await h.run();
      assert.equal(result.status, 'failed');
      assert.equal(result.result, outputLimitedAnswer(`${content}\n\n${allowance}`, 'tr-TR'));
      assert.ok(result.result.indexOf(outputLimitNotice('tr')) < result.result.indexOf('```js'));
      assert.equal(h.requests.length, 1);
    });

    test(`${build}: ${stream ? 'streaming' : 'normal'} empty budget exhaustion keeps bounded empty-response recovery`, async () => {
      const h = harness({ content: '', finishReason: 'length' }, { stream });
      const result = await h.run();
      assert.equal(result.status, 'failed');
      assert.equal(h.requests.length, 2);
      assert.equal(h.updates.some(update => update.data?.code === 'OUTPUT_LIMIT'), false);
      assert.equal(h.traces.at(-1).code, 'EMPTY_RESPONSE');
    });
  }

  test(`${build}: the interactive Ask stream adapter retains worker output-limit flags`, async () => {
    const h = harness({ outputTruncated: true, raw: { choices: [{ finish_reason: 'length' }] } });
    const result = await h.agent._chatStreamWithCostAllowance(h.provider, [{ role: 'user', content: 'Example' }],
      { maxTokens: 64 }, h.agent._newCostRunState(), { tabId: nextTab++ });
    assert.equal(result.outputTruncated, true);
    assert.equal(result.finishReason, 'length');
  });
}

test('runtime notice translations cover supported locales and remain browser-identical', async () => {
  const read = build => fs.readFileSync(new URL(`../src/${build}/src/ui/locales/output-limit-copy.mjs`, import.meta.url), 'utf8');
  assert.equal(read('chrome'), read('firefox'));
  const { outputLimitNotices, outputLimitNotice } = await import('../src/chrome/src/ui/locales/output-limit-copy.mjs');
  const locales = fs.readdirSync(new URL('../src/chrome/src/ui/locales/', import.meta.url)).filter(name => /^[a-z]+\.js$/.test(name));
  for (const locale of locales) assert.ok(outputLimitNotices[locale.slice(0, -3)]?.trim(), locale);
  assert.equal(outputLimitNotice('zh_CN'), outputLimitNotices.zh);
  assert.equal(outputLimitNotice('unknown'), outputLimitNotices.en);
  assert.equal(outputLimitNotice('constructor'), outputLimitNotices.en);
});
