/**
 * The background this new tab is showing, handed to the full-page chat Ask turns the tab into
 * (openAskChat in features/agent/handoff.js), so the chat opens on the same picture instead of
 * a new random one or a flat page.
 *
 * It is written to this tab's sessionStorage just before the tab navigates. Both pages belong to
 * the extension's origin and sessionStorage is per tab, so the chat finds it on its first paint,
 * keeps it across reloads, and no other tab sees it. The chat reads and checks it in
 * src/*\/src/ui/tab-chat-backdrop.js (CHAT_BACKDROP_KEY must match there; test/newtab.mjs checks).
 *
 * Only a description goes across, never the media itself: a bundled or remote picture by its
 * address, an uploaded one by its id in the custom-background database (it can be several MB),
 * a colour or gradient by its CSS value, plus the blur/brightness/filter settings. Videos are not
 * carried over; the chat then uses its plain surround.
 */
export const CHAT_BACKDROP_KEY = 'wbTabChatBackdrop';
export const CHAT_BACKDROP_VERSION = 1;

// Mirrors the choices in options/optionTypes/backgroundImageEffects.js.
const FILTERS = new Set(['grayscale', 'sepia', 'invert', 'saturate', 'contrast']);
const MAX_CSS_VALUE = 300;

let shown = null;

/** Called by Background whenever the background on screen changes. */
export function setShownBackground(data) {
  shown = data ? { ...data, photoInfo: data.photoInfo ? { ...data.photoInfo } : data.photoInfo } : null;
}

const readSetting = (storage, key) => {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
};

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

function effects(storage) {
  const filter = readSetting(storage, 'backgroundFilter');
  return {
    blur: clampNumber(readSetting(storage, 'blur') ?? 0, 0, 100, 0),
    brightness: clampNumber(readSetting(storage, 'brightness') ?? 100, 0, 100, 100),
    ...(FILTERS.has(filter)
      ? { filter, filterAmount: clampNumber(readSetting(storage, 'backgroundFilterAmount') ?? 100, 0, 100, 100) }
      : {}),
  };
}

// Colour backgrounds are stored as a declaration ("background: #123456;" or a gradient).
function backgroundValue(style) {
  const match = /^\s*background\s*:\s*([^;]+?)\s*;?\s*$/i.exec(String(style || ''));
  const value = match?.[1] ?? '';
  if (!value || value.length > MAX_CSS_VALUE || /url\s*\(/i.test(value)) return null;
  return value;
}

/**
 * The description of `data` the chat can paint, or null when there is nothing to carry over
 * (backgrounds turned off, a video, nothing shown yet).
 */
export function chatBackdropSnapshot(
  data = shown,
  { storage = globalThis.localStorage, base = globalThis.location?.href } = {},
) {
  if (!data || readSetting(storage, 'background') === 'false' || data.video) return null;

  const url = String(data.url || '');
  if (url) {
    const colour = typeof data.photoInfo?.colour === 'string' && data.photoInfo.colour.length <= 64
      ? { colour: data.photoInfo.colour }
      : {};
    const customId = Number(data.photoInfo?.customId);
    if (/^(data|blob):/i.test(url)) {
      // An uploaded picture: too large to copy, and a blob address dies with this page.
      if (!Number.isInteger(customId) || customId < 0) return null;
      return { v: CHAT_BACKDROP_VERSION, customId, ...colour, ...effects(storage) };
    }
    let href;
    try {
      href = new URL(url, base).href;
    } catch {
      return null;
    }
    return { v: CHAT_BACKDROP_VERSION, image: href, ...colour, ...effects(storage) };
  }

  const background = backgroundValue(data.style);
  return background ? { v: CHAT_BACKDROP_VERSION, background } : null;
}

/** Writes (or clears) this tab's snapshot. Never throws: the chat simply opens without it. */
export function saveChatBackdrop(session = globalThis.sessionStorage, snapshot = chatBackdropSnapshot()) {
  try {
    if (snapshot) session.setItem(CHAT_BACKDROP_KEY, JSON.stringify(snapshot));
    else session.removeItem(CHAT_BACKDROP_KEY);
    return Boolean(snapshot);
  } catch {
    return false;
  }
}
