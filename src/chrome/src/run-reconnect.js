const TERMINAL_RUN_STATUSES = new Set(['completed', 'stopped', 'failed', 'cancelled']);

function defaultWait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestMatches(value, requestId) {
  return value != null && String(value) === String(requestId);
}

function runResponseFromSnapshot(snapshot, { reconnected = false, resumed = false } = {}) {
  const updates = (Array.isArray(snapshot?.events) ? snapshot.events : [])
    .filter(event => event?.type && event.type !== 'run_complete')
    .map(event => ({ type: event.type, data: event.data }));
  if (snapshot?.status === 'failed' && !updates.some(update => update.type === 'error')) {
    updates.push({
      type: 'error',
      data: {
        message: snapshot.lastError
          || String(snapshot.finalContent || '').replace(/^Error:\s*/i, '')
          || 'The run stopped after the extension background restarted.',
      },
    });
  }
  return {
    content: String(snapshot?.finalContent || ''),
    updates,
    requestId: snapshot?.requestId || null,
    runId: snapshot?.runId || null,
    runStatus: snapshot?.status || null,
    success: snapshot?.status === 'completed',
    successfulDone: snapshot?.successfulDone === true,
    hadError: snapshot?.hadError === true || snapshot?.status === 'failed',
    reconnected,
    resumed,
  };
}

/**
 * Starts a detached background run and follows its persisted UI journal.
 *
 * The initiating runtime message is intentionally short-lived. If the
 * background context restarts, a non-terminal snapshot with no live owner is
 * resumed through `resumeAction`. Short state probes double as a run lease for
 * event-page/service-worker lifecycles.
 */
export async function runDetachedWithReconnect({
  initialAction,
  resumeAction = 'continue_start',
  payload,
  resumePayload = null,
  start,
  probe,
  isConnectionError,
  onStatus = () => {},
  onState = () => {},
  shouldResume = () => true,
  wait = defaultWait,
  pollIntervalMs = 1200,
  reconnectDelaysMs = [250, 500, 1000, 2000, 4000],
  maxResumeAttempts = 3,
  maxUncertainStartRetries = 2,
  maxMissingStateProbes = 6,
  maxConnectionFailures = 12,
} = {}) {
  if (typeof start !== 'function' || typeof probe !== 'function') {
    throw new Error('Detached run recovery requires start and probe functions.');
  }
  const requestId = String(payload?.requestId || '');
  if (!requestId) throw new Error('Detached run recovery requires a requestId.');

  let action = initialAction;
  let actionPayload = payload;
  let resumeAttempts = 0;
  let uncertainStartRetries = 0;
  let everReconnected = false;
  let startWasUncertain = false;

  while (true) {
    let startAcknowledged = false;
    try {
      const ack = await start(action, actionPayload);
      if (ack?.accepted === false) throw new Error(ack.error || 'The background rejected the run.');
      if (ack?.requestId && !requestMatches(ack.requestId, requestId)) {
        throw new Error('The background acknowledged a different run request.');
      }
      startAcknowledged = true;
      startWasUncertain = false;
    } catch (error) {
      if (!isConnectionError?.(error)) throw error;
      startWasUncertain = true;
      everReconnected = true;
      onStatus({ phase: 'reconnecting', requestId, error });
    }

    let missingStateProbes = 0;
    let connectionFailures = 0;
    let wasDisconnected = startWasUncertain;

    while (true) {
      const reconnectDelay = reconnectDelaysMs[
        Math.min(connectionFailures, Math.max(0, reconnectDelaysMs.length - 1))
      ] ?? pollIntervalMs;
      await wait(wasDisconnected ? reconnectDelay : pollIntervalMs);

      let state;
      try {
        state = await probe({ requestId });
        connectionFailures = 0;
        try {
          await onState(state);
        } catch {}
      } catch (error) {
        if (!isConnectionError?.(error)) throw error;
        connectionFailures += 1;
        wasDisconnected = true;
        everReconnected = true;
        onStatus({ phase: 'reconnecting', requestId, error, attempt: connectionFailures });
        if (connectionFailures >= maxConnectionFailures) {
          throw new Error('Could not reconnect to the extension background.');
        }
        continue;
      }

      const snapshot = state?.runUi && typeof state.runUi === 'object' ? state.runUi : null;
      const detachedError = state?.detachedError;
      if (requestMatches(detachedError?.requestId, requestId)) {
        throw new Error(detachedError?.message || 'Detached run failed.');
      }
      const sameSnapshot = requestMatches(snapshot?.requestId, requestId);
      const sameStartingRun = state?.starting === true
        && requestMatches(state?.startingRequestId, requestId);
      const sameLiveRun = state?.running === true && sameSnapshot;

      if (sameSnapshot && TERMINAL_RUN_STATUSES.has(snapshot.status)) {
        if (wasDisconnected) {
          everReconnected = true;
          onStatus({ phase: 'reconnected', requestId, state });
        }
        return runResponseFromSnapshot(snapshot, {
          reconnected: everReconnected,
          resumed: resumeAttempts > 0,
        });
      }

      if (sameStartingRun || sameLiveRun) {
        missingStateProbes = 0;
        if (wasDisconnected) {
          everReconnected = true;
          wasDisconnected = false;
          onStatus({ phase: 'reconnected', requestId, state });
        }
        continue;
      }

      if (state?.running === true || state?.starting === true) {
        throw new Error('Another run became active while reconnecting.');
      }

      if (sameSnapshot && !TERMINAL_RUN_STATUSES.has(snapshot.status)) {
        if (!shouldResume()) throw new Error('Run recovery was cancelled.');
        if (resumeAttempts >= maxResumeAttempts) {
          throw new Error('The extension background restarted repeatedly and the run could not be recovered.');
        }
        resumeAttempts += 1;
        everReconnected = true;
        action = resumeAction;
        actionPayload = {
          tabId: payload.tabId,
          requestId,
          mode: payload.mode,
          ...(resumePayload || {}),
        };
        onStatus({ phase: 'resuming', requestId, state, attempt: resumeAttempts });
        break;
      }

      missingStateProbes += 1;
      if (startWasUncertain
          && missingStateProbes >= 2
          && uncertainStartRetries < maxUncertainStartRetries) {
        uncertainStartRetries += 1;
        onStatus({ phase: 'retrying_start', requestId, attempt: uncertainStartRetries });
        break;
      }
      if (startAcknowledged && missingStateProbes >= maxMissingStateProbes) {
        throw new Error('The background acknowledged the run but did not publish recoverable run state.');
      }
      if (startWasUncertain
          && uncertainStartRetries >= maxUncertainStartRetries
          && missingStateProbes >= maxMissingStateProbes) {
        throw new Error('Could not reconnect to the extension background.');
      }
    }
  }
}

