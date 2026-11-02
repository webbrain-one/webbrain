/**
 * WebBrain Compass VLD v6 2B in the offscreen WebGPU worker: one model for chat
 * and tool calls, screenshots and decisions, like Tiny v5 before it.
 *
 * The published ONNX bundle (webbrain-one/webbrain-compass-vld-v6-2b-onnx, a
 * fine-tune of LFM3-VLD-2B Multipass from Liquid's LFM3-VL-2B) has two graphs:
 *   vision_encoder  pixel_values float32[gh/2, gw/2, 2, 2, 1536] (16x16 patches,
 *                   grouped 2x2, each frame twice for the temporal patch)
 *                   -> image_features float32[gh*gw/4, 2048]. It computes its own
 *                   2-D positions from the grid.
 *   decoder         input_ids, attention_mask, 1-D position_ids, image_features
 *                   (written into the <|image|> rows by the graph), video_features,
 *                   logits_to_keep, and per layer either a conv state
 *                   (past_conv.N, fp16 [1, 2048, 7]) or a KV cache
 *                   (past_key_values.N.key/value, fp16 [1, 4, T, 128]).
 *                   Outputs last-position logits and decision_hidden.
 * Transformers.js has no LFM3-VL processor, so this module ports
 * Lfm3VlImageProcessor (image_processing_lfm3_vl.py): smart_resize to a
 * multiple of 32 within the pixel budget, the uint8 antialiased bicubic resize
 * (Pillow's integer pipeline, shared with Tiny v5), the fused normalization and
 * the patch order. Lfm3VlProcessor expands each <|image|> the template writes
 * into one token per merged 2x2 patch block.
 *
 * Files, downloads and the tokenizer come from compass-vld-runtime.js, which
 * serves both builds; the pins are in compass-vld-v6-files.js.
 */

import { COMPASS_VLD_V6_MODEL_ID } from './compass-vld-v6-files.js';
import { addedTokenContents, argmax, f16ToF32, plainTextFor, pyRound, resizeBicubicRGB } from './compass-vld-runtime.js';

export { COMPASS_VLD_V6_MODEL_ID };

export const COMPASS_VLD_V6 = Object.freeze({
  imageToken: '<|image|>',
  imageTokenId: 125030,
  visionStartId: 125009, // <|vision_start|>
  visionEndId: 125010, // <|vision_end|>
  hidden: 2048,
  patchSize: 16,
  mergeSize: 2,
  temporalPatchSize: 2,
  minPixels: 65536, // processor_config.json size.shortest_edge
  maxPixels: 16777216, // size.longest_edge
  // config.json text_config.layer_types: conv layers keep a conv state, the
  // attention layers (full and sliding window) a KV cache.
  layerTypes: Object.freeze([
    'conv', 'conv', 'full_attention', 'conv', 'sliding_attention', 'conv', 'full_attention', 'conv',
    'sliding_attention', 'conv', 'full_attention', 'conv', 'sliding_attention', 'conv', 'full_attention', 'conv',
    'sliding_attention', 'conv', 'full_attention', 'conv', 'sliding_attention', 'conv', 'full_attention', 'conv',
  ]),
  convState: Object.freeze([2048, 7]),
  kvHeads: 4,
  headDim: 128,
  eosTokenIds: Object.freeze([124900]), // <|im_end|>
});

// ---------------------------------------------------------------- processor

/** Lfm3Vl's smart_resize: [height, width], both multiples of `factor`, within the pixel budget. */
export function smartResize(height, width, {
  factor = COMPASS_VLD_V6.patchSize * COMPASS_VLD_V6.mergeSize,
  minPixels = COMPASS_VLD_V6.minPixels,
  maxPixels = COMPASS_VLD_V6.maxPixels,
} = {}) {
  if (Math.max(height, width) / Math.min(height, width) > 200) {
    throw new Error(`The image's aspect ratio must be under 200 (got ${(Math.max(height, width) / Math.min(height, width)).toFixed(1)}).`);
  }
  let hBar = pyRound(height / factor) * factor;
  let wBar = pyRound(width / factor) * factor;
  if (hBar * wBar > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    hBar = Math.max(factor, Math.floor(height / beta / factor) * factor);
    wBar = Math.max(factor, Math.floor(width / beta / factor) * factor);
  } else if (hBar * wBar < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    hBar = Math.ceil((height * beta) / factor) * factor;
    wBar = Math.ceil((width * beta) / factor) * factor;
  }
  return [hBar, wBar];
}

