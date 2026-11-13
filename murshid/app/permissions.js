'use strict';

// Site permissions. Extensions bundled with Murshid get what they ask for;
// web pages get asked about anything that reaches the camera, microphone,
// location, notifications and the like. Answers last until Murshid quits.

const { dialog, desktopCapturer, webContents } = require('electron');
const { t } = require('./i18n');

const ALWAYS = new Set(['fullscreen', 'clipboard-sanitized-write', 'window-management', 'pointerLock', 'keyboardLock', 'speaker-selection']);
// The prompt for each permission, as a key in app/locales (whole sentences, so
// each language can put the site where its grammar wants it).
const DESCRIBE = {
  media: 'permission.media',
  geolocation: 'permission.geolocation',
  notifications: 'permission.notifications',
  midi: 'permission.midi',
  midiSysex: 'permission.midi',
  'clipboard-read': 'permission.clipboardRead',
  'display-capture': 'permission.displayCapture',
  openExternal: 'permission.openExternal',
  'idle-detection': 'permission.idleDetection',
  hid: 'permission.hid',
  serial: 'permission.serial',
  usb: 'permission.usb',
  'storage-access': 'permission.storageAccess',
  'top-level-storage-access': 'permission.storageAccess',
};

// A link to a scheme Chromium can't load itself (mailto:, zoommtg:, ...) comes
// here as 'openExternal', and Electron hands an allowed one to the operating
// system. Allow is kept per site and per scheme, so letting a site open mail
// links does not let it start other apps; Block covers all of the site's app
// links, so it can't keep asking with new schemes. These schemes are never
// handed over, as in Chrome (external_protocol_handler.cc), since Electron has
// no such list of its own.
const DENIED_EXTERNAL_SCHEMES = new Set(['afp', 'data', 'disk', 'disks', 'file', 'hcp', 'ie.http', 'javascript',
  'ms-help', 'nntp', 'res', 'shell', 'vbscript', 'view-source', 'vnd.ms.radio']);
// A long link is shown by its start and its end.
const SHOWN_HEAD = 140;
const SHOWN_TAIL = 60;

/** The link another app would open, parsed (its scheme is lower case), or null. */
function externalLink(value) {
  try {
    const url = new URL(String(value));
    return { scheme: url.protocol.slice(0, -1), href: url.href };
  } catch { return null; }
}

/**
 * The link as the prompt shows it, as one unbroken word. The URL parser has
 * already percent-encoded all but printable ASCII, except the spaces of an
 * opaque path ('search-ms:a    b'). Those are encoded here, or a page could
 * pad its link so the dialog wraps the page's own words onto a line of their
 * own, or push the part that matters out of sight.
 */
function shownLink(href) {
  const text = href.replace(/\s/g, encodeURIComponent);
  return text.length > SHOWN_HEAD + SHOWN_TAIL ? `${text.slice(0, SHOWN_HEAD)}…${text.slice(-SHOWN_TAIL)}` : text;
}

function describeRequest(host, permission, mediaTypes) {
  if (mediaTypes.length) {
    const camera = mediaTypes.includes('video');
    const microphone = mediaTypes.includes('audio');
    const key = camera && microphone ? 'permission.cameraAndMicrophone' : camera ? 'permission.camera' : 'permission.microphone';
    return t(key, { host });
  }
  return DESCRIBE[permission] ? t(DESCRIBE[permission], { host }) : t('permission.other', { host, permission });
}

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
  // No keys means nothing that can be asked about: a media request for no
  // camera or microphone, or an app link that isn't a URL. Those are refused.
  const keysFor = (origin, permission, types, link) => {
    if (permission === 'media') return mediaTypes(types).map((type) => `${origin} media:${type}`);
    if (permission === 'openExternal') return link ? [`${origin} openExternal:${link.scheme}`] : [];
    return [`${origin} ${permission}`];
  };

  const linkOf = (permission, details) => permission === 'openExternal' ? externalLink(details.externalURL) : null;
  // As in Chrome, these schemes are refused whoever asks, Murshid's own pages too.
  const deniedLink = (link) => Boolean(link && DENIED_EXTERNAL_SCHEMES.has(link.scheme));

  ctx.ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details = {}) => {
    const origin = originOf(requestingOrigin);
    const link = linkOf(permission, details);
    if (deniedLink(link)) return false;
    if (trusted(origin) || ALWAYS.has(permission)) return true;
    if (!origin) return false;
    const keys = keysFor(origin, permission, [details.mediaType], link);
    return keys.length > 0 && keys.every((key) => answers.get(key) === true);
  });

  ctx.ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
    const url = details.requestingUrl || (details.isMainFrame !== false ? wc?.getURL() : '');
    const origin = originOf(url);
    const link = linkOf(permission, details);
    if (deniedLink(link)) { callback(false); return; }
    if (trusted(origin) || ALWAYS.has(permission)) { callback(true); return; }
    const keys = keysFor(origin, permission, details.mediaTypes, link);
    if (!keys.length) { callback(false); return; }
    if (origin && keys.some((key) => answers.get(key) === false)) { callback(false); return; }
    const missing = origin ? keys.filter((key) => !answers.has(key)) : keys;
    if (!missing.length) { callback(true); return; }
    const appsBlocked = `${origin} openExternal`;
    if (link && origin && answers.get(appsBlocked) === false) { callback(false); return; }
    const types = permission === 'media' ? mediaTypes(details.mediaTypes).filter((type) => missing.includes(`${origin} media:${type}`)) : [];
    const host = origin ? origin.replace(/^https?:\/\//, '') : t(url?.startsWith('file:') ? 'permission.localFile' : 'permission.thisPage');
    const parent = ctx.windowForContents(wc)?.win || ctx.lastFocusedWindow()?.win;
    const scope = t(origin ? 'permission.remembered' : 'permission.once');
    dialog.showMessageBox(parent, {
      type: 'question', buttons: [t('permission.allow'), t('permission.block')], defaultId: 1, cancelId: 1,
      title: 'Murshid', message: describeRequest(host, permission, types),
      // An app link is shown, so it is clear which app the answer is for.
      detail: link ? `${shownLink(link.href)}\n\n${scope}` : scope,
      noLink: true,
    }).then(({ response }) => {
      const allowed = response === 0;
      if (origin) missing.forEach((key) => answers.set(key, allowed));
      if (origin && link && !allowed) answers.set(appsBlocked, false);
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
      const requester = originOf(request.securityOrigin) || t('permission.thisPage');
      const { response } = await dialog.showMessageBox(parent, {
        type: 'question', title: t('screen.title'),
        message: t('screen.message', { host: requester }),
        detail: t('screen.detail'),
        buttons: [t('screen.cancel'), ...sources.map((source, i) => `${i + 1}. ${source.name}`)],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (frame.isDestroyed() || frame.url !== originalUrl || response < 1 || response > sources.length) { callback(null); return; }
      callback({ video: sources[response - 1] });
    } catch { callback(null); }
  }, { useSystemPicker: true });
}

module.exports = { installPermissions };
