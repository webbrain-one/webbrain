/** Default wait for small WebBrain-initiated saves (screenshots, crops, run captures). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
/**
 * Longer budget for large tab recordings / transcript text writes. A 2-hour
 * capture can produce a multi-GB .webm that stays in_progress well past 30s.
 */
export const RECORDING_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DOWNLOAD_POLL_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadFailure(downloadId, message) {
  return new Error(`Download #${downloadId} ${message}`);
}

/**
 * Wait until the browser has committed a download to disk, then return the
 * browser-reported DownloadItem. DownloadItem.filename is the resolved,
 * absolute local path; the filename passed to downloads.download() is only a
 * request and may change because of configured folders or conflict handling.
 *
 * Contract vs network-tools `resolveDownloadInfo`: that helper is soft — it
 * returns best-known info (possibly still in_progress) after a short timeout
 * and never throws. This helper is hard — it throws on interrupt/timeout and
 * requires a non-empty resolved `filename` on complete. Keep both: soft waits
 * fit batch `download_files` digests; hard waits fit UI/agent "saved to …"
 * paths that must not lie.
 */
export async function waitForCompletedDownload(api, downloadId, {
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  pollMs = DEFAULT_DOWNLOAD_POLL_MS,
  now = () => Date.now(),
  wait = sleep,
} = {}) {
  if (downloadId == null) throw new Error('A download id is required.');
  if (!api?.downloads?.search) throw new Error('The downloads search API is unavailable.');

  const deadline = now() + Math.max(0, timeoutMs);
  let lastItem = null;

  while (true) {
    const items = await api.downloads.search({ id: downloadId });
    lastItem = items?.[0] || null;

    if (lastItem?.state === 'complete') {
      if (!lastItem.filename) {
        throw downloadFailure(downloadId, 'completed without a resolved local path.');
      }
      return lastItem;
    }
    if (lastItem?.state === 'interrupted') {
      const reason = lastItem.error ? `: ${lastItem.error}` : '.';
      throw downloadFailure(downloadId, `was interrupted${reason}`);
    }
    if (now() >= deadline) {
      const state = lastItem?.state ? ` (last state: ${lastItem.state})` : '';
      throw downloadFailure(downloadId, `did not complete within ${timeoutMs}ms${state}.`);
    }

    await wait(Math.max(0, pollMs));
  }
}

export async function resolveSavedDownload(api, downloadId, options) {
  const item = await waitForCompletedDownload(api, downloadId, options);
  return {
    downloadId,
    filename: item.filename,
    state: item.state,
  };
}
