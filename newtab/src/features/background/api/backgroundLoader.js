import { getOfflineImage } from './offlineImage';
import { randomColourStyleBuilder } from './randomColour';
import videoCheck from './videoCheck';
import { getAllBackgrounds, getAllBackgroundsWithMetadata } from 'utils/customBackgroundDB';

const parseJSON = (key, fallback = null) => {
  const item = localStorage.getItem(key);
  if (item === null || item === 'null') {
    return fallback;
  }
  try {
    const parsed = JSON.parse(item);
    return parsed !== null ? parsed : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Gets background data based on current configuration
 */
export async function getBackgroundData() {
  const isOffline =
    localStorage.getItem('offlineMode') === 'true' ||
    localStorage.getItem('showWelcome') === 'true';

  // Handle favourited background
  const fav = parseJSON('favourite');
  if (fav) {
    if (fav.type === 'random_colour' || fav.type === 'random_gradient') {
      return { type: 'colour', style: `background:${fav.url}` };
    }
    return { url: fav.url, video: videoCheck(fav.url), photoInfo: { ...fav, url: fav.url } };
  }

  const type = localStorage.getItem('backgroundType');

  switch (type) {
    case 'api':
      return getAPIBackground();

    case 'colour':
      return getColourBackground();

    case 'random_colour':
    case 'random_gradient':
      return randomColourStyleBuilder(type);

    case 'custom':
      return await getCustomBackground(isOffline);

    default:
      return null;
  }
}

/**
 * Gets solid colour background
 */
function getColourBackground() {
  return {
    type: 'colour',
    style: `background: ${localStorage.getItem('customBackgroundColour') || 'rgb(0,0,0)'}`,
  };
}

/**
 * The default source. Upstream Mue fetched photos from its own API; the
 * WebBrain new tab only uses the photos bundled with the extension, so nothing
 * is requested over the network. The type stays 'api' so saved settings and the
 * rest of the background code keep working unchanged.
 */
function getAPIBackground() {
  return { ...getOfflineImage('api'), currentAPI: localStorage.getItem('backgroundAPI') || 'mue' };
}

/**
 * Gets custom background
 */
async function getCustomBackground(isOffline) {
  // Get full metadata from IndexedDB
  let backgrounds = await getAllBackgroundsWithMetadata();

  // Fallback to localStorage URLs if IndexedDB is empty
  if (!backgrounds || backgrounds.length === 0) {
    const urls = parseJSON('customBackground', []);
    if (urls && urls.length > 0) {
      // Convert old URL format to metadata format
      backgrounds = urls.map((url) => ({ url, photoInfo: { hidden: true } }));
    }
  }

  if (!backgrounds || backgrounds.length === 0) return null;

  const selected = backgrounds[Math.floor(Math.random() * backgrounds.length)];

  // Check if selected is valid before using it
  if (!selected) return null;

  const url = selected.url || selected;

  if (isOffline && !url.startsWith('data:')) {
    return getOfflineImage('custom');
  }

  const data = {
    url,
    type: 'custom',
    video: videoCheck(url),
    photoInfo: {
      hidden: true,
      blur_hash: selected.blurHash || null,
      // Lets the full-page chat show the same upload without copying it (api/chatBackdrop.js).
      ...(Number.isInteger(selected.id) ? { customId: selected.id } : {}),
    },
  };

  // Don't store full image data in localStorage to avoid quota errors
  // Just store metadata
  try {
    localStorage.setItem(
      'currentBackground',
      JSON.stringify({
        type: 'custom',
        video: data.video,
        photoInfo: data.photoInfo,
      }),
    );
  } catch (e) {
    // Ignore quota errors for currentBackground
    console.warn('Could not save currentBackground to localStorage:', e);
  }

  return data;
}
