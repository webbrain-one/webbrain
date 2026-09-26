import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { SparkSha256 } from '../src/chrome/src/offscreen/spark-sha256.js';
import { SPARK_MODEL_ID, SPARK_REVISION, SPARK_FILES, SPARK_CACHE, sparkFileUrl, sparkCacheReady, cacheSparkFiles, SparkRuntime } from '../src/chrome/src/offscreen/spark-runtime.js';
import { WebGPUProvider, WEBGPU_TEXT_UI_MODEL_IDS, WEBGPU_COMPASS_TINY_V2_MODEL_ID, webgpuModelPreset } from '../src/chrome/src/providers/webgpu.js';
import { parseToolCallsFromText } from '../src/chrome/src/agent/tool-call-parser.js';

test('streaming SHA-256 matches Node across block boundaries and million-byte input', () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1024, 1000000]) {
    const data = new Uint8Array(size).fill(97);
    for (const chunk of [1, 67, 8192]) {
      const hash = new SparkSha256();
      for (let i = 0; i < data.length; i += chunk) hash.update(data.subarray(i, i + chunk));
      assert.equal(hash.hex(), createHash('sha256').update(data).digest('hex'));
      assert.throws(() => hash.hex(), /finalized/);
    }
  }
});

function fakeCacheStorage() {
  const entries = new Map();
  const cache = {
    match: async url => entries.get(url)?.clone(),
    put: async (url, response) => {
      const bytes = await response.arrayBuffer();
      entries.set(url, new Response(bytes, { headers: response.headers }));
    },
    delete: async url => entries.delete(url),
  };
  return { entries, cache, open: async name => { assert.equal(name, SPARK_CACHE); return cache; } };
}
function seed(cache) {
  for (const file of SPARK_FILES) cache.entries.set(sparkFileUrl(file.path), new Response('', {
    headers: { 'x-webbrain-sha256': file.sha256, 'content-length': String(file.bytes) },
  }));
}

test('pinned readiness checks every required file, precision and no main revision', async () => {
  const cache = fakeCacheStorage();
  assert.equal(await sparkCacheReady(cache), false);
  seed(cache);
  assert.equal(await sparkCacheReady(cache), true);
  cache.entries.delete(sparkFileUrl('onnx/model_fp16.onnx_data'));
  assert.equal(await sparkCacheReady(cache), false);
  assert.match(sparkFileUrl('tokenizer.json'), new RegExp(SPARK_REVISION));
  assert.equal(webgpuModelPreset(SPARK_MODEL_ID).dtype, 'fp16');
  assert.equal(webgpuModelPreset(SPARK_MODEL_ID).contextWindow, 4096);
  assert.deepEqual(WEBGPU_TEXT_UI_MODEL_IDS, [WEBGPU_COMPASS_TINY_V2_MODEL_ID, SPARK_MODEL_ID]);
});

test('private downloads fail closed on 401 and truncated/corrupt bytes; credentials never in URLs', async () => {
  for (const mode of ['401', 'truncated', 'corrupt']) {
    const cache = fakeCacheStorage();
    const token = 'test-only-not-a-real-secret';
    const fetchFile = async (url, options) => {
      assert.equal(url, sparkFileUrl('tokenizer.json'));
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.ok(!url.includes(token));
      return mode === '401' ? new Response('', { status: 401 })
        : new Response(mode === 'corrupt' ? new Uint8Array(SPARK_FILES[0].bytes) : new Uint8Array(10));
    };
    await assert.rejects(cacheSparkFiles({ cacheStorage: cache, fetchFile, token }), mode === '401' ? /HTTP 401/ : /integrity/);
    assert.equal(cache.entries.size, 0);
  }
});

