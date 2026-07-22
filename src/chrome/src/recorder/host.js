/**
 * Service-worker-side recorder orchestration.
 *
 * Two user-driven flows share this:
 *   • `/record` — current-tab capture via chrome.tabCapture.
 *   • `/record --full-screen` — screen/window capture via getDisplayMedia().
 *
 * Without this shared module, the two paths would either duplicate the
 * orchestration or have to round-trip messages through each other. Both
 * are ugly.
 *
 * Exports
 *   • getRecordingState()        — current state snapshot (read-only)
 *   • prepareRecordingHost()     — boots the offscreen recorder host before
 *     the display picker opens in that same recording context.
 *   • startTabRecording(tabId, options) — gets tabCapture streamId,
 *     boots the offscreen recorder, persists state, broadcasts a
 *     `recording_update` event:'started' to sidepanels.
 *   • startDisplayRecording(options) — prompts for a display/window stream via
 *     the offscreen recorder and records it with the same stop/download path.
 *   • stopTabRecording()         — halts the offscreen recorder, broadcasts
 *     event:'saving' (banner down), waits for the browser-resolved .webm path,
 *     broadcasts event:'stopped', kicks off transcription if requested.
 *
 * Transcription provider lookup is done lazily via setProviderManager()
 * so we can wire it from background.js without a circular import.
 */

import { ensureOffscreen } from '../offscreen/ensure.js';
import { transcribeAudio } from '../agent/transcribe.js';
import {
  RECORDING_DOWNLOAD_TIMEOUT_MS,
  resolveSavedDownload,
} from '../download-result.js';

let recordingState = { active: false };
const RECORDING_STATE_KEY = 'recordingState';
const RECORDING_SAFETY_ALARM_NAME = 'webbrain-recording-safety-cap';
export const MAX_RECORDING_MS = 2 * 60 * 60 * 1000; // 2 hours
let recordingSafetyTimeout = null;
let recordingStateReady = null;

