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
  icons/           app icon, .ico, PNGs, macOS template images
scripts/
  art/halftone.py  print the homepage pictures as gold halftone
  art/halftone.mjs run halftone.py with a Python that has OpenCV
  art/sources/     those pictures, with where they came from
  art/icon.mjs     draw the icon SVGs (the fez)
  build-icons.mjs  rasterize the icon (PNG, ICO, template images, favicons)
  copy-art.mjs     copy the icon into web/
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

The homepage's pictures are gold halftone prints of public-domain paintings
and photographs: Osman Hamdi Bey's *Islamic Theologian* (1902) in the hero, a
Mevlevi dervish of the Vanmour series (Rijksmuseum) beside "The way", and
details of Osman Hamdi Bey's *Public Scribe* and *The Tortoise Trainer* and of
19th-century photographs of Mevlevi dervishes (Rijksmuseum) on the feature
cards. `scripts/art/sources/` holds the parts of them that are used, with
their sources and licence notes.

`scripts/art/halftone.py` raises the local contrast, pushes the backgrounds
away, and prints each picture as a 45° dot screen whose dots grow with the
light: gold in the mid tones, parchment in the lights. The ink is written as
alpha, so the page's crimson and night grounds show between the dots. To
reprint (needs Python 3 with OpenCV, NumPy and Pillow):

```sh
pip install opencv-python-headless numpy pillow
npm run art:pictures   # writes web/art/halftone/*.webp
```

The app icon is a crimson fez with its black silk tassel on a parchment tile,
drawn by `scripts/art/icon.mjs` so it reads from 1024 px down to 16 px. `npm
run art:icons` rebuilds the icon files, and `npm run art` runs both steps.

The screenshot in `web/art/screenshot/` is a real capture of Murshid on
Windows, at 2x, on a fresh profile with no accounts.

## The homepage

`web/` is a static site (HTML, CSS, a little JS, self-hosted fonts). Preview it
with `npm run web` and open http://localhost:4917/web/. Fonts: Cormorant
Garamond, IBM Plex Sans and Mono, and Aref Ruqaa for the Arabic script, all
under the SIL Open Font License (`web/fonts/LICENSE.txt`).

## Licence

GPL-3.0-or-later, like WebBrain. electron-chrome-extensions is MIT.
