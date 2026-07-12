/**
 * Shared offscreen-document lifecycle helper.
 *
 * Chrome MV3 allows only ONE offscreen document per extension at a time,
 * and the set of `reasons` declared at createDocument time is fixed — you
 * cannot add reasons later. So both consumers of the offscreen document
 * (the localhost-fetch proxy in offscreen.js, the tab-recorder in
 * recorder.js, and the cloud bridge in cloud-bridge.js) must agree on a single
 * createDocument call that lists
 * every reason either of them might ever need.
 *
 * Callers:
 *   • providers/fetch-with-fallback.js — needs the doc when a direct fetch
 *     to a localhost LLM server fails (Private Network Access workaround).
 *   • background.js (record routes) — needs the doc to host the
 *     MediaRecorder and Web Audio mixer when recording starts.
 *   • background.js (cloud bridge routes) — needs the doc to keep an outbound
 *     WebSocket open to the local sidecar.
 *
 * Both call `ensureOffscreen()` lazily; whichever fires first creates the
 * doc with the unified reason set, and the second one no-ops via the
 * `hasDocument()` check.
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const OFFSCREEN_REASONS = [
  // Localhost fetch proxy — no perfectly matching reason, LOCAL_STORAGE is
  // what we've used historically.
  'LOCAL_STORAGE',
  // Tab recorder needs DISPLAY_MEDIA (chrome.tabCapture stream pulls in as
  // display media) and USER_MEDIA (mic via getUserMedia).
  'DISPLAY_MEDIA',
  'USER_MEDIA',
];
const OFFSCREEN_JUSTIFICATION =
  'Proxy fetch to localhost LLM servers; capture active tab + mic for the optional Record feature; maintain a localhost cloud bridge WebSocket.';

let ready = false;
let inflight = null;

async function offscreenDocumentExists() {
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return null;
  }
}

export async function ensureOffscreen() {
  if (inflight) return inflight;
  inflight = (async () => {
    const exists = await offscreenDocumentExists();
    if (exists === true) {
      ready = true;
      return;
    }
    if (exists === null && ready) return;
    ready = false;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: OFFSCREEN_REASONS,
        justification: OFFSCREEN_JUSTIFICATION,
      });
      ready = true;
    } catch (e) {
      // Race: another caller created it between hasDocument() and us.
      if (String(e?.message || e).includes('already exists')) {
        ready = true;
        return;
      }
      throw e;
    }
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}
