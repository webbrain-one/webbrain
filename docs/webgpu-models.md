# In-browser WebGPU models: checklist and lessons

Read this before adding, replacing or re-exporting a model for the Chromium
**WebGPU (In-browser)** provider (`src/chrome/src/providers/webgpu.js`,
`src/chrome/src/offscreen/inference-worker.js`). It records what made Ternary
Bonsai 2 unusable in the browser and the checks that would have caught it.

## What went wrong with Bonsai 2

Asking Bonsai 2 2B Vision to "summarize this page" took many minutes and froze
the desktop, on an RTX 5090 and on an M4 Max alike. Five independent causes
stacked up:

1. **Token-by-token prefill on the CPU.** The upstream language graph
   (`danyalmalik/Ternary-Bonsai-2-*-ONNX-WebGPU`, the same pattern as
   `onnx-community/Qwen3.5-*-ONNX`) computes every GatedDeltaNet prefill with an
   ONNX `Scan` over tokens. ONNX Runtime Web's WebGPU execution provider has no
   `Scan` (or `Loop`) kernel, so the node is placed on the CPU and its body runs
   once per token, with a GPU round trip, in each of 18 layers (24 for 4B).
   That costs about 6.5 ms per prompt token per layer: 0.13 s per prompt
   token for 2B and 0.19 s for 4B on an RTX 5090. A faster GPU barely helps,
   because the time goes to synchronisation, not compute.
2. **Logits for every prompt token.** The graph's `logits` output was
   `[batch, sequence_length, 248320]`, so prefill ran the LM head over the
   whole prompt and downloaded about 0.5 MB of FP16 scores per prompt token.
   Above roughly 4.3k tokens that output also exceeds the 2 GB maximum buffer
   size many WebGPU adapters report.
3. **The wrong GPU.** Chrome runs WebGPU on the adapter its GPU process uses.
   On a Windows machine with an RTX 5090 and a small display card (T400), every
   `powerPreference` returned the T400, which also drives the monitors. The model
   saturated it and the whole desktop stalled while the 5090 sat idle.
4. **One giant prefill pass.** Even with a fixed graph, a ~9k-token prompt in a
   single decoder pass keeps a GPU that is shared with the display (Apple
   silicon, a display-attached card) busy for seconds, and the desktop stutters.
5. **Large prompts.** Ask mode sent the full Ask system prompt (~3.4k tokens)
   plus 17 tool schemas (~5.7k tokens) to in-browser models on every call,
   because the compact tier only changes Act mode. The 2B model then often
   called a tool with invalid arguments, which cost another full call: "hello"
   took four calls and 108 s on the display GPU. Tiny Ask (below) replaces
   this path.

Two process gaps let this ship. The production harness
(`scripts/check-bonsai-webgpu.mjs`) only uses prompts of a few dozen tokens,
which hide prefill problems entirely. And graph files were replaced under
an already-cached URL, which installed copies never re-fetch.

## Checklist for a new or re-exported model

Do all of these on the exact files you will publish.

1. **Static graph audit.**

   ```bash
   python scripts/models/audit_webgpu_onnx.py path/to/decoder.onnx
   ```

   It exits non-zero for `Scan`/`Loop` anywhere in the graph (including `If`
   branches) and for a `logits` output that keeps the sequence dimension.
   `If` is fine; it has a WebGPU kernel. The original Bonsai 2 and
   `onnx-community/Qwen3.5` decoders fail this check. Compass Tiny,
   `Mike0021/Ternary-Bonsai-2-4B-text-ONNX` (which uses the
   `com.microsoft::LinearAttention` and `CausalConvWithState` contrib ops) and
   the rewritten Bonsai 2 Vision graphs pass.
   - A `num_logits_to_keep` input is not enough on its own. Transformers.js
     sets it to `1` only in text `generate()`. Its multimodal path and direct
     `forward()` calls (including sliced prefill) pass `0`, which keeps every
     position. Slice to the last position inside the graph, as
     `chunk_gdn_prefill.py` does. The audit blocks such graphs unless
     `--text-generate-only` says text `generate()` is the only caller.
