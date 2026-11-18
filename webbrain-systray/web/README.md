# WebBrain Companion site

A one-page site in the same 22 languages as the main website. The globe menu
and both site builders share `../../web/build/languages.json`. Every page is
generated from one template so it keeps the same structure:

```bash
python3 web/build.py        # writes web/index.html and web/<language>/index.html
python3 -m http.server 8765 --directory web
```

Everything is static: `assets/site.css`, `assets/site.js` (picks the visitor's
system for the download button and the tray illustration), the panel's own
typeface (Bricolage Grotesque, SIL OFL 1.1) and the images in `assets/img`.

English and Turkish copy live in `build.py`; the other languages are static
translation dictionaries in `locales/`. Rebuild these pages before running
`npm run build:web:landing` at the repository root to copy them to `/companion/`.
The app screenshots remain English or Turkish, the languages the app supports.
The additional dictionaries use machine translations, with product names and code
samples preserved.

## Images

The site never shows a real desktop.

- **Tray menu** (hero): drawn in HTML from the app's actual menu strings, on a
  plain plum field with one status bar. The *macOS / Windows / Linux* switch
  restyles it the way each system draws the menu.
- **Panel windows**: screenshots of the companion's panel only, taken with sample
  data (`WBC_DEMO=1`, accounts like `ada@example.com`) by `tools/shots.py`: the
  main page, adding a subscription and the Bonsai 2 27B details, in English and
  Turkish, light and dark. Pages pick the dark set with `prefers-color-scheme`.
- **Social card** (`assets/img/og.png`): rendered from the hero by `tools/og.py`.

## Publishing

- `SITE` in `build.py` is the public address used for canonical and social
  links (`https://webbrain.one/companion` by default).
- Download links point directly at the public GitHub release `systray-v0.2.0`
  of `webbrain-one/webbrain`. The CI workflow drafts a release when its tag is
  pushed; publish that draft before linking a new version. Update `VERSION`
  and the file sizes in `build.py` for new releases.
