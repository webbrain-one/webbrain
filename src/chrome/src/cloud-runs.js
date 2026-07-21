const DEFAULT_CLOUD_BRIDGE_URL = 'ws://127.0.0.1:17373/extension';
const CLOUD_RUN_STORAGE_KEY = 'webbrainCloudRunSnapshots';
const CLOUD_UPDATE_LIMIT = 200;
const CLOUD_RUN_LIMIT = 50;
const CLOUD_STRING_LIMIT = 16 * 1024;
const CLOUD_RUN_PERSIST_BYTES_LIMIT = 256 * 1024;
const CLOUD_PERSIST_BYTES_LIMIT = 4 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
// Suffix match on normalized keys (non-alnum stripped). Avoid bare `pin` as a
// suffix — it over-matches `spin`, `mapPin`, etc. Short exact keys live in the set.
const SENSITIVE_CLOUD_KEY = /(?:authorization|cookie|password|passwd|passphrase|passcode|pincode|secret|credential|privatekey|apikey|token|accesskeyid|secretaccesskey)$/i;
const SENSITIVE_CLOUD_KEY_EXACT = new Set(['pin', 'otp', 'cvv', 'cvc', 'ssn']);
const LARGE_IMAGE_KEY = /(?:attachimage|screenshot|image|imagedata|dataurl)$/i;

function cloudRunError(message, status) {
  return Object.assign(new Error(message), { status });
}

function normalizedCloudKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '');
}

export function normalizeCloudBridgeUrl(value = DEFAULT_CLOUD_BRIDGE_URL) {
  const url = new URL(String(value || DEFAULT_CLOUD_BRIDGE_URL));
  const host = url.hostname.toLowerCase();
  // WHATWG URL keeps the brackets on IPv6 literals: ws://[::1]/… parses to
  // hostname "[::1]", so both spellings must be allowlisted (same as
  // LOCAL_OLLAMA_HOSTS in ollama-handoff.js).
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('WebBrain cloud bridge URL must use ws:// on localhost.');
  }
  return url.href;
}

function isSensitiveCloudKey(key) {
  const normalizedKey = normalizedCloudKey(key);
  if (!normalizedKey) return false;
  return SENSITIVE_CLOUD_KEY.test(normalizedKey) || SENSITIVE_CLOUD_KEY_EXACT.has(normalizedKey);
}

function scrubCloudValue(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      const normalizedKey = normalizedCloudKey(key);
      if (normalizedKey && isSensitiveCloudKey(key)) {
        return '[redacted]';
      }
      if (typeof item === 'string' && /^data:image\//i.test(item)) {
        return `[image omitted: ${item.length} chars]`;
      }
      if (LARGE_IMAGE_KEY.test(normalizedKey) && typeof item === 'string' && item.length > 500) {
        return `[large payload omitted: ${item.length} chars]`;
      }
      if (typeof item === 'string' && item.length > CLOUD_STRING_LIMIT) {
        return `${item.slice(0, CLOUD_STRING_LIMIT)}\n[truncated ${item.length - CLOUD_STRING_LIMIT} chars for cloud persistence]`;
      }
      return item;
    }));
  } catch {
    return { unserializable: true };
  }
}

function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function compactCloudRunForPersistence(run) {
  const row = scrubCloudValue(run);
  row.structured = row.structured ?? !!run?.outputSchema;
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  const omittedUpdates = Array.isArray(row.updates) ? row.updates.length : 0;
  row.updates = [];
  row.persistenceTruncated = { omittedUpdates };
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  row.content = '';
  row.outputSchema = null;
  row.persistenceTruncated.omittedContent = true;
  row.persistenceTruncated.omittedSchema = true;
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  delete row.result;
  row.persistenceTruncated.omittedResult = true;
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  return scrubCloudValue({
    runId: run?.runId,
    status: run?.status,
    parentRunId: run?.parentRunId || null,
    tabId: run?.tabId,
    task: run?.task,
    structured: !!run?.outputSchema || run?.structured === true,
    pendingInput: run?.pendingInput || null,
    summary: run?.summary,
    content: '',
    finalUrl: run?.finalUrl,
    error: run?.error,
    createdAt: run?.createdAt,
    updatedAt: run?.updatedAt,
    completedAt: run?.completedAt,
    updates: [],
    persistenceTruncated: { omittedUpdates, omittedResult: true, omittedSchema: true },
  });
}

