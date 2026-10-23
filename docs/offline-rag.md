# Offline RAG and Emergency Corpus

DIV's offline retrieval-augmented generation (RAG) pipeline lets the
extension answer questions using locally stored reference materials without any
network connection. It builds on Apocalypse Mode's Wikipedia archives and adds
a new Emergency Box text corpus — a curated collection of public-domain
field-reference documents covering medical, survival, education, and
communication topics.

Standalone WebGPU chat has no tools. Retrieved passages are injected into the
prompt first; the selected WebGPU text model (Compass Tiny v2.1 by default, or
a Ternary Bonsai 2 preset) answers from that evidence or says it cannot.

## What's new

- **Emergency Box text corpus.** A verified ~502 MB ZIP containing ~570
  public-domain plaintext documents (~304 MB of source text) distributed from
  the `webbrain-one/emergency-box-corpus` repository. Documents are PDF-derived
  field references in multiple languages. Installed Emergency Box PDFs are a
  separate reader shelf and are **not** searched by this RAG path.
- **Two retrieval engines, not one.** Wikipedia uses the installed Kiwix/ZIM
  **title index** (`title-only`) and, when the archive has a Xapian index, the
  vendored GPL full-text worker. Emergency Box uses a prebuilt SQLite **FTS5
  BM25** index shipped inside the corpus ZIP. Wikipedia is not FTS5.
- **Semantic vector search (Emergency Box only).** An optional int8-quantized
  multilingual E5 model (`Xenova/multilingual-e5-small`, ~140 MB download)
  provides cosine-similarity search over passage embeddings that are also
  precomputed and shipped in the ZIP.
- **E5 reranking.** When the prebuilt vector index is not available for a
  source, candidates from BM25 can be reranked on-device using the same E5
  model. Missing or timed-out E5 falls back to BM25 and is reported as
  `lexical-fallback` (shown in chat as "keyword fallback").
- **Reciprocal Rank Fusion.** Lexical and semantic results are combined via
  reciprocal rank fusion, then diversified to limit redundancy (max 8 passages,
  max 2 per document). On-device WebGPU chat also caps injected evidence at
  about 1,800 tokens so the local model can finish its answer.
- **Local citation readers.** Wikipedia citations open `wikipedia-reader.html`.
  Emergency Box passage citations open `emergency-text.html` after re-hashing
  the plaintext document. When the matching Emergency Box PDF is installed,
  the same citation also links to `emergency-pdf.html`. No citation navigates
  to a live web page.
- **RAG readiness dashboard.** A 4-cell status grid collapsed under Emergency
  Box on Apocalypse Mode, and in the side panel, shows Wikipedia search,
  Emergency library search, semantic ranking, and local answer generation
  independently. Corpus and semantic installs live there, not on the PDF shelf.
- **Source and language filters.** Checkboxes limit retrieval to installed
  sources and languages. Filters persist across sessions. Standalone chat also
  routes per query: encyclopedia questions stay on Wikipedia when both sources
  are selected; personal health and first-aid questions can use both.
- **Transactional corpus updates.** The previous corpus remains active until
  every document checksum and the index are verified. Atomic activation means a
  failed update never leaves you without a working corpus.

## How a standalone query is answered