function matchingPlanResolution(state, planId) {
  const resolution = state?.runUi?.lastPlanResolution;
  if (!resolution || !requestMatches(resolution.planId, planId)) return null;
  return resolution;
}

/**
 * Delivers a plan decision across a transient runtime-message disconnect.
 *
 * A lost reply is not treated as a failed approval: the durable run journal
 * records the resolution, so a probe can prove that the first delivery won
 * without sending a duplicate decision.
 */
export async function sendPlanResponseWithReconnect({
  payload,
  requestId = '',
  send,
  probe,
  isConnectionError,
  onStatus = () => {},
  onState = () => {},
  wait = defaultWait,
  reconnectDelaysMs = [250, 500, 1000, 2000, 4000],
  maxAttempts = 8,
} = {}) {
  if (typeof send !== 'function' || typeof probe !== 'function') {
    throw new Error('Plan response recovery requires send and probe functions.');
  }
  const planId = String(payload?.planId || '');
  if (!planId) throw new Error('Plan response recovery requires a planId.');
  const expectedRequestId = String(requestId || '');
  let lastConnectionError = null;
  let reconnected = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await send(payload);
      if (response?.matched) return { ...response, reconnected };
    } catch (error) {
      if (!isConnectionError?.(error)) throw error;
      lastConnectionError = error;
      onStatus({ phase: 'reconnecting', planId, attempt: attempt + 1, error });
    }

    const delay = reconnectDelaysMs[
      Math.min(attempt, Math.max(0, reconnectDelaysMs.length - 1))
    ] ?? 1000;
    await wait(delay);

    let state;
    try {
      state = await probe({ planId, requestId: expectedRequestId });
      try {
        await onState(state);
      } catch {}
    } catch (error) {
      if (!isConnectionError?.(error)) throw error;
      lastConnectionError = error;
      onStatus({ phase: 'reconnecting', planId, attempt: attempt + 1, error });
      continue;
    }

    const resolution = matchingPlanResolution(state, planId);
    if (resolution) {
      reconnected = true;
      onStatus({ phase: 'reconnected', planId, state });
      return {
        ok: true,
        matched: String(resolution.decision || '') === String(payload?.decision || ''),
        recovered: true,
        reconnected: true,
      };
    }

    const sameRequest = !expectedRequestId
      || requestMatches(state?.runUi?.requestId, expectedRequestId);
    const samePendingPlan = requestMatches(state?.pendingPlan?.planId, planId);
    if (samePendingPlan && sameRequest) {
      reconnected = true;
      onStatus({ phase: 'reconnected', planId, state });
      continue;
    }

    return {
      ok: false,
      matched: false,
      restarted: sameRequest
        && state?.runUi?.status === 'awaiting_plan'
        && !state?.pendingPlan,
      reconnected,
    };
  }

  throw lastConnectionError || new Error('Could not reconnect to submit the plan decision.');
}

export { TERMINAL_RUN_STATUSES, runResponseFromSnapshot };
