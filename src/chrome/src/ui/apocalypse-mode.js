import {
  isBasicWikipediaArchive,
  selectBasicWikipediaArchive,
  wikipediaArchiveIncludesImages,
  createApocalypseStore,
} from '../agent/apocalypse-mode.js';
import {
  createEmergencyCorpusStore,
  isEmergencyCorpusRecord,
} from '../agent/emergency-corpus.js';
import {
  EMERGENCY_CORPUS_PROVISIONAL_MEASUREMENTS,
  EMERGENCY_CORPUS_RELEASE,
} from '../agent/emergency-corpus-release.js';
import {
  E5_MODEL_DOWNLOAD_BYTES,
} from '../agent/offline-reranker.js';
import {
  EMERGENCY_DOWNLOAD_STATE_MESSAGE,
  sendEmergencyDownloadCommand,
} from './emergency-download-client.js';
import { createOfflineRagReadinessController } from './offline-rag-readiness.js';
import {
  WEBGPU_COMPASS_TINY_V2_MODEL_ID,
  WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID,
  WEBGPU_TEXT_UI_MODEL_IDS,
  WEBGPU_DTYPE,
  WEBGPU_VISION_CONSENT_VERSION,
  WEBGPU_VISION_CONSENT_VERSION_KEY,
  WEBGPU_VISION_ENABLED_KEY,
  isShippedWebgpuPreset,
  webgpuModelDtype,
  webgpuModelPreset,
} from '../providers/webgpu.js';
import { t } from './i18n.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
let currentThemeMode = 'system';
loadMode().then((mode) => {
  currentThemeMode = mode;
  applyMode(mode, { syncStorage: false });
});
watch(() => currentThemeMode);
runtimeApi?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.themeMode) return;
  const next = changes.themeMode.newValue;
  if (THEME_MODES.includes(next)) currentThemeMode = next;
});

const WEBGPU_VISION_DOWNLOAD_STATE_KEY = 'webgpuVisionDownloadState';
const BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY = 'apocalypseBasicWikipediaAutoStartSuppressed';
const SUPPORTED_CATALOG_TIERS = new Set(['text', 'full']);
const supportsWebgpuVision = typeof globalThis.chrome?.offscreen?.createDocument === 'function';
const elements = Object.fromEntries([
  'enabled', 'installed-count', 'archive-bytes', 'storage-usage', 'notice',
  'vision-model-card', 'vision-model-status', 'vision-model-progress',
  'webgpu-provider-card', 'vision-model-test', 'vision-model-test-result',
  'models-readiness', 'models-readiness-label',
  'basic-wikipedia-card', 'basic-wikipedia-title', 'basic-wikipedia-description', 'basic-wikipedia-meta',
  'basic-wikipedia-status', 'basic-wikipedia-progress', 'basic-wikipedia-start',
  'emergency-box-callout', 'emergency-gate-reason', 'emergency-box-link',
  'offline-answer-engine', 'offline-rag-readiness', 'rag-components',
].map(id => [id, document.getElementById(id)]));
if (elements['vision-model-card']) elements['vision-model-card'].hidden = !supportsWebgpuVision;
if (elements['webgpu-provider-card']) elements['webgpu-provider-card'].hidden = !supportsWebgpuVision;
if (elements['basic-wikipedia-card']) elements['basic-wikipedia-card'].hidden = !supportsWebgpuVision;
let snapshot = null;
let basicWikipediaCatalogItem = null;
let basicWikipediaCatalogError = '';
let basicWikipediaCatalogLoading = false;
let basicWikipediaStartInFlight = false;
let basicWikipediaStartError = '';
let basicWikipediaAutoStartAttempted = false;
let basicWikipediaAutoStartSuppressed = false;
let corpusRecord = null;
let corpusProgress = { loaded: 0, total: 0, percent: 0, phase: '' };
let corpusDownloadInFlight = false;
let semanticState = { status: 'model-missing', loaded: 0, total: 0, progress: 0, error: '' };
let semanticDownloadInFlight = false;
let polling = false;
let processingDownload = false;
let visionDownloadState = null;
let visionFallbackExplicitlyEnabled = false;
let fixedWebgpuProviderConfigured = false;
let fixedWebgpuProviderMarkedReady = false;
let webgpuPresetHydrated = false;
let visionTestRunning = false;
let webgpuDownloadStatusRequest = 0;
let webgpuDownloadState = {
  status: 'checking',
  ready: false,
  modelId: WEBGPU_COMPASS_TINY_V2_MODEL_ID,
  dtype: WEBGPU_DTYPE,
  file: '',
  loaded: 0,
  total: 0,
  progress: 0,
  error: '',
};
const corpusStore = createEmergencyCorpusStore();
const apocalypseStore = createApocalypseStore();
const CORPUS_DOWNLOAD_ID = 'rag-emergency-corpus';
const SEMANTIC_DOWNLOAD_ID = 'rag-semantic-model';
const EMERGENCY_COMPONENT_STATE_EVENT = 'wb-emergency-component-download-state';
const EMERGENCY_COMPONENT_STATE_CHANNEL = 'webbrain-emergency-download-state';
const downloadStateChannel = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel(EMERGENCY_COMPONENT_STATE_CHANNEL)
  : null;

function publishComponentDownloadState(detail) {
  try {
    globalThis.dispatchEvent(new CustomEvent(EMERGENCY_COMPONENT_STATE_EVENT, { detail }));
  } catch { /* Another extension page can still observe the broadcast below. */ }
  try {
    downloadStateChannel?.postMessage(detail);
  } catch { /* The footer tracker is optional and must never interrupt a download. */ }
}

function publishComponentDownloadStates() {
  const corpusStatus = corpusUiStatus();
  const corpusTotal = Number(corpusProgress.totalBytes) || Number(corpusRecord?.staging?.totalBytes) || (corpusRecord?.status === 'ready' ? 245 * 1024 * 1024 : 0);
  const corpusReceived = Number(corpusProgress.bytesReceived) || Number(corpusRecord?.staging?.bytesReceived) || (corpusRecord?.status === 'ready' ? corpusTotal : 0);
  publishComponentDownloadState({
    id: CORPUS_DOWNLOAD_ID,
    status: corpusStatus,
    loaded: corpusReceived,
    total: corpusTotal,
    progress: corpusTotal > 0 ? corpusReceived / corpusTotal : (Number(corpusProgress.percent) ? Number(corpusProgress.percent) / 100 : 0),
    updatedAt: Number(corpusRecord?.updatedAt) || Date.now(),
    detail: corpusStatus === 'extracting' ? t('eb.rag.extracting_detail')
      : corpusStatus === 'indexing' ? t('eb.rag.indexing_detail') : '',
  });

  const semanticStatus = semanticState?.status || (semanticDownloadInFlight ? 'downloading' : 'model-missing');
  const semanticTotal = Number(semanticState?.total) || (semanticState?.status === 'ready' ? 134 * 1024 * 1024 : 0);
  const semanticReceived = Number(semanticState?.loaded) || (semanticState?.status === 'ready' ? semanticTotal : 0);
  publishComponentDownloadState({
    id: SEMANTIC_DOWNLOAD_ID,
    status: semanticStatus,
    loaded: semanticReceived,
    total: semanticTotal,
    progress: Number(semanticState?.progress) || (semanticTotal > 0 ? semanticReceived / semanticTotal : 0),
    updatedAt: Date.now(),
    detail: '',
  });
}

