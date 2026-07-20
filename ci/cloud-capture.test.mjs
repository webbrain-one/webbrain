import assert from 'node:assert/strict';
import { createCloudRunController } from '../src/chrome/src/cloud-runs.js';

let storedRows = [];
const chromeApi = {
  storage: {
    session: {
      async get() { return { webbrainCloudRunSnapshots: storedRows }; },
      async set(value) { storedRows = value.webbrainCloudRunSnapshots; },
    },
    local: {
      async get() { return {}; },
    },
  },
  tabs: {
    async query() { return [{ id: 7, url: 'https://example.test/', active: true, windowId: 1 }]; },
    async get() { return { id: 7, url: 'https://example.test/done', active: true, windowId: 1 }; },
    async update() {},
    async create() { return { id: 7 }; },
  },
  windows: { async update() {} },
  runtime: { async sendMessage() {} },
};
const agent = {
  isRunning() { return false; },
  setApiMutationsAllowed() {},
  async processMessage() { return 'done'; },
  abort() {},
};
const calls = [];
const controller = createCloudRunController({
  chromeApi,
  agent,
  ensureOffscreen: async () => {},
  makeRunId: () => 'run_capture_fixture',
  startRecording: async (tabId, options) => {
    calls.push(['start', tabId, options]);
    return { ok: true, state: { recordingId: 'rec_fixture' } };
  },
  stopRecording: async (options) => {
    calls.push(['stop', options]);
    return { ok: true, filename: 'webbrain-ci-run_capture_fixture.webm' };
  },
});

await controller.startRun({ task: 'fixture', capture: 'video' });
let snapshot;
for (let attempt = 0; attempt < 40; attempt += 1) {
  snapshot = await controller.status({ runId: 'run_capture_fixture' });
  if (snapshot.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}

assert.equal(snapshot.status, 'completed');
assert.equal(calls[0][0], 'start');
assert.equal(calls[0][2].mic, false);
assert.equal(calls[0][2].filename, 'webbrain-ci-run_capture_fixture.webm');
assert.deepEqual(calls[1], ['stop', { expectedRecordingId: 'rec_fixture' }]);
assert.equal(snapshot.updates.at(-1).type, 'artifact');
assert.equal(snapshot.updates.at(-1).data.filename, 'webbrain-ci-run_capture_fixture.webm');

console.log('cloud capture test passed');