export function buildCloudPersistenceRows(runs) {
  const values = Array.isArray(runs) ? [...runs] : [...(runs?.values?.() || [])];
  const candidates = values
    .sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')))
    .slice(0, CLOUD_RUN_LIMIT)
    .map(compactCloudRunForPersistence);
  const rows = [];
  let totalBytes = 2;
  for (const row of candidates) {
    const rowBytes = serializedBytes(row) + (rows.length ? 1 : 0);
    if (totalBytes + rowBytes > CLOUD_PERSIST_BYTES_LIMIT) continue;
    rows.push(row);
    totalBytes += rowBytes;
  }
  return rows;
}

function cloudSnapshot(run, { includeUpdates = true } = {}) {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    parentRunId: run.parentRunId || null,
    tabId: run.tabId,
    task: run.task,
    structured: run.structured ?? !!run.outputSchema,
    pendingInput: run.pendingInput || null,
    result: run.result,
    persistenceTruncated: run.persistenceTruncated,
    summary: run.summary,
    content: run.content,
    finalUrl: run.finalUrl,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    updates: includeUpdates ? run.updates : undefined,
  };
}

function isUsableCloudTab(tab) {
  if (tab?.id == null) return false;
  try {
    // Chrome can leave an unpacked-extension startup tab's `url` empty while
    // exposing the loaded page through `pendingUrl`, even with status=complete.
    const url = new URL(tab.url || tab.pendingUrl || '');
    return ['http:', 'https:', 'file:'].includes(url.protocol) || url.href === 'about:blank';
  } catch {
    return false;
  }
}