function normalizeRecordingFilename(value) {
  const filename = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()
    .trim()
    .replace(/[<>:"|?*]/g, '-')
    .replace(/[. ]+$/g, '');
  if (!filename || filename === '.' || filename === '..') return null;
  const stem = filename.replace(/\.webm$/i, '').replace(/[. ]+$/g, '') || 'webbrain-recording';
  return `${stem.slice(0, 175)}.webm`;
}

let providerManagerRef = null;

export function setProviderManager(pm) {
  providerManagerRef = pm;
}

export function getRecordingState() {
  return recordingState;
}

/** Live capture or in-flight disk flush — either blocks a concurrent start. */
function isRecordingBusy(state = recordingState) {
  return !!(state?.active || state?.saving);
}

function getRecordingSafetyDueAt(state = recordingState) {
  const startedAt = Number(state?.startedAt || 0);
  return startedAt > 0 ? startedAt + MAX_RECORDING_MS : 0;
}

function clearRecordingSafetyWatchdog() {
  if (recordingSafetyTimeout) {
    clearTimeout(recordingSafetyTimeout);
    recordingSafetyTimeout = null;
  }
  try { chrome.alarms?.clear?.(RECORDING_SAFETY_ALARM_NAME); } catch {}
}

function scheduleRecordingSafetyWatchdog(state = recordingState) {
  if (!state?.active) {
    clearRecordingSafetyWatchdog();
    return;
  }
  const dueAt = getRecordingSafetyDueAt(state);
  if (!dueAt) return;
  if (recordingSafetyTimeout) {
    clearTimeout(recordingSafetyTimeout);
    recordingSafetyTimeout = null;
  }
  const delay = Math.max(0, dueAt - Date.now());
  recordingSafetyTimeout = setTimeout(() => {
    stopRecordingForSafetyCap().catch((e) => {
      console.warn('[WebBrain] recording safety cap failed:', e);
    });
  }, delay);
  try { chrome.alarms?.create?.(RECORDING_SAFETY_ALARM_NAME, { when: dueAt }); } catch {}
}

async function loadRecordingState() {
  try {
    const stored = await chrome.storage.session.get(RECORDING_STATE_KEY);
    if (stored[RECORDING_STATE_KEY]) recordingState = stored[RECORDING_STATE_KEY];
  } catch { /* session storage unavailable */ }
  // A saving reservation only makes sense while this process is awaiting
  // resolveSavedDownload. After a service-worker restart the wait is gone —
  // free the slot so the user is not blocked forever.
  if (recordingState?.saving && !recordingState?.active) {
    recordingState = { active: false };
    try {
      await chrome.storage.session?.set?.({ [RECORDING_STATE_KEY]: recordingState });
    } catch { /* best-effort */ }
  }
  if (recordingState.active) scheduleRecordingSafetyWatchdog(recordingState);
}
recordingStateReady = loadRecordingState();

try {
  chrome.alarms?.onAlarm?.addListener?.((alarm) => {
    if (alarm?.name !== RECORDING_SAFETY_ALARM_NAME) return;
    stopRecordingForSafetyCap().catch((e) => {
      console.warn('[WebBrain] recording safety alarm failed:', e);
    });
  });
} catch {}

async function ensureRecordingStateLoaded() {
  try { await recordingStateReady; } catch {}
}

function saveRecordingState() {
  chrome.storage.session?.set({ [RECORDING_STATE_KEY]: recordingState }).catch(() => {});
}

export async function getRecordingStateFresh({ beforeFinalizeRecording = null } = {}) {
  await ensureRecordingStateLoaded();
  if (recordingState.active) {
    await reconcileStaleRecordingState({ finalizeInactiveSession: true, beforeFinalizeRecording });
    if (recordingState.active && Date.now() >= getRecordingSafetyDueAt(recordingState)) {
      await stopRecordingForSafetyCap({ beforeFinalizeRecording });
    }
  }
  return recordingState;
}

function broadcastContentRecordingState(active) {
  try {
    chrome.tabs?.query?.({}, (tabs) => {
      for (const tab of tabs || []) {
        if (tab?.id == null) continue;
        try {
          chrome.tabs.sendMessage(tab.id, {
            target: 'content',
            action: 'recording_state',
            active,
          }).catch?.(() => {});
        } catch {}
      }
    });
  } catch {}
}

function broadcast(event, payload = {}, { contentActive } = {}) {
  try {
    chrome.runtime.sendMessage({
      target: 'sidepanel',
      action: 'recording_update',
      event,
      ...payload,
    }).catch(() => {});
  } catch {}
  if (contentActive === true) broadcastContentRecordingState(true);
  else if (contentActive === false) broadcastContentRecordingState(false);
  else if (event === 'started') broadcastContentRecordingState(true);
  else if (event === 'stopped' || event === 'saving') broadcastContentRecordingState(false);
}

export async function prepareRecordingHost() {
  try {
    await ensureOffscreen();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `offscreen setup failed: ${e.message}` };
  }
}

// Probe the offscreen recorder for its live state. The return value is a
// discriminated verdict the reconciler can act on safely:
//   • { absent: true }  — no offscreen document exists (couldn't be created, or
//     it's confirmed gone). Nothing can be recording, so a stale active flag is
//     safe to clear.
//   • null              — a document exists but didn't answer (transient
//     failure). Ambiguous: it MIGHT be hosting a live recording, so the
//     reconciler must NOT clear on this.
//   • the recorder's state object on success.
async function readOffscreenRecorderState() {
  try {
    await ensureOffscreen();
  } catch {
    // The offscreen document can't even be established — definitively no
    // MediaRecorder running anywhere.
    return { absent: true };
  }
  try {
    const state = await chrome.runtime.sendMessage({ type: 'recorder-state' });
    return state || null;
  } catch {
    // The document didn't answer. Tell a truly-gone document (evicted — safe to
    // treat as no recorder) apart from a transient message failure on a live
    // document (ambiguous — must not clear a recording out from under the user).
    let exists = true;
    try { exists = await chrome.offscreen.hasDocument(); } catch {}
    return exists ? null : { absent: true };
  }
}

async function beforeRecordingFinalize(beforeFinalizeRecording) {
  if (!recordingState?.transcribeAfter || typeof beforeFinalizeRecording !== 'function') return;
  try {
    await beforeFinalizeRecording();
  } catch (e) {
    console.warn('[WebBrain] recording finalize provider preload failed:', e);
  }
}

async function reconcileStaleRecordingState({ finalizeInactiveSession = false, beforeFinalizeRecording = null } = {}) {
  const offscreenState = await readOffscreenRecorderState();
  // Couldn't reach a verdict (document exists but didn't answer). Stay
  // conservative and leave the flag as-is rather than risk tearing down a live
  // recording on a transient message failure.
  if (offscreenState === null) return false;
  // A genuinely live recording — never clear it out from under the user.
  if (offscreenState.recording || offscreenState.paused || offscreenState.stopping) return false;
  // The offscreen recorder still holds a finished-but-unflushed session (its
  // MediaRecorder stopped before the Stop message landed). Finalize it so the
  // captured bytes are saved instead of dropped.
  if (offscreenState.tabId && finalizeInactiveSession) {
    await beforeRecordingFinalize(beforeFinalizeRecording);
    await stopTabRecording();
    return recordingState.active === false;
  }
  if (offscreenState.tabId) return false;
  // Either the offscreen recorder reports idle (no session) or it's absent
  // entirely ({ absent: true }) — the document that would host a capture is
  // gone. In both cases no live recording can be relying on the flag, so clear
  // the stuck active state instead of leaving the banner/agent to believe a
  // capture is still running.
  clearRecordingSafetyWatchdog();
  recordingState = { active: false };
  saveRecordingState();
  broadcast('stopped', {
    result: {
      ok: true,
      alreadyStopped: true,
      staleCleared: true,
    },
  });
  return true;
}

/**
 * Start a recording session.
 *
 * @param {object} spec
 *   • source      "tab" or "display"
 *   • tabId       source tab for tab capture, optional origin tab for display
 *   • streamId    tabCapture stream id; only used for source:"tab"
 *   • options     video/audio/mic/transcribe/showBanner/mimeType/filename
 */
async function startRecordingSession({ source, tabId = null, streamId = null, options = {} }) {
  await ensureRecordingStateLoaded();
  if (recordingState.saving) {
    // Disk flush can take minutes for large .webm writes. Keep the slot reserved
    // so a late stopped broadcast cannot clobber a second session's UI.
    return {
      ok: false,
      error: 'A recording is still being saved. Wait a moment and try again.',
    };
  }
  if (recordingState.active) {
    const cleared = await reconcileStaleRecordingState({ finalizeInactiveSession: true });
    if (!cleared) {
      return {
        ok: false,
        error: `A recording is already in progress on tab ${recordingState.tabId || 'another source'}.`,
      };
    }
  }

  if (source === 'tab' && !tabId) return { ok: false, error: 'No tab ID supplied.' };
  if (source !== 'tab' && source !== 'display') {
    return {
      ok: false,
      error: `Unknown recording source: ${source || 'missing'}.`,
    };
  }

  if (source === 'tab') {
    // tabCapture.getMediaStreamId requires the target tab to be active in
    // its window. Activate first if needed.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && !tab.active) await chrome.tabs.update(tabId, { active: true });
    } catch { /* let the next step's error speak for it */ }

    try {
      streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId(
          { targetTabId: tabId },
          (id) => {
            const err = chrome.runtime.lastError;
            if (err || !id) reject(new Error(err?.message || 'getMediaStreamId returned no id'));
            else resolve(id);
          }
        );
      });
    } catch (e) {
      return { ok: false, error: `tabCapture failed: ${e.message}` };
    }
  }

  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `offscreen setup failed: ${e.message}` };
  }

  let recResult;
  try {
    recResult = await chrome.runtime.sendMessage({
      type: 'recorder-start',
      streamId,
      tabId,
      options: {
        source,
        video: options.video !== false,
        audio: options.audio !== false,
        mic: options.mic !== false,
        mimeType: options.mimeType || null,
      },
    });
  } catch (e) {
    return { ok: false, error: `recorder-start dispatch failed: ${e.message}` };
  }
  if (!recResult?.ok) {
    return { ok: false, error: recResult?.error || 'recorder failed to start' };
  }

  const startedAt = Date.now();
  recordingState = {
    active: true,
    recordingId: globalThis.crypto?.randomUUID?.()
      || `${startedAt}-${Math.random().toString(36).slice(2, 10)}`,
    source,
    tabId,
    startedAt,
    mimeType: recResult.mimeType,
    hasVideo: recResult.hasVideo,
    hasAudio: recResult.hasAudio,
    hasMic: recResult.hasMic,
    micError: recResult.micError || null,
    captureAudioError: recResult.captureAudioError || null,
    transcribeAfter: !!options.transcribeAfter,
    showBanner: source === 'tab' ? options.showBanner !== false : options.showBanner === true,
    filename: normalizeRecordingFilename(options.filename),
  };
  saveRecordingState();
  scheduleRecordingSafetyWatchdog(recordingState);
  broadcast('started', { state: recordingState });

  return { ok: true, state: recordingState };
}