// Transformers fuses rescale (1/255) and normalize (mean = std = 0.5) into (x - 127.5) / 127.5 in float32.
const NORM_LUT = (() => {
  const table = new Float32Array(256);
  for (let x = 0; x < 256; x++) table[x] = Math.fround((x - 127.5) / 127.5);
  return table;
})();

/**
 * Lfm3VlImageProcessor for one image of interleaved RGB pixels: the patches in
 * the vision encoder's layout [gh/2, gw/2, 2, 2, C*T*P*P] and the number of
 * image tokens the prompt needs for them.
 */
export function preprocessImage(rgb, width, height, cfg = COMPASS_VLD_V6) {
  const P = cfg.patchSize, M = cfg.mergeSize, T = cfg.temporalPatchSize;
  const [rh, rw] = smartResize(height, width, { factor: P * M, minPixels: cfg.minPixels, maxPixels: cfg.maxPixels });
  const pixels8 = rw === width && rh === height ? rgb : resizeBicubicRGB(rgb, width, height, rw, rh);
  const gh = rh / P, gw = rw / P;
  const D = 3 * T * P * P;
  const out = new Float32Array(gh * gw * D);
  const bw = gw / M;
  for (let by = 0; by < gh / M; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let my = 0; my < M; my++) {
        for (let mx = 0; mx < M; mx++) {
          const base = (((by * bw + bx) * M + my) * M + mx) * D;
          const y0 = (by * M + my) * P, x0 = (bx * M + mx) * P;
          for (let c = 0; c < 3; c++) {
            for (let py = 0; py < P; py++) {
              const row = ((y0 + py) * rw + x0) * 3 + c;
              for (let px = 0; px < P; px++) {
                const value = NORM_LUT[pixels8[row + px * 3]];
                // The frame is repeated for each temporal step.
                for (let t = 0; t < T; t++) out[base + ((c * T + t) * P + py) * P + px] = value;
              }
            }
          }
        }
      }
    }
  }
  return { width: rw, height: rh, gridH: gh, gridW: gw, tokens: (gh * gw) / (M * M), pixels: out };
}

/** Replace each `<|image|>` the chat template wrote with one token per merged patch block. */
export function expandImagePlaceholders(prompt, images, cfg = COMPASS_VLD_V6) {
  const parts = String(prompt).split(cfg.imageToken);
  if (parts.length - 1 !== images.length) {
    throw new Error(`The prompt has ${parts.length - 1} image slots for ${images.length} images.`);
  }
  let out = parts[0];
  for (let i = 0; i < images.length; i++) out += cfg.imageToken.repeat(images[i].tokens) + parts[i + 1];
  return out;
}

// ---------------------------------------------------------------- ORT runtime

export class CompassVldV6Runtime {
  /**
   * @param ort       onnxruntime-web (the WebGPU build Transformers.js uses)
   * @param tokenizer a Transformers.js tokenizer for this model
   * @param sessions  { vision_encoder, decoder }
   */
  constructor(ort, tokenizer, sessions, cfg = COMPASS_VLD_V6) {
    this.ort = ort;
    this.tokenizer = tokenizer;
    this.vision = sessions.vision_encoder;
    this.decoder = sessions.decoder;
    this.cfg = cfg;
    this.plainText = plainTextFor(addedTokenContents(tokenizer));
  }

