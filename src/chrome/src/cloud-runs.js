const DEFAULT_CLOUD_BRIDGE_URL = 'ws://127.0.0.1:17373/extension';
const CLOUD_RUN_STORAGE_KEY = 'webbrainCloudRunSnapshots';
const CLOUD_UPDATE_LIMIT = 200;
const CLOUD_RUN_LIMIT = 50;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);

export function normalizeCloudBridgeUrl(value = DEFAULT_CLOUD_BRIDGE_URL) {
  const url = new URL(String(value || DEFAULT_CLOUD_BRIDGE_URL));
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('WebBrain cloud bridge URL must use ws:// on localhost.');
  }
  return url.href;
}

function scrubCloudValue(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      if (typeof item === 'string' && item.startsWith('data:image/')) {
        return `[image omitted: ${item.length} chars]`;
      }
      if ((key === '_attachImage' || key === 'screenshot') && typeof item === 'string' && item.length > 500) {
        return `[large payload omitted: ${item.length} chars]`;
      }
      return item;
    }));
  } catch {
    return { unserializable: true };
  }
}

function cloudSnapshot(run, { includeUpdates = true } = {}) {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    tabId: run.tabId,
    task: run.task,
    structured: !!run.outputSchema,
    result: run.result,
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
    const rows = [...runs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, CLOUD_RUN_LIMIT)
      .map(run => scrubCloudValue(run));
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
        const restored = { ...row, updates: Array.isArray(row.updates) ? row.updates : [] };
        if (!TERMINAL_STATUSES.has(restored.status)) {
          const at = isoNow();
          restored.status = restored.status === 'aborting' ? 'aborted' : 'failed';
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
    run.updates.push({ type, data: scrubCloudValue(data), ts: run.updatedAt });
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
    if (type === 'plan_review' && run.status === 'running') {
      run.status = 'failed';
      run.error = 'Managed cloud runs cannot wait for interactive plan review.';
      agent.abort(run.tabId);
    }
    schedulePersist();
  }

  async function startRun(msg = {}) {
    await hydrate();
    const tabId = await resolveTabId(msg.tabId ?? msg.tab_id);
    const task = String(msg.task || msg.text || '').trim();
    if (!task) throw new Error('cloud_run requires `task`.');
    if (agent.isRunning(tabId)) throw new Error(`Tab ${tabId} already has an active WebBrain run.`);

    const outputSchema = msg.outputSchema || msg.output_schema || msg.responseFormat?.schema || msg.response_format?.schema || null;
    const createdAt = isoNow();
    const run = {
      runId: msg.runId || msg.run_id || makeRunId(),
      status: 'running',
      tabId,
      task,
      outputSchema,
      result: undefined,
      summary: '',
      content: '',
      finalUrl: '',
      error: '',
      updates: [],
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    runs.set(run.runId, run);
    await persist();

    (async () => {
      try {
        sendIndicator(tabId, 'WB_SHOW_AGENT_INDICATORS');
        const content = await agent.processMessage(tabId, task, (type, data) => {
          pushUpdate(run, type, data);
        }, 'act', [], { cloudRun: true, outputSchema });
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
        run.status = run.status === 'aborting' ? 'aborted' : 'failed';
        run.error = error?.message || String(error);
        run.finalUrl = await getTabUrl(tabId);
      } finally {
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
    if (run.status === 'running') {
      run.status = 'aborting';
      run.error = 'Abort requested.';
      run.updatedAt = isoNow();
      agent.abort(run.tabId);
      await persist();
    }
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
    abort,
    startBridge,
    stopBridge,
    bridgeStatus,
    syncBridge,
    hydrate,
  };
}
