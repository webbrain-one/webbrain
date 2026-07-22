export function resolveCloudRunId(started = {}) {
  return started.run_id || started.runId || started.id || '';
}

export function suiteShouldFail(totals = {}) {
  return Number(totals.failed || 0) > 0 || Number(totals.skipped || 0) > 0;
}

export function buildSessionSettings(capsolverApiKey = '') {
  return {
    wbLocale: 'en',
    useSiteAdapters: true,
    autoScreenshot: 'state_change',
    maxAgentSteps: 195,
    requestTimeoutMs: 180_000,
    verboseMode: true,
    enableAllPackagedSkills: true,
    askBeforeConsequentialActions: false,
    captchaSolverEnabled: Boolean(capsolverApiKey),
    ...(capsolverApiKey ? { capsolverApiKey } : {}),
  };
}
