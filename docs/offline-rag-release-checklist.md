# Offline RAG release and verification checklist

This checklist covers the Emergency text corpus, SQLite FTS5, optional
multilingual E5 reranking, and Wikipedia ZIM retrieval added for issue #278.
It deliberately separates measurements possible with the current incomplete
corpus from the final release gates.

## Current measured snapshot (2026-08-17)

The source folder currently contains 570 PDF-derived text files totaling
304,190,304 bytes. PDF-to-text extraction is complete for those files. The
collection is not final and more source files are expected. A mechanically
completed preview catalog applies the corpus owner's public-domain designation,
derives missing titles from filenames, and marks 154 unidentified languages as
`und`. The 570-document `2026.08.17-preview.3` release is wired into both
extensions for full download/index/search testing. Its 501,799,481-byte ZIP
(SHA-256 `950e5a3c6b52354c1de371b6463df39d9d239aa059dd5d3eabfa21e89c305e5e`)
contains 301,370,399 installed text bytes, a 1,052,307,456-byte prebuilt SQLite
FTS5 database, and a 97,447,968-byte int8 multilingual E5 index covering
251,144 passages. It is hosted in the separate
`webbrain-one/emergency-box-corpus` GitHub repository. The browser imports the
FTS5 database and performs exact full-corpus vector search, so it does not
compute either corpus index after download. It remains explicitly marked as a
preview because metadata refinements, known extraction warnings, and additional
documents are still pending.

The passage embeddings were generated on an NVIDIA RTX 5090 from the pinned
`intfloat/multilingual-e5-small` weights and then quantized to int8. An
independent eight-passage comparison against the extension's pinned
`Xenova/multilingual-e5-small` q8 ONNX model measured 0.9940 mean cosine
agreement (0.9886 minimum).

Working-tree extension ZIPs were measured with a temporary Git index so that
new files were included without staging or committing them:

| Package | Current ZIP | HEAD baseline | Change |
| --- | ---: | ---: | ---: |
| Chrome | 18,554,766 bytes | 17,914,296 bytes | +640,470 bytes (+3.58%) |
| Firefox | 11,867,989 bytes | 4,821,922 bytes | +7,046,067 bytes (+146.13%) |

The corresponding current unpacked source trees are 72,074,617 bytes for
Chrome and 44,032,174 bytes for Firefox. The larger Firefox delta is the
packaged CPU/Wasm inference runtime it did not previously contain. E5 model
weights are not in either extension ZIP: their pinned explicit download is
140,461,908 bytes. The separately hosted corpus ZIP contains the precomputed
passage vectors; the browser model only embeds each query. The legacy
passage-vector cache is capped at 268,435,456 bytes.

These measurements do not include the vendored Xapian/libzim Wasm
(`src/*/vendor/libzim/`, about 2.3 MB). See `docs/offline-rag-licensing.md`.

The deterministic synthetic benchmark can be repeated with:

```powershell
node scripts/benchmark-offline-rag.mjs 10000 200
```

On this machine with Node 24.19.0 and the exact packaged SQLite Wasm, 10,000
mixed English/CJK passages produced an 8,896,512-byte database. Index creation
took 1,143.804 ms (8,742.8 passages/second), and `PRAGMA quick_check` returned
`ok`. Across 200 warm queries returning 40 candidates:

| Query | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| `airway breathing` | 6.576 ms | 8.568 ms | 12.395 ms |
| `急救 呼吸道` | 15.779 ms | 19.556 ms | 23.047 ms |

This is a deterministic SQLite/search comparison, not a browser OPFS or final
corpus benchmark. Run the final measurements below on representative target
hardware once the corpus is frozen.

## Final corpus gates

1. Finish adding source files to `text-format`.
2. Re-run `process_texts.py --write-metadata-template`; fill every title,
   language, source URL, collection, and license from an authoritative record.
3. Run deterministic normalization. Do not restore the old local-LLM rewrite
   step: it changes source meaning, is not reproducible, and cannot provide a
   reliable integrity chain.
4. Review every corruption warning and require complete metadata.
5. Run all Python tests and build the deterministic text-pack ZIP, manifest,
   descriptor, SHA-256, exact compressed bytes, and exact extracted bytes.
6. Publish the immutable ZIP over HTTPS. Put the final descriptor into
   `emergency-corpus-release.js` in both browsers and remove the provisional
   source-count message.
7. Verify a fresh install, an interrupted/resumed install, a corrupt archive,
   a corrupt document, a canceled extraction, a canceled index, and an update
   while an older corpus is active. The prior active corpus must survive every
   failed update.

Record these final values in the issue or release notes:

- corpus document and passage counts;
- download ZIP bytes and SHA-256;
- extracted text and manifest bytes;
- final SQLite bytes and SHA-256;
- normalization, verification, extraction, and indexing time;
- English and CJK median/p95 query latency; and
- peak OPFS usage during first install and update.

Peak storage must be measured, not estimated. The expected upper-bound shape
during first install is downloaded ZIP + extracted staging files + staging
SQLite. During an update it additionally includes the complete old active text
and index until atomic activation succeeds.

## Browser offline test matrix

Run on current stable Chrome and Firefox with a fresh profile for each:

1. Install the unpacked extension. Enable Apocalypse Mode and explicitly
   install local generation, one Simple English Wikipedia archive, the final
   Emergency text pack, and E5. Confirm that merely opening a page or asking a
   question starts no corpus/model download.
2. Install a second Wikipedia language and both a Simple and full edition when
   available. Verify that source/language filters persist and that citations
   retain distinct archive identity.
3. In browser developer tools, set the network to Offline (or disconnect the
   machine), close all DIV pages, and restart the browser.
4. Ask an English factual question, an English emergency question, and a CJK
   question. Verify retrieval/generation readiness are shown independently,
   no request reaches the network, and answers cite only returned evidence.
5. Open every citation. Wikipedia links must open the local ZIM reader;
   Emergency links must re-hash the local source document and highlight the
   exact stable passage. No citation may navigate to a live web page.
6. Remove E5 and repeat. Results must return immediately through the disclosed
   keyword fallback. Remove the Emergency corpus and confirm its source is
   reported unavailable without downloading it. Reinstall explicitly.
7. Disable local generation while keeping indexes ready. Readiness must show
   retrieval ready and generation unavailable as separate states.
8. Test no-hit and insufficient-evidence prompts. The agent must say evidence
   is insufficient instead of inventing an answer or citation.
9. Test a ZIM with a full-text index, a ZIM without one, and a forced worker
   failure. Only the first may report `xapian-full-text`; the others must
   report `title-only-fallback`.

## Release blockers

- [ ] The Emergency corpus and metadata are final.
- [ ] The published descriptor contains immutable exact size/hash values.
- [ ] Final OPFS install/index/storage and query measurements are recorded.
- [ ] Chrome and Firefox pass the complete manual offline matrix.
- [ ] The owner made the explicit GPL/runtime decision in
      `docs/offline-rag-licensing.md`.
- [ ] If GPL was approved, complete corresponding source, build scripts,
      notices, SBOM, and package hashes ship with the release. Confirm the
      tagged tree retains `dist/corresponding-source/` and the GitHub release
      includes `webbrain-*-corresponding-source.zip` beside the browser ZIPs.
- [ ] The repository test suite passes apart from no acknowledged pre-existing
      artifact/environment failures.