  /** A copy of messages or tools with every string passed through plainText. */
  plainStrings(value) {
    if (typeof value === 'string') return this.plainText(value);
    if (Array.isArray(value)) return value.map(item => this.plainStrings(item));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.plainStrings(item)]));
    }
    return value;
  }

  async dispose() {
    for (const session of [this.vision, this.decoder]) {
      try { await session?.release?.(); } catch { /* already released */ }
    }
    this.vision = this.decoder = null;
  }

  tensor(type, data, dims) {
    return new this.ort.Tensor(type, data, dims);
  }

  encode(text) {
    return Array.from(this.tokenizer.encode(text, { add_special_tokens: false }));
  }

  /** The processor for one decoded image (interleaved RGB). */
  preprocess(rgb, width, height) {
    return preprocessImage(rgb, width, height, this.cfg);
  }

  async read(tensor) {
    const data = tensor.location === 'gpu-buffer' ? await tensor.getData() : tensor.data;
    return data instanceof Uint16Array ? f16ToF32(data) : (data instanceof Float32Array ? data : Float32Array.from(data));
  }

  /** Vision features for one preprocessed image: tokens x hidden, in prompt order. */
  async encodeImage(image) {
    const M = this.cfg.mergeSize;
    const D = 3 * this.cfg.temporalPatchSize * this.cfg.patchSize * this.cfg.patchSize;
    const out = await this.vision.run({
      pixel_values: this.tensor('float32', image.pixels, [image.gridH / M, image.gridW / M, M, M, D]),
    });
    try {
      const features = await this.read(out.image_features);
      if (features.length !== image.tokens * this.cfg.hidden) {
        throw new Error(`The vision encoder returned ${features.length / this.cfg.hidden} features for ${image.tokens} image tokens.`);
      }
      return features;
    } finally {
      out.image_features?.dispose?.();
    }
  }

  /** Prompt inputs: token ids and every image's features, in prompt order. */
  async buildInputs(promptText, images = [], { beforeImage = null } = {}) {
    const text = images.length ? expandImagePlaceholders(promptText, images, this.cfg) : promptText;
    const ids = this.encode(text);
    // Message text must reach here through plainText; an image token it spelled
    // would otherwise be taken for an image patch.
    const expected = images.reduce((sum, image) => sum + image.tokens, 0);
    const found = ids.reduce((sum, id) => sum + (id === this.cfg.imageTokenId ? 1 : 0), 0);
    if (found !== expected) throw new Error(`The prompt has ${found} image tokens for ${expected} image patches.`);
    const features = new Float32Array(expected * this.cfg.hidden);
    let offset = 0;
    for (const image of images) {
      beforeImage?.();
      const rows = await this.encodeImage(image);
      features.set(rows, offset);
      offset += rows.length;
    }
    return { ids, features, imageTokens: expected };
  }

  /** The decoder's empty state: zero conv states and empty KV caches. */
  emptyCache() {
    const feeds = {};
    const [channels, kernel] = this.cfg.convState;
    const names = Array.isArray(this.decoder?.inputNames) && this.decoder.inputNames.length
      ? this.decoder.inputNames
      : this.cfg.layerTypes.flatMap((type, i) => (type === 'conv' ? [`past_conv.${i}`] : [`past_key_values.${i}.key`, `past_key_values.${i}.value`]));
    for (const name of names) {
      if (name.startsWith('past_conv.')) {
        feeds[name] = this.tensor('float16', new Uint16Array(channels * kernel), [1, channels, kernel]);
      } else if (name.startsWith('past_key_values.')) {
        feeds[name] = this.tensor('float16', new Uint16Array(0), [1, this.cfg.kvHeads, 0, this.cfg.headDim]);
      }
    }
    return { feeds, length: 0 };
  }

  static disposeCache(cache) {
    for (const tensor of Object.values(cache?.feeds || {})) tensor?.dispose?.();
  }

  /**
   * One decoder pass over `ids` continuing `cache`. `features` holds the image
   * features for the image tokens among these ids, in order (empty when none).
   * Returns the last-position logits (and decision_hidden when asked) and the
   * new cache; with `keepCache: false` the new cache is released and the given
   * one stays usable (continuations of a shared prefix).
   */
  async forward(ids, cache, features = null, { keepCache = true, wantHidden = false } = {}) {
    const n = ids.length, H = this.cfg.hidden;
    const total = cache.length + n;
    const positions = new BigInt64Array(n);
    for (let i = 0; i < n; i++) positions[i] = BigInt(cache.length + i);
    const rows = features ? features.length / H : 0;
    const out = await this.decoder.run({
      ...cache.feeds,
      input_ids: this.tensor('int64', BigInt64Array.from(ids, BigInt), [1, n]),
      attention_mask: this.tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
      position_ids: this.tensor('int64', positions, [1, n]),
      image_features: this.tensor('float32', rows ? features : new Float32Array(0), [rows, H]),
      video_features: this.tensor('float32', new Float32Array(0), [0, H]),
      logits_to_keep: this.tensor('int64', BigInt64Array.of(1n), [1]),
    });
    const present = Object.entries(out).filter(([name]) => name.startsWith('present'));
    let kept = false;
    try {
      const logits = await this.read(out.logits);
      const hidden = wantHidden && out.decision_hidden ? await this.read(out.decision_hidden) : null;
      const next = { feeds: {}, length: total };
      if (keepCache) {
        for (const [name, tensor] of present) {
          next.feeds[name.replace('present_conv.', 'past_conv.').replace(/^present\./, 'past_key_values.')] = tensor;
        }
        kept = true;
      }
      return { logits, hidden, cache: next };
    } finally {
      out.logits?.dispose?.();
      out.decision_hidden?.dispose?.();
      // The new cache is released unless it was handed back, also when a read failed.
      if (!kept) for (const [, tensor] of present) tensor.dispose?.();
    }
  }

  /**
   * Prefill prompt tokens [0, count) in slices of `sliceTokens` (one pass when
   * 0), each continuing the previous slice's cache and taking the features of
   * the image tokens it holds. `beforeSlice` may throw to stop. Returns the
   * last slice's outputs and the cache.
   */
  async prefill(inputs, { count = inputs.ids.length, sliceTokens = 0, wantHidden = false, beforeSlice = null } = {}) {
    const H = this.cfg.hidden;
    const step = sliceTokens > 0 ? sliceTokens : count;
    let cache = this.emptyCache();
    let result = null;
    let featureRow = 0;
    try {
      for (let start = 0; start < count; start += step) {
        beforeSlice?.();
        const end = Math.min(start + step, count);
        const ids = inputs.ids.slice(start, end);
        const rows = ids.reduce((sum, id) => sum + (id === this.cfg.imageTokenId ? 1 : 0), 0);
        const features = rows ? inputs.features.subarray(featureRow * H, (featureRow + rows) * H) : null;
        featureRow += rows;
        result = await this.forward(ids, cache, features, { wantHidden: wantHidden && end === count });
        CompassVldV6Runtime.disposeCache(cache);
        cache = result.cache;
      }
      return { logits: result?.logits || null, hidden: result?.hidden || null, cache };
    } catch (error) {
      CompassVldV6Runtime.disposeCache(cache);
      throw error;
    }
  }

  /**
   * Greedy generation from a rendered chat prompt (each image as one
   * `<|image|>`). `shouldStop` is checked before every pass and may throw.
   */
  async generate(promptText, images = [], { maxNewTokens = 256, sliceTokens = 0, stopIds = this.cfg.eosTokenIds, shouldStop = null } = {}) {
    const inputs = await this.buildInputs(promptText, images, { beforeImage: shouldStop });
    let { logits, cache } = await this.prefill(inputs, { sliceTokens, beforeSlice: shouldStop });
    const ids = [];
    let finished = false;
    try {
      for (let step = 0; step < maxNewTokens; step++) {
        const token = argmax(logits);
        if (stopIds.includes(token)) { finished = true; break; }
        ids.push(token);
        if (ids.length >= maxNewTokens) break;
        shouldStop?.();
        const result = await this.forward([token], cache);
        CompassVldV6Runtime.disposeCache(cache);
        ({ logits, cache } = result);
      }
    } finally {
      CompassVldV6Runtime.disposeCache(cache);
    }
    return { ids, promptTokens: inputs.ids.length, finished };
  }

  /** Logits (and decision_hidden) after appending `text` to a prefilled prefix, leaving the prefix cache as it was. */
  async continuation(prefix, prefixCache, text) {
    const suffix = this.encode(text);
    if (suffix.includes(this.cfg.imageTokenId)) throw new Error('The continuation text has an image token; pass it through plainText.');
    const out = await this.forward(suffix, prefixCache, null, { keepCache: false, wantHidden: true });
    return { logits: out.logits, hidden: out.hidden, tokens: suffix.length };
  }
}
