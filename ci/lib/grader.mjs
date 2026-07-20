function getPath(value, dottedPath) {
  return String(dottedPath).split('.').reduce((current, key) => current?.[key], value);
}

function checkValue(actual, check) {
  if (Object.hasOwn(check, 'equals')) return actual === check.equals;
  if (Object.hasOwn(check, 'contains')) {
    if (Array.isArray(actual)) return actual.includes(check.contains);
    return String(actual ?? '').toLowerCase().includes(String(check.contains).toLowerCase());
  }
  if (Object.hasOwn(check, 'matches')) return new RegExp(check.matches, 'i').test(String(actual ?? ''));
  if (check.truthy) return Boolean(actual);
  return actual !== undefined;
}

function getFinalUrl(run, trace) {
  return run?.final_url || run?.finalUrl || trace?.run?.final_url || trace?.run?.finalUrl || '';
}

export function inferStuckAt({ run, trace, setupError, artifactError, checks }) {
  if (setupError) return 'setup';
  if (!run) return 'run_start';
  if (run.status === 'needs_user_input') return 'user_handoff';
  const updates = trace?.run?.updates || run.updates || [];
  const toolNames = updates
    .filter((update) => update.type === 'tool_result' || update.type === 'tool_call')
    .map((update) => update.data?.name || update.data?.tool || '');
  if (run.status !== 'completed') {
    if (!toolNames.length) return 'planning';
    if (!getFinalUrl(run, trace)) return 'navigation';
    return 'execution';
  }
  if (checks.some((check) => !check.passed && check.id !== 'artifact:video')) return 'verification';
  if (artifactError) return 'artifact_capture';
  return null;
}

export function gradeScenario({
  scenario,
  run,
  trace,
  remoteState,
  setupError,
  artifactError,
  captureRequired = false,
}) {
  const checks = [];
  const add = (id, label, weight, passed, evidence = '') => {
    checks.push({ id, label, weight, passed: Boolean(passed), evidence: String(evidence || '') });
  };

  add(
    'run_completed',
    'Cloud run completed',
    20,
    run?.status === 'completed',
    run?.status || setupError?.message || 'run unavailable',
  );

  for (const expected of scenario.verify?.result || []) {
    const actual = getPath(run?.result, expected.path);
    add(
      `result:${expected.path}`,
      expected.label || `Result field ${expected.path}`,
      expected.weight || 10,
      checkValue(actual, expected),
      JSON.stringify(actual),
    );
  }

  const events = remoteState?.events || [];
  for (const expected of scenario.verify?.events || []) {
    const matches = events.filter((event) => event.type === expected.type);
    add(
      `event:${expected.type}`,
      expected.label || `Gnippets event ${expected.type}`,
      expected.weight || 15,
      matches.length >= (expected.min || 1),
      matches.map((event) => event.detail).join(' | ') || 'event absent',
    );
  }

  if (scenario.verify?.finalUrlHost) {
    let host = '';
    try { host = new URL(getFinalUrl(run, trace)).hostname; } catch {}
    add('final_url', 'Finished on the expected host', 10, host === scenario.verify.finalUrlHost, host);
  }

  if (captureRequired) {
    add(
      'artifact:video',
      'Run video synchronized',
      10,
      !artifactError,
      artifactError?.message || 'video.webm',
    );
  }

  const available = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0);
  const score = available ? Math.round((earned / available) * 100) : 0;
  const requiredPassed = checks.every((check) => check.passed);
  return {
    scenario_id: scenario.id,
    passed: requiredPassed && !setupError,
    score,
    earned,
    available,
    stuck_at: inferStuckAt({ run, trace, setupError, artifactError, checks }),
    checks,
    error: setupError?.message || run?.error || '',
    artifact_warning: artifactError?.message || '',
  };
}

export function renderSummary(results, metadata = {}) {
  const passed = results.filter((result) => result.grade.passed).length;
  const lines = [
    '# WebBrain Cloud E2E report',
    '',
    `- Started: ${metadata.startedAt || 'unknown'}`,
    `- Finished: ${metadata.finishedAt || 'unknown'}`,
    `- Pack: ${metadata.pack || 'all'}`,
    `- Passed: ${passed}/${results.length}`,
    '',
    '| Scenario | Result | Score | Stuck at |',
    '|---|---:|---:|---|',
    ...results.map(({ scenario, grade }) => (
      `| ${scenario.title} | ${grade.passed ? 'PASS' : 'FAIL'} | ${grade.score} | ${grade.stuck_at || '—'} |`
    )),
    '',
  ];
  for (const { scenario, grade } of results) {
    lines.push(`## ${scenario.title}`, '');
    for (const check of grade.checks) {
      lines.push(`- ${check.passed ? '✓' : '✗'} ${check.label} (${check.weight})${check.evidence ? ` — ${check.evidence}` : ''}`);
    }
    if (grade.error) lines.push(`- Error: ${grade.error}`);
    if (grade.artifact_warning) lines.push(`- Artifact warning: ${grade.artifact_warning}`);
    lines.push('');
  }
  return lines.join('\n');
}
