import { SparkSha256 } from './spark-sha256.js';

export const SPARK_MODEL_ID = 'webbrain-one/webbrain-compass-tiny-xs-v3-onnx';
export const SPARK_REVISION = '67a2d019a1a713753b692826767269384e9e9b10';
export const SPARK_CONTEXT = 4096;
export const SPARK_CACHE = `transformers-spark-xs-v3-${SPARK_REVISION}`;
// Only data files are downloaded. Executable code always comes from the
// extension, using the same ORT 1.27 / Transformers.js 4.2 as the tested bundle.
export const SPARK_FILES = Object.freeze([
  ['tokenizer.json', 10115785, 'f71f91ee1b2ac0b27e47bf49ee4859d322ab3d191217ec9964d0189b02454c49'],
  ['tokenizer_config.json', 402, 'cf3dc83b97ec9c1d553a5e06045b8a5b627d4554018fa1abad5de95bc767a905'],
  ['chat_template.jinja', 4758, 'f9ace5b72165a4d2abb486b73f07b279cbe38bf9e70e66500c095b270966d24f'],
  ['generation_config.json', 296, '5b77f2b5603cd2e3950df71bce8a6d1493ad97e7b6cfbba171eade2e9503224c'],
  ['graph-abi.json', 3544, 'a3f88b1dca10b26478b0b83afaefbe5c984f5af475f916af24cf411224572980'],
  ['onnx/model_fp16.onnx', 1454092, '7b3095d0b51cc8aecc0aea0eb82869efa16039d358548e61fc461b5622a73819'],
  ['onnx/model_fp16.onnx_data', 3952418816, '9abbd8c7e69fbdb9bb4fe6244c30b66a397a4f237dbfc75e95dd11062db3acdc'],
].map(([path, bytes, sha256]) => Object.freeze({ path, bytes, sha256 })));
export const sparkFileUrl = path => `https://huggingface.co/${SPARK_MODEL_ID}/resolve/${SPARK_REVISION}/${path}`;

export async function sparkCacheReady(cacheStorage = globalThis.caches) {
  if (!cacheStorage) return false;
  const cache = await cacheStorage.open(SPARK_CACHE);
  for (const file of SPARK_FILES) {
    const response = await cache.match(sparkFileUrl(file.path));
    if (response?.headers.get('x-webbrain-sha256') !== file.sha256
        || response.headers.get('content-length') !== String(file.bytes)) return false;
  }
  return true;
}

export async function cacheSparkFiles({ token = '', signal, progress = () => {}, fetchFile = globalThis.fetch, cacheStorage = globalThis.caches } = {}) {
  if (!cacheStorage) throw new Error('Browser Cache Storage is required for Tiny XS v3.');
  const cache = await cacheStorage.open(SPARK_CACHE);
  for (const file of SPARK_FILES) progress({ status: 'initiate', file: file.path, loaded: 0, total: file.bytes });
  for (const file of SPARK_FILES) {
    signal?.throwIfAborted();
    const url = sparkFileUrl(file.path);
    const cached = await cache.match(url);
    if (cached?.headers.get('x-webbrain-sha256') === file.sha256
        && cached.headers.get('content-length') === String(file.bytes)) {
      progress({ status: 'done', file: file.path, loaded: file.bytes, total: file.bytes });
      continue;
    }
    progress({ status: 'initiate', file: file.path, loaded: 0, total: file.bytes });
    // Browser fetch strips Authorization on cross-origin HF storage redirects.
    // Never send this credential to a configurable endpoint or in a URL.
    const response = await fetchFile(url, {
      credentials: 'omit', signal,
      headers: token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {},
    });
    if (!response.ok || !response.body) {
      throw new Error(`Tiny XS v3 download failed (HTTP ${response.status}). For this private repo, save an authorized HF read token in Settings > Providers > WebGPU.`);
    }
    const hash = new SparkSha256();
    let loaded = 0;
    let lastProgressAt = 0;
    const verifiedStream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        signal?.throwIfAborted();
        loaded += chunk.byteLength;
        if (loaded > file.bytes) throw new Error(`Unexpected size for ${file.path}.`);
        hash.update(chunk);
        const now = Date.now();
        if (loaded === file.bytes || now - lastProgressAt >= 150) {
          progress({ status: 'progress', file: file.path, loaded, total: file.bytes, progress: loaded / file.bytes * 100 });
          lastProgressAt = now;
        }
        controller.enqueue(chunk);
      },
      flush() {
        signal?.throwIfAborted();
        if (loaded !== file.bytes || hash.hex() !== file.sha256) throw new Error(`Tiny XS v3 integrity check failed for ${file.path}.`);
      },
    }));
    try {
      await cache.put(url, new Response(verifiedStream, { headers: {
        'content-length': String(file.bytes), 'x-webbrain-sha256': file.sha256,
        'content-type': file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      } }));
      signal?.throwIfAborted();
    } catch (error) {
      await cache.delete(url);
      throw error;
    }
    progress({ status: 'done', file: file.path, loaded, total: file.bytes });
  }
}

function disposeTensors(tensors) {
  for (const tensor of tensors || []) {
    if (tensor?.location === 'gpu-buffer') { try { tensor.dispose(); } catch {} }
  }
}