downloadStateChannel?.addEventListener('message', (event) => {
  if (event.data?.type === 'request') renderRagComponents();
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function localGenerationStatus() {
  if (!supportsWebgpuVision) return snapshot?.enabled === true ? 'separate' : 'unavailable';
  const status = String(webgpuDownloadState?.status || '');
  if (status === 'ready') return 'ready';
  if (status === 'error') return 'error';
  if (status === 'downloading' || status === 'paused') return status;
  if (status === 'stopping') return 'downloading';
  if (status && status !== 'checking') return 'model-missing';
  return snapshot?.enabled === true ? 'separate' : 'unavailable';
}

const ragReadiness = elements['offline-rag-readiness']
  ? createOfflineRagReadinessController({
    root: elements['offline-rag-readiness'],
    apocalypseStore,
    corpusStore,
    semanticReranker: {
      async status() {
        return !semanticState?.status || semanticState.status === 'unknown'
          ? 'model-missing'
          : semanticState.status;
      },
      close() {},
    },
    getGenerationStatus: localGenerationStatus,
  })
  : { async refresh() {}, render() {}, close() {} };

function expandOfflineAnswerEngine() {
  if (elements['offline-answer-engine']) elements['offline-answer-engine'].open = true;
}

function bytes(value) {
  const number = Number(value) || 0;
  if (number < 1024) return `${number} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = number;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function notice(message, kind = '') {
  elements.notice.textContent = message || '';
  elements.notice.dataset.kind = kind;
}

async function command(command, payload = {}) {
  const response = await runtimeApi.runtime.sendMessage({ target: 'background', action: 'apocalypse_mode', command, ...payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

async function providerCommand(action, payload = {}) {
  const response = await runtimeApi.runtime.sendMessage({ target: 'background', action, ...payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

function normalizeWebgpuDownloadState(state = {}) {
  const allowedStatuses = new Set(['checking', 'not-downloaded', 'downloading', 'paused', 'stopping', 'ready', 'error']);
  const status = ['starting', 'queued'].includes(state.status)
    ? 'downloading'
    : allowedStatuses.has(state.status) ? state.status : 'not-downloaded';
  const loaded = Math.max(0, Number(state.loaded) || 0);
  const total = Math.max(0, Number(state.total) || 0);
  const progress = status === 'ready'
    ? 100
    : Math.max(0, Math.min(100, Number(state.progress) || (total > 0 ? loaded / total * 100 : 0)));
  return {
    status,
    ready: state.ready === true || status === 'ready',
    modelId: String(state.modelId || ''),
    dtype: state.dtype && typeof state.dtype === 'object' ? state.dtype : String(state.dtype || WEBGPU_DTYPE),
    file: String(state.file || ''),
    loaded,
    total,
    progress,
    error: String(state.error || ''),
  };
}

function formatWebgpuBytes(bytesDownloaded) {
  const value = Math.max(0, Number(bytesDownloaded) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index++;
  }
  return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[index]}`;
}

function webgpuDownloadStatusText(state = webgpuDownloadState) {
  const progress = Math.round(state.progress);
  switch (state.status) {
    case 'checking': return t('st.providers.webgpu_download.checking');
    case 'downloading': return t('st.providers.webgpu_download.downloading', { progress });
    case 'paused': return t('st.providers.webgpu_download.paused', { progress });
    case 'stopping': return t('st.providers.webgpu_download.stopping');
    case 'ready': return t('st.providers.webgpu_download.ready');
    case 'error': return t('st.providers.webgpu_download.error');
    default: return t('st.providers.webgpu_download.not_downloaded');
  }
}

function webgpuDownloadDetailText(state = webgpuDownloadState) {
  if (state.status === 'error') return state.error || t('st.providers.webgpu_download.error_detail');
  if (state.status === 'ready') return t('st.providers.webgpu_download.ready_detail');
  const file = state.file.split('/').pop() || '';
  if (state.total > 0) {
    const byteProgress = `${formatWebgpuBytes(state.loaded)} / ${formatWebgpuBytes(state.total)}`;
    return file ? `${file} · ${byteProgress}` : byteProgress;
  }
  if (file) return file;
  if (state.status === 'paused') return t('st.providers.webgpu_download.paused_detail');
  if (state.status === 'downloading') return t('st.providers.webgpu_download.preparing');
  return t('st.providers.webgpu_download.required');
}

function basicWikipediaRecord() {
  const wikipedia = (snapshot?.archives || []).filter(record => record.archiveKind === 'wikipedia');
  const ready = wikipedia
    .filter(record => record.status === 'ready')
    .sort((left, right) => Number(right.completedAt || right.updatedAt || 0) - Number(left.completedAt || left.updatedAt || 0));
  if (ready.length) return ready[0];
  return wikipedia
    .filter(isBasicWikipediaArchive)
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0]
    || null;
}

function updateEmergencyBoxGate(readinessKind) {
  const locked = readinessKind !== 'ready';
  const callout = elements['emergency-box-callout'];
  const link = elements['emergency-box-link'];
  if (!callout || !link) return;
  callout.dataset.locked = String(locked);
  callout.setAttribute('aria-disabled', String(locked));
  elements['emergency-gate-reason'].hidden = !locked;
  link.setAttribute('aria-disabled', String(locked));
  if (locked) {
    link.removeAttribute('href');
    link.setAttribute('tabindex', '-1');
  } else {
    link.href = link.dataset.href;
    link.removeAttribute('tabindex');
  }
}

function recordWebgpuTextState(state) {
  const normalized = normalizeWebgpuDownloadState(state);
  if (!normalized.modelId) return normalized;
  webgpuTextStateByModel.set(normalized.modelId, normalized);
  return normalized;
}

function anyShippedWebgpuTextReady() {
  if (webgpuDownloadState.ready === true && isShippedWebgpuPreset(webgpuDownloadState.modelId || selectedWebgpuModelId())) {
    return true;
  }
  for (const state of webgpuTextStateByModel.values()) {
    if (!isShippedWebgpuPreset(state.modelId)) continue;
    if (state.ready === true || state.status === 'ready') return true;
  }
  return false;
}

function updateOverallModelsReadiness() {
  if (!supportsWebgpuVision || !elements['models-readiness']) return;
  const textStatus = webgpuDownloadState.status;
  const wikipediaStatus = basicWikipediaRecord()?.status
    || (basicWikipediaStartInFlight ? 'starting' : (basicWikipediaStartError || basicWikipediaCatalogError) ? 'error' : 'not-downloaded');
  const corpusStatus = corpusRecord?.status || (corpusDownloadInFlight ? 'downloading' : 'not-installed');
  const semanticStatus = semanticState?.status || (semanticDownloadInFlight ? 'downloading' : 'model-missing');
  const textReadyForKit = anyShippedWebgpuTextReady();
  const textErrorBlocksKit = textStatus === 'error' && !textReadyForKit;

  let kind = 'pending';
  let key = 'ap.models.status.incomplete';
  if (snapshot?.enabled !== true) {
    kind = 'disabled';
    key = 'ap.models.status.disabled';
  } else if (textErrorBlocksKit || wikipediaStatus === 'error' || corpusStatus === 'error' || semanticStatus === 'error') {
    kind = 'error';
    key = 'ap.models.status.error';
  } else if (webgpuDownloadState.ready === true && wikipediaStatus === 'ready' && corpusStatus === 'ready' && semanticStatus === 'ready' && !anyOtherWebgpuTextBusy()) {
    kind = 'ready';
    key = 'ap.models.status.ready';
  } else if (textStatus === 'paused' || wikipediaStatus === 'paused' || corpusStatus === 'paused' || semanticStatus === 'paused' || anyOtherWebgpuTextPaused()) {
    key = 'ap.models.status.paused';
  } else if (['checking', 'downloading', 'stopping'].includes(textStatus)
    || anyOtherWebgpuTextBusy()
    || ['starting', 'queued', 'downloading', 'retrying'].includes(wikipediaStatus)
    || ['downloading', 'verifying', 'downloaded', 'extracting', 'indexing'].includes(corpusStatus)
    || ['downloading'].includes(semanticStatus)) {
    key = 'ap.models.status.downloading';
  }
  elements['models-readiness'].dataset.kind = kind;
  elements['models-readiness-label'].textContent = t(key);
  const emergencyKind = snapshot?.enabled === true
    && textReadyForKit
    && wikipediaStatus === 'ready'
    && corpusStatus === 'ready'
    && semanticStatus === 'ready'
    && !textErrorBlocksKit
    && wikipediaStatus !== 'error'
    && corpusStatus !== 'error'
    && semanticStatus !== 'error'
    ? 'ready'
    : kind;
  updateEmergencyBoxGate(emergencyKind);
}

function updateWebgpuDownloadPanel() {
  const panel = document.querySelector('[data-webgpu-download-panel]');
  if (!panel) return;
  const state = webgpuDownloadActionState();
  const progress = Math.round(state.progress);
  panel.dataset.state = state.status;
  panel.dataset.indeterminate = String(state.status === 'downloading' && state.total <= 0);
  panel.querySelector('[data-webgpu-download-status]').textContent = webgpuDownloadStatusText(state);
  const detail = webgpuDownloadDetailText(state);
  panel.querySelector('[data-webgpu-download-detail]').textContent = state.modelId !== selectedWebgpuModelId()
    ? `${webgpuModelPreset(state.modelId)?.label || state.modelId} · ${detail}`
    : detail;
  panel.querySelector('[data-webgpu-download-fill]').style.width = `${progress}%`;
  const track = panel.querySelector('[data-webgpu-download-track]');
  track.hidden = state.status === 'ready';
  track.setAttribute('aria-label', t('st.providers.webgpu_download.progress_label'));
  track.setAttribute('aria-valuenow', String(progress));
  track.setAttribute('aria-valuetext', webgpuDownloadStatusText(state));
  const actions = Object.fromEntries(['start', 'pause', 'resume', 'stop'].map(action => [
    action,
    panel.querySelector(`[data-webgpu-download-action="${action}"]`),
  ]));
  actions.start.hidden = !['not-downloaded', 'error'].includes(state.status);
  actions.pause.hidden = state.status !== 'downloading';
  actions.resume.hidden = state.status !== 'paused';
  actions.stop.hidden = !['downloading', 'paused', 'stopping', 'ready', 'error'].includes(state.status);
  actions.stop.textContent = t(state.status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop');
  for (const button of Object.values(actions)) {
    button.disabled = ['checking', 'stopping'].includes(state.status);
  }
  updateOverallModelsReadiness();
}

function confirmCompletedModelRemoval(action, status, modelTitleKey) {
  if (action !== 'stop' || status !== 'ready') return true;
  if (snapshot?.enabled === true || elements['enable']?.checked) {
    notice(t('ap.models.cannot_remove_while_enabled'), 'error');
    return false;
  }
  return globalThis.confirm(t('ap.models.confirm_remove', { model: t(modelTitleKey) }));
}

function selectedWebgpuPreset() {
  const checked = document.querySelector('[data-webgpu-text-preset]:checked');
  return webgpuModelPreset(checked?.value) || webgpuModelPreset(WEBGPU_COMPASS_TINY_V2_MODEL_ID);
}

function selectedWebgpuModelId() {
  return selectedWebgpuPreset()?.id || WEBGPU_COMPASS_TINY_V2_MODEL_ID;
}

function updateWebgpuTextPresetUi() {
  const preset = selectedWebgpuPreset();
  const size = document.querySelector('[data-webgpu-text-size]');
  if (size) size.textContent = `${preset?.size || '1.87 GB'} · WebGPU`;
  const warning = document.querySelector('[data-webgpu-text-warning]');
  if (warning) {
    const isXs = preset?.id === WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID;
    warning.hidden = !isXs;
    if (isXs) {
      warning.removeAttribute('data-i18n');
      warning.textContent = t('st.providers.webgpu_xs_note');
    }
  }
  const copy = document.querySelector('[data-webgpu-text-copy]');
  if (copy) {
    copy.hidden = preset?.id === WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID;
    copy.dataset.i18n = 'ap.webgpu.rag';
    copy.textContent = t('ap.webgpu.rag');
  }
  for (const input of document.querySelectorAll('[data-webgpu-text-preset]')) {
    input.checked = input.value === (preset?.id || WEBGPU_COMPASS_TINY_V2_MODEL_ID);
  }
}

const webgpuTextStateByModel = new Map();
const WEBGPU_TEXT_BUSY_STATUSES = new Set(['starting', 'queued', 'downloading', 'stopping', 'paused']);

function otherWebgpuTextStates() {
  const selected = selectedWebgpuModelId();
  return [...webgpuTextStateByModel.values()].filter(state => state.modelId && state.modelId !== selected);
}

function anyOtherWebgpuTextBusy() {
  return otherWebgpuTextStates().some(state => WEBGPU_TEXT_BUSY_STATUSES.has(state.status));
}

function anyOtherWebgpuTextPaused() {
  return otherWebgpuTextStates().some(state => state.status === 'paused');
}

function webgpuDownloadActionState() {
  // The Compass preset remains selected, but controls must follow a retained
  // Settings transfer, including when Compass itself is already cached.
  const transfers = [webgpuDownloadState, ...otherWebgpuTextStates()]
    .filter(state => WEBGPU_TEXT_BUSY_STATUSES.has(state.status));
  return transfers.find(state => state.status !== 'paused') || transfers[0] || webgpuDownloadState;
}

function setWebgpuDownloadState(state, { syncActiveTransfer = false } = {}) {
  const normalized = recordWebgpuTextState(state);
  const transfer = state?.activeTransfer ? recordWebgpuTextState(state.activeTransfer) : null;
  if (syncActiveTransfer) {
    // A fresh host snapshot is authoritative after completion or worker reset;
    // do not keep stale transfers blocking the panel when events were missed.
    const liveModels = new Set([normalized, transfer]
      .filter(item => item && WEBGPU_TEXT_BUSY_STATUSES.has(item.status))
      .map(item => item.modelId));
    for (const previous of otherWebgpuTextStates()) {
      if (WEBGPU_TEXT_BUSY_STATUSES.has(previous.status) && !liveModels.has(previous.modelId)) {
        webgpuTextStateByModel.delete(previous.modelId);
      }
    }
  }
  if (normalized.modelId && normalized.modelId !== selectedWebgpuModelId()) {
    updateWebgpuDownloadPanel();
    return;
  }
  webgpuDownloadState = normalized;
  updateWebgpuDownloadPanel();
}

async function runVisionDownloadAction(action) {
  if ((action === 'start' || action === 'resume') && !visionFallbackExplicitlyEnabled) {
    globalThis.location.href = runtimeApi.runtime.getURL('src/ui/settings.html#multimodal');
    return;
  }
  const actionMap = {
    start: 'start_webgpu_vision_download',
    resume: 'start_webgpu_vision_download',
    pause: 'pause_webgpu_vision_download',
    stop: 'stop_webgpu_vision_download',
  };
  const backgroundAction = actionMap[action];
  if (!backgroundAction) return;
  if (!confirmCompletedModelRemoval(action, visionDownloadState?.status, 'ap.models.vision.title')) return;
  const previous = visionDownloadState || { modelId: '' };
  visionDownloadState = {
    ...previous,
    status: action === 'pause' ? 'paused' : action === 'stop' ? 'stopping' : 'starting',
    error: '',
  };
  renderVisionDownload();
  try {
    const result = await providerCommand(backgroundAction);
    if (result?.ok === false) throw new Error(result.error || 'Vision Model download action failed.');
    if (action === 'start' || action === 'resume') {
      visionDownloadState = {
        ...visionDownloadState,
        status: result?.ready === true ? 'ready' : 'starting',
        progress: result?.ready === true ? 100 : visionDownloadState?.progress || 0,
      };
    } else {
      visionDownloadState = { ...visionDownloadState, ...result };
    }
    renderVisionDownload();
  } catch (error) {
    visionDownloadState = {
      ...visionDownloadState,
      status: 'error',
      error: error.message,
    };
    renderVisionDownload();
  }
}

async function ensureFixedWebgpuProvider({ markConfigured = false, force = false } = {}) {
  const preset = selectedWebgpuPreset();
  const model = preset?.id || WEBGPU_COMPASS_TINY_V2_MODEL_ID;
  const dtype = preset?.dtype || webgpuModelDtype(model, WEBGPU_DTYPE);
  if (!force && fixedWebgpuProviderConfigured && (!markConfigured || fixedWebgpuProviderMarkedReady)) {
    const current = webgpuDownloadState?.modelId;
    if (current === model) return;
  }
  await providerCommand('update_provider', {
    providerId: 'webgpu',
    config: {
      model,
      dtype,
      contextWindow: preset?.contextWindow || 32768,
      promptTier: 'compact',
    },
    markConfigured,
  });
  fixedWebgpuProviderConfigured = true;
  if (markConfigured) fixedWebgpuProviderMarkedReady = true;
}

async function refreshWebgpuDownloadStatus({ probeSibling = false } = {}) {
  if (!supportsWebgpuVision) return;
  const requestId = ++webgpuDownloadStatusRequest;
  try {
    let state = await providerCommand('get_webgpu_download_status');
    if (requestId !== webgpuDownloadStatusRequest) return;
    let preset = webgpuModelPreset(state?.modelId);
    if (!preset || !WEBGPU_TEXT_UI_MODEL_IDS.includes(preset.id)) {
      // Retain hidden/custom transfers without losing their Pause/Stop controls.
      setWebgpuDownloadState(state, { syncActiveTransfer: true });
      await ensureFixedWebgpuProvider({ force: true });
      if (requestId !== webgpuDownloadStatusRequest) return;
      state = await providerCommand('get_webgpu_download_status');
      if (requestId !== webgpuDownloadStatusRequest) return;
      preset = webgpuModelPreset(state?.modelId);
      if (!preset) throw new Error('Unable to select a shipped WebGPU text preset.');
    }
    if (preset) {
      const selectedId = selectedWebgpuModelId();
      if (!webgpuPresetHydrated || selectedId === preset.id) {
        const input = document.querySelector(`[data-webgpu-text-preset][value="${CSS.escape(preset.id)}"]`);
        if (input) input.checked = true;
        webgpuPresetHydrated = true;
      }
    }
    updateWebgpuTextPresetUi();
    setWebgpuDownloadState(state, { syncActiveTransfer: true });
    if (probeSibling) await refreshSiblingWebgpuTextStatus(state?.modelId, requestId);
    if (requestId !== webgpuDownloadStatusRequest) return;
    if (state?.ready === true) await ensureFixedWebgpuProvider({ markConfigured: true });
  } catch (error) {
    if (requestId === webgpuDownloadStatusRequest) setWebgpuDownloadState({ status: 'error', error: error.message });
  }
}

async function refreshSiblingWebgpuTextStatus(currentModelId, requestId = webgpuDownloadStatusRequest) {
  for (const model of WEBGPU_TEXT_UI_MODEL_IDS) {
    if (model === currentModelId) continue;
    const state = await providerCommand('get_webgpu_download_status', { model, dtype: webgpuModelDtype(model) });
    if (requestId !== webgpuDownloadStatusRequest) return;
    recordWebgpuTextState(state);
  }
  updateWebgpuDownloadPanel();
}

async function onWebgpuTextPresetChange() {
  recordWebgpuTextState(webgpuDownloadState);
  webgpuPresetHydrated = true;
  fixedWebgpuProviderConfigured = false;
  fixedWebgpuProviderMarkedReady = false;
  updateWebgpuTextPresetUi();
  webgpuDownloadState = {
    ...webgpuDownloadState,
    status: 'checking',
    ready: false,
    modelId: selectedWebgpuModelId(),
    dtype: selectedWebgpuPreset()?.dtype || WEBGPU_DTYPE,
    error: '',
  };
  updateWebgpuDownloadPanel();
  updateOverallModelsReadiness();
  try {
    await ensureFixedWebgpuProvider();
    await refreshWebgpuDownloadStatus({ probeSibling: true });
  } catch (error) {
    setWebgpuDownloadState({ status: 'error', error: error.message });
  }
}

async function runWebgpuDownloadAction(action) {
  const actionMap = {
    start: 'start_webgpu_download',
    resume: 'start_webgpu_download',
    pause: 'pause_webgpu_download',
    stop: 'stop_webgpu_download',
  };
  const backgroundAction = actionMap[action];
  if (!backgroundAction) return;
  const state = webgpuDownloadActionState();
  if (action === 'start' && WEBGPU_TEXT_BUSY_STATUSES.has(state.status)) return;
  if (!confirmCompletedModelRemoval(action, state.status, 'ap.models.text.title')) return;
  const target = { model: state.modelId || selectedWebgpuModelId(), dtype: state.dtype };
  try {
    if ((action === 'start' || action === 'resume') && target.model === selectedWebgpuModelId()) {
      await ensureFixedWebgpuProvider({ markConfigured: true });
    }
    if (action === 'start' || action === 'resume') {
      setWebgpuDownloadState({ ...state, status: 'downloading', error: '' });
    } else if (action === 'pause') {
      setWebgpuDownloadState({ ...state, status: 'paused', error: '' });
    } else {
      setWebgpuDownloadState({ ...state, status: 'stopping', error: '' });
    }
    setWebgpuDownloadState(await providerCommand(backgroundAction, target));
  } catch (error) {
    setWebgpuDownloadState({ ...state, status: 'error', ready: false, error: error.message });
  }
}

function setModelTestResult(element, message = '', kind = '') {
  element.textContent = message;
  element.dataset.kind = kind;
}

async function testWebgpuVisionModel() {
  if (visionDownloadState?.status !== 'ready' || visionTestRunning) return;
  visionTestRunning = true;
  renderVisionDownload();
  setModelTestResult(elements['vision-model-test-result'], t('st.vision.testing'));
  try {
    const result = await providerCommand('test_vision_provider');
    if (result?.ok) {
      setModelTestResult(
        elements['vision-model-test-result'],
        t('st.vision.connected', { model: result.model || 'LFM2.5-VL' }),
        'success',
      );
    } else {
      setModelTestResult(
        elements['vision-model-test-result'],
        t('st.vision.failed', { error: result?.error || 'Unknown error' }),
        'error',
      );
    }
  } catch (error) {
    setModelTestResult(elements['vision-model-test-result'], t('st.vision.failed', { error: error.message }), 'error');
  } finally {
    visionTestRunning = false;
    renderVisionDownload();
  }
}

function renderInstalled() {
  elements['installed-count'].textContent = String(snapshot?.installedCount || 0);
  elements['archive-bytes'].textContent = bytes(snapshot?.totalBytes);
  const usage = snapshot?.storage?.usage;
  elements['storage-usage'].textContent = usage == null ? t('ap.unavailable') : bytes(usage);
  elements['storage-usage'].parentElement.title = `${t('ap.metric.storage')}: ${elements['storage-usage'].textContent}`;
  renderBasicWikipediaDownload();
}

function renderBasicWikipediaDownload() {
  if (!supportsWebgpuVision) return;
  const record = basicWikipediaRecord();
  const displayItem = record || basicWikipediaCatalogItem;
  const status = record?.status || 'not-downloaded';
  const progress = record?.size
    ? Math.min(100, Math.round((Number(record.bytesDownloaded) || 0) / Number(record.size) * 100))
    : 0;
  const statusElement = elements['basic-wikipedia-status'];
  const customEdition = Boolean(record && !isBasicWikipediaArchive(record));
  elements['basic-wikipedia-title'].textContent = t(customEdition ? 'ap.models.wikipedia.active_title' : 'ap.models.wikipedia.title');
  elements['basic-wikipedia-description'].textContent = t(customEdition ? 'ap.models.wikipedia.active_desc' : 'ap.models.wikipedia.desc');
  elements['basic-wikipedia-meta'].hidden = !displayItem;
  const tier = displayItem && wikipediaArchiveIncludesImages(displayItem) ? 'full' : 'text';
  elements['basic-wikipedia-meta'].textContent = `${displayItem?.language || 'eng'} · ${String(displayItem?.archiveDate || t('ap.date_unknown')).slice(0, 10)} · ${t(`ap.tier.${tier}`)}`;
  elements['basic-wikipedia-progress'].hidden = !record || ['ready', 'deleting'].includes(status);
  elements['basic-wikipedia-progress'].value = progress;
  statusElement.dataset.kind = status === 'ready' || status === 'error' ? status : '';

  if (status === 'ready') {
    statusElement.textContent = t('ap.status.ready');
  } else if (status === 'error') {
    statusElement.textContent = `${t('ap.status.error')}${record.error ? ` · ${record.error}` : ''}`;
  } else if (record) {
    statusElement.textContent = `${t(`ap.status.${status}`)}${record.size ? ` · ${progress}%` : ''}`;
  } else if (snapshot?.enabled !== true) {
    statusElement.textContent = t('ap.models.wikipedia.waiting');
  } else if (basicWikipediaStartInFlight) {
    statusElement.textContent = t('ap.models.wikipedia.starting');
  } else if (basicWikipediaStartError || basicWikipediaCatalogError) {
    statusElement.dataset.kind = 'error';
    statusElement.textContent = basicWikipediaStartError || basicWikipediaCatalogError || t('ap.models.wikipedia.unavailable');
  } else if (basicWikipediaCatalogLoading || !basicWikipediaCatalogItem) {
    statusElement.textContent = t('ap.models.wikipedia.finding');
  } else if (basicWikipediaAutoStartSuppressed) {
    statusElement.textContent = t('ap.models.wikipedia.stopped');
  } else {
    statusElement.textContent = t('ap.models.wikipedia.required');
  }

  const actions = Object.fromEntries(['pause', 'resume', 'retry', 'read', 'stop'].map(action => [
    action,
    elements['basic-wikipedia-card'].querySelector(`[data-basic-wikipedia-action="${action}"]`),
  ]));
  elements['basic-wikipedia-start'].hidden = snapshot?.enabled !== true || Boolean(record) || !basicWikipediaCatalogItem || basicWikipediaStartInFlight;
  actions.pause.hidden = !['queued', 'downloading', 'retrying'].includes(status);
  actions.resume.hidden = status !== 'paused';
  actions.retry.hidden = status !== 'error' || !record?.downloadUrl || record.errorKind === 'archive-unreadable';
  actions.read.hidden = status !== 'ready';
  actions.stop.hidden = !record || status === 'deleting';
  actions.stop.textContent = t(status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop');
  for (const button of [elements['basic-wikipedia-start'], ...Object.values(actions)]) {
    button.disabled = basicWikipediaStartInFlight || status === 'deleting';
  }
  updateOverallModelsReadiness();
}

function openWikipediaReader(id) {
  const url = runtimeApi.runtime.getURL(`src/ui/wikipedia-reader.html?id=${encodeURIComponent(id)}`);
  const popup = { url, type: 'popup', width: 1180, height: 840 };
  try {
    if (globalThis.browser?.windows?.create) globalThis.browser.windows.create(popup).catch(() => globalThis.open(url, '_blank'));
    else if (globalThis.chrome?.windows?.create) {
      globalThis.chrome.windows.create(popup, () => {
        if (globalThis.chrome.runtime.lastError) globalThis.open(url, '_blank');
      });
    } else globalThis.open(url, '_blank');
  } catch {
    globalThis.open(url, '_blank');
  }
}

function renderVisionDownload() {
  if (!supportsWebgpuVision) return;
  const state = visionDownloadState || {};
  const status = state.status || 'not-downloaded';
  const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
  const active = ['queued', 'starting', 'downloading', 'loading'].includes(status);
  elements['vision-model-status'].dataset.kind = status === 'ready' || status === 'error'
    ? status
    : '';
  elements['vision-model-progress'].hidden = !active;
  elements['vision-model-progress'].value = progress;
  elements['vision-model-test'].disabled = !visionFallbackExplicitlyEnabled || status !== 'ready' || visionTestRunning;
  if (status !== 'ready' && !visionTestRunning) setModelTestResult(elements['vision-model-test-result']);

  const actions = Object.fromEntries(['start', 'pause', 'resume', 'stop'].map(action => [
    action,
    document.querySelector(`[data-vision-download-action="${action}"]`),
  ]));
  actions.start.hidden = visionFallbackExplicitlyEnabled
    ? !['idle', 'not-downloaded', 'error'].includes(status)
    : false;
  actions.start.textContent = t(visionFallbackExplicitlyEnabled
    ? 'st.providers.webgpu_download.start'
    : 'st.vision.local.enable');
  actions.pause.hidden = !visionFallbackExplicitlyEnabled
    || !['queued', 'starting', 'downloading', 'loading'].includes(status);
  actions.resume.hidden = !visionFallbackExplicitlyEnabled || status !== 'paused';
  actions.stop.hidden = !['starting', 'queued', 'loading', 'downloading', 'paused', 'stopping', 'ready', 'error'].includes(status);
  actions.stop.textContent = t(status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop');
  for (const button of Object.values(actions)) button.disabled = status === 'stopping';

  if (status === 'ready') {
    elements['vision-model-status'].textContent = t('ap.status.ready');
  } else if (status === 'error') {
    const message = String(state.error || '').trim();
    elements['vision-model-status'].textContent = `${t('ap.status.error')}${message ? ` · ${message}` : ''}`;
  } else if (status === 'downloading') {
    const loadedMb = Math.round(Number(state.loaded || 0) / 1024 / 1024);
    const totalMb = Math.round(Number(state.total || 0) / 1024 / 1024);
    const bytes = totalMb > 0 ? ` · ${loadedMb}/${totalMb} MB` : '';
    elements['vision-model-status'].textContent = `${t('ap.status.downloading')} · ${Math.round(progress)}%${bytes}`;
  } else if (status === 'loading') {
    elements['vision-model-status'].textContent = t('ap.status.downloading');
  } else if (status === 'paused') {
    elements['vision-model-status'].textContent = `${t('ap.status.paused')} · ${Math.round(progress)}%`;
  } else if (status === 'stopping') {
    elements['vision-model-status'].textContent = t('st.providers.webgpu_download.stopping');
  } else if (status === 'queued' || status === 'starting') {
    elements['vision-model-status'].textContent = t('ap.status.queued');
  } else if (snapshot?.enabled) {
    elements['vision-model-status'].textContent = t('st.providers.webgpu_download.not_downloaded');
  } else {
    elements['vision-model-status'].textContent = t('ap.vision.waiting');
  }
  updateOverallModelsReadiness();
}

async function refreshVisionDownload() {
  if (!supportsWebgpuVision) return;
  const stored = await runtimeApi.storage.local.get([
    WEBGPU_VISION_DOWNLOAD_STATE_KEY,
    WEBGPU_VISION_ENABLED_KEY,
    WEBGPU_VISION_CONSENT_VERSION_KEY,
  ]);
  visionDownloadState = stored[WEBGPU_VISION_DOWNLOAD_STATE_KEY] || null;
  visionFallbackExplicitlyEnabled = stored[WEBGPU_VISION_ENABLED_KEY] === true
    && stored[WEBGPU_VISION_CONSENT_VERSION_KEY] === WEBGPU_VISION_CONSENT_VERSION;
  renderVisionDownload();
}

function applyCorpusRecord(record) {
  if (!isEmergencyCorpusRecord(record)) return false;
  corpusRecord = record;
  if (record.staging) corpusProgress = record.staging;
  return true;
}

function ragStatusLabel(status) {
  const key = `eb.rag.status.${String(status || 'unavailable')}`;
  const translated = t(key);
  return translated === key ? String(status || '') : translated;
}

function corpusUiStatus() {
  if (corpusRecord?.status === 'ready' && corpusRecord.active) return 'ready';
  if (corpusDownloadInFlight) return corpusRecord?.status || 'downloading';
  if (corpusRecord?.status && corpusRecord.status !== 'not-installed') return corpusRecord.status;
  return EMERGENCY_CORPUS_RELEASE ? 'not-installed' : 'unavailable';
}

function componentAction(component, action, label, options = {}) {
  const disabled = options.disabled ? ' disabled' : '';
  const danger = options.danger ? ' danger' : '';
  const primary = options.primary ? ' primary' : '';
  return `<button type="button" class="${`${primary}${danger}`.trim()}" data-rag-action="${escapeHtml(action)}" data-rag-component="${escapeHtml(component)}"${disabled}>${escapeHtml(label)}</button>`;
}

function corpusActions(status) {
  const enabled = snapshot?.enabled === true;
  if (status === 'ready') return componentAction('corpus', 'delete', t('eb.delete'), { danger: true });
  if (['downloading', 'verifying', 'extracting', 'indexing'].includes(status)) {
    return componentAction('corpus', 'pause', t('eb.pause'));
  }
  if (status === 'downloaded') return componentAction('corpus', 'download', t('eb.rag.install'), { primary: true });
  if (status === 'paused' || status === 'error') {
    return [
      componentAction('corpus', 'download', t('eb.retry'), { primary: true, disabled: !enabled || !EMERGENCY_CORPUS_RELEASE }),
      componentAction('corpus', 'cancel', t('eb.rag.cancel_install'), { danger: true }),
    ].join('');
  }
  return componentAction('corpus', 'download', t('eb.download'), {
    primary: true,
    disabled: !enabled || !EMERGENCY_CORPUS_RELEASE,
  });
}

function semanticActions(status) {
  const enabled = snapshot?.enabled === true;
  if (status === 'ready') return componentAction('semantic', 'delete', t('eb.delete'), { danger: true });
  if (status === 'downloading') return componentAction('semantic', 'pause', t('eb.pause'));
  if (status === 'paused' || status === 'error') {
    return [
      componentAction('semantic', 'download', t('eb.retry'), { primary: true, disabled: !enabled }),
      componentAction('semantic', 'delete', t('eb.rag.clear_partial'), { danger: true }),
    ].join('');
  }
  return componentAction('semantic', 'download', t('eb.download'), { primary: true, disabled: !enabled });
}

function componentProgress(status, received, total, detail = '') {
  if (!['downloading', 'verifying', 'extracting', 'indexing', 'paused', 'error'].includes(status)) return '';
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
  return `<div class="rag-component-progress">
    <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="progress-fill" style="width:${percent}%"></div></div>
    <div class="progress-detail">${escapeHtml(detail || `${bytes(received)}${total ? ` / ${bytes(total)}` : ''}`)}</div>
  </div>`;
}

function renderRagComponents() {
  const corpusStatus = corpusUiStatus();
  const corpusReceived = Number(corpusProgress.bytesReceived)
    || Number(corpusRecord?.staging?.bytesReceived)
    || 0;
  const corpusTotal = Number(corpusProgress.totalBytes)
    || Number(corpusRecord?.staging?.totalBytes)
    || Number(EMERGENCY_CORPUS_RELEASE?.downloadBytes)
    || 0;
  const activeCorpusBytes = Number(corpusRecord?.active?.extractedBytes || 0)
    + Number(corpusRecord?.active?.indexBytes || 0);
  const provisional = EMERGENCY_CORPUS_PROVISIONAL_MEASUREMENTS;
  const corpusMeta = corpusStatus === 'ready'
    ? `${corpusRecord.active.documentCount} ${t('eb.rag.documents')} · ${bytes(activeCorpusBytes)}`
    : EMERGENCY_CORPUS_RELEASE
      ? `${bytes(EMERGENCY_CORPUS_RELEASE.downloadBytes)} ${t('eb.rag.network')}`
      : t('eb.rag.corpus_pending_meta', {
        count: provisional.sourceDocumentCount,
        size: bytes(provisional.sourceTextBytes),
      });
  const corpusDetail = corpusRecord?.error
    || (corpusStatus === 'extracting' ? t('eb.rag.extracting_detail') : '')
    || (corpusStatus === 'indexing' ? t('eb.rag.indexing_detail') : '');
  const corpusDescriptionKey = !EMERGENCY_CORPUS_RELEASE
    ? 'eb.rag.corpus_pending'
    : (EMERGENCY_CORPUS_RELEASE.preview ? 'eb.rag.corpus_preview' : 'eb.rag.corpus_description');

  const semanticStatus = !semanticState?.status || semanticState.status === 'unknown'
    ? (semanticDownloadInFlight ? 'downloading' : 'model-missing')
    : semanticState.status;
  const semanticReceived = Number(semanticState?.loaded) || 0;
  const semanticTotal = Number(semanticState?.total) || E5_MODEL_DOWNLOAD_BYTES;
  const semanticDetail = semanticState?.error || semanticState?.file || '';
  if (elements['rag-components']) {
    elements['rag-components'].innerHTML = `
    <article class="rag-component" data-status="${escapeHtml(corpusStatus)}">
      <div class="rag-component-copy">
        <h3 class="rag-component-title">${escapeHtml(t('eb.rag.corpus_title'))}<span class="status-label" data-status="${escapeHtml(corpusStatus)}">${escapeHtml(ragStatusLabel(corpusStatus))}</span></h3>
        <p>${escapeHtml(t(corpusDescriptionKey))}</p>
        <div class="rag-component-meta"><span>${escapeHtml(corpusMeta)}</span></div>
      </div>
      <div class="rag-component-actions">${corpusActions(corpusStatus)}</div>
      ${componentProgress(corpusStatus, corpusReceived, corpusTotal, corpusDetail)}
    </article>
    <article class="rag-component" data-status="${escapeHtml(semanticStatus)}">
      <div class="rag-component-copy">
        <h3 class="rag-component-title">${escapeHtml(t('eb.rag.semantic_title'))}<span class="status-label" data-status="${escapeHtml(semanticStatus)}">${escapeHtml(ragStatusLabel(semanticStatus))}</span></h3>
        <p>${escapeHtml(t('eb.rag.semantic_description'))}</p>
        <div class="rag-component-meta"><span>${escapeHtml(bytes(E5_MODEL_DOWNLOAD_BYTES))} ${escapeHtml(t('eb.rag.network'))}</span><span>CPU / WASM</span></div>
      </div>
      <div class="rag-component-actions">${semanticActions(semanticStatus)}</div>
      ${componentProgress(semanticStatus, semanticReceived, semanticTotal, semanticDetail)}
    </article>`;
  }
  updateOverallModelsReadiness();
  publishComponentDownloadStates();
}

async function readEmergencyHostState() {
  const host = await sendEmergencyDownloadCommand('status').catch(() => null);
  if (host?.corpus) applyCorpusRecord(host.corpus);
  else corpusRecord = await corpusStore.get().catch(() => null);
  if (host?.semantic) semanticState = host.semantic;
  return host;
}

async function refresh() {
  snapshot = await command('status');
  elements.enabled.checked = snapshot.enabled === true;
  renderInstalled();
  await refreshVisionDownload().catch(() => {});
  await readEmergencyHostState();
  renderRagComponents();
  void ragReadiness.refresh().catch(() => {});
}

async function loadBasicWikipediaAutoStartPreference() {
  try {
    const stored = await runtimeApi.storage.local.get(BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY);
    basicWikipediaAutoStartSuppressed = stored[BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY] === true;
  } catch {
    basicWikipediaAutoStartSuppressed = false;
  }
}

async function setBasicWikipediaAutoStartSuppressed(suppressed) {
  basicWikipediaAutoStartSuppressed = suppressed === true;
  if (basicWikipediaAutoStartSuppressed) {
    await runtimeApi.storage.local.set({ [BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY]: true });
  } else {
    await runtimeApi.storage.local.remove(BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY);
  }
}

async function startBasicWikipediaDownload({ automatic = false } = {}) {
  if (snapshot?.enabled !== true || basicWikipediaStartInFlight || basicWikipediaRecord() || !basicWikipediaCatalogItem) return;
  if (!automatic) await setBasicWikipediaAutoStartSuppressed(false);
  basicWikipediaStartInFlight = true;
  basicWikipediaStartError = '';
  renderBasicWikipediaDownload();
  try {
    const { download } = await command('resolve', { item: basicWikipediaCatalogItem });
    snapshot = await command('install', { download });
    renderInstalled();
    notice(t(automatic ? 'ap.models.wikipedia.started' : 'ap.queued'), 'success');
  } catch (error) {
    basicWikipediaStartError = error.message;
    notice(error.message, 'error');
  } finally {
    basicWikipediaStartInFlight = false;
    renderBasicWikipediaDownload();
  }
}

function maybeAutoStartBasicWikipediaDownload() {
  if (snapshot?.enabled !== true || basicWikipediaAutoStartSuppressed || basicWikipediaAutoStartAttempted
    || basicWikipediaStartInFlight || basicWikipediaRecord() || !basicWikipediaCatalogItem) return;
  basicWikipediaAutoStartAttempted = true;
  void startBasicWikipediaDownload({ automatic: true });
}

async function startEmergencyCorpusDownload({ automatic = false, confirm = !automatic } = {}) {
  if (snapshot?.enabled !== true || corpusDownloadInFlight || !EMERGENCY_CORPUS_RELEASE) return;
  if (confirm) {
    const installedEstimate = Number(EMERGENCY_CORPUS_RELEASE.installedTextBytes || 0)
      + Number(EMERGENCY_CORPUS_RELEASE.installedIndexBytes
        || Math.round(Number(EMERGENCY_CORPUS_RELEASE.installedTextBytes || 0) * 0.65));
    const confirmKey = EMERGENCY_CORPUS_RELEASE.preview
      ? 'eb.rag.confirm_corpus_preview'
      : 'eb.rag.confirm_corpus';
    if (!globalThis.confirm(t(confirmKey, {
      network: bytes(EMERGENCY_CORPUS_RELEASE.downloadBytes),
      installed: bytes(installedEstimate),
    }))) return;
  }
  corpusDownloadInFlight = true;
  renderRagComponents();
  try {
    await sendEmergencyDownloadCommand('start_corpus');
    notice(t(automatic ? 'ap.models.wikipedia.started' : 'ap.queued'), 'success');
  } catch (error) {
    if (error?.name !== 'AbortError') {
      notice(error.message, 'error');
    }
  } finally {
    corpusDownloadInFlight = false;
    corpusRecord = await corpusStore.get().catch(() => null);
    renderRagComponents();
  }
}

async function maybeAutoStartEmergencyCorpusDownload() {
  if (snapshot?.enabled !== true || corpusDownloadInFlight || !EMERGENCY_CORPUS_RELEASE) return;
  corpusRecord = await corpusStore.get().catch(() => null);
  if (corpusRecord?.status === 'ready' || corpusRecord?.status === 'downloading' || corpusRecord?.status === 'verifying' || corpusRecord?.status === 'extracting' || corpusRecord?.status === 'indexing') {
    renderRagComponents();
    return;
  }
  void startEmergencyCorpusDownload({ automatic: true });
}

async function startSemanticDownload({ automatic = false, confirm = !automatic } = {}) {
  if (snapshot?.enabled !== true || semanticDownloadInFlight) return;
  if (semanticState?.status === 'ready') return;
  if (confirm && !globalThis.confirm(t('eb.rag.confirm_semantic', {
    network: bytes(E5_MODEL_DOWNLOAD_BYTES),
    installed: bytes(E5_MODEL_DOWNLOAD_BYTES),
  }))) return;
  semanticDownloadInFlight = true;
  renderRagComponents();
  try {
    await sendEmergencyDownloadCommand('start_semantic');
    notice(t(automatic ? 'ap.models.wikipedia.started' : 'ap.queued'), 'success');
  } catch (error) {
    if (error?.name !== 'AbortError') {
      notice(error.message, 'error');
    }
  } finally {
    semanticDownloadInFlight = false;
    const snapshotState = await sendEmergencyDownloadCommand('status').catch(() => null);
    if (snapshotState?.semantic) semanticState = snapshotState.semantic;
    renderRagComponents();
  }
}

async function maybeAutoStartSemanticDownload() {
  if (snapshot?.enabled !== true || semanticDownloadInFlight) return;
  await readEmergencyHostState();
  if (semanticState?.status === 'ready' || semanticState?.status === 'downloading') {
    renderRagComponents();
    return;
  }
  void startSemanticDownload({ automatic: true });
}

async function loadBasicWikipediaCatalog() {
  if (snapshot?.enabled !== true || basicWikipediaCatalogItem || basicWikipediaCatalogLoading) return;
  basicWikipediaCatalogLoading = true;
  basicWikipediaCatalogError = '';
  renderBasicWikipediaDownload();
  try {
    const result = await command('catalog', { language: 'eng' });
    const supported = (Array.isArray(result.items) ? result.items : [])
      .filter(item => SUPPORTED_CATALOG_TIERS.has(item.tier));
    basicWikipediaCatalogItem = selectBasicWikipediaArchive(supported);
    basicWikipediaCatalogError = basicWikipediaCatalogItem ? '' : t('ap.models.wikipedia.unavailable');
    maybeAutoStartBasicWikipediaDownload();
  } catch (error) {
    basicWikipediaCatalogError = error.message;
  } finally {
    basicWikipediaCatalogLoading = false;
    renderBasicWikipediaDownload();
  }
}

async function runBasicWikipediaAction(action, sourceButton) {
  const record = basicWikipediaRecord();
  if (!record) return;
  if (action === 'read') {
    openWikipediaReader(record.id);
    return;
  }
  if (action === 'stop') {
    if (record.status === 'ready' && (snapshot?.enabled === true || elements['enable']?.checked)) {
      notice(t('ap.cannot_delete_while_enabled'), 'error');
      return;
    }
    const message = record.target?.kind === 'file-handle' ? t('ap.delete_external') : t('ap.delete_internal');
    if (!globalThis.confirm(message)) return;
    await setBasicWikipediaAutoStartSuppressed(true);
  }
  sourceButton.disabled = true;
  try {
    const archiveAction = action === 'stop' ? 'delete' : action;
    snapshot = await command(archiveAction, { id: record.id });
    renderInstalled();
    const actionLabel = action === 'stop'
      ? t(record.status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop')
      : t(`ap.${archiveAction}`);
    notice(t('ap.action_done', { action: actionLabel }), 'success');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    sourceButton.disabled = false;
    renderBasicWikipediaDownload();
  }
}

document.querySelectorAll('[data-webgpu-download-action]').forEach((button) => {
  button.addEventListener('click', () => runWebgpuDownloadAction(button.dataset.webgpuDownloadAction));
});
document.querySelectorAll('[data-webgpu-text-preset]').forEach((input) => {
  input.addEventListener('change', () => onWebgpuTextPresetChange());
});
document.querySelectorAll('[data-vision-download-action]').forEach((button) => {
  button.addEventListener('click', () => runVisionDownloadAction(button.dataset.visionDownloadAction));
});
elements['vision-model-test']?.addEventListener('click', testWebgpuVisionModel);
elements['basic-wikipedia-start']?.addEventListener('click', () => startBasicWikipediaDownload());
document.querySelectorAll('[data-basic-wikipedia-action]').forEach((button) => {
  button.addEventListener('click', event => runBasicWikipediaAction(button.dataset.basicWikipediaAction, event.currentTarget));
});
elements['rag-components']?.addEventListener('click', async event => {
  const button = event.target.closest('[data-rag-action][data-rag-component]');
  if (!button) return;
  const { ragAction: action, ragComponent: component } = button.dataset;
  try {
    if (component === 'corpus') {
      if (action === 'download') await startEmergencyCorpusDownload({
        confirm: corpusUiStatus() === 'not-installed',
      });
      if (action === 'pause') await sendEmergencyDownloadCommand('pause_corpus');
      if (action === 'cancel') await sendEmergencyDownloadCommand('cancel_corpus');
      if (action === 'delete') {
        if (snapshot?.enabled === true) {
          notice(t('ap.cannot_delete_while_enabled'), 'error');
          return;
        }
        if (globalThis.confirm(t('eb.rag.confirm_delete_corpus'))) {
          await sendEmergencyDownloadCommand('delete_corpus');
          corpusRecord = null;
        }
      }
    }
    if (component === 'semantic') {
      if (action === 'download') await startSemanticDownload({
        confirm: !['paused', 'error'].includes(semanticState?.status),
      });
      if (action === 'pause') await sendEmergencyDownloadCommand('pause_semantic');
      if (action === 'delete') {
        if (snapshot?.enabled === true) {
          notice(t('ap.cannot_delete_while_enabled'), 'error');
          return;
        }
        if (globalThis.confirm(t('eb.rag.confirm_delete_semantic'))) {
          await sendEmergencyDownloadCommand('stop_semantic');
        }
      }
    }
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    await readEmergencyHostState();
    renderRagComponents();
    void ragReadiness.refresh().catch(() => {});
  }
});
runtimeApi.runtime?.onMessage?.addListener?.((message) => {
  if (message?.type === 'webgpu-text-download-state') {
    setWebgpuDownloadState(message.state);
    return false;
  }
  if (message?.type === EMERGENCY_DOWNLOAD_STATE_MESSAGE) {
    const previousCorpus = corpusRecord?.status;
    const previousSemantic = semanticState?.status;
    const corpusUpdated = message.corpus ? applyCorpusRecord(message.corpus) : false;
    if (message.semantic) semanticState = message.semantic;
    if (corpusUpdated || message.semantic) renderRagComponents();
    if (corpusRecord?.status !== previousCorpus || semanticState?.status !== previousSemantic) {
      void ragReadiness.refresh().catch(() => {});
    }
    return false;
  }
  return false;
});
elements['emergency-box-link']?.addEventListener('click', (event) => {
  if (elements['emergency-box-link'].getAttribute('aria-disabled') !== 'true') return;
  event.preventDefault();
  notice(t('ap.emergency.gate'), 'error');
});

elements.enabled.addEventListener('change', async () => {
  try {
    snapshot = await command('enable', { enabled: elements.enabled.checked });
    if (snapshot.enabled === true) {
      basicWikipediaAutoStartAttempted = false;
      basicWikipediaStartError = '';
      await setBasicWikipediaAutoStartSuppressed(false);
    }
    if (snapshot.textModel?.modelId) setWebgpuDownloadState(snapshot.textModel);
    await refreshVisionDownload().catch(() => {});
    renderInstalled();
    renderRagComponents();
    updateOverallModelsReadiness();
    notice(t(elements.enabled.checked ? 'ap.enabled_notice' : 'ap.disabled_notice'), 'success');
    if (snapshot.enabled === true) {
      void loadBasicWikipediaCatalog();
      void maybeAutoStartEmergencyCorpusDownload();
      void maybeAutoStartSemanticDownload();
    }
  } catch (error) { elements.enabled.checked = !elements.enabled.checked; notice(error.message, 'error'); }
});
document.addEventListener('wb-locale-changed', () => {
  renderInstalled();
  renderVisionDownload();
  updateWebgpuTextPresetUi();
  updateWebgpuDownloadPanel();
  renderBasicWikipediaDownload();
  renderRagComponents();
  ragReadiness.render();
  updateOverallModelsReadiness();
});
runtimeApi.storage?.onChanged?.addListener?.((changes, area) => {
  if (!supportsWebgpuVision || area !== 'local') return;
  if (!changes[WEBGPU_VISION_DOWNLOAD_STATE_KEY]
      && !changes[WEBGPU_VISION_ENABLED_KEY]
      && !changes[WEBGPU_VISION_CONSENT_VERSION_KEY]) return;
  if (changes[WEBGPU_VISION_DOWNLOAD_STATE_KEY]) {
    visionDownloadState = changes[WEBGPU_VISION_DOWNLOAD_STATE_KEY].newValue || null;
  }
  if (changes[WEBGPU_VISION_ENABLED_KEY] || changes[WEBGPU_VISION_CONSENT_VERSION_KEY]) {
    void refreshVisionDownload().catch(() => {});
    return;
  }
  renderVisionDownload();
});

async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!processingDownload && (snapshot?.archives || []).some(record => ['queued', 'downloading', 'retrying'].includes(record.status))) {
      processingDownload = true;
      command('process').catch(() => {}).finally(() => { processingDownload = false; });
    }
    await Promise.all([refresh(), refreshWebgpuDownloadStatus()]);
  } catch { /* The next poll or persisted alarm retries. */ }
  finally { polling = false; }
}

await Promise.all([
  refresh().catch(error => notice(error.message, 'error')),
  refreshWebgpuDownloadStatus({ probeSibling: true }),
  loadBasicWikipediaAutoStartPreference(),
]);
const params = new URLSearchParams(globalThis.location.search);
const resumeComponent = params.get('resumeComponent');
if (resumeComponent || globalThis.location.hash === '#offline-answer-engine') {
  expandOfflineAnswerEngine();
}
if (resumeComponent) {
  globalThis.history.replaceState({}, '', `${globalThis.location.pathname}${globalThis.location.hash || ''}`);
  if (resumeComponent === CORPUS_DOWNLOAD_ID) void startEmergencyCorpusDownload({ confirm: false });
  if (resumeComponent === SEMANTIC_DOWNLOAD_ID) void startSemanticDownload({ confirm: false });
}
if (snapshot?.enabled === true) {
  void loadBasicWikipediaCatalog();
  void maybeAutoStartEmergencyCorpusDownload();
  void maybeAutoStartSemanticDownload();
}
globalThis.addEventListener('hashchange', () => {
  if (globalThis.location.hash === '#offline-answer-engine') expandOfflineAnswerEngine();
});
setInterval(poll, 2000);
globalThis.addEventListener('pagehide', () => {
  ragReadiness.close();
  downloadStateChannel?.close();
}, { once: true });
