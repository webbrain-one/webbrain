import test from 'node:test';
import assert from 'node:assert/strict';
for (const browser of ['chrome', 'firefox']) {
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  for (const [label, url, redactOrigin] of [
    ['bare origin', 'https://example.com', false],
    ['root slash', 'https://example.com/', false],
    ['private path', 'https://example.com/private-path?token=secret-value', false],
    ['credential in origin', 'https://example.com', true],
  ]) test(`${browser}: strict diagnostics preserve ${label} evidence without private payloads`, async () => {
    const stored = {};
    const agent = { strictSecretMode: true, isRunning: () => false, abort() {},
      async processMessage(_tab, _task, update, _mode, _attachments, options) {
        if (redactOrigin) {
          update('tool_call', { name: 'type_text', args: { text: 'example.com' } });
          update('tool_result', { name: 'type_text', result: { success: true } });
        }
        update('tool_call', { name: 'research_url', args: { url, query: 'private-query' } });
        update('tool_result', { name: 'research_url', result: { success: false, error: 'Failed to fetch private-error-content', content: 'private-page' } });
        update('tool_call', { name: 'fetch_url', args: { url: 'https://example.com/private-path?token=secret-value' } });
        update('tool_result', { name: 'fetch_url', result: { success: true, status: 200 } });
        update('tool_call', { name: 'read_page', args: {} });
        update('tool_result', { name: 'read_page', result: { text: 'private-page' } });
        update('error', { message: 'Stopped: research_url failed three times for the same read-only resource. private-error-content' });
        options.onRunFinished('loop_stopped');
        return 'Stopped';
      } };
    const api = { storage: { session: { get: async key => ({ [key]: stored[key] }), set: async values => Object.assign(stored, values) } }, tabs: {
      get: async () => ({ id: 7, url: 'https://example.com' }), query: async () => [{ id: 7, url: 'https://example.com' }], update: async () => {},
    } };
    const c = createCloudRunController({ chromeApi: api, agent, ensureOffscreen: async () => {} });
    const started = await c.startRun({ task: 'Read the source' });
    let run;
    for (let i = 0; i < 100; i++) {
      run = await c.status({ runId: started.runId });
      if (run.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(run.status, 'failed');
    const call = run.updates.find(u => u.type === 'tool_call' && u.data.name === 'research_url');
    const result = run.updates.find(u => u.type === 'tool_result' && u.data.name === 'research_url');
    const fetchCall = run.updates.find(u => u.type === 'tool_call' && u.data.name === 'fetch_url');
    for (const event of [call, fetchCall]) {
      if (redactOrigin) assert.ok(!JSON.stringify(event.data.args).includes('example.com'));
      else assert.equal(event.data.args.url_origin, 'https://example.com');
    }
    assert.equal(result.data.toolCallSeq, call.seq);
    assert.ok(result.data.durationMs >= 0);
    assert.deepEqual(result.data.diagnostic, { version: 1, outcome: 'failed', failureKind: 'network_error' });
    const read = run.updates.find(u => u.type === 'tool_result' && u.data.name === 'read_page');
    assert.equal(read.data.diagnostic.outcome, 'unknown');
    assert.equal(read.data.result.success, undefined);
    assert.ok(run.updates.some(u => u.data?.diagnostic?.failureKind === 'repeated_read_failure'));
    for (const secret of ['private-path', 'secret-value', 'private-query', 'private-error-content', 'private-page']) {
      assert.ok(!JSON.stringify(run).includes(secret), secret);
      assert.ok(!JSON.stringify(stored).includes(secret), secret);
    }
  });
}
for (const browser of ['chrome', 'firefox']) {
 const {toolDiagnostic}=await import(`../src/${browser}/src/cloud-diagnostics.js`);
 test(`${browser}: memory identity and screenshot bounds errors remain specific without raw payloads`,()=>{
  for(const [error,failureKind] of [
   ['Memory could not identify this action and entity. Read the relevant page first.','memory_target_unidentified'],
   ['(955, 825) is outside f56, which is 1406x746 pixels.','coordinate_out_of_bounds']
  ]) assert.deepEqual(toolDiagnostic({success:false,error}),{version:1,outcome:'failed',failureKind});
 });
}