export async function startTabRecording(tabId, options = {}) {
  return startRecordingSession({ source: 'tab', tabId, options });
}

export async function startDisplayRecording(options = {}) {
  return startRecordingSession({
    source: 'display',
    tabId: options.tabId || null,
    options,
  });
}

/**
 * Stop the active recording, save the .webm, optionally transcribe.
 *
 * @returns {Promise<{ok:true, filename, downloadId, ...}|{ok:false, error}>}
 */
async function stopRecordingForSafetyCap({ beforeFinalizeRecording = null } = {}) {
  await ensureRecordingStateLoaded();
  if (!recordingState.active) {
    clearRecordingSafetyWatchdog();
    return { ok: true, alreadyStopped: true };
  }
  const dueAt = getRecordingSafetyDueAt(recordingState);
  if (dueAt && Date.now() < dueAt) {
    scheduleRecordingSafetyWatchdog(recordingState);
    return { ok: true, notDue: true };
  }
  await beforeRecordingFinalize(beforeFinalizeRecording);
  return stopTabRecording({ reason: 'safety_cap' });
}

export async function stopTabRecording(opts = {}) {
  await ensureRecordingStateLoaded();
  if (opts.expectedRecordingId
      && isRecordingBusy()
      && recordingState.recordingId !== opts.expectedRecordingId) {
    return { ok: true, skipped: true, reason: 'different-recording' };
  }
  if (recordingState.saving) {
    // Capture already stopped; disk flush is still running for this session.
    return { ok: true, alreadyStopped: true, saving: true };
  }
  if (!recordingState.active) {
    // Scoped run cleanup may arrive after the user already stopped and saved
    // this recording. Do not rebroadcast an empty stopped result: that would
    // overwrite the panel's useful filename/transcript state.
    if (opts.expectedRecordingId) return { ok: true, alreadyStopped: true };
    // Nothing active. Still broadcast 'stopped' so any sidepanel showing a
    // stale banner clears it, and report success — the user's goal (no active
    // recording) is already met. This is benign (no failure to surface), so
    // the broadcast carries ok:true and the UI clears silently.
    clearRecordingSafetyWatchdog();
    broadcast('stopped', { result: { ok: true, alreadyStopped: true } });
    return { ok: true, alreadyStopped: true };
  }
  let res = null;
  let stopError = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'recorder-stop' });
  } catch (e) {
    stopError = `recorder-stop dispatch failed: ${e.message}`;
  }

  // If the offscreen recorder is gone or refused to stop, the recording is no
  // longer recoverable (e.g. the service worker was suspended for hours and the
  // offscreen session was evicted, but recordingState.active stuck around in
  // session storage). Force the state clear and tell the panel — otherwise the
  // banner can tick forever with no way to dismiss it.
  if (stopError || !res?.ok) {
    const error = stopError || res?.error || 'recorder failed to stop';
    clearRecordingSafetyWatchdog();
    recordingState = { active: false };
    saveRecordingState();
    broadcast('stopped', { result: { ok: false, error } });
    return { ok: true, cleared: true, warning: error };
  }

  // Capture is over as soon as the offscreen recorder stops. Drop the live
  // banner, but keep a saving reservation so a second start cannot race the
  // disk flush and then get wiped by this session's final stopped broadcast.
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/T/, '_')
    .slice(0, 19);
  const filename = recordingState.filename || `webbrain-recording-${stamp}.webm`;
  const wantTranscribeAfter = !!recordingState.transcribeAfter;
  const savingRecordingId = recordingState.recordingId;
  clearRecordingSafetyWatchdog();
  recordingState = {
    active: false,
    saving: true,
    recordingId: savingRecordingId,
    tabId: recordingState.tabId,
    source: recordingState.source,
    startedAt: recordingState.startedAt,
  };
  saveRecordingState();
  broadcast('saving');

  // Save webm to Downloads. The data URL is safe — recorder.js strips
  // the codecs param before passing it to FileReader.readAsDataURL, so
  // chrome.downloads.download's URL parser doesn't get tripped up.
  let downloadId = null;
  let savedDownload = null;
  let saveError = null;
  try {
    downloadId = await chrome.downloads.download({
      url: res.dataUrl,
      filename,
      saveAs: false,
    });
    savedDownload = await resolveSavedDownload(chrome, downloadId, {
      timeoutMs: RECORDING_DOWNLOAD_TIMEOUT_MS,
    });
  } catch (e) {
    saveError = `download failed: ${e.message}`;
  }

  const wantTranscribe = wantTranscribeAfter && !saveError;
  const final = {
    ok: !saveError,
    filename: saveError ? null : savedDownload.filename,
    downloadId,
    state: savedDownload?.state,
    error: saveError || undefined,
    sizeBytes: res.sizeBytes,
    durationMs: res.durationMs,
    mimeType: res.mimeType,
    transcribeAfter: wantTranscribe,
    reason: opts.reason || undefined,
    recordingId: savingRecordingId,
  };

  // Defense in depth: only clear/broadcast terminal stopped for this save if
  // the reservation is still ours (another path should not have started).
  const stillOurSave = recordingState.saving
    && recordingState.recordingId === savingRecordingId
    && !recordingState.active;
  if (stillOurSave) {
    recordingState = { active: false };
    saveRecordingState();
    broadcast('stopped', { result: final });
  } else if (recordingState.active) {
    // A newer live session exists — deliver the path toast without content:false
    // or banner teardown.
    broadcast('saved', { result: final }, { contentActive: true });
  } else {
    broadcast('stopped', { result: final });
  }

  if (wantTranscribe) {
    runTranscription({
      dataUrl: res.dataUrl,
      mimeType: res.mimeType,
      baseFilename: filename.replace(/\.webm$/, ''),
    }).catch((e) => {
      console.error('[WebBrain] runTranscription crashed:', e);
    });
  }

  return final;
}

