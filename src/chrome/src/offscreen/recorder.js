/**
 * Offscreen-document tab recorder.
 *
 * Lives in offscreen.html alongside the localhost fetch proxy. Holds the
 * tabCapture MediaStream, the mic MediaStream, the Web Audio mixer, and
 * the MediaRecorder for the duration of a recording. Driven by
 * runtime.onMessage from background.js:
 *
 *   {type:'recorder-start', streamId, tabId, options:{source, video, mic, mimeType}}
 *     ↳ acquires tab stream via getUserMedia(chromeMediaSource:'tab'), or
 *       prompts for a display/window stream via getDisplayMedia() in this
 *       offscreen context, optionally acquires mic, wires Web Audio so the user can still HEAR
 *       the tab while it's being recorded (tabCapture mutes the tab by
 *       default), starts MediaRecorder, replies {ok:true}.
 *
 *   {type:'recorder-stop'}
 *     ↳ flushes MediaRecorder, converts the accumulated chunks to a
 *       blob URL the background script can hand to chrome.downloads.
 *
 *   {type:'recorder-state'}
 *     ↳ {recording, startedAt, tabId, mimeType, sizeEstimate, error?}
 *
 * Everything that needs DOM / WebRTC / MediaRecorder APIs lives here;
 * the service worker can't touch those.
 */

