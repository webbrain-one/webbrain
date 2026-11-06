# Murshid

*Mürşid* (Ottoman Turkish, from Arabic مرشد): one who shows the way.

Murshid is a Chromium browser, built on Electron, with WebBrain built in:

- **Tabs, like Chrome.** Tab strip with drag to reorder, reopen closed tab, an
  address bar that searches, downloads, find in page, zoom, print, devtools and
  the usual keyboard shortcuts.
- **WebBrain preinstalled.** The extension in `../src/chrome` is loaded into
  every profile. The toolbar's WebBrain button opens its side panel, docked in
  the window and resizable; per-tab panels follow the tab you are on.
- **WebBrain's new tab page preinstalled**, and switched on for new profiles.
- **WebBrain Companion in the system tray.** Murshid starts
  `../webbrain-systray` in the background (`--background`, no panel) when it is
  installed or bundled and not already running. The tray app is the Go
  companion, not part of the Electron process.

The homepage is in `web/`.

## Run it

```sh
cd murshid
npm install
npm start
```

`npm start` loads WebBrain straight from `../src/chrome`, so it always runs the
extension at your checkout's HEAD. `MURSHID_PROFILE=<folder>` uses a separate
profile (handy for testing first-run behaviour); `MURSHID_DEBUG=1` mirrors the
extension worker's console to the terminal. Extension warnings and errors are
always written to `<profile>/logs/extensions.log`.

## How WebBrain runs inside Electron

Electron supports only part of the Chrome extension API.
[electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell)
adds `tabs`, `windows`, `action`, `contextMenus`, `cookies`, `notifications`,
`webNavigation` and friends. Murshid fills in what WebBrain still needs, in
`app/crx/`:

| API | How Murshid provides it |
|---|---|
| `chrome.sidePanel` | Per-tab and per-window panels as a docked `WebContentsView` (`setOptions`, `open`, `close`, `setPanelBehavior`, `getLayout`, `onOpened`/`onClosed`). |
| `chrome.debugger` | Bridged to `webContents.debugger` (CDP 1.3): `attach`, `detach`, `sendCommand`, `getTargets`, `onEvent`, `onDetach`, with Chrome's error texts. |
| `chrome.tabs.captureVisibleTab` | `webContents.capturePage()`, PNG or JPEG. |
| `chrome.offscreen` | A hidden window in the same session. |
| `chrome.downloads` | The session's real downloads (`download`, `search`, `pause`/`resume`/`cancel`, `erase`, `open`, `show`, events). |
| `chrome.tabGroups`, `chrome.tabs.group` | Group ids are kept so callers work; there is no group UI yet. |
| `chrome.identity.launchWebAuthFlow` | A sign-in window that stops at `https://<id>.chromiumapp.org/`. |
| `chrome.search.query` | Murshid's search engine setting. |
| `chrome.runtime.getContexts`, `runtime.lastError` | Answers for side panels and offscreen documents; `lastError` set for Murshid's own callback APIs. |

`preload-pre.js` runs in extension workers and pages before
electron-chrome-extensions' preload (which freezes `chrome`), `preload-post.js`
after it. `bridge.js` is the main-process side. While Murshid runs it keeps
WebBrain's service worker alive, so a run waiting on a model reply is not cut
off by the 30-second idle timeout.

Not there yet: `chrome.tabCapture`, `chrome.identity.getAuthToken`,
`contextMenus.update` (a no-op in electron-chrome-extensions), a tab-group UI,
the PDF viewer's MIME handler, and Chrome Web Store installs.

## Layout

```
app/
  main.js          startup, session, extension loading, IPC for the chrome UI
  window.js        one browser window: tabs, side panel, layout
  tab.js           one tab (a WebContentsView)
  crx/             extension API bridge (see above)
  ui/              the browser chrome: tab strip, toolbar, panel header
  pages/           murshid://newtab, settings, about, error
  commands.js      shortcuts (before-input-event on Windows/Linux, app menu on macOS)
  menu.js          app menu, ⋮ menu, tab menu
  downloads.js     download tracking shared by the toolbar and chrome.downloads
  companion.js     find and start WebBrain Companion
  permissions.js   site permission prompts
assets/
  art/             the portrait and the semazen (traced, see scripts/art)
  icons/           app icon, .ico, PNGs, macOS template images
scripts/
  art/trace.py     trace the portrait and the semazen from public-domain pictures
  art/trace.mjs    run trace.py with a Python that has OpenCV
  art/sources/     those pictures, with where they came from
  art/icon.mjs     draw the icon SVGs
  build-icons.mjs  rasterize the icon (PNG, ICO, template images, favicons)
  copy-art.mjs     copy the artwork into web/
  copy-fonts.mjs   copy the self-hosted fonts into web/fonts
  serve.mjs        static server for web/ and assets/
vendor/companion/  WebBrain Companion builds to bundle (not committed)
web/               the Murshid homepage
```

## Package it

```sh
npm run pack   # unpacked app in dist/ (quick check)
npm run dist   # installers: NSIS (Windows), DMG (macOS), AppImage + deb (Linux)
```

The WebBrain extension is copied into `resources/extensions/webbrain`. To
bundle the Companion, put its build for the target in
`vendor/companion/<platform>-<arch>/` first (see the README there); it lands in
`resources/companion`. Builds are not code-signed yet.

## The artwork

The portrait in the hero arch and the whirling dervish in "The way" are line
drawings traced from real pictures, both in the public domain:

- **The murshid**: Suleiman the Magnificent, from the portrait by Nakkaş Osman
  in the *Şemailname* of 1579 (Topkapı Palace Museum, H.1563 fol. 47v),
  [via Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Istanbul,_Topkapi_Palace_Museum_MS_Hazine_1563_fol._47v_Suleyman_I_by_Nakka%C5%9F_Osman.jpg).
- **The semazen**: *A Mevlevee Dervish*, a hand-coloured lithograph of about
  1830–60 (British Museum 1904,0929.59),
  [via Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Derviche_Tourneur_(BM_1904,0929.59).jpg).

`scripts/art/sources/` holds both pictures and their licence notes.
`scripts/art/trace.py` turns them into SVG strokes: it flattens the paint,
sorts the pixels into a few colour regions (turban, face, caftan…), draws each
region's outline once, adds the artist's own fine lines (turban folds, eyes,
pleats) as centre lines, and writes smooth Bézier paths ordered top to bottom.
The homepage inlines the SVGs and draws the strokes in as they come into view;
without JavaScript, or with reduced motion, they are shown still.

To retrace (needs Python 3 with OpenCV, NumPy, SciPy and scikit-image):

```sh
pip install opencv-python-headless numpy scipy scikit-image
npm run art:trace   # writes assets/art/*.svg and copies them into web/art
```

`python scripts/art/trace.py portrait --debug=<dir>` also writes the colour
regions and line masks it used, which helps when tuning the sample points in
its `CONFIG`.

The app icon is still the geometric profile drawn by `scripts/art/icon.mjs`:
the traced portrait does not survive being shrunk to 16–32 px. `npm run
art:icons` rebuilds the icon files, and `npm run art` runs both steps.

## The homepage

`web/` is a static site (HTML, CSS, a little JS, self-hosted fonts). Preview it
with `npm run web` and open http://localhost:4917/web/. Fonts: Cormorant
Garamond, IBM Plex Sans and Mono, and Aref Ruqaa for the Arabic script, all
under the SIL Open Font License (`web/fonts/LICENSE.txt`).

## Licence

GPL-3.0-or-later, like WebBrain. electron-chrome-extensions is MIT.
