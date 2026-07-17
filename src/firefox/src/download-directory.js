export const DOWNLOAD_DIRECTORY_STORAGE_KEY = 'downloadDirectory';

/**
 * Browser download paths are always relative to the browser/OS Downloads
 * directory. Keep the stored preference in that portable form so an empty
 * value naturally means "use the system default".
 */
export function normalizeDownloadDirectory(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.startsWith('/') || raw.startsWith('~') || /^[a-zA-Z]:\//.test(raw)) return '';

  const parts = raw.split('/').map((part) => part.trim());
  if (parts.some((part) => !part || part === '.' || part === '..')) return '';
  if (parts.some((part) => /[\u0000-\u001f\u007f<>:"|?*]/.test(part))) return '';
  return parts.join('/');
}

export function filenameInDownloadDirectory(directory, filename) {
  const normalizedDirectory = normalizeDownloadDirectory(directory);
  if (!normalizedDirectory) return '';

  const basename = String(filename ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!basename || basename === '.' || basename === '..') return '';
  return `${normalizedDirectory}/${basename}`;
}

function filenameFromDownloadUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

/**
 * Firefox does not expose downloads.onDeterminingFilename. Its download call
 * sites therefore resolve the configured relative path before starting each
 * download. Missing storage keeps tests and older runtimes on the original
 * filename, while a configured directory also supplies a URL-derived fallback
 * for downloads that did not request a name.
 */
export async function filenameInConfiguredDownloadDirectory(api, filename, url = '') {
  const original = filename || undefined;
  if (!api?.storage?.local?.get) return original;
  try {
    const stored = await api.storage.local.get(DOWNLOAD_DIRECTORY_STORAGE_KEY);
    const directory = normalizeDownloadDirectory(stored?.[DOWNLOAD_DIRECTORY_STORAGE_KEY]);
    if (!directory) return original;
    const candidate = original || filenameFromDownloadUrl(url) || 'download';
    return filenameInDownloadDirectory(directory, candidate) || `${directory}/download`;
  } catch {
    return original;
  }
}
