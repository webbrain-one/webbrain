/**
 * WebBrain Companion configuration and model selection rules.
 *
 * Companion connects WebBrain to a local subscription proxy running on
 * loopback port 8327.
 */

export const WEBBRAIN_COMPANION_DEFAULT_BASE_URL = 'http://127.0.0.1:8327/v1';
export const COMPANION_BONSAI_MODEL = 'bonsai-2.5-27b';
export const COMPANION_LEGACY_BONSAI_MODEL = 'bonsai-2-27b';

// The tray app's current release. Settings and the install page both link to
// these files, so a new release only changes them here.
export const WEBBRAIN_COMPANION_VERSION = '0.2.1';
export const WEBBRAIN_COMPANION_SITE_URL = 'https://webbrain.one/companion/#download';
export const WEBBRAIN_COMPANION_DOWNLOAD_BASE = `https://github.com/webbrain-one/webbrain/releases/download/systray-v${WEBBRAIN_COMPANION_VERSION}/WebBrain-Companion-${WEBBRAIN_COMPANION_VERSION}-`;
export const WEBBRAIN_COMPANION_DOWNLOADS = Object.freeze({
  macos: { os: 'macOS', file: 'macos-universal.zip' },
  windows: { os: 'Windows', file: 'windows-setup.exe' },
  'linux-x64': { os: 'Linux', file: 'linux-x64.tar.gz' },
  'linux-arm64': { os: 'Linux', file: 'linux-arm64.tar.gz' },
});

/**
 * Which Companion build fits this computer: a key of WEBBRAIN_COMPANION_DOWNLOADS,
 * or '' when there is none (ChromeOS, Android, an unknown system), which sends
 * people to the download page instead.
 */
export function detectCompanionPlatform(navigatorLike = globalThis.navigator) {
  const hinted = String(navigatorLike?.userAgentData?.platform || '').toLowerCase();
  const ua = String(navigatorLike?.userAgent || '');
  const platform = String(navigatorLike?.platform || '');
  if (/android|cros|chrome os/i.test(`${hinted} ${ua}`)) return '';
  if (hinted === 'macos' || /Mac OS X|Macintosh/i.test(ua) || /^Mac/i.test(platform)) return 'macos';
  if (hinted === 'windows' || /Windows/i.test(ua) || /^Win/i.test(platform)) return 'windows';
  if (hinted === 'linux' || /Linux|X11/i.test(ua) || /Linux/i.test(platform)) {
    return /aarch64|arm64|armv8/i.test(`${ua} ${platform}`) ? 'linux-arm64' : 'linux-x64';
  }
  return '';
}

/** The download for one platform key, or null for none. */
export function companionDownloadFor(platformKey) {
  const entry = WEBBRAIN_COMPANION_DOWNLOADS[platformKey];
  return entry ? { os: entry.os, url: `${WEBBRAIN_COMPANION_DOWNLOAD_BASE}${entry.file}` } : null;
}

// Preferred models in priority order:
// 1. haiku-5.5 (Claude Haiku 5.5)
// 2. luna-6.1 (GPT-6.1 Luna)
// 3. gemini-3.8-flash (Gemini 3.8 Flash)
export const COMPANION_PREFERRED_MODEL_PATTERNS = [
  /(?:haiku.*5[.\-_]?5|5[.\-_]?5.*haiku)/i,
  /(?:luna.*6[.\-_]?1|6[.\-_]?1.*luna)/i,
  /gemini[-_.]?3[.\-_]?8[-_.]?flash/i,
];

/**
 * Keep an existing choice, upgrading its Bonsai ID when the new model is ready.
 * For a new selection, use the preferred models or the first available model.
 */
export function selectPreferredCompanionModel(models = [], currentModel = '') {
  if (!Array.isArray(models) || models.length === 0) return '';
  if (currentModel === COMPANION_LEGACY_BONSAI_MODEL && models.includes(COMPANION_BONSAI_MODEL)) {
    return COMPANION_BONSAI_MODEL;
  }
  // A chosen local model may be starting or updating. Keep that choice while
  // Companion only advertises subscription models.
  if (currentModel === COMPANION_BONSAI_MODEL || currentModel === COMPANION_LEGACY_BONSAI_MODEL
      || models.includes(currentModel)) {
    return currentModel;
  }
  for (const pattern of COMPANION_PREFERRED_MODEL_PATTERNS) {
    const matched = models.find((m) => typeof m === 'string' && pattern.test(m));
    if (matched) return matched;
  }
  if (models[0] === COMPANION_LEGACY_BONSAI_MODEL && models.includes(COMPANION_BONSAI_MODEL)) {
    return COMPANION_BONSAI_MODEL;
  }
  return typeof models[0] === 'string' ? models[0] : '';
}
