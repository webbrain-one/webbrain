# pdfjs-dist (vendored)

Mozilla PDF.js, used by `src/agent/pdf-tools.js` to extract text from
PDFs the user is viewing in their browser. The Chrome PDF viewer is a
`chrome-extension://` page that our content scripts can't inject into,
so instead of trying to scrape the viewer's DOM we fetch the PDF
binary and parse it with pdfjs in the shared offscreen document.

## Source

- Package: `pdfjs-dist` v5.7.284
- Files: `legacy/build/pdf.mjs` + `legacy/build/pdf.worker.mjs`
- Origin: <https://github.com/mozilla/pdf.js>
- Upstream license: Apache-2.0 (see `LICENSE` in this folder)

## Store-review patch

The upstream legacy files split the strings `<script>`, `</script>`, and
`javascript:` across constants in an old `core-js` null-prototype fallback.
Chrome Web Store classifies that string splitting as obfuscation. Our vendored
copies spell those strings directly; the resulting values and fallback logic
are unchanged.

## Why the legacy build

The legacy build targets older JS runtimes than the default modern
build. MV3 service workers support modern JS but the legacy bundle's
extra polyfills cost ~50 KB and remove a class of "this API isn't in
service workers" surprises (e.g. URL.createObjectURL behaves
differently in the worker context). Worth the size for the resilience.

## How it's loaded

`src/offscreen/pdf-extraction-host.js` does a lazy dynamic import on the first
PDF read. PDF.js must run in an extension page because the Chrome MV3 service
worker rejects dynamic `import()`:

```js
const pdfjs = await import(chrome.runtime.getURL('vendor/pdfjs/pdf.mjs'));
```

The worker URL is resolved the same way:

```js
pdfjs.GlobalWorkerOptions.workerSrc =
  chrome.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
```

The Agent's `read_pdf` facade ensures the shared offscreen document, waits for
an explicit ready response, and then sends the PDF URL plus bounded page
options. The host accepts requests only from the extension's background
service worker and only fetches `http:`, `https:`, or `file:` URLs. For Claude
passthrough, it encodes the same fetched bytes before PDF.js transfers the
buffer to its worker, so text extraction and the document attachment cannot
diverge. Both PDF.js files are listed in `manifest.json`'s
`web_accessible_resources`, so `chrome.runtime.getURL` returns a fetchable URL
without loading the multi-megabyte modules during ordinary service-worker
startup.

## Updating

1. `npm pack pdfjs-dist@latest` (in any scratch directory).
2. `tar xzf pdfjs-dist-*.tgz package/legacy/build/pdf.mjs
    package/legacy/build/pdf.worker.mjs package/LICENSE`
3. Move them over `pdf.mjs`, `pdf.worker.mjs`, `LICENSE` here.
4. Reapply the store-review patch described above to both JavaScript files.
5. Update the version line at the top of this README.
6. Smoke-test by opening a real PDF tab in the loaded extension and
   running a `read_pdf` from the side panel.

Don't try to bundle pdfjs through any build step — the project
ships extension source as-is and pdfjs is already a published
distributable, so re-bundling would duplicate work and risk drift.