export function createCloudRunController({
  chromeApi,
  agent,
  ensureOffscreen,
  sendIndicator = () => {},
  startRecording = null,
  stopRecording = null,
  now = () => new Date(),
  makeRunId = () => `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
} = {}) {
  const api = chromeApi;
  const runs = new Map();
  let hydratePromise = null;
  let persistQueue = Promise.resolve();
  let persistTimer = null;

  const isoNow = () => now().toISOString();

  async function persist() {
    if (!api.storage?.session?.set) return;
    const rows = buildCloudPersistenceRows(runs);
    persistQueue = persistQueue
      .catch(() => {})
      .then(() => api.storage.session.set({ [CLOUD_RUN_STORAGE_KEY]: rows }));
    await persistQueue;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist().catch(() => {});
    }, 100);
  }

  async function hydrate() {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      if (!api.storage?.session?.get) return;
      const stored = await api.storage.session.get(CLOUD_RUN_STORAGE_KEY).catch(() => ({}));
      const rows = Array.isArray(stored?.[CLOUD_RUN_STORAGE_KEY]) ? stored[CLOUD_RUN_STORAGE_KEY] : [];
      let changed = false;
      for (const row of rows) {
        if (!row?.runId) continue;
        const rawUpdates = Array.isArray(row.updates) ? row.updates : [];
        let nextUpdateSeq = 0;
        const updates = rawUpdates.map((update) => {
          const candidate = Number(update?.seq);
          const seq = Number.isSafeInteger(candidate) && candidate > nextUpdateSeq
            ? candidate
            : nextUpdateSeq + 1;
          if (seq !== candidate) changed = true;
          nextUpdateSeq = seq;
          return { ...update, seq };
        });
        const restored = { ...row, updates, nextUpdateSeq };
        if (!TERMINAL_STATUSES.has(restored.status)) {
          const at = isoNow();
          restored.status = restored.status === 'aborting' ? 'aborted' : 'failed';
          restored.pendingInput = null;
          restored.error = restored.status === 'aborted'
            ? 'Run aborted when the WebBrain service worker restarted.'
            : 'Run interrupted when the WebBrain service worker restarted.';
          restored.updatedAt = at;
          restored.completedAt = at;
          changed = true;
        }
        runs.set(restored.runId, restored);
      }
      if (changed) await persist();
    })();
    return hydratePromise;
  }

  async function activateTab(tab) {
    if (!tab?.id) return tab;
    await api.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId != null && api.windows?.update) {
      await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return tab;
  }

  async function resolveTabId(requestedTabId) {
    if (requestedTabId != null && requestedTabId !== '') {
      const tab = await api.tabs.get(Number(requestedTabId));
      if (!isUsableCloudTab(tab)) throw new Error(`Tab ${requestedTabId} is not a controllable webpage.`);
      await activateTab(tab);
      return tab.id;
    }

    const active = await api.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = active.find(isUsableCloudTab);
    if (activeTab) return activeTab.id;

    const allTabs = await api.tabs.query({});
    const fallback = allTabs.find(isUsableCloudTab);
    if (fallback) {
      await activateTab(fallback);
      return fallback.id;
    }

    const created = await api.tabs.create({ url: 'about:blank', active: true });
    if (created?.id == null) throw new Error('Could not create a browser tab for the cloud run.');
    return created.id;
  }

  async function getTabUrl(tabId) {
    try {
      return (await api.tabs.get(tabId))?.url || '';
    } catch {
      return '';
    }
  }

  function pushUpdate(run, type, data) {
    run.updatedAt = isoNow();
    const previous = run.updates.at(-1);
    // Consecutive text_delta events upsert the same seq: content grows in place
    // and ts advances. Full-array pollers are fine; append-only / seq-cursor
    // clients must re-read that row (or take a full snapshot) rather than
    // assuming each seq is immutable.
    if (type === 'text_delta' && previous?.type === 'text_delta') {
      previous.data = scrubCloudValue({
        ...previous.data,
        content: `${previous.data?.content || ''}${data?.content || ''}`,
      });
      previous.ts = run.updatedAt;
      schedulePersist();
      return;
    }
    run.nextUpdateSeq = (Number(run.nextUpdateSeq) || 0) + 1;
    const scrubbedData = scrubCloudValue(data);
    run.updates.push({ seq: run.nextUpdateSeq, type, data: scrubbedData, ts: run.updatedAt });
    if (run.updates.length > CLOUD_UPDATE_LIMIT) {
      run.updates.splice(0, run.updates.length - CLOUD_UPDATE_LIMIT);
    }
    if (type === 'tool_result' && data?.name === 'done_json') {
      const result = data.result || {};
      if (result.cloudFailed) {
        run.status = 'failed';
        run.error = result.error || 'done_json failed';
        run.summary = result.summary || run.summary;
      } else if (Object.prototype.hasOwnProperty.call(result, 'cloudResult')) {
        run.result = result.cloudResult;
        run.summary = result.summary || run.summary;
      }
    }
    if (type === 'clarify' && scrubbedData?.clarifyId && !TERMINAL_STATUSES.has(run.status)) {
      run.status = 'needs_user_input';
      run.pendingInput = scrubbedData;
    }
    if (type === 'run_status'
        && scrubbedData?.status === 'clarification_required'
        && run.status !== 'aborting'
        && run.status !== 'aborted') {
      run.status = 'failed';
      run.error = scrubbedData.message
        || 'Cloud run stopped because explicit clarification authorization is required.';
      run.pendingInput = null;
    }
    if (type === 'plan_review' && run.status === 'running') {
      run.status = 'failed';
      run.error = 'Managed cloud runs cannot wait for interactive plan review.';
      agent.abort(run.tabId);
    }
    schedulePersist();
  }

  async function startRun(msg = {}) {
    await hydrate();
    const parentRunId = String(msg.parentRunId || msg.parent_run_id || '').trim() || null;
    let requestedTabId = msg.tabId ?? msg.tab_id;
    if (parentRunId) {
      const parent = runs.get(parentRunId);
      if (parent) {
        if (!TERMINAL_STATUSES.has(parent.status)) {
          throw cloudRunError('Parent cloud run must be finished before it can be continued.', 409);
        }
        const existingChild = [...runs.values()].find(candidate => candidate.parentRunId === parentRunId);
        if (existingChild) {
          throw cloudRunError(`Cloud run has already been continued as ${existingChild.runId}.`, 409);
        }
        requestedTabId = parent.tabId;
      } else if (requestedTabId == null || requestedTabId === '') {
        throw cloudRunError('Parent cloud run is no longer available and has no saved tab.', 409);
      }
    }
    const tabId = await resolveTabId(requestedTabId);
    const task = String(msg.task || msg.text || '').trim();
    if (!task) throw new Error('cloud_run requires `task`.');
    if (agent.isRunning(tabId)) throw new Error(`Tab ${tabId} already has an active WebBrain run.`);

    const apiMutationsAllowed = msg.apiMutationsAllowed === true || msg.api_mutations_allowed === true;
    const outputSchema = msg.outputSchema || msg.output_schema || msg.responseFormat?.schema || msg.response_format?.schema || null;
    const createdAt = isoNow();
    const run = {
      runId: msg.runId || msg.run_id || makeRunId(),
      status: 'running',
      parentRunId,
      tabId,
      task,
      outputSchema,
      capture: msg.capture === 'video' ? 'video' : 'none',
      result: undefined,
      summary: '',
      content: '',
      finalUrl: '',
      error: '',
      pendingInput: null,
      updates: [],
      nextUpdateSeq: 0,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    runs.set(run.runId, run);
    await persist();

    (async () => {
      let recordingId = null;
      try {
        if (run.capture === 'video') {
          try {
            if (!startRecording || !stopRecording) throw new Error('Cloud run video capture is unavailable.');
            const recording = await startRecording(tabId, {
              video: true,
              mic: false,
              showBanner: false,
              filename: `webbrain-ci-${run.runId}.webm`,
            });
            if (!recording?.ok) throw new Error(recording?.error || 'Cloud run video capture could not start.');
            recordingId = recording.state?.recordingId || null;
          } catch (captureError) {
            pushUpdate(run, 'capture_error', {
              kind: 'video',
              message: captureError?.message || String(captureError),
            });
            throw captureError;
          }
          pushUpdate(run, 'artifact_started', {
            kind: 'video',
            filename: `webbrain-ci-${run.runId}.webm`,
          });
        }
        if (apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);
        sendIndicator(tabId, 'WB_SHOW_AGENT_INDICATORS');
        const content = await agent.processMessage(tabId, task, (type, data) => {
          pushUpdate(run, type, data);
        }, 'act', [], { cloudRun: true, outputSchema });
        run.pendingInput = null;
        run.content = content;
        run.finalUrl = await getTabUrl(tabId);
        if (run.status === 'aborting') {
          run.status = 'aborted';
          run.error = run.error || 'Aborted by cloud_abort.';
        } else if (run.status !== 'failed') {
          if (outputSchema && run.result === undefined) {
            run.status = 'failed';
            run.error = 'Structured cloud run finished without a valid done_json result.';
          } else {
            run.status = 'completed';
            if (!outputSchema) run.result = content;
          }
        }
      } catch (error) {
        run.pendingInput = null;
        run.status = run.status === 'aborting' ? 'aborted' : 'failed';
        run.error = error?.message || String(error);
        run.finalUrl = await getTabUrl(tabId);
      } finally {
        // Do not expose a terminal status until the requested recording has
        // finished flushing to Downloads; pollers use terminality as the cue
        // that traces and artifacts are complete.
        const terminalStatus = recordingId && TERMINAL_STATUSES.has(run.status)
          ? run.status
          : null;
        if (terminalStatus) run.status = 'running';
        if (recordingId) {
          try {
            const capture = await stopRecording({ expectedRecordingId: recordingId });
            if (!capture?.ok) throw new Error(capture?.error || 'Cloud run video capture could not stop.');
            pushUpdate(run, 'artifact', {
              kind: 'video',
              filename: capture.filename || `webbrain-ci-${run.runId}.webm`,
            });
          } catch (captureError) {
            pushUpdate(run, 'capture_error', {
              kind: 'video',
              message: captureError?.message || String(captureError),
            });
          }
        }
        if (terminalStatus) run.status = terminalStatus;
        run.completedAt = isoNow();
        run.updatedAt = run.completedAt;
        sendIndicator(tabId, 'WB_HIDE_AGENT_INDICATORS');
        await persist().catch(() => {});
      }
    })();

    return cloudSnapshot(run, { includeUpdates: false });
  }

  async function status(msg = {}) {
    await hydrate();
    const runId = msg.runId || msg.run_id;
    if (!runId) return { runs: [...runs.values()].map(run => cloudSnapshot(run, { includeUpdates: false })) };
    const run = runs.get(runId);
    if (!run) throw new Error('Unknown cloud run.');
    return cloudSnapshot(run);
  }

  async function abort(msg = {}) {
    await hydrate();
    const run = runs.get(msg.runId || msg.run_id);
    if (!run) throw new Error('Unknown cloud run.');
    if (run.status === 'running' || run.status === 'needs_user_input') {
      run.status = 'aborting';
      run.pendingInput = null;
      run.error = 'Abort requested.';
      run.updatedAt = isoNow();
      agent.abort(run.tabId);
      await persist();
    }
    return cloudSnapshot(run);
  }

  async function respond(msg = {}) {
    await hydrate();
    const run = runs.get(msg.runId || msg.run_id);
    if (!run) throw cloudRunError('Unknown cloud run.', 404);
    if (run.status !== 'needs_user_input') {
      throw cloudRunError('Cloud run is not waiting for user input.', 409);
    }
    const clarifyId = String(msg.clarifyId || msg.clarify_id || '').trim();
    if (!clarifyId) throw cloudRunError('cloud_respond requires `clarify_id`.', 400);
    const pendingClarifyId = String(run.pendingInput?.clarifyId || run.pendingInput?.clarify_id || '').trim();
    if (!pendingClarifyId || clarifyId !== pendingClarifyId) {
      throw cloudRunError('Clarification is no longer pending for this cloud run.', 409);
    }
    const answer = String(msg.answer ?? '').trim();
    if (!answer) throw cloudRunError('cloud_respond requires `answer`.', 400);
    if (!agent.submitClarifyResponse(run.tabId, clarifyId, answer, 'cloud_api')) {
      throw cloudRunError('Clarification is no longer available in the active WebBrain run.', 409);
    }
    run.status = 'running';
    run.pendingInput = null;
    run.error = '';
    pushUpdate(run, 'clarify_response', { clarifyId, source: 'cloud_api' });
    await persist();
    return cloudSnapshot(run);
  }

  async function startBridge(url = DEFAULT_CLOUD_BRIDGE_URL) {
    await ensureOffscreen();
    return api.runtime.sendMessage({ type: 'cloud-bridge-start', url: normalizeCloudBridgeUrl(url) });
  }

  async function stopBridge() {
    return api.runtime.sendMessage({ type: 'cloud-bridge-stop' });
  }

  async function bridgeStatus() {
    await ensureOffscreen();
    return api.runtime.sendMessage({ type: 'cloud-bridge-status' });
  }

  async function syncBridge() {
    const stored = await api.storage.local.get(['webbrainCloudBridgeEnabled', 'webbrainCloudBridgeUrl']);
    if (!stored.webbrainCloudBridgeEnabled) return stopBridge().catch(() => ({ enabled: false, connected: false }));
    return startBridge(stored.webbrainCloudBridgeUrl || DEFAULT_CLOUD_BRIDGE_URL);
  }

  return {
    runs,
    startRun,
    status,
    respond,
    abort,
    startBridge,
    stopBridge,
    bridgeStatus,
    syncBridge,
    hydrate,
  };
}
