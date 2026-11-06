'use strict';

// Site permissions. Extensions bundled with Murshid get what they ask for;
// web pages get asked about anything that reaches the camera, microphone,
// location, notifications and the like. Answers last until Murshid quits.

const { dialog } = require('electron');

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

function originOf(url) {
  try { return new URL(url).origin; } catch { return url || ''; }
}

function installPermissions(ctx) {
  const answers = new Map(); // `${origin} ${permission}` -> boolean

  const isExtension = (origin) => origin.startsWith('chrome-extension://') || origin.startsWith('murshid://');

  ctx.ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const origin = originOf(requestingOrigin);
    if (isExtension(origin) || ALWAYS.has(permission)) return true;
    return answers.get(`${origin} ${permission}`) === true;
  });

  ctx.ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = originOf(details.requestingUrl || wc?.getURL());
    if (isExtension(origin) || ALWAYS.has(permission)) {
      callback(true);
      return;
    }
    const key = `${origin} ${permission}`;
    if (answers.has(key)) {
      callback(answers.get(key));
      return;
    }
    const what = permission === 'media' && details.mediaTypes?.length
      ? `use your ${details.mediaTypes.map((t) => (t === 'video' ? 'camera' : 'microphone')).join(' and ')}`
      : DESCRIBE[permission] || `use “${permission}”`;
    const host = origin.replace(/^https?:\/\//, '');
    const parent = ctx.windowForContents(wc)?.win || ctx.lastFocusedWindow()?.win;
    dialog.showMessageBox(parent, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      title: 'Murshid',
      message: `${host} wants to ${what}`,
      detail: 'Your choice is remembered until you quit Murshid.',
      noLink: true,
    }).then(({ response }) => {
      const allowed = response === 0;
      answers.set(key, allowed);
      callback(allowed);
    }).catch(() => callback(false));
  });
}

module.exports = { installPermissions };