export class SparkRuntime {
  constructor(ort, tokenizer, abi, eos, session) {
    this.ort = ort;
    this.tokenizer = tokenizer;
    this.abi = abi;
    this.eos = new Set(eos);
    this.session = session;
  }
  async dispose() {
    const session = this.session;
    this.session = null;
    if (session) await session.release();
  }
  async step(ids, past, seen) {
    const feeds = {
      input_ids: new this.ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      position_ids: new this.ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(seen + i))), [1, ids.length]),
    };
    this.abi.inputs.slice(2).forEach((name, i) => { feeds[name] = past[i]; });
    let outputs;
    let success = false;
    try {
      outputs = await this.session.run(feeds);
      const logits = await outputs.logits.getData();
      if (logits.length !== this.abi.vocabSize || !logits.every(Number.isFinite)) throw new Error('Tiny XS v3 returned invalid logits.');
      const next = this.abi.outputs.slice(1).map(name => outputs[name]);
      if (next.some(t => t?.dims?.[2] !== seen + ids.length)) throw new Error('Tiny XS v3 KV-cache shape mismatch.');
      outputs.logits.dispose();
      success = true;
      return { logits, past: next };
    } finally {
      disposeTensors(past);
      if (!success && outputs) disposeTensors(Object.values(outputs));
    }
  }
  async generate(messages, { tools = [], maxTokens = 512 } = {}) {
    if (!this.session) throw new Error('Tiny XS v3 runtime has been disposed.');
    const prompt = this.tokenizer.apply_chat_template(messages, {
      tools, tokenize: false, add_generation_prompt: true, enable_thinking: false,
    });
    const ids = this.tokenizer.encode(prompt, { add_special_tokens: false });
    if (!ids.length || ids.length >= SPARK_CONTEXT) throw new Error('Tiny XS v3 prompt exceeds its 4K context; shorten the conversation.');
    // Reserve no more than the remaining context; never truncate input/evidence.
    const budget = Math.min(2048, Math.max(1, Math.floor(Number(maxTokens) || 512)), SPARK_CONTEXT - ids.length);
    let past = this.abi.inputs.slice(2).map(() => new this.ort.Tensor('float16', new Uint16Array(0), [1, this.abi.numKvHeads, 0, this.abi.headDim]));
    const tokens = [];
    let seen = ids.length;
    let result;
    let finishReason = 'length';
    try {
      result = await this.step(ids, past, 0);
      past = result.past;
      for (let i = 0; i < budget; i++) {
        let token = 0;
        for (let j = 1; j < result.logits.length; j++) if (result.logits[j] > result.logits[token]) token = j;
        tokens.push(token);
        if (this.eos.has(token)) { finishReason = 'stop'; break; }
        if (i + 1 < budget) {
          result = await this.step([token], past, seen++);
          past = result.past;
        }
      }
      return {
        content: this.tokenizer.decode(tokens, { skip_special_tokens: true }),
        usage: { promptTokens: ids.length, completionTokens: tokens.length },
        finishReason,
      };
    } finally { disposeTensors(past); }
  }
}

export async function createSparkRuntime({ library, ort, wasmPaths, cacheStorage = globalThis.caches, adapter } = {}) {
  if (!await sparkCacheReady(cacheStorage)) throw new Error('Tiny XS v3 pinned package is not completely cached. Download it first.');
  adapter ||= await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter?.features.has('shader-f16')) throw new Error('Tiny XS v3 requires WebGPU shader-f16 support.');
  ort.env.webgpu.adapter = adapter;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = wasmPaths;
  const cache = await cacheStorage.open(SPARK_CACHE);
  const read = async path => (await cache.match(sparkFileUrl(path)));
  const tokenizer = new library.PreTrainedTokenizer(await (await read('tokenizer.json')).json(), await (await read('tokenizer_config.json')).json());
  tokenizer.chat_template = (await (await read('chat_template.jinja')).text()).replace(/\r\n?/g, '\n');
  const abi = await (await read('graph-abi.json')).json();
  if (abi.numLayers !== 28 || abi.inputs.length !== 58 || abi.outputs.length !== 57 || abi.deploymentContextTokens !== SPARK_CONTEXT) throw new Error('Tiny XS v3 graph ABI mismatch.');
  const generation = await (await read('generation_config.json')).json();
  const eos = Array.isArray(generation.eos_token_id) ? generation.eos_token_id : [generation.eos_token_id];
  // ORT reads the external-data URL while creating the session. Keep these
  // object URLs alive until that work completes, then release their backing blobs.
  const graphUrl = URL.createObjectURL(await (await read('onnx/model_fp16.onnx')).blob());
  const dataUrl = URL.createObjectURL(await (await read('onnx/model_fp16.onnx_data')).blob());
  try {
    const session = await ort.InferenceSession.create(graphUrl, {
      executionProviders: ['webgpu'], graphOptimizationLevel: 'disabled',
      preferredOutputLocation: 'gpu-buffer',
      externalData: [{ path: 'model_fp16.onnx_data', data: dataUrl }],
    });
    if (session.inputNames.length !== abi.inputs.length ||
        session.outputNames.length !== abi.outputs.length ||
        session.inputNames.some((name, index) => name !== abi.inputs[index]) ||
        session.outputNames.some((name, index) => name !== abi.outputs[index])) {
      await session.release();
      throw new Error('Tiny XS v3 graph ABI tensor ordering mismatch.');
    }
    return new SparkRuntime(ort, tokenizer, abi, eos, session);
  } finally {
    URL.revokeObjectURL(graphUrl);
    URL.revokeObjectURL(dataUrl);
  }
}
