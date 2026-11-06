'use strict';

// Site permissions. Extensions bundled with Murshid get what they ask for;
// web pages get asked about anything that reaches the camera, microphone,
// location, notifications and the like. Answers last until Murshid quits.

const { dialog, desktopCapturer, webContents } = require('electron');

const ALWAYS = new Set(['fullscreen', 'clipboard-sanitized-write', 'window-management', 'pointerLock', 'keyboardLock', 'speaker-selection']);
const DESCRIBE = {
  media: 'use your camera or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices',
  'clipboard-read': 'see text and images copied to the clipboard',
  'display-capture': 'share your screen',
  openExternal: 'open an app on this computer',
  'idle-detection': 'know when you are using this device',
  hid: 'connect to HID devices',
  serial: 'connect to serial ports',
  usb: 'connect to USB devices',
  'storage-access': 'use cookies and site data in this context',
  'top-level-storage-access': 'use cookies and site data in this context',
};

function originOf(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(url.hostname)) return `chrome-extension://${url.hostname}`;
    if (url.protocol === 'murshid:' && url.hostname) return `murshid://${url.hostname}`;
    return url.origin === 'null' ? '' : url.origin;
  } catch { return ''; }
}

function installPermissions(ctx) {
  const answers = new Map();
  const trusted = (origin) => origin.startsWith('murshid://') || (ctx.webBrainId && origin === `chrome-extension://${ctx.webBrainId}`);
  const mediaTypes = (types) => Array.isArray(types) && types.length && types.every((t) => t === 'audio' || t === 'video') ? [...new Set(types)] : [];
  const keysFor = (origin, permission, types) => permission === 'media'
    ? mediaTypes(types).map((type) => `${origin} media:${type}`)
    : [`${origin} ${permission}`];

  ctx.ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details = {}) => {
    const origin = originOf(requestingOrigin);
    if (trusted(origin) || ALWAYS.has(permission)) return true;
    if (!origin) return false;
    const keys = keysFor(origin, permission, [details.mediaType]);
    return keys.length > 0 && keys.every((key) => answers.get(key) === true);
  });

  ctx.ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
    const url = details.requestingUrl || (details.isMainFrame !== false ? wc?.getURL() : '');
    const origin = originOf(url);
    if (trusted(origin) || ALWAYS.has(permission)) { callback(true); return; }
    const keys = keysFor(origin, permission, details.mediaTypes);
    if (permission === 'media' && !keys.length) { callback(false); return; }
    if (origin && keys.some((key) => answers.get(key) === false)) { callback(false); return; }
    const missing = origin ? keys.filter((key) => !answers.has(key)) : keys;
    if (!missing.length) { callback(true); return; }
    const types = permission === 'media' ? mediaTypes(details.mediaTypes).filter((type) => missing.includes(`${origin} media:${type}`)) : [];
    const what = types.length
      ? `use your ${types.map((t) => (t === 'video' ? 'camera' : 'microphone')).join(' and ')}`
      : DESCRIBE[permission] || `use “${permission}”`;
    const host = origin ? origin.replace(/^https?:\/\//, '') : (url?.startsWith('file:') ? 'A local file' : 'This page');
    const parent = ctx.windowForContents(wc)?.win || ctx.lastFocusedWindow()?.win;
    dialog.showMessageBox(parent, {
      type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1,
      title: 'Murshid', message: `${host} wants to ${what}`,
      detail: origin ? 'Your choice is remembered until you quit Murshid.' : 'This choice applies only to this request.',
      noLink: true,
    }).then(({ response }) => {
      const allowed = response === 0;
      if (origin) missing.forEach((key) => answers.set(key, allowed));
      callback(allowed);
    }).catch(() => callback(false));
  });

  ctx.ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const frame = request.frame;
    if (!frame || !request.videoRequested) { callback(null); return; }
    const originalUrl = frame.url;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.length || frame.isDestroyed() || frame.url !== originalUrl) { callback(null); return; }
      const wc = webContents.fromFrame(frame);
      const parent = ctx.windowForContents(wc)?.win || ctx.lastFocusedWindow()?.win;
      const requester = originOf(request.securityOrigin) || 'This page';
      const { response } = await dialog.showMessageBox(parent, {
        type: 'question', title: 'Share your screen',
        message: `${requester} wants to share a screen or window`,
        detail: 'Choose what to share. Audio is not shared.',
        buttons: ['Cancel', ...sources.map((source, i) => `${i + 1}. ${source.name}`)],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (frame.isDestroyed() || frame.url !== originalUrl || response < 1 || response > sources.length) { callback(null); return; }
      callback({ video: sources[response - 1] });
    } catch { callback(null); }
  }, { useSystemPicker: true });
}

module.exports = { installPermissions };
