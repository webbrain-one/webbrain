# Offline Wikipedia full-text licensing decision

Status: **SHIPPED — GPL distribution accepted; Wasm bundled from source (-O2)**  
Scope: the Xapian/libzim WebAssembly runtime only. Packages that include
`src/*/vendor/libzim/` are conveyed under GPL-3.0-or-later. Title lookup remains
the fallback when an archive has no index or the worker fails.

This is an engineering distribution record, not legal advice.

## Proposed, pinned runtime

The candidate is
[`openzim/javascript-libzim` v0.95](https://github.com/openzim/javascript-libzim/releases/tag/v0.95),
commit `470b36920fba421a4c1a83b326e66d8aa0533870`. The upstream release was
published on 2026-08-06 and updates libzim to 9.8.1. Its JavaScript API is still
documented by upstream as unstable before 1.0.

The only candidate binary asset is `libzim_wasm_0.95.zip`:

- exact size: `4,671,056` bytes
- SHA-256: `896e4eab4986670ae9c0858312fa5225436e3498990c45df752e0be46eb4fe3d`
- upstream URL: `https://github.com/openzim/javascript-libzim/releases/download/v0.95/libzim_wasm_0.95.zip`

Do not copy that asset into either extension until the decision below is signed
off and the corresponding-source procedure has been completed.

For a reproducible source build, DIV pins the versions declared by the
v0.95 source Makefile and workflow:

| Component | Pinned version | License and canonical text |
| --- | --- | --- |
| javascript-libzim | 0.95 / commit above | GPL-3.0-or-later; [`LICENSE`](https://github.com/openzim/javascript-libzim/blob/470b36920fba421a4c1a83b326e66d8aa0533870/LICENSE) |
| libzim | 9.8.1 | GPL-2.0-or-later; [`COPYING`](https://github.com/openzim/libzim/blob/9.8.1/COPYING) |
| Xapian Core | 1.4.31 | GPL-2.0-or-later; [`COPYING`](https://github.com/xapian/xapian/blob/v1.4.31/xapian-core/COPYING) |
| XZ / liblzma | 5.2.6 | public-domain core with per-file exceptions; [`COPYING`](https://github.com/tukaani-project/xz/blob/v5.2.6/COPYING) |
| zlib | 1.3.1 | Zlib; [`LICENSE`](https://github.com/madler/zlib/blob/v1.3.1/LICENSE) |
| Zstandard | 1.5.7 | BSD-3-Clause or GPL-2.0; [`LICENSE`](https://github.com/facebook/zstd/blob/v1.5.7/LICENSE) |
| ICU | 73.2 | Unicode-DFS-2016; [`LICENSE`](https://github.com/unicode-org/icu/blob/release-73-2/icu4c/LICENSE) |
| Emscripten build image | 3.1.41 | MIT/NCSA; [`LICENSE`](https://github.com/emscripten-core/emscripten/blob/3.1.41/LICENSE) |

The versions above describe the reproducible **source-build path**, not a claim
that an opaque upstream ZIP is a complete software bill of materials. Before a
release, CI must build from these sources, archive every input and patch, emit an
SBOM, and verify the output hashes. If the release asset is used instead, its
producer must first provide an equivalent exact SBOM and complete corresponding
source for that binary.

## Linking and packaging approach if approved

The runtime would be compiled to Wasm with libzim, Xapian, liblzma, zlib,
Zstandard, and ICU statically linked into the module. The Wasm, worker glue, and
all runtime support files would be copied into both Chrome and Firefox packages.
They would be loaded only from extension URLs under the extension Content
Security Policy. There would be no CDN import, executable-code download, or
runtime version fallback.

`src/{chrome,firefox}/src/agent/zim-xapian.js` is the license-neutral adapter.
The local worker supplied after approval must expose:

```text
openArchive({ source, record }) -> session
session.hasFullTextIndex() -> boolean
session.searchWithSnippets(query, { limit, language }) -> result[]
session.close()
```

Each result contains `path`, `title`, `snippet`, and optionally `score`. Search
is capped at ten results per archive. A ZIM with no full-text index, a missing
runtime, or a runtime error uses the existing title provider. Reader operations
continue through DIV's existing audited ZIM reader.

## Required notices and corresponding source

If GPL distribution is approved, every Chrome and Firefox release must include:

1. the complete GPLv3 and GPLv2 license texts plus all third-party copyright and
   license notices listed above;
2. a prominent notice that the package contains a modified javascript-libzim /
   libzim / Xapian Wasm build and the exact DIV modifications and date;
3. the exact build scripts, patches, configuration, interface-definition files,
   and installation information needed to reproduce the shipped Wasm;
4. complete corresponding source for the shipped binaries, published alongside
   the extension release with immutable hashes and a durable retrieval URL;
5. an SBOM mapping every shipped Wasm/JS artifact to its version, source archive,
   license, and SHA-256; and
6. a documented determination about the license of the combined extension and
   any required source release or relicensing of DIV itself.

Merely linking to the upstream repositories is not the corresponding-source
procedure for a locally modified binary. Store terms, trademark rules, and the
interaction between browser-extension packaging and GPL linking also require
review before release.

## Owner decision

Exactly one option must be selected in a repository change approved by the
repository owner:

- [x] **Approve GPL distribution.** The owner accepts the compliance work and
  confirms the repository/release licensing strategy for the combined work.
- [ ] **Reject GPL distribution.** Keep the honest title-only fallback and do
  not claim completion of the issue's Xapian acceptance criterion.
- [ ] **Use a different runtime.** Name a browser-compatible, permissively
  licensed implementation that can query the ZIM Xapian index; repeat this
  dependency and distribution review before bundling it.

Approver: Emre Sokullu (repository owner)
Decision date: 2026-08-19
Decision/reference: branch `gpld`

### Licensing strategy for the combined work

MIT-licensed code can be incorporated into a GPL work, but a combined work that
integrates GPL components must be distributed under compatible GPL terms. The
project therefore uses this version boundary:

- DIV **33.0.0 and later**, including the repository and Chrome, Edge, and
  Firefox packages, is conveyed under **GPL-3.0-or-later**.
- Releases before 33.0.0 remain available under the MIT license that applied
  when they were published. The historical text is retained at
  [`LICENSES/MIT.txt`](../LICENSES/MIT.txt).
- Independently published subprojects can retain a different license when they
  are separate works and carry their own license notice. The MCP server and
  LM Studio plugin remain MIT-licensed under their local `LICENSE` files.
- Third-party files remain governed by their own notices.

GPL-3.0 is the resolved version because javascript-libzim is GPL-3.0-or-later
while libzim and Xapian are GPL-2.0-or-later, and "or later" lets both move up.
This also keeps the existing Apache-2.0 dependencies (sqlite-wasm, Transformers.js,
pdf.js) compatible: Apache-2.0 conflicts with GPL-2.0-only but not with GPL-3.0.
Confirm the "or later" wording on each upstream COPYING file before the first
release, because the whole strategy rests on it.

A user disabling Apocalypse Mode does not change the license of what was
distributed. If the Wasm is in the package, the package is GPL. Shipping an
permissively licensed build would require a separate artifact without the Wasm, not a
settings toggle.

### Build provenance: use the source path, not the prebuilt one

The upstream Makefile has two paths and only one of them is acceptable here.

- `make libzim_release` downloads a **prebuilt** `libzim_wasm-emscripten-9.8.1`
  tarball from download.openzim.org and compiles only the bindings against it.
  The upstream release workflow uses this. DIV must not, because the
  corresponding source for that binary is not ours to provide.
- The default `all` target builds xz, zlib, zstd, ICU, Xapian, and libzim from
  pinned source tarballs with documented origins, then links the bindings. Every
  version in the table above comes from these targets.

DIV builds the source path. CI must archive every downloaded tarball and
patch, record its SHA-256, and publish them as the corresponding source beside
the release. The release packager keeps the tracked
`dist/corresponding-source/` tree in the tagged commit and creates a
`dist/webbrain-*-corresponding-source.zip` asset from that exact `HEAD`; the
patch and minor release workflows upload it beside the browser ZIPs.

The Wasm is built from that path and vendored at `src/*/vendor/libzim/`.
`ZIM_XAPIAN_RUNTIME_BUNDLED` is `true` and `ZIM_XAPIAN_DISTRIBUTION_STATUS` is
`bundled-from-source`. Emscripten's wasm-opt segfaults on this module at `-O3`,
so the link is `-O2`; `sbom.json` records `linkOptimization: "O2"`.

### Detecting a full-text index without the runtime

libzim 0.95 exposes no `hasFulltextIndex` binding, and its `search()` catches its
own exceptions and returns an empty vector, so a missing index looks exactly like
a query that matched nothing. Kiwix stores the index as an ordinary ZIM entry, so
DIV's own reader answers the question instead: `hasFullTextIndex()` on the
archive, surfaced through `createKiwixZimProvider`. That keeps the check outside
the GPL surface and lets an archive with no index skip loading the runtime at
all.