2. **Node placement on real WebGPU.** Create the session in a browser with
   `ort.env.logLevel = 'verbose'` and `logSeverityLevel: 0`, then read the
   `Node placements` block. Small shape ops (`Shape`, `Gather`, `Equal` on
   int64) belong on the CPU. Any compute op reported as
   `webgpu kernel not found in registries` is a red flag.
3. **Long prompts and prefill scaling.** The short harness prompts cannot show
   prefill problems. Run real prompts of about 1k, 4k and 8k tokens, plus a
   long prompt with an image for vision models, through the production
   worker on hardware WebGPU:

   ```bash
   node scripts/check-webgpu-long-prompts.mjs --model <owner/repo> \
     --profile <cached profile> --offline --lengths 1000,4000,8000 --slices 0,512
   ```

   The model's production path and dtype come from the provider presets.
   Serve an unpublished export with `--local-repo <owner/repo>=<dir>`, which
   clears that model's cached copy first.

   It prints wall time and seconds per 1k prompt tokens for each prompt. It
   rejects software WebGPU adapters, and it fails when a text prompt of 4k or
   more tokens takes longer than `--max-seconds-per-1k` (default 10). A
   CPU fallback costs 100 seconds or more per 1k tokens.
   - For the multimodal (`onnx-vl`) presets it also runs an image prompt and
     compares each sliced answer with the first `--slices` value. It fails if
     they diverge within the first eight words, which is what a broken cache
     handoff does. A later divergence is reported but expected (see "Sliced
     prefill" below).
   - Text models run each prompt once, for timing only.
   - The worker's multimodal chat accepts only the shipped `onnx-vl` presets,
     so a new vision model needs a preset (and worker support) before this
     check can run it.

   Seconds per 1k tokens should stay roughly flat, around a second on a
   desktop GPU. Reference for rewritten Bonsai 2 2B Vision on an RTX 5090
   (48 new tokens, including decode):

   | Prompt tokens | One pass | 512-token slices | 256-token slices |
   |---|---|---|---|
   | 1k | 1.3 s | 1.4 s | 1.4 s |
   | 4k | 3.3 s | 4.0 s | 4.7 s |
   | 8k | 5.5 s | 7.7 s | 10.0 s |

   In a decoder-only benchmark, 4B prefilled 8,192 tokens in 16 s. The
   original Scan graph took 128 s for 1,024 tokens.
4. **Ask eval.** Run `scripts/check-webgpu-ask.mjs` through the real extension
   before and after any change to the in-browser prompt, page context or
   runtime. It covers greeting, summary, a fact at the end of a long page,
   prices, a follow-up, arithmetic, a selection, Turkish, a prompt injection,
   an Act request, a linked URL and a browser page. Use a fresh `--profile`
   for each build: a reused profile keeps running the service worker of the
   build it first loaded, so it can silently test old code. The report lists
   the prompt variant that answered each task (`tiny_ask` or `ask`).
5. **Production harness.** Run `scripts/check-bonsai-webgpu.mjs` online and
   `--offline` (with `--vision --image-history` for vision models) and record
   the evidence with `scripts/models/bonsai/record_browser_validation.py`.
6. **Memory.** Budget weights, plus KV and recurrent cache for the browser
   context, plus transient prefill buffers. Keep every single tensor under
   2 GB, the per-buffer limit on many adapters.
7. **Rollout.** Browsers keep files cached by URL. If a published file
   changes in place, existing installs never see it unless the worker
   refreshes it explicitly (see "Updating a published graph").

## Fixing a Qwen3.5 / GatedDeltaNet export

Use the tools in `scripts/models/bonsai/`:

- `chunk_gdn_prefill.py` replaces every GatedDeltaNet `Scan` with the
  chunked gated delta rule and slices the LM head to the last position.
  Weights and the `.onnx_data` file stay byte-identical; only the small graph
  file changes. Decode keeps the original single-token branch.
  - 128-token chunks. Inside a chunk, the unit lower-triangular WY inverse uses
    **recursive block inversion**. A Neumann-product inverse is shorter but
    overflows FP32 when keys in a chunk are strongly correlated.
  - Across chunks, a Hillis-Steele prefix scan over the affine state maps runs
    with `If`-skipped steps. The step count is derived from
    `text_config.max_position_embeddings`, so every accepted prompt length
    stays correct. Chunks must be powers of two from 16 to 1024.
- `validate_chunked_gdn.py` compares old and new graphs on CPU with real text.
  It covers chunk-boundary lengths, a multi-chunk prompt, a cached continuation,
  logits, every cache output (whole-tensor and worst-element error) and
  finiteness. It reads the chunk size from the rewritten graph.
- `make_chunked_bundle.py` derives a sealed bundle. It writes model-card
  parity and timing claims only from evidence that passes the verifier (both
  graph hashes, chunk coverage, top-1 and decode equality, FP16 tolerances).
  It drops browser evidence recorded against the previous graph and keeps
  native vision parity only while its encoder hashes still match.
- `build_vision.py` applies the rewrite on full rebuilds.

## Compass VLD Tiny v5

The default in-browser model,
[`webbrain-one/webbrain-compass-vld-tiny-v5-onnx`](https://huggingface.co/webbrain-one/webbrain-compass-vld-tiny-v5-onnx)
(about 2.2 GB), is DIV's fine-tune of
[MiniCPM-V-4.7-1B](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B): a SigLIP
vision tower with a merger that downsamples 16 times, and a language model with
Qwen3.5-0.8B's topology (18 GatedDeltaNet and 6 full-attention layers). One
model serves chat and tool calls, screenshots (the vision fallback and tiny
Ask) and decisions. Its training data and evaluations are on the model card.

- **Runtime.** Transformers.js has neither a MiniCPM-V model class nor its
  processor, so `src/chrome/src/offscreen/compass-vld-runtime.js` drives the
  three graphs with ONNX Runtime Web directly, in the same worker, model
  queue and Cache Storage as the other presets:
  - `embed_tokens` (Q8): token embeddings.
  - `vision_encoder` (FP16): crops to image features.
  - `decoder_model_merged` (Q8): a chunked GatedDeltaNet prefill (no `Scan`),
    last-position `logits` and `decision_hidden`, and the recurrent,
    convolution and KV cache in and out.

  It ports the processor: slicing a screenshot into up to nine crops plus a
  thumbnail, Pillow-compatible bicubic resampling, the image placeholders and
  the canvas M-RoPE positions. Token ids and positions match the PyTorch
  processor, and resampled pixels differ by at most 2/255 on about 0.01% of
  values. `test/compass-vld-runtime.mjs` checks the crops, placeholders and
  positions against a PyTorch reference for synthetic images
  (`test/fixtures/compass-vld-processor.json`). The tokenizer is
  Transformers.js's `Qwen2Tokenizer`, built from the cached files rather than
  by `AutoTokenizer.from_pretrained`, which first looks for
  `tokenizer_config.json` at revision `main`: the pinned download never
  caches that, so the lookup would go to Hugging Face on every load and fail
  offline. With the published files it renders the reference's prompts and
  produces its token ids exactly. Message text, tool descriptions and decision
  questions that spell one of its added tokens get a zero-width space after
  the first character, so a page quoting `<|image_pad|>`, `<|im_end|>` or
  `</tool_response>` cannot add an image slot, end a turn or close a tool
  result. That covers every added token, not only the special ones: the
  tokenizer adds `<tool_call>`, `<tool_response>` and `<think>` (and their
  closing tags) without marking them special, and Transformers.js encodes
  them as single tokens all the same. Decoding is greedy with thinking off;
  tool calls use Qwen3.5's XML format.
- **Download.** Files are read at a pinned commit (`COMPASS_VLD_REVISION`),
  one at a time. Each is stored only once it arrived whole and is then
  checked against its pinned size and SHA-256; a mismatch removes it and
  fails the download, and a match is recorded in a small entry beside the
  file (`compassVldVerifiedUrl`). A file's own headers are written before its
  body arrives, so only that record says it was checked: a file stored by a
  download that stopped before its check is checked by the next Download
  instead of being trusted or fetched again. A dropped connection or a server
  error retries that file twice. Inference reads only the cache. The ready
  marker does not name the revision, so readiness also checks that every
  pinned file is cached and recorded as checked; after a new pin the model
  reads as not downloaded until Download fetches the new files, and a
  finished download removes the earlier revision's.
- **Checks on the published files** (RTX 5090, Chromium through Playwright):
  - `audit_webgpu_onnx.py` passes for every graph: no `Scan` or `Loop`, and
    decoder logits of shape `[batch, 1, 248094]`.
  - `check-bonsai-webgpu.mjs --vision --image-history --offline`, with
    Hugging Face fetches blocked: the sum, the tool call and its result,
    each image's colour and shape, and the second image picked from a
    two-image history all passed, as did the same run with `--ocr` (the
    four-character code printed in each ~1 MP image). The first answer
    took about 6 s, loading the model from the cache included; the others
    took 0.2–1.2 s.
  - `check-webgpu-long-prompts.mjs --vision` (up to 48 new tokens, decode
    included; the answers were identical with and without slices):

    | Prompt tokens | One pass | 512-token slices |
    |---|---|---|
    | 1k | 1.0 s | 1.0 s |
    | 4k | 1.6 s | 1.8 s |
    | 8k | 2.5 s | 4.3 s |
    | 1k with a screenshot | 0.8 s | 0.6 s |
  - `check-webgpu-ask.mjs`: 20/20 tasks in 28 s, every one through tiny Ask
    in one call; the six image tasks took a screenshot and the text tasks
    none. Two answers passed the loose checks but are worth watching: the
    Act request answered that it would click the button instead of saying
    Ask cannot act, and the Turkish and Spanish image questions were
    answered in English.
  - Decisions and the tiny Ask screenshot gate are below.
- **Memory.** About 2.2 GB of weights, about 12 KB of FP16 KV per token in
  its six attention layers, and a fixed recurrent state in the GatedDeltaNet
  layers.

## Runtime behaviour to keep

- **Tiny Ask** (`src/chrome/src/agent/tiny-ask.js`). A side-panel Ask turn
  whose provider is the in-browser model makes one tool-free call.
  - DIV reads the current page before the call: `read_page` windows up to
    60k characters, the selection, PDF text through the `read_pdf` redirect,
    and a page the user linked in the question (`fetch_url`). It sends a
    ~280-token system prompt with that text in untrusted-content wrappers.
    The page's URL and title are page-controlled, so they go inside the
    page's wrapper too, not in a trusted line.
  - A long page keeps its opening plus the chunks that share content words
    with the question, in ~9k characters (~2.5k tokens). The first call stays
    near 4k tokens, against ~10k before.
  - Page text is ephemeral: durable history keeps only the question, and each
    turn reads the page again. Offline Wikipedia and Emergency Box references
    are added only when there is no page text.
  - When the model reads images (Compass VLD Tiny v5 or Ternary Bonsai 2 2B
    Vision), a question can also get a screenshot of the visible page. The
    model decides, so it works in any language and there are no word lists
    (`tinyAskScreenshotGate`). The numbers below are Bonsai's; Compass VLD
    Tiny v5's follow them.
    - Before the answer, one Yes/No readout on the same model returns a logit
      margin and the decoder's last-position state. It costs about 0.22 s on
      the RTX 5090 and generates no text.
    - A small probe scores them (`tiny-ask-gate-probe.js`, 2,050 weights,
      `scripts/models/bonsai/train_gate_probe.py`). The training data comes
      from templates in 11 languages (`gate_dataset.py`).
    - The readout sees only the user's message and facts DIV knows: how
      much page text there is, an attached image, a linked page. It never
      sees page content, so a page cannot steer it.
    - Hand-written test, 72 questions: 64/72 correct and 1/38 false "yes".
      The 28 questions in 7 languages absent from training scored 23/28.
      The untrained readout scored 38/72.
    - Misses lean towards no screenshot, which is the old behaviour; most are
      colour-of-a-button questions in unseen languages. A wrong "yes" only
      costs a screenshot, about 0.5 s.
    - Follow-ups: the screenshot is gone from history, so "And the button?"
      after a screenshot answer needs another look. The stored question is
      marked (`webbrainTinyAskScreenshot`, never the image), and the next turn
      uses a lower bar, 0.4 instead of 0.5. The readout still sees only the
      new message: with the earlier question added it said yes to 11–13 of 30
      text follow-ups such as "Thanks!".
      - The bar was chosen on 60 follow-ups in 14 languages: 27/30 visual ones
        (22/30 at 0.5), 0/30 false "yes".
      - It was also chosen on 42 that point back with a pronoun: 10/17 visual
        ("Does it have a handle?"; 8/17 at 0.5) and 3/25 false "yes" (2/25).
        Some text ones look anyway: "How much does it hold?" scores 0.73 alone.
      - Checked on 52 others in 16 languages, written afterwards: 21/26
        (18/26), 0/26 false "yes".
      - `check-tiny-ask-screenshot-gate.mjs --follow-ups` runs all three.
    - A page with almost no text gets a note to answer from the image. A
      screenshot alone never suppresses offline references. With an attached
      image both images can be sent, when the readout says the page is needed
      too.
    - Compass VLD Tiny v5 has its own probe (1,026 weights, in the same file).
      Its untrained readout scored 44/72 on the hand-written test, answering
      yes to 6 of the 34 visual questions. A probe trained like Bonsai's scored
      72/72 there but caught only 24 of the 73 visual follow-ups below: its
      training had no short follow-ups such as "And the button?". The shipped
      probe adds them (`gate_dataset.py --follow-ups`: about 320 short
      follow-ups from templates in the same 11 languages, phrased unlike the
      follow-up sets below, split 80/20 on their own). On the RTX 5090:
      - Validation (generated templates, follow-ups included): 175/181.
      - Hand-written test: 69/72, all 34 visual questions and 3/38 false
        "yes", all three short requests in languages absent from training
        (pl, vi, hi); 25/28 in those languages.
      - Through the extension, the questions in
        `check-tiny-ask-screenshot-gate.mjs`: 24/24 visual, 1/31 false "yes"
        ("Ada Lovelace kimdir?" on a page with almost no text).
      - Through the extension, follow-ups at 0.4: 22/30 visual and 0/30
        false "yes" on the set the bar was chosen on, 11/17 and 1/25 on the
        pronoun set, 24/26 and 0/26 on the set checked afterwards.
      - The readout takes about 0.11 s (median), against 0.22 s for Bonsai.
    - If the readout fails, the turn stays text-only. That includes a model
      without a trained probe (only Compass VLD Tiny v5 and Bonsai 2 2B Vision
      have one) and a cached decoder graph from before `decision_hidden`.
      There is no fallback to the untrained readout.
    - The capture is the same as automatic screenshots: redaction, size
      budget and the per-turn limit. It is ephemeral like page text, and it
      never goes to a separate vision model.
    - Redaction covers form fields, not text drawn in images, so the prompt's
      no-secrets rule names screenshots too, and Strict Secret Mode takes no
      tiny Ask screenshot.
    - On the RTX 5090 a screenshot adds about 0.5–1 s. `scripts/check-webgpu-ask.mjs`
      has image tasks in English, Turkish, German and Spanish, and text tasks
      that must take no screenshot (18/18). `scripts/check-tiny-ask-screenshot-gate.mjs`
      measures the readout alone.
  - It reuses the standalone WebGPU run machinery but not its prompt or
    history: the standalone window still has no page access, and the two
    profiles' history segments never cross (`webbrainStandaloneChat` and
    `webbrainTinyAsk` markers).
  - Act and Dev are refused for in-browser models, in the agent before
    enrichment and in the side-panel mode toggle.
  - Selection shortcuts keep their own source-bound path. After a background
    restart a tiny Ask candidate hydrates the tab before it is decided, so a
    restored selected-text scope is never bypassed by a full page read.
  - Do not add tools or instructions back to this profile without
    re-running `scripts/check-webgpu-ask.mjs`. Every token is prefilled again
    on every call, and a 2B model picks tools unreliably.
- **Sliced prefill.** For the Bonsai 2 Vision presets and Compass VLD Tiny v5
  the worker prefills long prompts in 512-token slices that carry the
  recurrent, conv and KV cache, then continues decoding from that cache
  (`generate()` for Bonsai, `CompassVldRuntime.generate` for Compass VLD).
  - Answers match a single pass up to FP16 rounding. In the RTX 5090 runs,
    most sliced greedy answers were identical over 48 tokens. The rest
    matched for the first 30–39 words, then picked a different but
    equivalent phrasing: slicing changes the order of floating-point sums,
    which can flip a near-tied token. The results were reproducible run to
    run, and a smaller slice was not always further off.
  - A broken cache handoff looks different: the answer loses the prompt right
    away.
  - Each extra slice adds roughly one decoder run of fixed overhead (about
    0.14 s on an RTX 5090).

  - The `chrome.storage.local` key `webgpuPrefillSliceTokens` overrides the
    slice (64–8192, `0` disables).
  - Apply the same pattern to any new model that serves long prompts on
    shared GPUs.
- **Cache-only inference.** Chat never downloads. Only explicit download or
  preload flows fetch model files: Providers → WebGPU, Apocalypse
  Mode, and the first-install page (Chrome), which offers Compass VLD Tiny v5
  behind its optional "Download local models" button: one 2.2 GB download
  that chats, reads screenshots and answers decisions. The install page
  checks for hardware WebGPU before fetching anything, never changes the
  active provider or the decision settings, and only points an idle WebGPU
  provider at the model when the configured model is not already downloaded.
  Auto decisions and Auto in-browser vision then use it, whatever the chat
  provider ([`providers-and-models.md`](providers-and-models.md#decision-models)).
  The page no longer downloads D1 or Ternary Bonsai 2 2B Vision.

## Decisions on WebGPU

Two on-device paths answer typed decision questions (`choice`, `noul`,
`score`) without generating text. `scripts/check-webgpu-decisions.mjs` runs
them through the real extension on the same labelled questions (`--engines`
takes `d1`, `compass-vld` and `bonsai`):

```bash
node scripts/check-webgpu-decisions.mjs --test <final_test.json> --images <dir> \
  --engines d1,compass-vld --stress --download --profile <fresh profile> \
  --adapter-luid 0,82094 --output result.json
```

The labelled set is d1's balanced-V3 held-out test (72 synthetic screenshots,
144 questions). It is not in this repository.

- **d1 (the decision model).** A bidirectional encoder that scores option
  markers, published as
  [`webbrain-one/d1-browser-decision-fp16`](https://huggingface.co/webbrain-one/d1-browser-decision-fp16).
  - Its graphs pass the static audit, but its six full-attention layers are
    dense: each row materializes a 16 × length × length FP32 score tensor.
    The old batching budgeted tokens (65,536), not that tensor, and every
    question is its own row with the whole state. On the 5090, 16 questions
    on a ~2k-token state needed a 2.6 GB buffer and failed; 4k overflowed.
  - `d1-runtime.js` now bounds batches by the score tensor (256 MiB, and never
    more than the adapter's storage-binding limit), caps text-only rows at
    2,048 tokens, runs tiled screenshots through the vision tower in crop
    groups under the same budget, and keeps screenshot features on the GPU
    between graphs.
  - The FP16 package stores the FP32 release's weights rounded once and
    computes in FP32. Against FP32 it agrees on 144/144 decisions with a
    largest probability difference of 0.010, on the CPU and on WebGPU.
  - Package checks for a re-export: `scripts/models/d1/convert_fp16.py`,
    `scripts/models/d1/parity-cpu.mjs` (the extension's runtime on
    onnxruntime-node, both packages, scored against the labels) and
    `scripts/models/d1/package_fp16.py`.
- **The chat model as a decision model** (`src/chrome/src/offscreen/webgpu-decisions.js`,
  `compass-vld-decision-probe.js`, `bonsai-decision-probe.js`). The model
  prefills the state and screenshots once and appends each question as a
  short continuation of that cache; nothing generates text. Compass VLD Tiny
  v5 answers agent decisions; Ternary Bonsai 2 2B Vision, the first chat
  model used this way, only answers diagnostic fixtures now.
  - The zero-shot readout (option-code token probabilities, the Perplexity
    decider's readout) follows the answer format but never says "unknown"
    for completion: it called 30 of 48 pending or failed views completed. A
    stricter prompt, chosen on the validation split, only reached 26/48.
  - The shipped mode asks about one option at a time ("Proposed answer: …
    Is the proposed answer correct?") and scores each option from its Yes
    margin and the decoder's last-position hidden state with a 2,049-parameter
    probe (`scripts/models/bonsai/train_decision_probe.py`). The backbone is
    frozen; the probe is trained on d1's train split and its regularization
    chosen on validation. The 2B decoder graph exposes that state as
    `decision_hidden` (`scripts/models/bonsai/add_decision_hidden.py`);
    logits and caches are unchanged.
  - Ternary is disabled as an agent decision provider. Real trace replays
    produced confident false failures; simplifying the question or using the
    raw token readout also produced confident false completions on wrong
    destinations and unsubmitted drafts. Its chat and screenshot reading
    remain available, and its diagnostic fixture path stays for comparison.
  - **Compass VLD Tiny v5** replaces it. Unlike Bonsai's frozen backbone, the
    model itself was fine-tuned on d1's train split in this protocol (the
    verify continuation above, among its chat and screenshot data), and the
    same 1,025-parameter probe shape reads its margins and
    `decision_hidden`; the probe's weights on the hidden state came out
    small, so the score is close to the scaled Yes margin. In Chrome, Auto
    uses it once it is downloaded, before a downloaded D1, for completion and
    scheduled checks, in place of Compass's managed route too; a saved On
    selection of the in-browser chat model uses it for every decision. Auto
    skips it while the task keeps another model in this worker (a WebGPU chat
    model other than v5, or the in-browser screenshot reader of a provider
    that cannot see images): the worker holds one model at a time, so each
    check would unload that model and the next turn would load it again. D1,
    in its own worker, answers those checks instead. A
    positive completion still needs independent proof, and the first decision
    after a browser restart, which loads the model, can exceed the judge's
    15-second deadline and fall back to the existing chain.
  - d1's test families are disjoint from its train families but come from
    the same generator, so the synthetic results below favour the models
    trained on that split (d1 and Compass VLD Tiny v5) and do not establish
    reliability on real browser tasks. Validate on real traces before relying
    on the margins.


Results on the held-out test, RTX 5090, through the extension:

| | d1 FP32, main | d1 FP16, new runtime | Bonsai 2B readout, no training | Bonsai 2B + probe | Compass VLD Tiny v5 + probe |
|---|---:|---:|---:|---:|---:|
| Categorical | 92/126 | 92/126 | 74/126 | 110/126 | 120/126 |
| Completion found | 22/24 | 22/24 | 24/24 | 21/24 | 24/24 |
| False completions | 1/48 | 1/48 | 30/48 | 4/48 | 0/48 |
| Unknown recognized | 23/24 | 23/24 | 0/24 | 20/24 | 24/24 |
| Other choice / yes-no | 10/36, 13/18 | 10/36, 13/18 | 18/36, 14/18 | 29/36, 16/18 | 33/36, 15/18 |
| Score MAE | 0.574 | 0.573 | 0.459 | 0.724 | 0.147 |
| Latency p50 / p95 (s per request) | 0.83 / 0.97 | 0.75 / 0.88 | 1.65 / 2.16 | 2.25 / 2.81 | 0.89 / 1.25 |
| 16 questions on 1k / 2k / 4k / 8k-token states | ok / fail / fail / fail | all ok | not run | not run | not run |

Compass VLD Tiny v5 was measured through extension 42.3.1 with this change
(`--engines compass-vld`, Q8 language model, FP16 vision encoder): its
first request, which loads the model, took 4.7 s, and the Providers test
through the judge, provider and worker passed with its two pixel facts in
2.0 s. A request's prefill (a median of about 500 tokens with the
screenshot) took about 0.38 s and its questions about 0.5 s.

- At DIV's 0.9 completion threshold d1 was the better completion
  verifier than Bonsai's probe (22 found, 1 false against 19 and 4); the
  probe is better on every other question type and better calibrated overall
  (test NLL 1.04 against 1.38). Score questions got worse with the probe (18
  test questions).
- All of these are synthetic, AI-labelled screens from one generator; the
  probe and d1 were trained on the same train split. Neither result
  establishes real-site quality.
- Bonsai's cost is the prefill (median 1.2 s; about 1.3 s for an
  1,100-token state with one screenshot) plus about 0.15 s per option.
- The 2B repository's decoder graph with `decision_hidden` is published
  (Hugging Face commit `b9895bc`, `decision-validation.json`). On the CPU its
  logits and caches are bit-identical to the previous graph
  (`scripts/models/bonsai/check_decision_hidden.py`). Installs that cached
  the previous graph keep it until the model is downloaded again on the
  Providers page;
  until then the provider reports that it needs the updated decoder.

## Updating a published graph

Prefer a new repository or file name for a changed graph. If a file must
change in place, as the Bonsai 2 Vision decoders did:

- Pin the new file's SHA-256 in the worker (`BONSAI2_DECODER_GRAPH_SHA256`).
- Inference only detects a stale cached graph and keeps using it.
- An explicit download or preload replaces just that file, verified by hash,
  with a 15 s deadline and no attempt while known offline. It then drops the
  resident session built from the old graph.
- Never block or break offline use to force an update.

## Diagnosing a slow or stuttering user machine

- In a normal tab, run
  `(await navigator.gpu.requestAdapter({powerPreference: 'high-performance'})).info`
  to see the adapter Chrome uses. On Windows, compare it with `nvidia-smi` or
  Task Manager.
- To move Chrome to another GPU on Windows, use Settings → System → Display →
  Graphics → Chrome, or start Chrome with `--use-adapter-luid=<high>,<low>`.
  Use **decimal** values: the hex form gave no adapter in Chromium 147. Find a
  LUID with PowerShell, matching adapters by dedicated memory use:
  `(Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples`.
- Stutter while the GPU is shared with the display is expected for long
  single passes. Lower `webgpuPrefillSliceTokens` (for example to 256) and keep
  prompts short.

## Open items

- The Bonsai 2 2B **text** preset still points at
  `danyalmalik/Ternary-Bonsai-2-2B-ONNX-WebGPU`, which fails the audit. Publish
  a rewritten text repository or point the preset at a passing graph.
- Selection shortcuts (context-menu "explain", "summarize" and similar) on
  in-browser models still use the full Ask system prompt, without tools.
- Compass VLD Tiny v5's decision results come from d1's synthetic test.
  Replay real traces, the evidence that disabled Ternary's decisions, before
  relying on its margins.
- The install guide no longer has D1's line, so its D1-first download path
  (`initializeD1Download` in `ui/install.js`, `providers/install-download-queue.js`)
  is unused; remove it or give the guide D1 back.
- Compass VLD Tiny v5's Q4 graphs (about 1.7 GB with the FP16 vision encoder, pinned in the runtime)
  could back a lighter preset for smaller GPUs; they have not been measured
  in the extension.