async function runTranscription({ dataUrl, mimeType, baseFilename }) {
  broadcast('transcribing');

  let blob;
  try {
    const r = await fetch(dataUrl);
    blob = await r.blob();
  } catch (e) {
    return broadcastTranscribed({ ok: false, error: `Couldn't read recording bytes: ${e.message}` });
  }

  if (!providerManagerRef) {
    return broadcastTranscribed({
      ok: false,
      error: 'No provider manager wired — internal error. Transcription unavailable until background.js calls setProviderManager().',
    });
  }
  try {
    if (providerManagerRef.providers?.size === 0) {
      await providerManagerRef.load();
    }
  } catch (e) {
    return broadcastTranscribed({
      ok: false,
      error: `Couldn't load transcription providers: ${e.message || e}`,
    });
  }

  const ext = mimeType?.startsWith('audio/') ? 'webm' : 'webm';
  const result = await transcribeAudio(providerManagerRef.providers, blob, {
    filename: `${baseFilename}.${ext}`,
  });

  if (!result.ok) {
    return broadcastTranscribed({ ok: false, error: result.error });
  }

  const txtFilename = `${baseFilename}.txt`;
  const txtDataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(result.text);
  let downloadId = null;
  let savedDownload = null;
  try {
    downloadId = await chrome.downloads.download({
      url: txtDataUrl,
      filename: txtFilename,
      saveAs: false,
    });
    savedDownload = await resolveSavedDownload(chrome, downloadId, {
      timeoutMs: RECORDING_DOWNLOAD_TIMEOUT_MS,
    });
  } catch (e) {
    return broadcastTranscribed({
      ok: false,
      error: `Transcript text generated but download failed: ${e.message}`,
      text: result.text,
      providerId: result.providerId,
      model: result.model,
    });
  }

  return broadcastTranscribed({
    ok: true,
    text: result.text,
    transcriptDownloadId: downloadId,
    transcriptFilename: savedDownload.filename,
    providerId: result.providerId,
    model: result.model,
    latencyMs: result.latencyMs,
  });
}

function broadcastTranscribed(result) {
  broadcast('transcribed', { result });
  return result;
}
