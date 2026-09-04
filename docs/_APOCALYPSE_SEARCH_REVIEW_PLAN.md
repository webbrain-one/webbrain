# Emergency Box search layer: zvec assessment and practical improvement plan

## Context

The question was whether [alibaba/zvec](https://github.com/alibaba/zvec) or
[zvec-ai/zvec-grep](https://github.com/zvec-ai/zvec-grep) could replace the current methods used for
Wikipedia and Emergency Box search in apocalypse mode, and what complications that would introduce.

The research revealed two things, both of which change the direction of the plan:

1. **zvec cannot be integrated into this product.** It cannot play a meaningful role either at runtime or at build time (rationale below).
2. **Emergency Box already has semantic search.** You selected the "no semantic search" option in the questions,
   but the code says otherwise. E5 embeddings + an int8 vector index + BM25 with RRF fusion are already running.
   What is missing is not semantic search, but **an ANN index and size discipline**.

Therefore, instead of adopting zvec, the plan focuses on solving the four concerns you identified
(relevance, speed, size, and maintenance) through measurable steps on top of the existing architecture.
In line with your chosen scope, it addresses **Emergency Box first**; the Wikipedia/Xapian side is left untouched.

---

## 1. Why zvec should be ruled out

| Finding | Source |
|---|---|
| zvec is an in-process vector DB written in C++; it wraps the Proxima engine | README |
| Its Node SDK is not pure JS: `@zvec/zvec` is a thin 72 KB wrapper, while the actual work is done by prebuilt native `@zvec/bindings-{linux-x64,linux-arm64,win32-x64,darwin-arm64,+musl}` packages | npm registry |
| **The upstream request for wasm bindings was closed as "not planned"** — and the request described our exact scenario: "build the index on the server, then load and search it in the browser" | [issue #25](https://github.com/alibaba/zvec/issues/25) |
| AVX2/AVX512 runtime dispatch, io_uring, WAL, mmap, and similar dependencies are difficult to port to wasm | README |
| `zvec-grep` is a Node ≥22 CLI/MCP tool; it depends on the native `@vscode/ripgrep` binary and `node-llama-cpp` | npm registry |
| There is no darwin-x64 binding (Intel Macs are unsupported) | npm registry |

The critical point is that **build-time use does not solve the problem either.** zvec's value lies in its native query engine
and its own index formats (HNSW, IVF-RaBitQ). It does not produce a browser-portable artifact. Even if we generated a zvec
index on the build machine, we would have to write its reader from scratch in JS — at which point zvec's contribution
would drop to zero.


## Context

The question was whether [alibaba/zvec](https://github.com/alibaba/zvec) or [zvec-ai/zvec-grep](https://github.com/zvec-ai/zvec-grep) could replace the current methods used for Wikipedia and Emergency Box search in apocalypse mode, and what complications that would introduce.

The research revealed two things, both of which change the direction of the plan:

1. **zvec cannot be integrated into this product.** It cannot play a meaningful role either at runtime or at build time (rationale below).
2. **Emergency Box already has semantic search.** You selected the "no semantic search" option in the questions, but the code says otherwise. E5 embeddings + an int8 vector index + BM25 with RRF fusion are already running. What is missing is not semantic search, but **an ANN index and size discipline**.

Therefore, instead of adopting zvec, the plan focuses on solving the four concerns you identified (relevance, speed, size, and maintenance) through measurable steps on top of the existing architecture. In line with your chosen scope, it addresses **Emergency Box first**; the Wikipedia/Xapian side is left untouched.

---

## 1. Why zvec should be ruled out

| Finding | Source |
|---|---|
| zvec is an in-process vector DB written in C++; it wraps the Proxima engine | README |
| Its Node SDK is not pure JS: `@zvec/zvec` is a thin 72 KB wrapper, while the actual work is done by prebuilt native `@zvec/bindings-{linux-x64,linux-arm64,win32-x64,darwin-arm64,+musl}` packages | npm registry |
| **The upstream request for wasm bindings was closed as "not planned"** — and the request described our exact scenario: "build the index on the server, then load and search it in the browser" | [issue #25](https://github.com/alibaba/zvec/issues/25) |
| AVX2/AVX512 runtime dispatch, io_uring, WAL, mmap, and similar dependencies are difficult to port to wasm | README |
| `zvec-grep` is a Node ≥22 CLI/MCP tool; it depends on the native `@vscode/ripgrep` binary and `node-llama-cpp` | npm registry |
| There is no darwin-x64 binding (Intel Macs are unsupported) | npm registry |

The critical point is that **build-time use does not solve the problem either.** zvec's value lies in its native query engine and its own index formats (HNSW, IVF-RaBitQ). It does not produce a browser-portable artifact. Even if we generated a zvec index on the build machine, we would have to write its reader from scratch in JS — at which point zvec's contribution would drop to zero.

**The only defensible use of zvec:** the corpus producer (`build_emergency_pack.py`, in the separate `webbrain-one/emergency-box-corpus` repository) is written in Python, and zvec's primary SDK is Python. We could use zvec there as an **evaluation oracle**: load the same 251k E5 vectors and generate exact-KNN ground truth to measure recall loss when moving to ANN. To be honest, we could also do this with about 20 lines of numpy; zvec's contribution here would be marginal. It is not worth adding the dependency, but it could be tried as a measurement tool in Phase 0 if desired.

What can be taken from `zvec-grep` is not code, but an **idea**: hybrid BM25+vector fusion (which we already have through RRF) and structure-aware chunking. It introduces nothing new.

---

## 2. What actually exists today

The Emergency Box retrieval pipeline (all under `src/chrome/src/agent/`):

- **Lexical:** SQLite FTS5 with weighted BM25 — `offline-rag-index.js:20` (schema), `:60` (`bm25(passages, 0,0,0,7,0,2,0,0,4,1,0.6,...)`). It uses two passes: exact, followed by a prefix-based relaxed pass if results are below `RELAXED_RETRY_THRESHOLD` (5) — `offline-retrieval.js:132,145-168`.
- **Semantic:** `Xenova/multilingual-e5-small`, 384 dimensions, q8 — `offline-reranker.js:6-10`. Passage vectors are **not computed on-device**; they arrive prebuilt in the corpus ZIP (`indexes/emergency-box-e5-q8.bin`, `WBVE5Q8` format, parser in `offline-rag-index.js:404-451`). Only the query vector is generated on-device.
- **Search loop:** `searchEmergencyVector()` — `offline-rag-worker.js:281-330`. **Brute force, exact, no ANN:** 251,144 × 384 int8 dot products, with a cancellation check every 4,096 rows.
- **Fusion:** RRF k=60 — `offline-rag.js:630-665`, followed by diversification at `:705-737`.

Measured figures:

| Metric | Value | Source |
|---|---|---|
| Total installed index | **1,149,755,424 B (~1.15 GB)** | `emergency-corpus-release.js:20-33` |
| — FTS5 db | **1,052,307,456 B (~1.05 GB)** | `docs/offline-rag-release-checklist.md:19-24` |
| — Vector index | 97,447,968 B (~97 MB) | same source |
| Installed plain text | 301,370,399 B | `emergency-corpus-release.js` |
| E5 model download | 140,461,908 B | `offline-reranker.js` |
| Passage count | 251,144 | `emergency-corpus-release.js` |
| recall@1 / recall@5 / MRR | 0.554 / 0.875 / 0.685 | `scripts/benchmark-offline-relevance.mjs:33-39` |
| — weak categories | **typo 0.357**, **inflection 0.393** | same source |

**What the four concerns actually correspond to:**

- **Size** — this is where the largest and most concrete gain is available. The 1.05 GB FTS5 db is enormous. The schema (`offline-rag-index.js:11-35`) specifies neither `detail=` nor `content=`, which means FTS5 uses the default `detail=full`, keeps a **full positional index**, and stores **a second copy of all text** in the `passages_content` shadow table — even though the text is already installed separately as 301 MB.
- **Speed** — about 96M int8 multiply-add operations per query. The semantic timeout is 30 s (`offline-retrieval.js:17`).
- **Relevance** — poor typo/inflection performance is a lexical weakness, not a vector-engine problem.
- **Maintenance** — handwritten, test-pinned components: `preferMatchingAgeCohort`, `AGE_COHORT_SYNONYMS`, `relaxedFts5Prefix`, `insertVectorWinner`, and `cjkNgrams`.

---

## 3. Proposed approach

### Phase 0 — Measurement harness (do this first, no code changes)

Do not act on any size claim without producing numbers. Using the existing `scripts/benchmark-offline-relevance.mjs` harness and the vendored SQLite, build a variant matrix. For every variant, measure **db size + recall@1/@5 + MRR (broken down by category) + query p50/p95**.

Variants: current · `detail=column` · `detail=none` · contentless (`content=''`) + external text · `search_terms` column removed.

Do not proceed to Phase 1 without the output of this phase.

### Phase 1 — Size: FTS5 db (goal: reduce 1.05 GB substantially)

Two independent levers:

1. **Reduce `detail=`.** Positional data is required for phrase and NEAR queries. `buildFts5Query()` (`offline-rag-index.js:330-353`) joins terms with `OR` and quotes individual tokens (`'tourniquet bleeding'` → `'"tourniquet" OR "bleeding"'`), so it **does not generate multiword phrases** — `detail=none` appears compatible. Prefix queries (`blee*`) work with `detail=none`. Verify this in Phase 0, because shifts in `bm25()` scores may affect recall.
2. **Remove the duplicate text.** The text is already installed under `emergency-box-text/`. Make FTS5 contentless or use external content, then read `body`/`title` through the locator after the query, eliminating duplication in the shadow table. This changes how `EMERGENCY_FTS_SEARCH_SQL` (`:44-64`) returns text columns — that is the main place to modify.

### Phase 2 — Speed + size: vectors (97 MB, brute force)

Introduce a two-stage search:

- At build time, generate a **1 bit/dimension binary code** for every passage: 384 bits = **48 B/passage** → ~12 MB (about 1/8 of today's 97 MB).
- At runtime, first use popcount/Hamming to produce a coarse top-N (~2,000), then run the existing exact int8 dot product **only for those N candidates**. The final ranking remains exact while scan cost falls by ~100×.
- Places to modify: `searchEmergencyVector()` (`offline-rag-worker.js:281-330`) and the next version of the `WBVE5Q8` format (`offline-rag-index.js:404-451`, `EMERGENCY_VECTOR_INDEX_FORMAT_VERSION`).

We would implement this ourselves; zvec's RaBitQ can serve as a reference, but no dependency is required.

### Phase 3 — Relevance: typo 0.357 and inflection 0.393

This belongs on the lexical side:

- **Typo:** add an auxiliary FTS5 `trigram` index used only during the relaxed pass.
- **Inflection:** the corpus is multilingual, so aggressive stemming is risky. Measure the inexpensive option first — lower the lexical weight in RRF for short queries and lean more heavily on the semantic side (`offline-rag.js:630-665`).

Measure both changes using the category breakdown in the Phase 0 matrix; no category may fall below its floor.

### Phase 4 — Maintenance

`sqlite-vec` is the only realistic library candidate: pure C, dependency-free, statically compiled into SQLite WASM (dynamic extension loading is unavailable), and its `vec0` virtual tables could retire `insertVectorWinner` + `WBVE5Q8`. **However, it is not recommended now:** it is still 0.1.7-alpha, it also uses brute force (so it does not provide the Phase 2 speedup), and tests pin the SHA-256 of `vendor/sqlite/index.mjs` and `sqlite3.wasm` (`test/run.js:33182`) — adopting it would require rebuilding the wasm. Revisit it if SQLite wasm is rebuilt for another reason.

---

## 4. Files to modify

| File | Purpose |
|---|---|
| `src/chrome/src/agent/offline-rag-index.js` | FTS5 schema (`:11-35`), search SQL (`:44-64`), vector format parser (`:404-451`) |
| `src/chrome/src/agent/offline-rag-worker.js` | Make `searchEmergencyVector()` two-stage (`:281-330`), db import (`:201-239`) |
| `src/chrome/src/agent/offline-rag.js` | RRF weights (`:630-665`), hit merging if text becomes contentless |
| `src/chrome/src/agent/offline-retrieval.js` | Two-pass lexical flow (`:132,145-168`) |
| `scripts/benchmark-offline-relevance.mjs` | Phase 0 variant matrix; floors (`:40`) |
| `src/firefox/src/agent/…` | Firefox copies of the same files — tests require them to be byte-identical |

**The largest complication outside this repository:** the index format is produced by `build_emergency_pack.py` in the `webbrain-one/emergency-box-corpus` repository. Phases 1 and 2 require **a coordinated corpus release** (501 MB ZIP), plus an `OFFLINE_RAG_INDEX_PROTOCOL_VERSION` bump (currently 2) and a manifest migration path for users still on the old format. This is the most expensive item in the plan, and its timing is determined by that repository.

---

## 5. Verification

At the end of each phase, in order:

1. `node scripts/benchmark-offline-relevance.mjs --verbose` — must pass the recall@1 ≥ 0.53 · recall@5 ≥ 0.85 · MRR ≥ 0.66 floors (`:40`); typo/inflection **must not regress** in the category breakdown.
2. `node scripts/benchmark-offline-rag.mjs` — index installation and query latency regression.
3. `node test/run.js` — especially `:33182` (FTS5 query shape + sqlite wasm SHA), `:33236` (`WBVE5Q8` layout), `:33271` (actual FTS5 integrity), and `:34876` (two-pass flow). If the format changes, update these assertions deliberately — never weaken them silently.
4. Installation smoke test with the real corpus: install Emergency Box, run the queries from `docs/offline-rag-release-checklist.md` (`airway breathing`, `急救 呼吸道`), measure the installed index size, and record it in the table.
5. Test separately in Chrome and Firefox; verify that the offscreen path (`offline-rag-host.js`) remains intact on the MV3 side.

## 6. Out of scope

- The Wikipedia/ZIM/Xapian side (later, according to your prioritization).
- The substring scans in `emergency-pdf-search.js` and `emergency-box.js:218-230` — these are not RAG; they are separate, small surfaces and can be handled as a separate task if desired.
- The zvec / zvec-grep dependency — not adopted for the reasons above.
# Emergency Box search layer: zvec assessment and practical improvement plan

## Context

The question was whether [alibaba/zvec](https://github.com/alibaba/zvec) or [zvec-ai/zvec-grep](https://github.com/zvec-ai/zvec-grep) could replace the current methods used for Wikipedia and Emergency Box search in apocalypse mode, and what complications that would introduce.

The research revealed two things, both of which change the direction of the plan:

1. **zvec cannot be integrated into this product.** It cannot play a meaningful role either at runtime or at build time (rationale below).
2. **Emergency Box already has semantic search.** You selected the "no semantic search" option in the questions, but the code says otherwise. E5 embeddings + an int8 vector index + BM25 with RRF fusion are already running. What is missing is not semantic search, but **an ANN index and size discipline**.

Therefore, instead of adopting zvec, the plan focuses on solving the four concerns you identified (relevance, speed, size, and maintenance) through measurable steps on top of the existing architecture. In line with your chosen scope, it addresses **Emergency Box first**; the Wikipedia/Xapian side is left untouched.

---

## 1. Why zvec should be ruled out

| Finding | Source |
|---|---|
| zvec is an in-process vector DB written in C++; it wraps the Proxima engine | README |
| Its Node SDK is not pure JS: `@zvec/zvec` is a thin 72 KB wrapper, while the actual work is done by prebuilt native `@zvec/bindings-{linux-x64,linux-arm64,win32-x64,darwin-arm64,+musl}` packages | npm registry |
| **The upstream request for wasm bindings was closed as "not planned"** — and the request described our exact scenario: "build the index on the server, then load and search it in the browser" | [issue #25](https://github.com/alibaba/zvec/issues/25) |
| AVX2/AVX512 runtime dispatch, io_uring, WAL, mmap, and similar dependencies are difficult to port to wasm | README |
| `zvec-grep` is a Node ≥22 CLI/MCP tool; it depends on the native `@vscode/ripgrep` binary and `node-llama-cpp` | npm registry |
| There is no darwin-x64 binding (Intel Macs are unsupported) | npm registry |

The critical point is that **build-time use does not solve the problem either.** zvec's value lies in its native query engine and its own index formats (HNSW, IVF-RaBitQ). It does not produce a browser-portable artifact. Even if we generated a zvec index on the build machine, we would have to write its reader from scratch in JS — at which point zvec's contribution would drop to zero.

**The only defensible use of zvec:** the corpus producer (`build_emergency_pack.py`, in the separate `webbrain-one/emergency-box-corpus` repository) is written in Python, and zvec's primary SDK is Python. We could use zvec there as an **evaluation oracle**: load the same 251k E5 vectors and generate exact-KNN ground truth to measure recall loss when moving to ANN. To be honest, we could also do this with about 20 lines of numpy; zvec's contribution here would be marginal. It is not worth adding the dependency, but it could be tried as a measurement tool in Phase 0 if desired.

What can be taken from `zvec-grep` is not code, but an **idea**: hybrid BM25+vector fusion (which we already have through RRF) and structure-aware chunking. It introduces nothing new.

---

## 2. What actually exists today

The Emergency Box retrieval pipeline (all under `src/chrome/src/agent/`):

- **Lexical:** SQLite FTS5 with weighted BM25 — `offline-rag-index.js:20` (schema), `:60` (`bm25(passages, 0,0,0,7,0,2,0,0,4,1,0.6,...)`). It uses two passes: exact, followed by a prefix-based relaxed pass if results are below `RELAXED_RETRY_THRESHOLD` (5) — `offline-retrieval.js:132,145-168`.
- **Semantic:** `Xenova/multilingual-e5-small`, 384 dimensions, q8 — `offline-reranker.js:6-10`. Passage vectors are **not computed on-device**; they arrive prebuilt in the corpus ZIP (`indexes/emergency-box-e5-q8.bin`, `WBVE5Q8` format, parser in `offline-rag-index.js:404-451`). Only the query vector is generated on-device.
- **Search loop:** `searchEmergencyVector()` — `offline-rag-worker.js:281-330`. **Brute force, exact, no ANN:** 251,144 × 384 int8 dot products, with a cancellation check every 4,096 rows.
- **Fusion:** RRF k=60 — `offline-rag.js:630-665`, followed by diversification at `:705-737`.

Measured figures:

| Metric | Value | Source |
|---|---|---|
| Total installed index | **1,149,755,424 B (~1.15 GB)** | `emergency-corpus-release.js:20-33` |
| — FTS5 db | **1,052,307,456 B (~1.05 GB)** | `docs/offline-rag-release-checklist.md:19-24` |
| — Vector index | 97,447,968 B (~97 MB) | same source |
| Installed plain text | 301,370,399 B | `emergency-corpus-release.js` |
| E5 model download | 140,461,908 B | `offline-reranker.js` |
| Passage count | 251,144 | `emergency-corpus-release.js` |
| recall@1 / recall@5 / MRR | 0.554 / 0.875 / 0.685 | `scripts/benchmark-offline-relevance.mjs:33-39` |
| — weak categories | **typo 0.357**, **inflection 0.393** | same source |

**What the four concerns actually correspond to:**

- **Size** — this is where the largest and most concrete gain is available. The 1.05 GB FTS5 db is enormous. The schema (`offline-rag-index.js:11-35`) specifies neither `detail=` nor `content=`, which means FTS5 uses the default `detail=full`, keeps a **full positional index**, and stores **a second copy of all text** in the `passages_content` shadow table — even though the text is already installed separately as 301 MB.
- **Speed** — about 96M int8 multiply-add operations per query. The semantic timeout is 30 s (`offline-retrieval.js:17`).
- **Relevance** — poor typo/inflection performance is a lexical weakness, not a vector-engine problem.
- **Maintenance** — handwritten, test-pinned components: `preferMatchingAgeCohort`, `AGE_COHORT_SYNONYMS`, `relaxedFts5Prefix`, `insertVectorWinner`, and `cjkNgrams`.

---

## 3. Proposed approach

### Phase 0 — Measurement harness (do this first, no code changes)

Do not act on any size claim without producing numbers. Using the existing `scripts/benchmark-offline-relevance.mjs` harness and the vendored SQLite, build a variant matrix. For every variant, measure **db size + recall@1/@5 + MRR (broken down by category) + query p50/p95**.

Variants: current · `detail=column` · `detail=none` · contentless (`content=''`) + external text · `search_terms` column removed.

Do not proceed to Phase 1 without the output of this phase.

### Phase 1 — Size: FTS5 db (goal: reduce 1.05 GB substantially)

Two independent levers:

1. **Reduce `detail=`.** Positional data is required for phrase and NEAR queries. `buildFts5Query()` (`offline-rag-index.js:330-353`) joins terms with `OR` and quotes individual tokens (`'tourniquet bleeding'` → `'"tourniquet" OR "bleeding"'`), so it **does not generate multiword phrases** — `detail=none` appears compatible. Prefix queries (`blee*`) work with `detail=none`. Verify this in Phase 0, because shifts in `bm25()` scores may affect recall.
2. **Remove the duplicate text.** The text is already installed under `emergency-box-text/`. Make FTS5 contentless or use external content, then read `body`/`title` through the locator after the query, eliminating duplication in the shadow table. This changes how `EMERGENCY_FTS_SEARCH_SQL` (`:44-64`) returns text columns — that is the main place to modify.

### Phase 2 — Speed + size: vectors (97 MB, brute force)

Introduce a two-stage search:

- At build time, generate a **1 bit/dimension binary code** for every passage: 384 bits = **48 B/passage** → ~12 MB (about 1/8 of today's 97 MB).
- At runtime, first use popcount/Hamming to produce a coarse top-N (~2,000), then run the existing exact int8 dot product **only for those N candidates**. The final ranking remains exact while scan cost falls by ~100×.
- Places to modify: `searchEmergencyVector()` (`offline-rag-worker.js:281-330`) and the next version of the `WBVE5Q8` format (`offline-rag-index.js:404-451`, `EMERGENCY_VECTOR_INDEX_FORMAT_VERSION`).

We would implement this ourselves; zvec's RaBitQ can serve as a reference, but no dependency is required.

### Phase 3 — Relevance: typo 0.357 and inflection 0.393

This belongs on the lexical side:

- **Typo:** add an auxiliary FTS5 `trigram` index used only during the relaxed pass.
- **Inflection:** the corpus is multilingual, so aggressive stemming is risky. Measure the inexpensive option first — lower the lexical weight in RRF for short queries and lean more heavily on the semantic side (`offline-rag.js:630-665`).

Measure both changes using the category breakdown in the Phase 0 matrix; no category may fall below its floor.

### Phase 4 — Maintenance

`sqlite-vec` is the only realistic library candidate: pure C, dependency-free, statically compiled into SQLite WASM (dynamic extension loading is unavailable), and its `vec0` virtual tables could retire `insertVectorWinner` + `WBVE5Q8`. **However, it is not recommended now:** it is still 0.1.7-alpha, it also uses brute force (so it does not provide the Phase 2 speedup), and tests pin the SHA-256 of `vendor/sqlite/index.mjs` and `sqlite3.wasm` (`test/run.js:33182`) — adopting it would require rebuilding the wasm. Revisit it if SQLite wasm is rebuilt for another reason.

---

## 4. Files to modify

| File | Purpose |
|---|---|
| `src/chrome/src/agent/offline-rag-index.js` | FTS5 schema (`:11-35`), search SQL (`:44-64`), vector format parser (`:404-451`) |
| `src/chrome/src/agent/offline-rag-worker.js` | Make `searchEmergencyVector()` two-stage (`:281-330`), db import (`:201-239`) |
| `src/chrome/src/agent/offline-rag.js` | RRF weights (`:630-665`), hit merging if text becomes contentless |
| `src/chrome/src/agent/offline-retrieval.js` | Two-pass lexical flow (`:132,145-168`) |
| `scripts/benchmark-offline-relevance.mjs` | Phase 0 variant matrix; floors (`:40`) |
| `src/firefox/src/agent/…` | Firefox copies of the same files — tests require them to be byte-identical |

**The largest complication outside this repository:** the index format is produced by `build_emergency_pack.py` in the `webbrain-one/emergency-box-corpus` repository. Phases 1 and 2 require **a coordinated corpus release** (501 MB ZIP), plus an `OFFLINE_RAG_INDEX_PROTOCOL_VERSION` bump (currently 2) and a manifest migration path for users still on the old format. This is the most expensive item in the plan, and its timing is determined by that repository.

---

## 5. Verification

At the end of each phase, in order:

1. `node scripts/benchmark-offline-relevance.mjs --verbose` — must pass the recall@1 ≥ 0.53 · recall@5 ≥ 0.85 · MRR ≥ 0.66 floors (`:40`); typo/inflection **must not regress** in the category breakdown.
2. `node scripts/benchmark-offline-rag.mjs` — index installation and query latency regression.
3. `node test/run.js` — especially `:33182` (FTS5 query shape + sqlite wasm SHA), `:33236` (`WBVE5Q8` layout), `:33271` (actual FTS5 integrity), and `:34876` (two-pass flow). If the format changes, update these assertions deliberately — never weaken them silently.
4. Installation smoke test with the real corpus: install Emergency Box, run the queries from `docs/offline-rag-release-checklist.md` (`airway breathing`, `急救 呼吸道`), measure the installed index size, and record it in the table.
5. Test separately in Chrome and Firefox; verify that the offscreen path (`offline-rag-host.js`) remains intact on the MV3 side.

## 6. Out of scope

- The Wikipedia/ZIM/Xapian side (later, according to your prioritization).
- The substring scans in `emergency-pdf-search.js` and `emergency-box.js:218-230` — these are not RAG; they are separate, small surfaces and can be handled as a separate task if desired.
- The zvec / zvec-grep dependency — not adopted for the reasons above.
