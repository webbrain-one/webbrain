/**
 * Offscreen-document tab recorder.
 *
 * Lives in offscreen.html alongside the localhost fetch proxy. Holds the
 * tabCapture MediaStream, the mic MediaStream, the Web Audio mixer, and
 * the MediaRecorder for the duration of a recording. Driven by
 * runtime.onMessage from background.js:
 *
 *   {type:'recorder-start', streamId, tabId, options:{video, mic, mimeType}}
 *     ↳ acquires tab stream via getUserMedia(chromeMediaSource:'tab'),
 *       optionally acquires mic, wires Web Audio so the user can still
 *       HEAR the tab while it's being recorded (tabCapture mutes the
 *       tab by default), starts MediaRecorder, replies {ok:true}.
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

  async function start({ streamId, tabId, options }) {
    if (session) {
      throw new Error('A recording is already in progress.');
    }
    const { video = true, mic = true, mimeType: requestedMime } = options || {};

    // Pick a MediaRecorder mimeType the browser actually supports. VP9 is
    // best quality-per-byte; VP8 is the wide-compat fallback. Audio-only
    // gets webm/opus.
    const candidates = video
      ? [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
        ]
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

    // 1. Tab stream — chrome.tabCapture exposes the active tab as a
    // MediaStream when we pass the streamId we got from
    // chrome.tabCapture.getMediaStreamId() on the service-worker side.
    //
    // Note: even if `video:false` was requested, we still pull video from
    // tabCapture and discard the track below — tabCapture's audio path
    // requires you to ask for the full stream, you can't request audio
    // alone via this API.
    const tabConstraints = {
      audio: {
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
    let tabStream;
    try {
      tabStream = await navigator.mediaDevices.getUserMedia(tabConstraints);
    } catch (e) {
      throw new Error(`Failed to capture tab: ${e.message || e}`);
    }
    log('tab stream acquired', tabStream.getTracks().map(t => `${t.kind}:${t.label || 'unnamed'}`));

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

    // 3. Web Audio mixer. Combine tab audio + mic into one node, AND
    // re-pipe it to the speaker so the user can still hear the call.
    // Without the passthrough, tabCapture mutes the tab and the user
    // can't follow the conversation — a known footgun.
    const audioContext = new AudioContext();
    const mixDest = audioContext.createMediaStreamDestination();

    const tabAudioSource = audioContext.createMediaStreamSource(
      new MediaStream(tabStream.getAudioTracks())
    );
    tabAudioSource.connect(mixDest);          // into the recording
    tabAudioSource.connect(audioContext.destination); // out to user's speaker

    if (micStream) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(mixDest); // into the recording (do NOT loop to speaker — feedback)
    }

    // 4. Build the final stream the recorder consumes.
    const finalStream = new MediaStream();
    if (video) {
      for (const t of tabStream.getVideoTracks()) finalStream.addTrack(t);
    }
    for (const t of mixDest.stream.getAudioTracks()) finalStream.addTrack(t);

    // 5. MediaRecorder. Collect dataavailable chunks. Pass a timeslice so
    // partial data survives a crash and gives us progress estimates.
    const recorder = new MediaRecorder(finalStream, {
      mimeType: chosenMime,
      // ~256 kbps audio is plenty for speech; the rest is video budget.
      audioBitsPerSecond: 192_000,
      videoBitsPerSecond: 2_500_000,
    });
    const chunks = [];
    let bytes = 0;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        bytes += e.data.size;
      }
    };

    session = {
      tabId,
      mimeType: chosenMime,
      hasVideo: video,
      hasMic: !!micStream,
      micError,
      startedAt: Date.now(),
      recorder,
      tabStream,
      micStream,
      audioContext,
      chunks,
      get bytes() { return bytes; },
    };

    // Cleanup if the underlying tab stream goes away (tab closed, user
    // revoked capture, etc.). We can't notify the service worker
    // synchronously, but it can poll recorder-state.
    for (const t of tabStream.getTracks()) {
      t.addEventListener('ended', () => {
        log('tab track ended unexpectedly:', t.kind);
        if (session && session.recorder.state !== 'inactive') {
          try { session.recorder.stop(); } catch {}
        }
      });
    }

    recorder.start(2000); // 2s timeslices → ondataavailable every 2s
    log('recorder started', { mimeType: chosenMime, video, mic: !!micStream });
    return {
      ok: true,
      mimeType: chosenMime,
      hasVideo: video,
      hasMic: !!micStream,
      micError,
    };
  }

  function stateSnapshot() {
    if (!session) return { recording: false };
    return {
      recording: session.recorder.state === 'recording',
      paused: session.recorder.state === 'paused',
      tabId: session.tabId,
      startedAt: session.startedAt,
      mimeType: session.mimeType,
      hasVideo: session.hasVideo,
      hasMic: session.hasMic,
      micError: session.micError,
      bytes: session.bytes,
    };
  }

  async function stop() {
    if (!session) throw new Error('No active recording.');
    const s = session;

    // Finalize the recorder, wait for the last dataavailable + the stop event.
    await new Promise((resolve) => {
      const onStop = () => {
        s.recorder.removeEventListener('stop', onStop);
        resolve();
      };
      s.recorder.addEventListener('stop', onStop);
      try { s.recorder.requestData(); } catch {}
      try { s.recorder.stop(); } catch {}
    });

    // Release the streams + AudioContext.
    try { for (const t of s.tabStream.getTracks()) t.stop(); } catch {}
    if (s.micStream) {
      try { for (const t of s.micStream.getTracks()) t.stop(); } catch {}
    }
    try { await s.audioContext.close(); } catch {}

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

    session = null;
    return {
      ok: true,
      mimeType: s.mimeType,        // original, with codecs param
      blobType: bareType,          // what the data URL actually carries
      sizeBytes: blob.size,
      durationMs: Date.now() - s.startedAt,
      dataUrl,
    };
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
