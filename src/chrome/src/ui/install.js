import { applyDOMTranslations, t } from './i18n.js';
import { D1_CONSENT_VERSION } from '../providers/d1-config.js';
import {
  WEBBRAIN_COMPANION_SITE_URL,
  companionDownloadFor,
  detectCompanionPlatform,
} from '../providers/companion-config.js';
import {
  initializeCardSpotlight,
  initializeScenePlayback,
  initializeShowcaseAutoplay,
  startRecordingClock,
} from './install-motion.js';

const GUIDES = {
  chrome: { name: 'Google Chrome', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  edge: { name: 'Microsoft Edge', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  brave: { name: 'Brave', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  vivaldi: { name: 'Vivaldi', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  opera: { name: 'Opera', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  firefox: { name: 'Firefox', openKey: 'install.open_sidebar', failureKey: 'install.open_failed_firefox' },
  chromium: { name: 'Chromium', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  unknown: { name: 'Browser', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
};

function browserBrands(navigatorLike) {
  return (navigatorLike?.userAgentData?.brands || [])
    .map((entry) => String(entry?.brand || '').toLowerCase())
    .join(' ');
}

export async function detectBrowser(navigatorLike = globalThis.navigator) {
  try {
    if (await navigatorLike?.brave?.isBrave?.()) return 'brave';
  } catch {
    // Brave detection is an optional progressive enhancement.
  }

  const ua = String(navigatorLike?.userAgent || '');
  const brands = browserBrands(navigatorLike);
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/\bEdg(?:e|A|iOS)?\//i.test(ua) || brands.includes('microsoft edge')) return 'edge';
  if (/\bOPR\//i.test(ua) || brands.includes('opera')) return 'opera';
  if (/\bVivaldi\//i.test(ua) || brands.includes('vivaldi')) return 'vivaldi';
  if (brands.includes('google chrome')) return 'chrome';
  if (/\b(?:Chrome|Chromium)\//i.test(ua) || brands.includes('chromium')) return 'chromium';
  return 'unknown';
}

export function getBrowserGuide(browserKey) {
  return GUIDES[browserKey] || GUIDES.unknown;
}

export function selectInstallFeature(feature, { documentLike = globalThis.document } = {}) {
  const tabs = Array.from(documentLike?.querySelectorAll?.('[data-feature]') || []);
  const panels = Array.from(documentLike?.querySelectorAll?.('[data-feature-panel]') || []);
  if (!tabs.some((tab) => tab.dataset.feature === feature)) return false;

  for (const tab of tabs) {
    const selected = tab.dataset.feature === feature;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.featurePanel !== feature;
  }
  return true;
}

export function initializeFeatureShowcase({ documentLike = globalThis.document } = {}) {
  const tabs = Array.from(documentLike?.querySelectorAll?.('[data-feature]') || []);
  if (tabs.length === 0) return false;

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      selectInstallFeature(tab.dataset.feature, { documentLike });
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = Math.max(0, tabs.indexOf(tab));
      let nextIndex = currentIndex;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
      else nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      const nextTab = tabs[nextIndex];
      selectInstallFeature(nextTab.dataset.feature, { documentLike });
      nextTab.focus();
    });
  }
  return selectInstallFeature(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.feature || tabs[0].dataset.feature, { documentLike });
}

/**
 * Keep the open calls in the click handler's synchronous turn. Both Chrome's
 * sidePanel.open() and Firefox's sidebarAction.open() require a user gesture.
 */
export function openInstalledPanel({ build, tabId, chromeApi = globalThis.chrome, browserApi = globalThis.browser } = {}) {
  if (build === 'firefox') {
    if (!browserApi?.sidebarAction?.open) {
      throw new Error('Sidebar API unavailable');
    }
    return browserApi.sidebarAction.open();
  }

  if (tabId == null || !chromeApi?.sidePanel?.open) {
    throw new Error('Side panel API unavailable');
  }
  chromeApi.sidePanel.setOptions({
    tabId,
    path: 'src/ui/sidepanel.html',
    enabled: true,
  }).catch?.(() => {});
  return chromeApi.sidePanel.open({ tabId });
}

export function reportInstalledPanelOpened({
  build,
  tabId,
  chromeApi = globalThis.chrome,
  browserApi = globalThis.browser,
} = {}) {
  const runtime = build === 'firefox' ? browserApi?.runtime : chromeApi?.runtime;
  if (!runtime?.sendMessage || tabId == null) return Promise.resolve(false);
  return Promise.resolve(runtime.sendMessage({
    type: 'WB_INSTALL_PANEL_OPENED',
    tabId,
  })).then(() => true);
}

// ── Optional local model ─────────────────────────────────────────────────
// The install page offers the in-browser model WebBrain already ships for
// WebGPU. It drives the same background routes as Settings and Apocalypse Mode
// (get/start/pause_webgpu_download), so the download shows up there too.

const LOCAL_MODEL_POLL_MS = 1500;
const LOCAL_MODEL_STATUSES = new Set(['checking', 'not-downloaded', 'downloading', 'paused', 'stopping', 'ready', 'error']);
// The WebGPU worker downloads one model at a time, and a paused transfer still
// holds that slot until it finishes or is stopped.
const LOCAL_MODEL_TRANSFER_STATUSES = new Set(['checking', 'starting', 'queued', 'downloading', 'paused', 'stopping']);
const LOCAL_MODEL_POLLING_STATUSES = new Set(['checking', 'downloading', 'stopping', 'busy']);

export function normalizeLocalModelSnapshot(snapshot = {}, modelId = '') {
  const raw = String(snapshot?.status || '');
  let status = ['starting', 'queued', 'loading'].includes(raw)
    ? 'downloading'
    : LOCAL_MODEL_STATUSES.has(raw) ? raw : 'not-downloaded';
  const ready = snapshot?.ready === true || status === 'ready';
  const loaded = Math.max(0, Number(snapshot?.loaded) || 0);
  const total = Math.max(0, Number(snapshot?.total) || 0);
  const progress = ready
    ? 100
    : Math.max(0, Math.min(100, Number(snapshot?.progress) || (total > 0 ? loaded / total * 100 : 0)));
  const other = snapshot?.activeTransfer;
  const otherModel = String(other?.modelId || other?.model || '').trim();
  if (ready) status = 'ready';
  else if (['not-downloaded', 'error'].includes(status) && otherModel && otherModel !== String(modelId || '').trim()
    && LOCAL_MODEL_TRANSFER_STATUSES.has(String(other?.status || ''))) {
    status = 'busy';
  }
  return {
    status,
    progress: Math.round(progress),
    error: status === 'error' ? String(snapshot?.error || '') : '',
  };
}

/** What the button and status line show for one normalized state. */
export function localModelView(state = {}) {
  const progress = Math.round(Number(state.progress) || 0);
  switch (state.status) {
    case 'ready':
      return { labelKey: 'install.local_model.ready', action: null, statusKey: 'install.local_model.ready_detail', progress: null };
    case 'downloading':
      return { labelKey: 'install.local_model.pause', action: 'pause', statusKey: 'install.local_model.downloading', progress };
    case 'paused':
      return { labelKey: 'install.local_model.resume', action: 'resume', statusKey: 'install.local_model.paused', progress };
    case 'stopping':
      return { labelKey: 'install.local_model.download', action: null, statusKey: 'install.local_model.working', progress: null };
    case 'busy':
      return { labelKey: 'install.local_model.download', action: null, statusKey: 'install.local_model.busy', progress: null };
    case 'unsupported':
      return { labelKey: 'install.local_model.download', action: null, statusKey: 'install.local_model.unsupported', progress: null };
    case 'error':
      return { labelKey: 'install.local_model.retry', action: 'start', statusKey: 'install.local_model.error', progress: null, isError: true };
    case 'checking':
      return { labelKey: 'install.local_model.download', action: null, statusKey: 'install.local_model.checking', progress: null };
    default:
      return { labelKey: 'install.local_model.download', action: 'start', statusKey: '', progress: null };
  }
}

function backgroundCommand(runtime, action, payload = {}) {
  return Promise.resolve(runtime.sendMessage({ target: 'background', action, ...payload })).then((response) => {
    // A thrown handler error arrives as { error, status: 500 }. A download
    // snapshot in its error state also carries `error`, but with a string
    // status, and a probe reports { ok: false, error }: both are answers.
    if (response?.error && typeof response.status !== 'string' && response.ok !== false) {
      throw new Error(response.error);
    }
    return response;
  });
}

/**
 * Point the WebGPU provider at the downloaded model so Settings and Apocalypse
 * Mode show it as ready. Never touches the active chat provider, and never
 * replaces a configured model that is already downloaded or downloading.
 */
export async function pointWebgpuProviderAtModel(modelId, { runtime = globalThis.chrome?.runtime } = {}) {
  const { providers = {}, active } = await backgroundCommand(runtime, 'get_providers') || {};
  const config = providers.webgpu;
  if (!config || active === 'webgpu') return false;
  const configured = String(config.model || '').trim();
  if (configured === modelId) return false;
  const current = normalizeLocalModelSnapshot(
    await backgroundCommand(runtime, 'get_webgpu_download_status', configured ? { model: configured } : {}),
    configured,
  );
  if (!['not-downloaded', 'error'].includes(current.status)) return false;
  await backgroundCommand(runtime, 'update_provider', {
    providerId: 'webgpu',
    config: { model: modelId },
    markConfigured: false,
  });
  return true;
}

// ── D1, the on-device decision model ─────────────────────────────────────
// The same button downloads D1, WebBrain's experimental decision model, and
// then the chat model: D1 first, in its own worker, and the chat model once
// D1's download is over. The background queues the chat model with D1's
// download, so it follows even after this page is closed
// (providers/install-download-queue.js); when D1 cannot download here, the
// chat model starts at once. D1 loads when its files are in. The click is the
// consent the note asks for. The guide writes no decision settings: once D1 is
// downloaded, Auto, the default mode, uses it for its checks, whatever the
// chat provider (decision-availability.js).

const D1_POLL_MS = 1500;
const D1_POLLING_STATUSES = new Set(['checking', 'downloading']);
// D1's download is under way: checking the GPU, transferring or paused.
const D1_TRANSFER_STATUSES = new Set(['checking', 'downloading', 'paused']);
// Chat model states in which a D1 transfer has the button: the chat model is
// not downloading, so D1 goes first.
const D1_FIRST_CHAT_STATUSES = new Set(['not-downloaded', 'error', 'busy', 'paused']);

export function normalizeD1Snapshot(snapshot = {}) {
  const raw = String(snapshot?.status || '');
  const progress = Math.max(0, Math.min(100, Math.round(Number(snapshot?.progress) || 0)));
  const usedForDecisions = snapshot?.usedForDecisions === true;
  // The background still holds the chat model's download for after D1's.
  const chatModelQueued = snapshot?.chatModelQueued === true;
  const shared = { usedForDecisions, chatModelQueued };
  if (snapshot?.loaded === true || raw === 'ready') return { status: 'ready', progress: 100, error: '', ...shared };
  // Downloaded and verified but not loaded: a decision loads it again.
  if (raw === 'cached' || snapshot?.cached === true) return { status: 'saved', progress: 100, error: '', ...shared };
  if (raw === 'checking') return { status: 'checking', progress: 0, error: '', ...shared };
  if (['downloading', 'loading'].includes(raw)) return { status: 'downloading', progress, error: '', ...shared };
  if (raw === 'stopped') return { status: 'paused', progress, error: '', ...shared };
  if (raw === 'error') return { status: 'error', progress: 0, error: String(snapshot?.error || ''), ...shared };
  return { status: 'idle', progress: 0, error: '', ...shared };
}

/** The D1 line for one normalized state; nothing while D1 was never started. */
export function d1View(state = {}) {
  switch (state.status) {
    case 'checking': return { statusKey: 'install.local_model.checking' };
    case 'downloading': return { statusKey: 'install.local_model.d1_downloading', progress: state.progress };
    case 'paused': return { statusKey: 'install.local_model.d1_paused', progress: state.progress };
    // Saved but not loaded yet, D1 loads for the next decision it answers.
    // A profile that turned decisions Off or chose another model under On is
    // only told that D1 is on this device.
    case 'ready': case 'saved': return { statusKey: state.usedForDecisions ? 'install.local_model.d1_ready' : 'install.local_model.d1_saved' };
    case 'unsupported': return { statusKey: 'install.local_model.d1_unsupported' };
    case 'error': return { statusKey: 'install.local_model.d1_error', isError: true };
    default: return { statusKey: '' };
  }
}

/**
 * The shared button. D1 downloads first: while its download is under way and
 * the chat model is not downloading, the button and the progress bar follow
 * D1 (`displayState` is what the block shows), and the chat model's own line
 * keeps its own progress (`statusProgress`). Then the button is the chat
 * model's, until that model is ready and needs nothing more; the same button
 * then finishes D1's download, so a D1 that is not downloaded yet, was paused
 * or stopped with an error can still be started, resumed or retried.
 */
export function localModelButtonView(view, chatStatus, d1State) {
  if (!d1State) return view;
  if (D1_FIRST_CHAT_STATUSES.has(chatStatus) && D1_TRANSFER_STATUSES.has(d1State.status)) {
    const d1 = { statusProgress: view.progress, progress: Math.round(Number(d1State.progress) || 0) };
    switch (d1State.status) {
      case 'checking': return { ...view, ...d1, labelKey: 'install.local_model.download', action: null, progress: null, displayState: 'checking' };
      case 'downloading': return { ...view, ...d1, labelKey: 'install.local_model.pause', action: 'd1-pause', displayState: 'downloading' };
      default: return { ...view, ...d1, labelKey: 'install.local_model.resume', action: 'd1-start', displayState: 'paused' };
    }
  }
  if (chatStatus !== 'ready') return view;
  switch (d1State.status) {
    case 'idle': return { ...view, labelKey: 'install.local_model.download', action: 'd1-start' };
    case 'paused': return { ...view, labelKey: 'install.local_model.resume', action: 'd1-start' };
    case 'error': return { ...view, labelKey: 'install.local_model.retry', action: 'd1-start' };
    case 'downloading': return { ...view, labelKey: 'install.local_model.pause', action: 'd1-pause' };
    case 'checking': return { ...view, labelKey: 'install.local_model.download', action: null };
    default: return view;
  }
}

export function initializeD1Download({
  documentLike = globalThis.document,
  runtime = globalThis.chrome?.runtime,
  translate = t,
  pollMs = D1_POLL_MS,
  // Called after each state change, so the shared button can follow D1.
  onChange = null,
} = {}) {
  const line = documentLike?.getElementById?.('local-model-d1');
  if (!line || !runtime?.sendMessage) return null;
  let state = { status: 'idle', progress: 0, error: '', usedForDecisions: false, chatModelQueued: false };
  let timer = null;
  let disposed = false;
  let starting = false;
  const command = (name, extra = {}) => backgroundCommand(runtime, 'd1_control', { command: name, ...extra });

  const render = () => {
    const view = d1View(state);
    line.hidden = !view.statusKey;
    line.textContent = view.statusKey ? translate(view.statusKey, { progress: view.progress ?? 0, error: state.error || '' }) : '';
    line.classList?.toggle?.('is-error', view.isError === true);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = null;
    if (!disposed && D1_POLLING_STATUSES.has(state.status)) timer = setTimeout(() => { void refresh(); }, pollMs);
  };
  const setState = (next) => {
    state = { progress: 0, error: '', usedForDecisions: false, chatModelQueued: false, ...next };
    render();
    schedule();
    onChange?.();
  };

  async function refresh() {
    try {
      const response = await command('status');
      // A guide reopened before D1 was ever started stays silent.
      if (!starting && !disposed) setState(normalizeD1Snapshot(response?.result));
    } catch {
      schedule();
    }
  }

  // `chatModel`: the chat model to download once D1's download is over.
  // Resolves to whether this call queued it behind a D1 download it started.
  async function start({ chatModel = '' } = {}) {
    if (starting || ['checking', 'downloading', 'ready', 'saved'].includes(state.status)) return false;
    starting = true;
    let queued = false;
    try {
      setState({ status: 'checking' });
      try {
        await command('probe');
      } catch (error) {
        // No GPU D1 can run on: the chat model may still fit.
        setState({ status: 'unsupported', error: error?.message || String(error) });
        return false;
      }
      try {
        const response = await command('download', { consent: true, consentVersion: D1_CONSENT_VERSION, ...(chatModel ? { chatModel } : {}) });
        setState(normalizeD1Snapshot({ status: 'checking', ...response?.result }));
        queued = !!chatModel && response?.result?.chatModelQueued === true;
      } catch (error) {
        setState({ status: 'error', error: error?.message || String(error) });
        return false;
      }
    } finally {
      starting = false;
    }
    await refresh();
    return queued;
  }

  async function pause() {
    if (!['checking', 'downloading'].includes(state.status)) return;
    try { await command('stop'); } catch { /* the next status read tells */ }
    await refresh();
  }

  render();
  void refresh();
  return {
    start,
    pause,
    refresh,
    getState: () => ({ ...state }),
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

export function initializeLocalModelDownload({
  documentLike = globalThis.document,
  runtime = globalThis.chrome?.runtime,
  translate = t,
  pollMs = LOCAL_MODEL_POLL_MS,
} = {}) {
  const root = documentLike?.getElementById?.('local-model');
  const modelId = String(root?.dataset?.model || '').trim();
  if (!root || !modelId || !runtime?.sendMessage) return null;
  const button = documentLike.getElementById('local-model-button');
  const label = documentLike.getElementById('local-model-label');
  const bar = documentLike.getElementById('local-model-progress');
  const statusLine = documentLike.getElementById('local-model-status');
  let state = { status: 'checking', progress: 0, error: '' };
  let inFlight = false;
  let pollTimer = null;
  let disposed = false;
  let rendered = false;
  // Whether the background held the chat model's download for after D1's.
  let chatModelQueued = false;
  // D1's own changes redraw the button once this controller has drawn it. When
  // the background lets go of the queued chat model, it has started it (or
  // found it already downloading or ready), so its state is read again.
  const d1 = initializeD1Download({
    documentLike, runtime, translate, pollMs,
    onChange: () => {
      if (rendered) render();
      const queued = d1?.getState().chatModelQueued === true;
      if (chatModelQueued && !queued && !inFlight) void refresh();
      chatModelQueued = queued;
    },
  });
  const buttonView = () => localModelButtonView(localModelView(state), state.status, d1?.getState());

  const render = () => {
    rendered = true;
    const view = buttonView();
    root.dataset.state = view.displayState || state.status;
    if (label) label.textContent = translate(view.labelKey);
    if (button) {
      button.disabled = inFlight || !view.action;
      const d1Status = d1?.getState().status;
      const d1Busy = ['checking', 'downloading'].includes(d1Status)
        && (state.status === 'ready' || D1_FIRST_CHAT_STATUSES.has(state.status));
      if (inFlight || d1Busy || ['checking', 'downloading', 'stopping'].includes(state.status)) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    }
    if (bar) {
      bar.hidden = view.progress == null;
      bar.setAttribute('aria-valuenow', String(view.progress ?? 0));
      bar.style?.setProperty?.('--local-model-progress', `${view.progress ?? 0}%`);
    }
    if (statusLine) {
      statusLine.textContent = view.statusKey ? translate(view.statusKey, { progress: view.statusProgress ?? view.progress ?? 0, error: state.error || '' }) : '';
      statusLine.classList?.toggle?.('is-error', view.isError === true);
    }
  };

  const schedulePoll = () => {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (disposed || !LOCAL_MODEL_POLLING_STATUSES.has(state.status)) return;
    pollTimer = setTimeout(() => { void refresh(); }, pollMs);
  };

  const setState = (next) => {
    state = { progress: 0, error: '', ...next };
    render();
    schedulePoll();
  };

  async function refresh({ quiet = false } = {}) {
    try {
      const snapshot = await backgroundCommand(runtime, 'get_webgpu_download_status', { model: modelId });
      if (!inFlight) setState(normalizeLocalModelSnapshot(snapshot, modelId));
    } catch (error) {
      // On first paint a missing status is just "not downloaded yet"; the click
      // probes the browser and reports a real problem.
      if (!inFlight) setState(quiet ? { status: 'not-downloaded' } : { status: 'error', error: error?.message || String(error) });
    }
  }

  // The chat model now: D1 has nothing to download here (no D1, already
  // saved, or a GPU it cannot use, or its download did not start).
  async function startChatModel() {
    inFlight = true;
    render();
    try {
      await backgroundCommand(runtime, 'start_webgpu_download', { model: modelId });
    } catch (error) {
      inFlight = false;
      setState({ status: 'error', error: error?.message || String(error) });
      return;
    }
    inFlight = false;
    await refresh();
  }

  button?.addEventListener('click', async () => {
    const view = buttonView();
    if (!view.action || inFlight) return;
    inFlight = true;
    if (view.action === 'd1-start' || view.action === 'd1-pause') {
      // Only D1 is downloaded, paused or resumed: before the chat model while
      // D1 goes first, which keeps the chat model queued behind it, or after
      // it once the chat model is ready.
      render();
      try {
        if (view.action === 'd1-pause') await d1.pause();
        else await d1.start(state.status !== 'ready' ? { chatModel: modelId } : {});
      } finally {
        inFlight = false;
        render();
      }
      return;
    }
    try {
      if (view.action === 'pause') {
        render();
        void d1?.pause();
        await backgroundCommand(runtime, 'pause_webgpu_download');
      } else if (view.action === 'resume') {
        render();
        // D1 still to download goes first; the paused chat model resumes
        // after it. A D1 that is done, or cannot download here, leaves the
        // chat model to resume now.
        const queued = d1 && ['idle', 'error'].includes(d1.getState().status) ? await d1.start({ chatModel: modelId }) : false;
        if (!queued) await backgroundCommand(runtime, 'start_webgpu_download', { model: modelId });
      } else {
        state = { status: 'checking', progress: 0, error: '' };
        render();
        // A browser without hardware WebGPU could download the files but never
        // run them, so check the adapter first (no weights are fetched).
        const probe = await backgroundCommand(runtime, 'test_provider', { providerId: 'webgpu' });
        if (probe?.ok === false) {
          inFlight = false;
          setState({ status: 'unsupported', error: String(probe.error || '') });
          return;
        }
        try {
          await pointWebgpuProviderAtModel(modelId, { runtime });
        } catch {
          // Only cosmetic for Settings; the download itself does not need it.
        }
        // D1 downloads first; its line reports it, and the background starts
        // the chat model once D1's download is over. The button stays busy
        // until D1's download has started, so a Pause always finds D1's
        // transfer to stop.
        let queued = false;
        if (d1) {
          state = { status: 'not-downloaded', progress: 0, error: '' };
          render();
          queued = await d1.start({ chatModel: modelId });
        }
        if (!queued) {
          inFlight = false;
          await startChatModel();
          return;
        }
      }
    } catch (error) {
      inFlight = false;
      setState({ status: 'error', error: error?.message || String(error) });
      return;
    }
    inFlight = false;
    await refresh();
  });

  // The offscreen host broadcasts transfer progress; polling is the fallback.
  runtime.onMessage?.addListener?.((message) => {
    if (message?.type !== 'webgpu-text-download-state' || inFlight) return false;
    if (String(message.state?.modelId || '').trim() !== modelId) return false;
    setState(normalizeLocalModelSnapshot(message.state, modelId));
    return false;
  });

  render();
  void refresh({ quiet: true });
  return {
    getState: () => ({ ...state }),
    refresh,
    d1,
    dispose() {
      disposed = true;
      clearTimeout(pollTimer);
      d1?.dispose();
    },
  };
}

// ── Optional WebBrain Companion ──────────────────────────────────────────
// The tray app that lets WebBrain use the Claude, ChatGPT, Gemini, Grok or
// Kimi plan someone already pays for. The card links the build for this
// computer and watches for the app the way onboarding's model scan does
// (list_provider_models), so it turns green once the app runs and is signed in.

const COMPANION_PROVIDER_ID = 'webbrain_companion';
const COMPANION_POLL_MS = 4000;

/** 'idle' (not running), 'signin' (running, no plan signed in) or 'ready'. */
export function normalizeCompanionProbe(response) {
  if (response?.ok !== true) return 'idle';
  const models = Array.isArray(response.models) ? response.models.filter((model) => String(model || '').trim()) : [];
  return models.length > 0 ? 'ready' : 'signin';
}

export function companionStatusKey(status) {
  switch (status) {
    case 'ready': return 'install.companion.ready';
    case 'signin': return 'install.companion.signin';
    case 'idle': return 'install.companion.idle';
    default: return '';
  }
}

export function initializeCompanionSetup({
  documentLike = globalThis.document,
  runtime = globalThis.chrome?.runtime,
  navigatorLike = globalThis.navigator,
  translate = t,
  pollMs = COMPANION_POLL_MS,
} = {}) {
  const root = documentLike?.getElementById?.('companion-setup');
  if (!root) return null;
  const link = documentLike.getElementById('companion-download');
  const label = documentLike.getElementById('companion-download-label');
  const statusLine = documentLike.getElementById('companion-status');

  // A computer with no build (ChromeOS, say) gets the download page instead.
  const download = companionDownloadFor(detectCompanionPlatform(navigatorLike));
  if (link) link.href = download?.url || WEBBRAIN_COMPANION_SITE_URL;
  if (label) label.textContent = download ? translate('install.companion.download', { os: download.os }) : translate('install.companion.get');

  let status = 'checking';
  let timer = null;
  let disposed = false;
  let probing = false;
  const render = () => {
    root.dataset.state = status;
    if (!statusLine) return;
    const key = companionStatusKey(status);
    statusLine.hidden = !key;
    statusLine.textContent = key ? translate(key) : '';
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = null;
    if (!disposed && status !== 'ready') timer = setTimeout(() => { void refresh(); }, pollMs);
  };

  async function refresh() {
    if (disposed || probing || !runtime?.sendMessage) return;
    probing = true;
    try {
      status = normalizeCompanionProbe(await backgroundCommand(runtime, 'list_provider_models', { providerId: COMPANION_PROVIDER_ID }));
    } catch {
      status = 'idle';
    } finally {
      probing = false;
    }
    render();
    schedule();
  }

  // Coming back from the installer or the app's sign-in window checks at once.
  const onVisible = () => {
    if (documentLike.visibilityState !== 'hidden' && status !== 'ready') void refresh();
  };
  documentLike.addEventListener?.('visibilitychange', onVisible);

  render();
  void refresh();
  return {
    refresh,
    getState: () => status,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      documentLike.removeEventListener?.('visibilitychange', onVisible);
    },
  };
}

async function getInstallTab(build) {
  const tabs = build === 'firefox'
    ? globalThis.browser?.tabs
    : globalThis.chrome?.tabs;
  try {
    return await tabs?.getCurrent?.();
  } catch {
    return null;
  }
}

/**
 * The page is complete without any motion, so a failure here must never get in
 * the way of the open-panel action that the rest of hydration wires up.
 */
function initializeMotion() {
  try {
    initializeShowcaseAutoplay({ select: (feature) => selectInstallFeature(feature) });
    initializeScenePlayback();
    initializeCardSpotlight();
    startRecordingClock();
  } catch (error) {
    console.warn('[WebBrain] Install page motion unavailable:', error);
  }
}

async function hydrateGuide() {
  applyDOMTranslations(document);
  initializeFeatureShowcase();
  initializeMotion();
  try {
    // Chrome only: the Firefox page has no local-model block.
    initializeLocalModelDownload();
  } catch (error) {
    console.warn('[WebBrain] Local model download unavailable:', error);
  }
  try {
    // Both builds: Firefox reaches the Companion through its background too.
    initializeCompanionSetup({ runtime: globalThis.chrome?.runtime || globalThis.browser?.runtime });
  } catch (error) {
    console.warn('[WebBrain] Companion setup unavailable:', error);
  }

  const build = document.documentElement.dataset.build;
  const [browserKey, installTab] = await Promise.all([
    detectBrowser(),
    getInstallTab(build),
  ]);
  const guide = getBrowserGuide(browserKey);
  document.documentElement.dataset.browser = browserKey;
  document.getElementById('browser-label').textContent = t('install.browser.detected', { browser: guide.name });

  const openButton = document.getElementById('open-panel-button');
  const openLabel = document.getElementById('open-panel-label');
  const status = document.getElementById('open-panel-status');
  // Chrome keeps the only open button in the closing call-to-action: the hero
  // offers the optional local model instead. Firefox has no local model, so
  // its hero keeps the open button and the closing call-to-action mirrors it,
  // forwarding to the primary button (one click handler, one in-flight open)
  // and repeating its status line.
  const mirrorButtons = Array.from(document.querySelectorAll('[data-open-panel-mirror]'));
  const statusLines = [status, ...document.querySelectorAll('[data-open-panel-status-mirror]')];
  const showStatus = (text, isError = false) => {
    for (const line of statusLines) {
      line.classList.toggle('is-error', isError);
      line.textContent = text;
    }
  };
  const setMirrorsDisabled = (disabled) => {
    for (const mirror of mirrorButtons) mirror.disabled = disabled;
  };
  openLabel.textContent = t(guide.openKey);

  openButton.addEventListener('click', () => {
    openButton.classList.add('is-opening');
    openButton.disabled = true;
    setMirrorsDisabled(true);
    openButton.setAttribute('aria-busy', 'true');
    showStatus('');

    let opening;
    try {
      opening = openInstalledPanel({ build, tabId: installTab?.id });
    } catch {
      opening = Promise.reject(new Error('Panel unavailable'));
    }

    Promise.resolve(opening).then(() => {
      openButton.classList.remove('is-opening');
      openButton.disabled = false;
      setMirrorsDisabled(false);
      openButton.removeAttribute('aria-busy');
      showStatus('');
      reportInstalledPanelOpened({ build, tabId: installTab?.id }).catch(() => {});
    }).catch(() => {
      openButton.classList.remove('is-opening');
      openButton.disabled = false;
      setMirrorsDisabled(false);
      openButton.removeAttribute('aria-busy');
      showStatus(t(guide.failureKey), true);
    });
  });
  for (const mirror of mirrorButtons) {
    mirror.addEventListener('click', () => openButton.click());
  }
  openButton.disabled = false;
  setMirrorsDisabled(false);

  if (build === 'firefox') {
    document.getElementById('shortcut-hint')?.remove();
  }
}

if (typeof document !== 'undefined') {
  hydrateGuide().catch(() => {
    const build = document.documentElement.dataset.build;
    const guide = getBrowserGuide(build === 'firefox' ? 'firefox' : 'unknown');
    const status = document.getElementById('open-panel-status');
    if (status) {
      status.classList.add('is-error');
      status.textContent = t(guide.failureKey);
    }
  });
}
