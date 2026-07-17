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

export function createDownloadDirectoryListener(api) {
  let directory = '';
  let changedBeforeReady = false;
  const ready = Promise.resolve(api.storage.local.get(DOWNLOAD_DIRECTORY_STORAGE_KEY))
    .then((stored) => {
      if (!changedBeforeReady) {
        directory = normalizeDownloadDirectory(stored?.[DOWNLOAD_DIRECTORY_STORAGE_KEY]);
      }
    })
    .catch(() => {});

  api.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local' || !changes[DOWNLOAD_DIRECTORY_STORAGE_KEY]) return;
    changedBeforeReady = true;
    directory = normalizeDownloadDirectory(changes[DOWNLOAD_DIRECTORY_STORAGE_KEY].newValue);
  });

  return function routeWebBrainDownload(downloadItem, suggest) {
    if (downloadItem?.byExtensionId !== api.runtime.id) {
      suggest();
      return undefined;
    }

    ready.then(() => {
      const filename = filenameInDownloadDirectory(directory, downloadItem.filename);
      suggest(filename ? { filename } : undefined);
    });
    return true;
  };
}

export function installDownloadDirectoryRouting(api) {
  if (!api?.downloads?.onDeterminingFilename?.addListener) return null;
  const listener = createDownloadDirectoryListener(api);
  api.downloads.onDeterminingFilename.addListener(listener);
  return listener;
}