test('cached files are reused offline and cancellation cannot mark a package ready', async () => {
  const cache = fakeCacheStorage();
  seed(cache);
  await cacheSparkFiles({ cacheStorage: cache, fetchFile: () => { throw new Error('must remain offline'); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cacheSparkFiles({ cacheStorage: cache, signal: controller.signal }), /abort/i);
});

test('HF download credential goes only to start-download, defaults and context bounds remain safe', async () => {
  const provider = new WebGPUProvider({ model: SPARK_MODEL_ID, contextWindow: 32768, hfToken: 'test-secret' });
  assert.equal(provider.config.contextWindow, 4096);
  assert.equal(provider.maxOutputTokens, 2048);
  assert.equal(new WebGPUProvider({ model: SPARK_MODEL_ID, maxOutputTokens: 64 }).maxOutputTokens, 64);
  const requests = [];
  provider._dispatch = async payload => { requests.push(payload); return payload.type === 'webgpu-download-status' ? { ready: true } : { content: 'hello' }; };
  await provider.startDownload();
  await provider.chat([{ role: 'user', content: 'hello' }]);
  assert.equal(requests[0].hfToken, 'test-secret');
  assert.ok(requests.slice(1).every(request => !JSON.stringify(request).includes('test-secret')));
  const defaults = new WebGPUProvider();
  assert.equal(defaults.model, WEBGPU_COMPASS_TINY_V2_MODEL_ID);
  assert.equal(defaults.dtype, 'q4f16');
});

function mockedRuntime({ badLogits = false, failDecode = false } = {}) {
  const positions = [], disposed = [];
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims, location: 'cpu' }); }
    dispose() { disposed.push(this); }
  }
  const abi = { inputs: ['input_ids', 'position_ids', 'kv'], outputs: ['logits', 'present'], numKvHeads: 2, headDim: 256, vocabSize: 3 };
  const tokenizer = {
    apply_chat_template: (messages, options) => { assert.equal(options.enable_thinking, false); return messages[0].content; },
    encode: text => text === 'too long' ? Array(4096).fill(1) : [1, 2],
    decode: tokens => tokens.join(','),
  };
  const session = {
    release: async () => { session.released = true; },
    run: async feeds => {
      positions.push([...feeds.position_ids.data].map(Number));
      if (positions.length > 1 && failDecode) throw new Error('OrtRun device lost');
      const length = positions.at(-1).at(-1) + 1;
      const logits = new Tensor('float32', null, [1, 3]);
      logits.location = 'gpu-buffer';
      logits.getData = async () => new Float32Array(badLogits ? [NaN, 1, 0] : positions.length === 1 ? [0, 2, 0] : [0, 0, 2]);
      const present = new Tensor('float16', null, [1, 2, length, 256]); present.location = 'gpu-buffer';
      return { logits, present };
    },
  };
  return { runtime: new SparkRuntime({ Tensor }, tokenizer, abi, [2], session), session, positions, disposed };
}
test('native generation is greedy, preserves positional/cache order, stops on EOS and releases KV', async () => {
  const { runtime, positions, disposed, session } = mockedRuntime();
  const result = await runtime.generate([{ role: 'user', content: 'hello' }]);
  assert.equal(result.content, '1,2'); assert.equal(result.finishReason, 'stop');
  assert.deepEqual(positions, [[0, 1], [2]]);
  assert.equal(disposed.length, 4);
  await runtime.dispose(); assert.equal(session.released, true);
  await assert.rejects(runtime.generate([]), /disposed/);
});
test('overlong prompts and nonfinite/error outputs fail instead of repairing or falling back', async () => {
  const { runtime, positions } = mockedRuntime();
  await assert.rejects(runtime.generate([{ role: 'user', content: 'too long' }]), /4K/);
  assert.equal(positions.length, 0);
  await assert.rejects(mockedRuntime({ badLogits: true }).runtime.generate([{ role: 'user', content: 'hi' }]), /invalid logits/);
  await assert.rejects(mockedRuntime({ failDecode: true }).runtime.generate([{ role: 'user', content: 'hi' }]), /device lost/);
});
test('existing Spark native tool syntax stays on the normal allowlisted parser and permission path', () => {
  const text = '<tool_call>click_ax<arg_key>ref_id</arg_key><arg_value>ref_7</arg_value></tool_call>';
  const calls = parseToolCallsFromText(text, new Set(['click_ax']));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'click_ax');
  assert.equal(JSON.parse(calls[0].function.arguments).ref_id, 'ref_7');
  assert.equal(parseToolCallsFromText(text, new Set(['read_page'])).length, 0);
  assert.equal(parseToolCallsFromText(text.replace('</arg_value>', ''), new Set(['click_ax'])).length, 0);
});
test('Settings and Apocalypse both offer XS; worker uses a native graph, not AutoModel remapping', () => {
  const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const settings = read('src/chrome/src/ui/settings.js');
  const apocalypse = read('src/chrome/src/ui/apocalypse-mode.html');
  const worker = read('src/chrome/src/offscreen/inference-worker.js');
  assert.match(settings, /suggestions: WEBGPU_TEXT_UI_MODEL_IDS/);
  assert.ok(apocalypse.includes(`value="${SPARK_MODEL_ID}"`));
  assert.match(worker.slice(worker.indexOf('async function getTextRuntime')), /createSparkRuntime/);
  assert.match(worker, /runtime\.spark\.generate/);
  assert.match(read('src/chrome/src/profile-sync.js'), /NON_PORTABLE_PROVIDER_ID = 'webgpu'/);
});
