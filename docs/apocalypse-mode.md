# Apocalypse Mode

Apocalypse Mode is WebBrain's optional offline knowledge layer. It reads
Wikipedia archives in the openZIM format used by Kiwix. It does **not** make the
configured LLM available offline: generating an answer still requires a local
model or a reachable model provider.

## Consent and installation

The feature is disabled by default. Enabling the packaged Wikipedia skill does
not enable Apocalypse Mode, query the Kiwix catalog, or store article text.
Open the **☢ Apocalypse Mode** link beside **Support** in the Settings header to
opt in.

On supported Chromium browsers, WebBrain VL 2 450M is an optional local vision fallback.
Apocalypse Mode never enables or downloads it. The dedicated **Use local
fallback** control in **Settings → Assistive Models → Vision** checks WebGPU support,
records explicit consent, and starts caching the approximately 810 MB model
from Hugging Face. The download continues in the background, but screenshot
operations report its status and never wait for it. Wikipedia archives still
require their own confirmation. The local **text** model is Compass Tiny v2.1
(`webbrain-one/webbrain-compass-tiny-v2.1`, about 1.87 GB, 32k context
window), and remains the default text preset. **Compass Tiny XS v3** is an
optional private, noncommercial research preview in the same picker:
Spark-X2.5-1.7B, native FP16 / FP32 GEMM, about 3.96 GB, 4K context. It requires
an authorized HF read token saved in Settings → Providers → WebGPU for the
initial download; inference is local and has no cloud fallback. See
[provider details](providers-and-models.md#compass-tiny-xs-v3-private-research-preview)
for the pinned revision, hardware requirements and cache behavior. Switching
presets preserves cached files and transfer ownership; Pause/Stop target the
actual active transfer. The selected text model's download
starts automatically when Apocalypse Mode is enabled. Once downloaded,
Compass works without Apocalypse Mode enabled: it is selectable as a chat
provider under Settings → Providers and through the standalone chat control.
Disabling
local vision preserves its cache and any configured remote vision provider.

Archive language is selected independently from WebBrain's interface language.
The management page reads Kiwix's current OPDS catalog and offers a language plus
one of two editions: **Text only**, which resolves to the complete `nopic`
edition, and **With images**, which resolves to the complete `maxi` edition.
Both are complete-encyclopedia (`_all_`) archives. `selectWikipediaArchiveVariant`
accepts nothing else, so curated subsets and compact `mini` editions are never
installed from the catalog even though `classifyArchiveTier` can still label them.

The required first download is separate and fixed: Simple English, complete, and
`nopic`. See `isBasicWikipediaArchive`. It is text-only, not an images edition.

Because both selectable editions are complete `_all_` archives, both carry the
Kiwix full-text index: `nopic` omits images, not the index.

Before an install, WebBrain resolves the archive's Metalink and shows its exact byte size,
archive date, catalog publisher/source and license notice, integrity-piece
count, and the browser's reported free extension storage. The archive is
downloaded only after that confirmation. Existing `.zim` files are validated
and their embedded date/language/source/license metadata is shown before import.
When the current catalog or archive omits a license field, WebBrain says that it
was not declared instead of presenting the general Wikipedia notice as an exact
publisher declaration.

Kiwix publishes very different archive sizes. A complete language edition can
require tens or hundreds of GiB, especially when images are included. Catalog
values can change; the confirmation dialog is authoritative for the selected
current entry.

## Storage and lifecycle

- IndexedDB (`webbrain_apocalypse_mode`) contains the opt-in setting, archive
  metadata, byte cursor, generation, retry state, and storage reference.
- Archive bodies are kept in the extension's Origin Private File System (OPFS),
  not as multi-gigabyte IndexedDB values. Chromium browsers exposing the File
  System Access API can instead use a user-selected file target. Removing that
  archive from WebBrain retains the user-owned file; Firefox uses OPFS.
- Downloads use Metalink piece boundaries and verify each piece before writing
  it. The persisted cursor makes background-worker restarts resumable.
- A lease prevents two extension contexts from claiming the same piece.
- Pause and disable increment a generation so stale work cannot commit.
  Deletion removes metadata before bytes, so an in-flight request cannot
  resurrect the archive.
- Transient failures use bounded exponential backoff. Integrity failures never
  write the rejected piece and eventually require a manual retry.
- Catalog downloads continue in the background after the management page is
  closed. Reopen Apocalypse Mode to inspect progress or pause the download.
- The Chromium-only local vision model uses the browser's Transformers cache.
  After its explicitly requested download completes, its GPU allocations are
  released until WebBrain actually needs local screenshot analysis.
- Every optional WebGPU text/VL preset has a separate completion marker and
  cache entry. Switching presets can release the previous GPU runtime without
  deleting its cached files.
- An installed archive that later becomes unreadable because of corruption,
  eviction, or a revoked file grant moves from ready to an actionable error;
  WebBrain reports the read failure instead of misreporting an empty search.
- Update checks can be manual or automatic. The automatic policy performs a
  daily catalog network check, but installing a discovered replacement still
  requires confirmation. A newer archive never silently overwrites an older
  one; delete the older archive after verifying the replacement.

Imported archives are structurally checked and extension free space is reviewed
before they are copied to OPFS. Closing the management page interrupts an active
user-file import because browsers do not provide a durable file grant
consistently. A stale import is marked failed, and its partial bytes are retained
so the failure remains visible and recoverable.
Delete the failed entry to reclaim that storage, then choose the file again to
restart the import. Partial import bytes are removed automatically on explicit
cancellation, quota exhaustion, or another write failure.

## Retrieval and attribution

If a live Wikipedia tool request fails, the exact built-in Wikipedia skill can
search installed archives by canonical title and title prefix through the ZIM
URL index. Retrieval is behind a provider seam; `createKiwixZimProvider()` is
the default, and tests inject another provider without changing lifecycle or
tool-routing code. The ZIM provider follows redirects, decompresses
uncompressed and Zstandard clusters, selects a bounded passage around matching
query terms, and returns the resolved canonical Wikipedia URL plus embedded
archive language/date/source/license metadata. Local archive text uses the same
untrusted-result boundary as live third-party content.

WebBrain reads the documented openZIM structures directly, using the MIT-licensed
`fzstd` decoder, and that reader stays the only path used for reading articles.

Full-text search over a ZIM's Xapian index uses the GPL worker vendored under
`src/*/vendor/libzim/`. `ZIM_XAPIAN_RUNTIME_BUNDLED` is `true`. Catalog archives
that include an index (`X/fulltext/xapian` or the older
`Z//fulltextIndex/xapian`) answer with snippets. A conceptual query no longer
has to name the article title. See `docs/offline-rag-licensing.md` for the
decision, the release licensing strategy, and the reproducible -O2 source build.

Standalone retrieval detects the question language from script, multilingual
query words, and the interface locale fallback. A matching installed archive is
searched before newer archives in other languages. The user's language filters
remain authoritative: an empty filter searches every installed language, while
selected ISO 639-3 codes exclude other-language passages from the final evidence.

When the question language differs from the installed Wikipedia archive
languages that will be searched, the already-downloaded WebGPU text model first
produces short search keyword translations for those archive languages. This
works both with the default "all installed languages" setting and explicit
language filters. The translations are bounded, validated as data, and used only
as per-archive Xapian queries; they are never stored as conversation messages. A
failed or malformed translation causes no download and falls back to the
original query. This improves cross-language lookup but remains dependent on the
selected text model's language ability.

`hasFullTextIndex()` on the reader reports whether an archive carries an index at
all, checking both the current `X/fulltext/xapian` entry and the older
`Z//fulltextIndex/xapian` one. Every catalog edition has one. A manually imported
`.zim` may not, and libzim gives no way to tell the difference on its own: its
`search()` swallows the error and returns no results, which is indistinguishable
from a query that matched nothing. Probing the archive directly keeps that
distinction honest and lets an unindexed archive skip loading the runtime.

## Browser limits

- OPFS quota and eviction policy are browser/profile specific. The pre-install
  estimate is informative, not a reservation.
- Chrome Manifest V3 background workers are ephemeral; persisted jobs and alarms
  resume piece downloads after the worker restarts.
- Firefox uses a persistent extension background page, but large storage quotas
  and OPFS behavior can still differ by version and device.
- Private/incognito profiles, profile clearing, extension removal, or browser
  storage eviction can remove archives.
- Very large archives may be impractical on mobile or low-storage devices.

Catalog metadata comes from the [Kiwix OPDS catalog](https://library.kiwix.org/),
the file format is documented by [openZIM](https://wiki.openzim.org/wiki/ZIM_file_format),
and archive content remains subject to the license embedded by its publisher.

See [Remote Downloads & Data Sources](remote-downloads.md) for download triggers, execution order, and integrity verification.
