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

  let basename = String(filename ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .trim();
  basename = basename.replace(/^\.+|\.+$/g, '').trim();
  if (!basename) return '';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) {
    basename = `_${basename}`;
  }
  return `${normalizedDirectory}/${basename}`;
}

export async function configuredDownloadDirectory(api) {
  if (!api?.storage?.local?.get) return '';
  try {
    const stored = await api.storage.local.get(DOWNLOAD_DIRECTORY_STORAGE_KEY);
    return normalizeDownloadDirectory(stored?.[DOWNLOAD_DIRECTORY_STORAGE_KEY]);
  } catch {
    return '';
  }
}

/**
 * Firefox does not expose downloads.onDeterminingFilename. Its download call
 * sites therefore resolve the configured relative path before starting each
 * download. Missing storage keeps tests and older runtimes on the original
 * filename. Callers must supply a real filename rather than guessing from the
 * URL, because doing so would override a server-selected Content-Disposition
 * filename.
 */
export async function filenameInConfiguredDownloadDirectory(api, filename) {
  const original = filename || undefined;
  const directory = await configuredDownloadDirectory(api);
  if (!directory) return original;
  if (!original) return undefined;
  return filenameInDownloadDirectory(directory, original) || original;
}
