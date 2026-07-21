import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeScenario, inferStuckAt, renderSummary } from './lib/grader.mjs';
import { buildSessionSettings, resolveCloudRunId, suiteShouldFail } from './lib/suite.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(await fs.readFile(path.join(root, 'catalog', 'scenarios.json'), 'utf8'));

assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
assert.ok(scenarios.every((scenario) => scenario.output_schema?.type === 'object'));
assert.ok(scenarios.every((scenario) => scenario.verify));

assert.equal(resolveCloudRunId({ run_id: 'snake-case' }), 'snake-case');
assert.equal(resolveCloudRunId({ runId: 'camel-case' }), 'camel-case');
assert.equal(resolveCloudRunId({ id: 'generic-id' }), 'generic-id');
assert.equal(resolveCloudRunId({}), '');
assert.equal(suiteShouldFail({ failed: 0, skipped: 0 }), false);
assert.equal(suiteShouldFail({ failed: 1, skipped: 0 }), true);
assert.equal(suiteShouldFail({ failed: 0, skipped: 1 }), true);
assert.equal(buildSessionSettings().askBeforeConsequentialActions, false);
assert.equal(buildSessionSettings().captchaSolverEnabled, false);
assert.deepEqual(
  {
    enabled: buildSessionSettings('captcha-key').captchaSolverEnabled,
    key: buildSessionSettings('captcha-key').capsolverApiKey,
  },
  { enabled: true, key: 'captcha-key' },
);

const mountainScenario = scenarios.find((scenario) => scenario.id === 'wikipedia-table-extraction');
const invalidMountainHeights = gradeScenario({
  scenario: mountainScenario,
  run: {
    status: 'completed',
    final_url: 'https://en.wikipedia.org/wiki/List_of_highest_mountains_on_Earth',
    result: {
      mountains: [
        { name: 'Mount Everest', height_m: 0 },
        { name: 'K2', height_m: 0 },
        { name: 'Kangchenjunga', height_m: 0 },
      ],
    },
  },
});
assert.equal(invalidMountainHeights.passed, false);
assert.deepEqual(
  invalidMountainHeights.checks
    .filter((check) => check.id.endsWith('.height_m'))
    .map((check) => check.passed),
  [false, false, false],
);

const scenario = {
  id: 'fixture',
  title: 'Fixture',
  verify: {
    result: [
      { path: 'ok', equals: true, weight: 40 },
      { path: 'title', contains: 'needle', weight: 20 },
    ],
    events: [{ type: 'saved', weight: 20 }],
    finalUrlHost: 'example.com',
  },
};
const run = {
  status: 'completed',
  result: { ok: true, title: 'The Needle' },
  final_url: 'https://example.com/done',
};
const grade = gradeScenario({
  scenario,
  run,
  trace: { run: { updates: [] } },
  remoteState: { events: [{ type: 'saved', detail: 'fixture' }] },
});
assert.equal(grade.passed, true);
assert.equal(grade.score, 100);
assert.equal(grade.stuck_at, null);
assert.match(renderSummary([{ scenario, grade }]), /PASS/);
assert.equal(inferStuckAt({ run: { status: 'failed', updates: [] }, checks: [] }), 'planning');
const camelCaseUrlGrade = gradeScenario({
  scenario: { id: 'camel-url', verify: { finalUrlHost: 'example.com' } },
  run: { status: 'completed', finalUrl: 'https://example.com/camel' },
});
assert.equal(camelCaseUrlGrade.passed, true);
const traceCamelCaseUrlGrade = gradeScenario({
  scenario: { id: 'trace-camel-url', verify: { finalUrlHost: 'example.com' } },
  run: { status: 'completed' },
  trace: { run: { finalUrl: 'https://example.com/from-trace' } },
});
assert.equal(traceCamelCaseUrlGrade.passed, true);
assert.equal(inferStuckAt({
  run: {
    status: 'failed',
    finalUrl: 'https://example.com/execution',
    updates: [{ type: 'tool_call', data: { name: 'click' } }],
  },
  checks: [],
}), 'execution');
const missingVideo = gradeScenario({
  scenario,
  run,
  trace: { run: { updates: [] } },
  remoteState: { events: [{ type: 'saved', detail: 'fixture' }] },
  artifactError: new Error('capture missing'),
  captureRequired: true,
});
assert.equal(missingVideo.passed, false);
assert.equal(missingVideo.stuck_at, 'artifact_capture');

console.log(`ci tests passed (${scenarios.length} scenarios validated)`);
