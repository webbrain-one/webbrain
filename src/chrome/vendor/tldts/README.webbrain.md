# Vendored tldts

- Package: `tldts`
- Version: `7.4.10` (the same pinned version as the `tldts` devDependency in
  the root `package.json`)
- Upstream: <https://github.com/remusao/tldts>
- File: `dist/index.esm.min.js` from the published npm package, unmodified.
  It is self-contained: the `tldts-core` code and a Public Suffix List
  snapshot (ICANN and private sections) are bundled into it.
- SHA-256: `1f4e2f0bfab5a01e51032948573cf2920366ea0f50addc4e69bd3fffb9aec536`
- License: MIT (see `LICENSE`)

WebBrain uses `getDomain` with private domains enabled in
`src/network/network-tools.js` (`registrableDomain`). That function decides
whether a background fetch (`fetch_url`, `read_page_source`, `read_pdf`, and
the Firefox download re-fetch) may carry the user's cookies: only when the
target and the active tab share a registrable domain. With the private
section, tenants of shared hosts such as `appspot.com`, `blogspot.com` or
`s3.amazonaws.com` are separate sites, as they are for the browser's own
cookie rules. The dependency is bundled with the extension; no executable
code or list data is fetched at runtime.

To update: bump the `tldts` devDependency, run `npm install`, copy
`node_modules/tldts/dist/index.esm.min.js` and `node_modules/tldts/LICENSE`
into `src/chrome/vendor/tldts/` and `src/firefox/vendor/tldts/`, update the
version and SHA-256 here and in `test/run.js`, then run
`WEBBRAIN_TEST_FILTER="registrable|tldts" node test/run.js`.
