// What a native chat path did before it missed its budget.
//
// native-chat-mv3 and native-chat-presubmit-mv3 abort a path that has not
// finished in time, and their finally block then deletes the temporary
// profile, so a timed-out path used to leave nothing to diagnose. Before the
// abort, this saves the run's events, the background's run state (a pending
// card shows up there), the provider's record of the run and the page's own
// replies next to the evidence that passing paths write.
import fs from 'node:fs/promises';
import path from 'node:path';
import { within } from '../lib/time-budget.mjs';

const omitScreenshots = (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value;

export async function writeTimeoutEvidence({ out, dispatchPath, started, budgetMs, error, harness, page, worker, message, tabId, requestId, current }) {
  // Each read is bounded: the page or the worker may be what stopped answering.
  const read = work => within(work, 5000);
  const evidence = {
    path: dispatchPath, timedOut: true, budgetMs, elapsedMs: Date.now() - started, error: error?.message || String(error),
    finalUrl: page.url(),
    runState: await read(() => message('agent_run_state', { tabId, requestId })),
    run: await read(() => harness.evaluate(id => window.nativeRuns[id], requestId)),
    actualReplies: await read(() => page.evaluate(() => window.qaReplies)),
    nativeBubbles: await read(() => page.locator('.bubble').allInnerTexts()),
    provider: current,
    network: await read(() => worker.evaluate(() => globalThis.nativeFixtureNetwork)),
    externalMessages: 0,
  };
  const file = path.join(out, `${dispatchPath}-timeout-evidence.json`);
  await fs.writeFile(file, JSON.stringify(evidence, omitScreenshots, 2));
  console.log(JSON.stringify({ path: dispatchPath, timedOut: true, budgetMs, elapsedMs: evidence.elapsedMs, evidence: file }));
}