1. **Normalize the query.** Question prefixes are stripped, then multilingual
   stopwords (from [ranks.nl](https://www.ranks.nl/stopwords), packaged in
   `offline-query-stopwords.js`) are dropped. A query that is only leftover
   stopwords does not fall back to the raw sentence.
2. **Choose sources for this turn.** Routing is not sticky. With both Wikipedia
   and Emergency Box selected, encyclopedia-style questions search Wikipedia
   only. Personal health and first-aid questions search both when they are
   ready. Pronoun follow-ups such as "fix it" after a history article do not
   reuse the previous topic when the new message has its own distinctive terms.
3. **Search.** Wikipedia hits come from Xapian when the archive has an index,
   otherwise from the ZIM title index. Emergency Box hits
   always use FTS5 when the text pack is `ready`; E5 vectors are used when the
   model and index are available.
4. **Fuse and budget.** Hits are fused, diversified, and wrapped as untrusted
   evidence. WebGPU generation is capped (currently 2048 new tokens). LFM2.5
   strips `<think>` from the visible answer; Bonsai 27B uses a 128-token think
   budget so reasoning cannot consume the whole decode. If the model spends that
   budget inside reasoning, DIV retries with a shorter evidence prompt
   rather than inventing an answer.
5. **Cite locally.** Each kept passage gets a stable token (`[WB-E-…]` or
   Wikipedia equivalent) and a local reader URL. Emergency Box citations add an
   **Open PDF** link only when that catalog PDF is installed.

## What's under the hood

### Architecture

```
agent.js (service worker)
  → offline-retrieval-offscreen.js (MV3 proxy)
    → offscreen/offline-rag-host.js (offscreen document, owns the retrieval service)
      → offline-rag-index.js (main-thread FTS5 + vector client)
        → offline-rag-worker.js (dedicated Web Worker, owns SQLite Wasm + OPFS SAH pool)
```

Wikipedia search does not go through SQLite. Indexed archives use the vendored
Xapian worker; otherwise Apocalypse Mode's ZIM title index. Both then share the
same fusion and citation bridge.

The offscreen document also hosts the E5 reranker worker
(`offline-reranker-worker.js`). The layered proxy pattern exists because Chrome
MV3 service workers cannot hold OPFS synchronous access handles.

### Key modules

| Module | Purpose |
| --- | --- |
| `offline-rag.js` | Browser-neutral primitives: chunking, tokenization, citation tokens, evidence assembly, reciprocal rank fusion, diversity selection |
| `offline-rag-index.js` | FTS5 schema definition, vector index binary format (`WBVE5Q8`), query builders, hit normalization |
| `offline-rag-worker.js` | Dedicated Web Worker owning the SQLite Wasm runtime and OPFS SAH pool. Handles index building, FTS5 search, brute-force cosine similarity over int8 vectors |
| `offline-rag-prompt.js` | Trusted prompt policy bridge: assembles evidence, builds citation reference objects with `readerUrl`, and attaches an installed PDF reader URL when one matches |
| `offline-retrieval.js` | Orchestrates Wikipedia title search + Emergency lexical + Emergency vector + semantic reranking, then fusion and diversification |
| `offline-reranker.js` | Client for the E5 reranking worker. Model download/pause/stop, query embedding, candidate reranking |
| `offline-query-stopwords.js` | Packaged ranks.nl stopword lists used before Wikipedia and Emergency search |
| `emergency-corpus.js` | Transactional lifecycle: resumable HTTP Range downloads, SHA-256 verification, manifest-driven extraction, OPFS storage, Web Lock coordination |
| `emergency-corpus-release.js` | Release pointer: pinned URL, SHA-256, byte counts, passage counts for the current corpus |
| `zim-xapian.js` | Adapter for full-text Wikipedia ZIM search via the vendored Xapian/libzim Wasm worker |

### Storage layout

- **OPFS** (Origin Private File System):
  - `.webbrain-offline-rag-sahpool-v1/` — SQLite SAH pool directory
  - `webbrain-offline-rag/emergency-box-text/downloads/` and `installs/` — Emergency corpus files
- **IndexedDB** (`webbrain_offline_rag`): Corpus lifecycle state, active version, manifest, install ID, index path, vector index declaration
- **IndexedDB** (`webbrain_emergency_box`): Installed PDF/resource records used for **Open PDF** citation links
- **Legacy passage-vector cache**: capped at 256 MB

### FTS5 schema

FTS5 indexes **Emergency Box passages only**.

```sql
CREATE VIRTUAL TABLE passages USING fts5(
  passage_id UNINDEXED, document_id UNINDEXED, source_id UNINDEXED,
  title, language UNINDEXED, collection, source UNINDEXED, license UNINDEXED,
  locator, body, search_terms,
  passage_sha256 UNINDEXED, token_estimate UNINDEXED, ordinal UNINDEXED,
  reader_url UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

BM25 scoring weights: `body` 7, `search_terms` 1, `locator` 0.6, `collection`
2, `title` 4.

### Vector index format

Custom binary format with `WBVE5Q8` magic header:
- 4096-byte header with JSON metadata (model ID, revision, dtype, passage count,
  dimensions)
- Int8 quantized passage vectors (384 dimensions each)
- Float32 L2 norms for cosine similarity
- Brute-force cosine similarity in the worker (251K passages is tractable)

### Passage chunking

Documents are chunked into passages of 180–700 tokens (target ~420):
1. Split by newlines into paragraphs
2. Detect headings (markdown `#`, patterns like `Chapter`, numbered sections,
   ALL-CAPS lines)
3. Split oversized paragraphs by sentence boundaries
4. Merge adjacent small paragraphs up to target token count
5. Each passage gets a deterministic `passageId` based on document + locator +
   content hash

### Retrieval modes

These modes apply to Emergency Box ranking. Wikipedia uses Xapian full-text when
the archive has an index, otherwise title lookup.

| Mode | Description |
| --- | --- |
| `hybrid-full-vector` | Prebuilt E5 vectors used directly (Emergency Box) |
| `semantic-reranked` | E5 reranker used on BM25 candidates |
| `lexical-fallback` | BM25 only (no E5 model available or E5 timed out) |

### Graceful degradation

- Without E5: Emergency Box falls back to BM25 lexical search
- Without Emergency Box: searches only Wikipedia sources
- Without both: reports offline search unavailable
- Xapian full-text Wikipedia search: used when the archive has an index;
  otherwise title-only lookup
- Empty retrieval: the local model must not invent medical advice

## Vendor libraries

All vendor libraries are committed as vendored files. No runtime fetch of
executable code occurs. Only model weights and corpus data are downloaded by the
user.

| Library | Version | License | Purpose |
| --- | --- | --- | --- |
| fflate | 0.8.3 | MIT | Streaming ZIP decompression |
| SQLite Wasm | 3.53.0-build1 | Apache-2.0 | FTS5 full-text search for the Emergency Box corpus |
| Transformers.js | 4.2.0 | Apache-2.0 | E5 inference runtime |
| ONNX Runtime Web | 1.27.0 | MIT | WASM/GPU inference backend |
| E5 model | multilingual-e5-small q8 | Apache-2.0 | Semantic embeddings (downloaded separately) |

## Licensing

The Emergency Box corpus, SQLite, fflate, and Transformers.js are all
permissively licensed and do not independently impose copyleft terms. DIV
33.0.0 and later is nevertheless GPL-3.0-or-later because the distributed
extension integrates the GPL-licensed Xapian/libzim runtime.

The Xapian/libzim full-text Wikipedia runtime is vendored and GPL. See
[offline-rag-licensing.md](offline-rag-licensing.md) for the decision record,
corresponding source, and how release artifacts are conveyed.

## Further reading

- [Apocalypse Mode](apocalypse-mode.md) — Wikipedia archive management
- [Remote downloads & data sources](remote-downloads.md) — Origins, execution order, and verification
- [Offline RAG licensing](offline-rag-licensing.md) — GPL decision record
- [Release checklist](offline-rag-release-checklist.md) — Verification gates
  and measurements