(function () {
  'use strict';

  // Single active session per offscreen doc (Chrome only allows one
  // offscreen doc, and concurrent recordings would conflict anyway).
  let session = null;

  function ts() {
    return new Date().toISOString();
  }

  function log(...args) {
    // Keep these visible — the offscreen DevTools console is the only
    // way to debug a stuck MediaRecorder. Cheap and prefixed.
    console.log('[recorder]', ts(), ...args);
  }

  // Convert a Blob → data URL string we can hand back via runtime.sendMessage.
  // (URL.createObjectURL would also work but the URL is tied to this
  // offscreen doc's lifetime; a data URL survives a doc reload.)
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('FileReader failed'));
      r.readAsDataURL(blob);
    });
  }

  function pickRecorderMimeType({ hasVideo, hasAudio, requestedMime }) {
    const candidates = hasVideo
      ? (hasAudio
          ? [
              'video/webm;codecs=vp9,opus',
              'video/webm;codecs=vp8,opus',
              'video/webm',
            ]
          : [
              'video/webm;codecs=vp9',
              'video/webm;codecs=vp8',
              'video/webm',
            ])
      : [
          'audio/webm;codecs=opus',
          'audio/webm',
        ];
    const chosenMime = (requestedMime && MediaRecorder.isTypeSupported(requestedMime))
      ? requestedMime
      : candidates.find(m => MediaRecorder.isTypeSupported(m));
    if (!chosenMime) {
      throw new Error('No supported MediaRecorder mimeType found.');
    }
    return chosenMime;
  }

  async function start(message) {
    let { streamId, tabId, options } = message || {};
    if (session) {
      const state = session.recorder?.state || '';
      if (state === 'inactive') {
        log('discarding stale inactive session before start');
        try { await releaseSession(session); } catch {}
        session = null;
      }
    }
    if (session) {
      throw new Error('A recording is already in progress.');
    }
    const {
      source = 'tab',
      video = true,
      audio = true,
      mic = true,
      mimeType: requestedMime,
    } = options || {};

    // 1. Capture stream — chrome.tabCapture exposes the active tab as a
    // MediaStream when we pass the streamId we got from
    // chrome.tabCapture.getMediaStreamId() on the service-worker side. For
    // `/record --full-screen`, the offscreen document uses the Web platform's
    // display-media picker directly; offscreen documents only expose
    // chrome.runtime from the extension API surface, so the desktop-capture
    // extension API is intentionally not used here.
    //
    // Note: even if `video:false` was requested, we still pull video from
    // tabCapture and discard the track below — tabCapture's audio path
    // requires you to ask for the full stream, you can't request audio
    // alone via this API.
    let captureStream;
    let captureAudioError = null;
    if (source === 'display') {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Full-screen recording requires display media support.');
      }
      try {
        captureStream = await navigator.mediaDevices.getDisplayMedia({
          audio: audio !== false,
          video: true,
        });
      } catch (e) {
        throw new Error(`Failed to capture screen/window: ${e.message || e}`);
      }
      if (audio !== false && captureStream.getAudioTracks().length === 0) {
        captureAudioError = 'Screen/window audio was not shared or is unavailable.';
      }
    } else {
      const captureConstraints = {
        audio: audio === false ? false : {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
      };
      try {
        captureStream = await navigator.mediaDevices.getUserMedia(captureConstraints);
      } catch (e) {
        throw new Error(`Failed to capture tab: ${e.message || e}`);
      }
    }
    log(`${source} stream acquired`, captureStream.getTracks().map(t => `${t.kind}:${t.label || 'unnamed'}`));

    // 2. Mic stream — best-effort. If the user has not granted mic
    // permission, fall through with mic disabled instead of failing the
    // whole recording.
    let micStream = null;
    let micError = null;
    if (mic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        log('mic stream acquired');
      } catch (e) {
        micError = e.message || String(e);
        log('mic getUserMedia failed:', micError);
      }
    }

    // 3. Web Audio mixer. Combine captured audio + mic into one node. For tab
    // capture, re-pipe captured audio to the speaker so the user can still hear
    // the call; desktop/window capture does not need that passthrough.
    // Everything from here through the MediaRecorder construction can throw
    // (AudioContext under autoplay policy, createMediaStreamSource, or the
    // MediaRecorder constructor on an unsupported config). `session` isn't set
    // yet, so a throw here would otherwise strand the already-acquired tab/mic
    // streams (tab left captured + muted) with no way for stop() to release
    // them. Release everything we acquired before rethrowing.
    let audioContext = null;
    let recorder;
    let chosenMime;
    try {
      const capturedAudioTracks = captureStream.getAudioTracks();
      const hasAudioSources = capturedAudioTracks.length > 0 || !!micStream;
      let mixDest = null;
      if (hasAudioSources) {
        audioContext = new AudioContext();
        mixDest = audioContext.createMediaStreamDestination();

        if (capturedAudioTracks.length) {
          const capturedAudioSource = audioContext.createMediaStreamSource(
            new MediaStream(capturedAudioTracks)
          );
          capturedAudioSource.connect(mixDest); // into the recording
          if (source === 'tab') {
            capturedAudioSource.connect(audioContext.destination);
          }
        }

        if (micStream) {
          const micSource = audioContext.createMediaStreamSource(micStream);
          micSource.connect(mixDest); // into the recording (do NOT loop to speaker — feedback)
        }
      }

      // 4. Build the final stream the recorder consumes.
      const finalStream = new MediaStream();
      if (video) {
        for (const t of captureStream.getVideoTracks()) finalStream.addTrack(t);
      }
      if (mixDest) {
        for (const t of mixDest.stream.getAudioTracks()) finalStream.addTrack(t);
      }
      const finalHasVideo = finalStream.getVideoTracks().length > 0;
      const finalHasAudio = finalStream.getAudioTracks().length > 0;
      if (!finalHasVideo && !finalHasAudio) {
        throw new Error('No media tracks available to record.');
      }
      chosenMime = pickRecorderMimeType({
        hasVideo: finalHasVideo,
        hasAudio: finalHasAudio,
        requestedMime,
      });

      // 5. MediaRecorder. Collect dataavailable chunks. Pass a timeslice so
      // partial data survives a crash and gives us progress estimates.
      const recorderOptions = {
        mimeType: chosenMime,
      };
      if (finalHasAudio) {
        // ~192 kbps audio is plenty for speech; the rest is video budget.
        recorderOptions.audioBitsPerSecond = 192_000;
      }
      if (finalHasVideo) {
        recorderOptions.videoBitsPerSecond = 2_500_000;
      }
      recorder = new MediaRecorder(finalStream, recorderOptions);
    } catch (e) {
      try { for (const t of captureStream.getTracks()) t.stop(); } catch {}
      if (micStream) { try { for (const t of micStream.getTracks()) t.stop(); } catch {} }
      if (audioContext) { try { audioContext.close(); } catch {} }
      throw new Error(`Failed to start recorder: ${e.message || e}`);
    }
    const chunks = [];
    let bytes = 0;
    let dataEventCount = 0;
    recorder.ondataavailable = (e) => {
      dataEventCount += 1;
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        bytes += e.data.size;
      }
    };

    session = {
      tabId,
      source,
      mimeType: chosenMime,
      hasVideo: video,
      hasAudio: captureStream.getAudioTracks().length > 0,
      hasMic: !!micStream,
      micError,
      captureAudioError,
      startedAt: Date.now(),
      recorder,
      captureStream,
      micStream,
      audioContext,
      chunks,
      stopping: false,
      stopPromise: null,
      stopEventObserved: false,
      get bytes() { return bytes; },
      get dataEventCount() { return dataEventCount; },
    };
    const activeSession = session;
    recorder.addEventListener('stop', () => {
      activeSession.stopEventObserved = true;
    });

    // Cleanup if the underlying capture stream goes away (tab/window closed,
    // user revoked capture, Chrome's Stop sharing control, etc.). We can't
    // notify the service worker synchronously, but it can poll recorder-state.
    for (const t of captureStream.getTracks()) {
      t.addEventListener('ended', () => {
        const s = session;
        if (!s || s.captureEndedCleanupStarted) return;
        s.captureEndedCleanupStarted = true;
        log(`${source} track ended unexpectedly:`, t.kind);
        finalizeCaptureEnded(s).catch((e) => {
          log('capture-ended finalize failed:', e?.message || e);
        });
      });
    }

    recorder.start(2000); // 2s timeslices → ondataavailable every 2s
    log('recorder started', { source, mimeType: chosenMime, video, mic: !!micStream });
    return {
      ok: true,
      mimeType: chosenMime,
      hasVideo: video,
      hasAudio: captureStream.getAudioTracks().length > 0,
      hasMic: !!micStream,
      micError,
      captureAudioError,
    };
  }

  function stateSnapshot() {
    if (!session) return { recording: false };
    return {
      recording: session.recorder.state === 'recording',
      paused: session.recorder.state === 'paused',
      stopping: !!session.stopping,
      source: session.source,
      tabId: session.tabId,
      startedAt: session.startedAt,
      mimeType: session.mimeType,
      hasVideo: session.hasVideo,
      hasAudio: session.hasAudio,
      hasMic: session.hasMic,
      micError: session.micError,
      captureAudioError: session.captureAudioError,
      bytes: session.bytes,
    };
  }

  async function stop() {
    if (!session) throw new Error('No active recording.');
    const s = session;
    s.stopping = true;

    try {
      // Finalize the recorder, wait for the last dataavailable + the stop event.
      await waitForRecorderStop(s);

      // Release the streams + AudioContext.
      await releaseSession(s);

      // IMPORTANT: strip the codecs= parameter from the blob's type before
      // serializing to a data URL. MediaRecorder gives us something like
      // "video/webm;codecs=vp9,opus" — that comma inside the parameter
      // value makes the resulting `data:video/webm;codecs=vp9,opus;base64,XXX`
      // URL ambiguous, and chrome.downloads.download's URL parser
      // mis-segments it. The base64 payload ends up partially treated as
      // mediatype params, so what hits disk is corrupted bytes and the
      // .webm fails to play ("Invalid data found").
      //
      // The bare type ("video/webm") is enough — the codec is also encoded
      // inside the WebM track header, so players auto-detect it without
      // the param hint. We still return the FULL mimeType in the metadata
      // for callers that want it (e.g. transcription).
      const bareType = (s.mimeType || 'video/webm').split(';')[0];
      const blob = new Blob(s.chunks, { type: bareType });
      const dataUrl = await blobToDataUrl(blob);

      return {
        ok: true,
        mimeType: s.mimeType,        // original, with codecs param
        blobType: bareType,          // what the data URL actually carries
        sizeBytes: blob.size,
        durationMs: Date.now() - s.startedAt,
        dataUrl,
      };
    } finally {
      if (session === s) session = null;
    }
  }

  function waitForRecorderStop(s) {
    if (!s?.recorder) return Promise.resolve();
    if (s.stopPromise) return s.stopPromise;
    s.stopPromise = new Promise((resolve) => {
      let done = false;
      let timeout = null;
      let stopped = s.recorder.state === 'inactive';
      let finalDataSettled = false;
      const initialBytes = Number(s.bytes || 0);
      const finish = () => {
        if (done) return;
        done = true;
        s.stopEventObserved = true;
        if (timeout) clearTimeout(timeout);
        try { s.recorder.removeEventListener('stop', onStop); } catch {}
        try { s.recorder.removeEventListener('dataavailable', onFinalDataAvailable); } catch {}
        resolve();
      };
      const maybeFinish = () => {
        if (stopped && finalDataSettled) finish();
      };
      const onStop = () => {
        stopped = true;
        maybeFinish();
      };
      const onFinalDataAvailable = (e) => {
        if (e?.data && e.data.size > 0) {
          finalDataSettled = true;
        } else if (initialBytes > 0 || Number(s.bytes || 0) > 0) {
          // A final dataavailable event can be empty when prior timeslices
          // already flushed usable bytes. Treat that as settled, but never
          // accept a zero-byte recording until the timeout fallback fires.
          finalDataSettled = true;
        }
        maybeFinish();
      };
      try { s.recorder.addEventListener('stop', onStop); } catch {}
      try { s.recorder.addEventListener('dataavailable', onFinalDataAvailable); } catch {}
      try { s.recorder.requestData(); } catch {}
      timeout = setTimeout(() => {
        log('timed out waiting for MediaRecorder final data; finalizing with collected chunks', {
          bytes: s.bytes,
          dataEvents: s.dataEventCount,
          stopped,
        });
        stopped = true;
        finalDataSettled = true;
        finish();
      }, 2000);
      try {
        if (s.recorder.state === 'inactive') stopped = true;
        else s.recorder.stop();
      } catch {
        stopped = true;
      }
      maybeFinish();
    });
    return s.stopPromise;
  }

  async function releaseSession(s) {
    const captureStream = s.captureStream;
    const micStream = s.micStream;
    const audioContext = s.audioContext;
    s.captureStream = null;
    s.micStream = null;
    s.audioContext = null;
    try { for (const t of captureStream?.getTracks?.() || []) t.stop(); } catch {}
    try { for (const t of micStream?.getTracks?.() || []) t.stop(); } catch {}
    try {
      if (audioContext && audioContext.state !== 'closed') await audioContext.close();
    } catch {}
  }

  function notifyCaptureEnded(s) {
    try {
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'recording_capture_ended',
        source: s.source,
        tabId: s.tabId,
      }).catch((e) => {
        log('capture-ended finalize notify failed:', e?.message || e);
      });
    } catch (e) {
      log('capture-ended finalize notify failed:', e?.message || e);
    }
  }

  async function finalizeCaptureEnded(s) {
    s.stopping = true;
    await waitForRecorderStop(s);
    notifyCaptureEnded(s);
    await releaseSession(s);
  }

  // ─── runtime.onMessage router ─────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('recorder-')) {
      return false; // not ours — let other listeners (offscreen.js) handle
    }
    (async () => {
      try {
        if (msg.type === 'recorder-start') {
          const r = await start(msg);
          sendResponse(r);
        } else if (msg.type === 'recorder-stop') {
          const r = await stop();
          sendResponse(r);
        } else if (msg.type === 'recorder-state') {
          sendResponse(stateSnapshot());
        } else {
          sendResponse({ ok: false, error: `unknown recorder message: ${msg.type}` });
        }
      } catch (e) {
        log('error handling', msg.type, e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // async response
  });

  log('recorder.js loaded');
})();
