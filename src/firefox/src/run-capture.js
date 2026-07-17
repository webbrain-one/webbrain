import { filenameInConfiguredDownloadDirectory } from './download-directory.js';

export const RUN_CAPTURE_START_ERROR_PREFIX = 'Run capture could not start: ';

function sanitizeRunCaptureSaveAs(value) {
  const filename = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()
    .trim()
    .replace(/[<>:"|?*]/g, '-')
    .replace(/[. ]+$/g, '');
  if (!filename || filename === '.' || filename === '..') return '';
  return filename.slice(0, 180);
}

function runCaptureTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
}

function buildRunScreenshotFilenames(saveAs, date = new Date()) {
  const requested = sanitizeRunCaptureSaveAs(saveAs);
  const stem = (requested.replace(/\.png$/i, '') || `webbrain-run-${runCaptureTimestamp(date)}`).slice(0, 170);
  return {
    before: `${stem}-before.png`,
    after: `${stem}-after.png`,
  };
}

function buildRunRecordingFilename(saveAs) {
  const requested = sanitizeRunCaptureSaveAs(saveAs);
  if (!requested) return null;
  const stem = requested.replace(/\.webm$/i, '').replace(/[. ]+$/g, '') || 'webbrain-recording';
  return `${stem.slice(0, 175)}.webm`;
}

function normalizeRunCaptureRequest(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid run-capture request.');
  }
  if (value.kind !== 'record' && value.kind !== 'screenshot') {
    throw new Error('Invalid run-capture kind.');
  }
  if (value.saveAs != null && typeof value.saveAs !== 'string') {
    throw new Error('Invalid run-capture filename.');
  }
  return { kind: value.kind, saveAs: value.saveAs || null };
}

export async function captureAndSaveRunScreenshot(api, tabId, filename) {
  let tab = tabId == null ? null : await api.tabs.get(tabId);
  if (!tab || tab.windowId == null) {
    throw new Error('The run tab is no longer available.');
  }
  // A run can activate a new tab. Return to the originating tab so the after
  // image captures the page that the agent operated on.
  if (!tab.active) {
    tab = await api.tabs.update(tabId, { active: true });
  }
  if (!tab?.active || tab.windowId == null) {
    throw new Error('The run tab could not be activated for capture.');
  }
  const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  filename = await filenameInConfiguredDownloadDirectory(api, filename);
  const downloadId = await api.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { filename, downloadId };
}

export function createRunCaptureController({
  api,
  startRecording = null,
  stopRecording = null,
  unsupportedRecordingMessage = 'Tab recording is not supported in this browser.',
} = {}) {
  async function start(request, tabId) {
    if (request == null) return null;
    try {
      const directive = normalizeRunCaptureRequest(request);
      if (directive.kind === 'screenshot') {
        const filenames = buildRunScreenshotFilenames(directive.saveAs);
        const before = await captureAndSaveRunScreenshot(api, tabId, filenames.before);
        return { kind: 'screenshot', filenames, before };
      }

      if (!startRecording || !stopRecording) throw new Error(unsupportedRecordingMessage);
      const result = await startRecording(tabId, {
        video: true,
        mic: true,
        showBanner: true,
        filename: buildRunRecordingFilename(directive.saveAs),
      });
      if (!result?.ok) throw new Error(result?.error || 'unknown recording error');
      return {
        kind: 'record',
        recordingId: result.state?.recordingId || null,
        micError: result.state?.hasMic === false ? result.state?.micError || null : null,
      };
    } catch (error) {
      throw new Error(`${RUN_CAPTURE_START_ERROR_PREFIX}${error?.message || String(error)}`);
    }
  }

  async function finish(state, tabId) {
    if (!state) return null;
    if (state.kind === 'record') {
      const result = await stopRecording({ expectedRecordingId: state.recordingId });
      if (!result?.ok) throw new Error(result?.error || 'unknown recording error');
      return { kind: 'record', filename: result.filename || null };
    }

    const after = await captureAndSaveRunScreenshot(api, tabId, state.filenames.after);
    return {
      kind: 'screenshot',
      filenames: [state.filenames.before, state.filenames.after],
      before: state.before,
      after,
    };
  }

  return { start, finish };
}
