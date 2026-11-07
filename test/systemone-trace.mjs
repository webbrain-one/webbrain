import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium, firefox } from 'playwright';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: Jev metadata survives privacy projection without evidence`, async () => {
    const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);
    const { buildTraceStats } = await import(`../src/${build}/src/trace/stats.js`);
    const metadata = { decision: 'usage', model: 'jev-1.13.0', latencyMs: 25, estimatedCostUsd: 0.001,
      usage: { prompt_tokens: 12, completion_tokens: 2, raw: 'secret', cost: null }, evidence: 'secret' };
    for (const includeContent of [false, true]) {
      const data = projectTraceEventData('note', { step: 0, note: 'system_one', extra: metadata }, { includeContent });
      assert.deepEqual(data.extra, { decision: 'usage', model: 'jev-1.13.0', latencyMs: 25, estimatedCostUsd: 0.001,
        usage: { prompt_tokens: 12, completion_tokens: 2 } });
      const stats = buildTraceStats([{ kind: 'note', data }]);
      assert.equal(stats.totalCost, 0.001);
      assert.equal(stats.totalInputTokens, 12);
      assert.equal(stats.totalOutputTokens, 2);
      assert.equal(stats.totalLlmLatencyMs, 25);
      assert.equal(stats.llmRequestCount, 1);
    }
  });

  test(`${build}: done verification attempts keep their engine, outcome and timing, never the evidence`, async () => {
    const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);
    const metadata = { phase: 'done_verification', engine: 'llm', modality: 'vision', outcome: 'failed', reason: 'judged',
      captureMs: 420, evaluateMs: 3100, elapsedMs: 3600, probability: 0.97, confidence: 0.9, laterOutcome: 'asked',
      model: 'owned-model', evidence: 'secret page text', summary: 'secret summary' };
    for (const includeContent of [false, true]) {
      const data = projectTraceEventData('note', { step: 0, note: 'system_one', extra: metadata }, { includeContent });
      assert.deepEqual(data.extra, { phase: 'done_verification', engine: 'llm', modality: 'vision', outcome: 'failed',
        reason: 'judged', model: 'owned-model', captureMs: 420, evaluateMs: 3100, elapsedMs: 3600 });
    }
    // A second look that ran out of time keeps its label and the time it had.
    const timedOut = { phase: 'done_verification', engine: 'llm', model: 'owned-model', modality: 'ax', outcome: 'uncertain',
      reason: 'timeout', timeoutMs: 7998, elapsedMs: 8002 };
    for (const includeContent of [false, true]) {
      assert.deepEqual(projectTraceEventData('note', { step: 0, note: 'system_one', extra: timedOut }, { includeContent }).extra, timedOut);
    }
    const unsafe = projectTraceEventData('note', { step: 0, note: 'system_one', extra: {
      engine: 'llm with spaces', outcome: 'x'.repeat(200), captureMs: -1, evaluateMs: Infinity, elapsedMs: '9', timeoutMs: -1 } }, {});
    assert.deepEqual(unsafe.extra, {});
  });

  test(`${build}: completion timing keeps only its numbers and the verdict's names`, async () => {
    const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);
    const timing = { preparationMs: 1200, readingMs: 300, verificationMs: 4100, outcome: 'uncertain', engine: 'legacy',
      summary: 'secret', pageText: 'secret', url: 'https://owned.example.test/private' };
    for (const includeContent of [false, true]) {
      assert.deepEqual(projectTraceEventData('note', { step: 3, note: 'done_timing', extra: timing }, { includeContent }),
        { step: 3, note: 'done_timing', extra: { preparationMs: 1200, readingMs: 300, verificationMs: 4100, outcome: 'uncertain', engine: 'legacy' } });
    }
    assert.deepEqual(projectTraceEventData('note', { step: 0, note: 'done_timing', extra: {
      preparationMs: -5, readingMs: 'x', verificationMs: Infinity, outcome: 'done', engine: 'bad engine' } }, {}).extra, {});
  });

  test(`${build}: late scheduler usage updates durable totals once without reopening the run`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.route('http://jev-trace.local/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
        const file = resolve(`src/${build}`, '.' + path);
        if (!file.startsWith(resolve(`src/${build}`) + sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      await page.goto('http://jev-trace.local/');
      const result = await page.evaluate(async () => {
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ tracingEnabled: true }) } } };
        const trace = await import('/src/trace/recorder.js');
        const stats = await import('/src/trace/stats.js');
        const runId = await trace.startRun({ conversationId: 'test-session' });
        const extra = { decision: 'usage', model: 'jev-1.13.0', latencyMs: 30,
          estimatedCostUsd: 0.001, usage: { prompt_tokens: 10, completion_tokens: 1 }, evidence: 'must disappear' };
        await trace.recordNote(runId, 0, 'system_one', extra);
        await trace.endRun(runId);
        const before = (await trace.listRuns())[0];
        await trace.recordNote(runId, 0, 'system_one', extra);
        await trace.recordNote(runId, 0, 'system_one', { decision: 'downgrade', reason: 'low_confidence' });
        const after = (await trace.listRuns())[0];
        const events = await trace.getRunEvents(runId);
        return { before, after, replay: stats.buildTraceStats(events), events };
      });
      assert.equal(result.before.totalCost, 0.001);
      assert.equal(result.after.totalCost, 0.002);
      assert.equal(result.after.totalInputTokens, 20);
      assert.equal(result.after.llmRequestCount, 2);
      assert.equal(result.after.endedAt, result.before.endedAt);
      assert.equal(result.after.status, 'done');
      assert.equal(result.after.durationMs, result.before.durationMs);
      assert.equal(result.after.totalCost, result.replay.totalCost);
      assert.equal(result.after.totalInputTokens, result.replay.totalInputTokens);
      assert.doesNotMatch(JSON.stringify(result.events), /must disappear/);
    } finally { await browser.close(); }
  });
}
