import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

// Videos longer than one clip: generate_image fits scenes to the model's clip
// lengths, generates the clips, and joins them into one MP4 without
// re-encoding. Over two minutes it asks the user first (video-length-cap).

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) } };

// The generated media store's IndexedDB calls, kept in memory: Node has no
// IndexedDB. Other databases never open.
const assets = new Map();
globalThis.indexedDB = {
  open(name) {
    const request = {};
    if (name !== 'webbrain_generated_media') return request;
    request.result = {
      close() {},
      transaction() {
        const transaction = {
          objectStore: () => ({
            put(record) { assets.set(record.id, record); setTimeout(() => transaction.oncomplete?.()); },
            get(id) { const read = {}; setTimeout(() => { read.result = assets.get(id); read.onsuccess?.(); }); return read; },
          }),
        };
        return transaction;
      },
    };
    setTimeout(() => request.onsuccess?.());
    return request;
  },
};
const storedBytes = async mediaId => new Uint8Array(await assets.get(mediaId).blob.arrayBuffer());

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
// The mock jobs ask to be polled again at once.
const soon = { 'Retry-After': '0.001' };
const fixtures = Object.fromEntries(await Promise.all([
  'h264-aac-1', 'h264-aac-2', 'h264-aac-48px', 'h264-aac-fragmented-1', 'h264-aac-fragmented-2', 'vp9-opus-1', 'vp9-opus-2',
  'h264-aac-short-audio', 'h264-aac-late-audio', 'vp9-opus-late-audio',
].map(async name => [name, new Uint8Array(await fs.readFile(new URL(`./fixtures/video/${name}.mp4`, import.meta.url)))])));
const { createFile, MP4BoxBuffer } = await import('../src/chrome/vendor/mp4box/mp4box.all.mjs');

function parse(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const file = createFile();
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
  file.flush();
  return file;
}

const sampleBytes = (bytes, trak) => trak.samples.map(sample => bytes.subarray(sample.offset, sample.offset + sample.size));
const boxBytes = (bytes, box) => bytes.subarray(box.start, box.start + box.size);

const videoOf = file => file.moov.traks[0];
const audioOf = file => file.moov.traks[1];

// A fixture with some of its bytes rewritten: `edit(view, file)` gets a view of
// the copy and the parsed original.
function patched(name, edit) {
  const copy = fixtures[name].slice();
  edit(new DataView(copy.buffer), parse(fixtures[name]));
  return copy;
}

// A fragmented clip whose fragments start later: each track's decode times
// moved by `seconds` ({ vide, soun }).
function laterFragments(bytes, seconds) {
  const file = parse(bytes);
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const traks = new Map(file.moov.traks.map(trak => [trak.tkhd.track_id, trak]));
  for (const traf of file.moofs.flatMap(moof => moof.trafs)) {
    const trak = traks.get(traf.tfhd.track_id);
    const add = Math.round((seconds[trak.mdia.hdlr.handler] || 0) * trak.mdia.mdhd.timescale);
    if (traf.tfdt.version === 1) view.setBigUint64(traf.tfdt.start + 12, BigInt(traf.tfdt.baseMediaDecodeTime + add));
    else view.setUint32(traf.tfdt.start + 12, traf.tfdt.baseMediaDecodeTime + add);
  }
  return copy;
}

// Where a track's samples are shown on the movie's timeline, in seconds: its
// edit names the first media time shown.
function shown(file, trak) {
  const timescale = trak.mdia.mdhd.timescale;
  const start = trak.edts?.elst?.entries?.[0]?.media_time ?? 0;
  return {
    from: (Math.min(...trak.samples.map(sample => sample.cts)) - start) / timescale,
    to: (Math.max(...trak.samples.map(sample => sample.cts + sample.duration)) - start) / timescale,
    movie: file.moov.mvhd.duration / file.moov.mvhd.timescale,
  };
}

// OpenRouter's video API: a catalog entry, jobs that complete on the first
// poll, and clip bytes chosen per job. `fail` refuses a submission: true for
// an overloaded provider (503), or the HTTP status to answer with.
function videoApi({ entry, clip = () => fixtures['h264-aac-1'], fail = () => false }) {
  const calls = { submits: [], inFlight: 0, maxInFlight: 0 };
  const jobs = new Map();
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/images/models')) return json({ data: [] });
    if (url.endsWith('/videos/models')) return json({ data: [entry] });
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      const index = calls.submits.push(body) - 1;
      const failure = fail(index, body);
      if (failure === 402) return json({ error: { message: 'HTTP 402: insufficient balance (1008)', code: 402 } }, 402);
      if (failure) return json({ error: { message: 'Provider overloaded' } }, 503);
      const id = `job-${index}`;
      jobs.set(id, { body, index });
      calls.inFlight += 1;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      return json({ id }, 202, soon);
    }
    const match = /\/videos\/(job-\d+)(\/content)?/.exec(url);
    assert.ok(match, url);
    if (!match[2]) return json({ status: 'completed' }, 200, soon);
    await new Promise(done => setTimeout(done, 5));
    calls.inFlight -= 1;
    return new Response(clip(jobs.get(match[1])), { headers: { 'Content-Type': 'video/mp4' } });
  };
  return { fetchImpl, calls };
}

// The OpenAPI document fal.ai publishes for a model, as its model listing
// returns it: the request body behind a $ref.
const falSchema = input => ({
  openapi: '3.0.4',
  paths: {
    '/model/requests/{request_id}/status': { get: {} },
    '/model': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } } } },
  },
  components: { schemas: { Input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, ...input } } } },
});
// MiniMax H3 Max on fal.ai: any length up to 15 s; resolutions in capitals.
const h3Max = { id: 'minimax/h3-max/text-to-video', schema: falSchema({
  duration: { type: 'number', minimum: 0.92, maximum: 15, default: 5 },
  aspect_ratio: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
  resolution: { type: 'string', enum: ['480P', '768P', '1080P'] },
}) };
// Hailuo 02 on fal.ai: clips of 6 or 10 s, given as text.
const hailuo = { id: 'fal-ai/minimax/hailuo-02/standard/text-to-video', schema: falSchema({ duration: { type: 'string', enum: ['6', '10'], default: '6' } }) };
const falConfig = (model, settings = {}) => ({ provider: 'fal', apiKey: 'fal-key', model: 'fal-ai/flux/schnell', videoModel: model.id, ...settings });

// fal.ai: the model's schema (`schema`: a document, null when fal.ai has
// none for it, or the HTTP status of the read), a queue whose jobs complete on
// the first poll, and hosted clips. `fail` refuses a submission: true for an
// overloaded provider (503), or the HTTP status to answer with.
function falApi({ model, schema, clip = () => fixtures['h264-aac-1'], fail = () => false }) {
  const calls = { schemas: 0, submits: [], downloads: [], cancels: [] };
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('https://fal.ai/api/openapi/queue/openapi.json?')) {
      assert.equal(init.headers?.Authorization, undefined);
      assert.equal(init.credentials, 'omit');
      assert.equal(new URL(url).searchParams.get('endpoint_id'), model);
      return json({ error: 'No public schema in this fixture' }, 404);
    }
    if (url.startsWith('https://v3b.fal.media/')) {
      // A hosted clip is downloaded without the key.
      assert.equal(init.headers, undefined);
      assert.equal(init.credentials, 'omit');
      const index = Number(/clip-(\d+)\.mp4$/.exec(url)[1]);
      calls.downloads.push(index);
      return new Response(clip(index, calls.submits[index]), { headers: { 'Content-Type': 'video/mp4' } });
    }
    assert.equal(init.headers?.Authorization, 'Key fal-key');
    if (init.method === 'PUT') { calls.cancels.push(url); return json({}); }
    assert.equal(init.redirect, 'error');
    if (url.startsWith('https://api.fal.ai/v1/models?')) {
      calls.schemas += 1;
      const query = new URL(url).searchParams;
      assert.deepEqual([query.get('endpoint_id'), query.get('expand')], [model, 'openapi-3.0']);
      if (typeof schema === 'number') return json({ error: { type: 'not_found', message: 'Endpoint(s) not found' } }, schema);
      return json({ models: [{ endpoint_id: model, openapi: schema ?? { error: { code: 'expansion_failed' } } }] });
    }
    if (init.method === 'POST') {
      assert.equal(url, `https://queue.fal.run/${model}`);
      const body = JSON.parse(init.body);
      const index = calls.submits.push(body) - 1;
      const failure = fail(index, body);
      if (failure) return json({ detail: failure === 402 ? 'Exhausted balance' : 'Overloaded' }, failure === true ? 503 : failure);
      const job = `https://queue.fal.run/${model}/requests/req-${index}`;
      return json({ request_id: `req-${index}`, status_url: `${job}/status`, response_url: job, cancel_url: `${job}/cancel` });
    }
    const [, index, status] = /\/requests\/req-(\d+)(\/status)?$/.exec(url);
    return status ? json({ status: 'COMPLETED' }) : json({ video: { url: `https://v3b.fal.media/files/b/clip-${index}.mp4` } });
  };
  return { fetchImpl, calls };
}

// Luma Ray 2 on Comfy Router: the body schema inline, its lengths "5s" and "9s".
const rayTwo = { id: 'luma/ray-2', schema: {
  openapi: '3.0.2',
  paths: { '/v2/models/luma/ray-2': { post: { requestBody: { content: { 'application/json': { schema: {
    type: 'object', required: ['prompt'],
    properties: {
      prompt: { type: 'string' }, model: { type: 'string' }, loop: { type: 'boolean' }, duration: { $ref: '#/components/schemas/Duration' },
      resolution: { anyOf: [{ type: 'string', enum: ['540p', '720p', '1080p', '4k'] }, { type: 'string' }] }, aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] },
    },
  } } } } } } },
  components: { schemas: { Duration: { anyOf: [{ type: 'string', enum: ['5s', '9s'] }, { type: 'string' }] } } },
} };

// Comfy Router: the model's schema (a document, or the HTTP status of the
// read), queued requests that complete on the first poll, and hosted clips.
function comfyRouterApi({ model, schema, clip = () => fixtures['h264-aac-1'], fail = () => false }) {
  const calls = { schemas: 0, submits: [], downloads: [], cancels: [] };
  const base = `https://api.comfy.org/v2/models/${model}`;
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('https://storage.comfy.example/')) {
      assert.equal(init.headers, undefined);
      assert.equal(init.credentials, 'omit');
      const index = Number(/clip-(\d+)\.mp4$/.exec(url)[1]);
      calls.downloads.push(index);
      return new Response(clip(index, calls.submits[index]), { headers: { 'Content-Type': 'video/mp4' } });
    }
    assert.equal(init.headers?.['X-API-Key'], 'comfy-key');
    assert.equal(init.redirect, 'error');
    if (url === `${base}/openapi.json`) {
      calls.schemas += 1;
      return typeof schema === 'number' ? json({ detail: 'No schema', error_type: 'model_not_found' }, schema) : json(schema);
    }
    if (init.method === 'PUT') { calls.cancels.push(url); return json({}); }
    if (init.method === 'POST') {
      assert.equal(url, `${base}/requests`);
      const body = JSON.parse(init.body);
      const index = calls.submits.push(body) - 1;
      const failure = fail(index, body);
      if (failure) return json({ detail: 'Insufficient credits', error_type: 'insufficient_credits' }, failure === true ? 503 : failure);
      return json({ request_id: `req-${index}` }, 201);
    }
    const [, index, status] = /\/requests\/req-(\d+)(\/status)?$/.exec(url);
    return status ? json({ status: 'COMPLETED' }) : json({ assets: { video: `https://storage.comfy.example/clip-${index}.mp4` } });
  };
  return { fetchImpl, calls };
}

const grok = { id: 'x-ai/grok-imagine-video-1.5-lite', supported_durations: Array.from({ length: 15 }, (_, i) => i + 1),
  supported_resolutions: ['480p', '720p', '1080p'], supported_aspect_ratios: ['16:9', '9:16', '1:1'] };
const config = { provider: 'openrouter', apiKey: 'or-key', model: grok.id };
// The agent's chat provider, one object so clarification authority matches.
const chatProvider = { name: 'owned', model: 'owned', config: {} };
const scenes = (count, duration) => Array.from({ length: count }, (_, i) => ({ prompt: `Scene idea ${i + 1}`, duration }));
// A card that is still waiting fails the assertion instead of hanging the suite.
const settled = promise => Promise.race([promise, new Promise(done => setTimeout(() => done('still waiting'), 1000))]);

const root = resolve('.');
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/__media.html') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><div id="chat"></div>');
      return;
    }
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep)) throw new Error('outside root');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.mp4': 'video/mp4' })[extname(file)] || 'text/plain');
    res.end(await fs.readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
let browser, origin;
before(async () => {
  browser = await chromium.launch({ headless: true });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await browser?.close();
  await new Promise(done => server.close(done));
});

for (const build of ['chrome', 'firefox']) {
  const join = await import(`../src/${build}/src/agent/video-join.js`);
  const media = await import(`../src/${build}/src/agent/generative-media.js`);
  const journal = await import(`../src/${build}/src/run-ui-journal.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const Scheduler = await import(`../src/${build}/src/agent/scheduler.js`);
  // generate_image as the agent calls it, with the selected OpenRouter model.
  // A failed clip's retry does not wait here.
  const generate = (args, options) => media.generateImage(args, { config, retryDelayMs: 1, ...options });
  // Clips kept from one test's failed video are not another test's.
  beforeEach(() => media.forgetKeptVideoClips());

  test(`${build}: clips with one codec setup join into one MP4 without re-encoding`, () => {
    const sources = [fixtures['h264-aac-1'], fixtures['h264-aac-2']];
    const { bytes, durationSeconds } = join.joinMp4Clips(sources);
    assert.equal(durationSeconds, 2);
    assert.equal(join.mp4DurationSeconds(bytes), 2);
    const output = parse(bytes);
    assert.deepEqual(output.boxes.map(box => box.type), ['ftyp', 'moov', 'mdat'], 'moov comes before mdat');
    const [video, audio] = output.moov.traks;
    assert.equal(video.mdia.hdlr.handler, 'vide');
    assert.equal(audio.mdia.hdlr.handler, 'soun');
    // Every video frame is the source's frame, byte for byte, in order.
    const sourceFrames = sources.flatMap(source => sampleBytes(source, parse(source).moov.traks[0]));
    const joinedFrames = sampleBytes(bytes, video);
    assert.equal(joinedFrames.length, 24);
    joinedFrames.forEach((frame, index) => assert.deepEqual(frame, sourceFrames[index], `frame ${index}`));
    // The second clip's frames are shown right after the first clip's, and the
    // movie runs from its first picture to its declared length.
    const times = video.samples.map(sample => sample.cts - video.edts.elst.entries[0].media_time).sort((a, b) => a - b);
    assert.deepEqual(times.map(value => value / 1024), Array.from({ length: 24 }, (_, i) => i));
    assert.deepEqual(shown(output, video), { from: 0, to: 2, movie: 2 });
    // Audio: the first clip's frames are all kept; the second clip's start-up
    // frame is dropped and the rest is copied as is. Every frame but the last
    // plays in full (1024 samples, as AAC frames do), so the second clip's first
    // real frame plays within half a frame (512 samples) of one second in, with
    // its picture, and the sound ends within half a frame of the picture.
    const [firstAudio, secondAudio] = sources.map(source => sampleBytes(source, parse(source).moov.traks[1]));
    assert.deepEqual(sampleBytes(bytes, audio).slice(0, 17), firstAudio);
    assert.deepEqual(sampleBytes(bytes, audio).slice(17), secondAudio.slice(1));
    assert.ok(audio.samples.every((sample, i) => sample.duration === 1024 || i === audio.samples.length - 1));
    assert.ok(Math.abs(audio.samples[17].cts - audio.edts.elst.entries[0].media_time - 16000) <= 512);
    assert.ok(Math.abs(shown(output, audio).to - 2) <= 0.032);
    // AAC's pre-roll for seeking (a 'roll' sample group) covers every frame.
    const sourceRoll = parse(sources[0]).moov.traks[1].mdia.minf.stbl.sgpds[0];
    assert.deepEqual(boxBytes(bytes, audio.mdia.minf.stbl.sgpds[0]), boxBytes(sources[0], sourceRoll));
    assert.deepEqual(audio.mdia.minf.stbl.sbgps.map(sbgp => sbgp.entries), [[{ sample_count: 33, group_description_index: 1 }]]);
  });

  test(`${build}: fragmented and VP9/Opus clips join too`, () => {
    // [clips, codecs, audio frames kept from the first clip, start-up frames dropped
    //  from the second, how far into its first kept frame the second clip's sound
    //  starts, the audio's pre-roll groups as runs of [frames, group], and how far
    //  (in samples) the sound may play from its time]
    for (const [names, codecs, kept, dropped, lead, roll, slack] of [
      // No edit lists: the picture starts after a B-frame delay (2048/12288 s),
      // so every track is shown from there and the movie starts at its first
      // picture. The first audio frame (the encoder's start-up) lasts until
      // then; it plays right before the sound, as in a file with an edit list.
      // AAC frames play in full, each within half a frame of its time.
      [['h264-aac-fragmented-1', 'h264-aac-fragmented-2'], ['avc1', 'mp4a'], 17, 1, 0, [], 512],
      // Opus: the first clip's short final frame would play over the second
      // clip's first frame, whose first 312 samples are the decoder's start-up,
      // so the short frame is dropped rather than squeezed. Each clip keeps its
      // own pre-roll groups (none for its first four frames).
      [['vp9-opus-1', 'vp9-opus-2'], ['vp09', 'Opus'], 50, 0, 312, [[4, 0], [46, 1], [4, 0], [47, 1]], 0],
    ]) {
      const label = names.join('+');
      const { bytes, durationSeconds } = join.joinMp4Clips(names.map(name => fixtures[name]));
      assert.equal(durationSeconds, 2, label);
      const output = parse(bytes);
      const [video, audio] = output.moov.traks;
      assert.deepEqual(output.moov.traks.map(trak => trak.mdia.minf.stbl.stsd.entries[0].type), codecs, label);
      assert.equal(video.samples.length, 24, label);
      assert.deepEqual(shown(output, video), { from: 0, to: 2, movie: 2 }, `${label}: the picture runs from 0 to the declared length`);
      assert.ok(Math.abs(shown(output, audio).to - 2) <= slack / audio.mdia.mdhd.timescale, `${label}: and so does the sound`);
      const [firstAudio, secondAudio] = names.map(name => parse(fixtures[name]).moov.traks[1]);
      assert.deepEqual(sampleBytes(bytes, audio).slice(0, kept), sampleBytes(fixtures[names[0]], firstAudio).slice(0, kept), `${label}: the first clip's audio up to the join`);
      assert.deepEqual(sampleBytes(bytes, audio).slice(kept), sampleBytes(fixtures[names[1]], secondAudio).slice(dropped), `${label}: the second clip's audio`);
      assert.ok(Math.abs(audio.samples[kept].cts + lead - audio.edts.elst.entries[0].media_time - audio.mdia.mdhd.timescale) <= slack,
        `${label}: the second clip's sound starts one second in`);
      const shortest = Math.min(...secondAudio.samples.map(sample => sample.duration));
      assert.ok(audio.samples.every(sample => sample.duration >= shortest), `${label}: no frame is squeezed`);
      assert.deepEqual((audio.mdia.minf.stbl.sbgps[0]?.entries || []).map(entry => [entry.sample_count, entry.group_description_index]), roll, `${label}: pre-roll groups`);
    }
    // Fragments can start at any decode time: five seconds later, the clips
    // join into the same file.
    const fragmented = [fixtures['h264-aac-fragmented-1'], fixtures['h264-aac-fragmented-2']];
    assert.equal(parse(laterFragments(fragmented[0], { vide: 5, soun: 5 })).moov.traks[0].samples[0].dts, 5 * 12288);
    assert.deepEqual(join.joinMp4Clips(fragmented.map(clip => laterFragments(clip, { vide: 5, soun: 5 }))).bytes, join.joinMp4Clips(fragmented).bytes);
  });

  test(`${build}: sound shorter than its picture, or starting after it, is filled with silence`, () => {
    // 'S' for AAC-LC's silent mono frame (an empty spectrum), '#' for sound.
    const marks = (bytes, trak) => sampleBytes(bytes, trak)
      .map(data => (data.length === 4 && [0, 0, 0, 7].every((value, i) => data[i] === value) ? 'S' : '#')).join('');
    const joined = clips => {
      const { bytes, durationSeconds } = join.joinMp4Clips(clips.map(clip => (typeof clip === 'string' ? fixtures[clip] : clip)));
      const output = parse(bytes);
      return { bytes, durationSeconds, output, audio: audioOf(output) };
    };
    // Where a joined frame plays, in seconds; the sound may start up to half a frame (32 ms) off.
    const playsAt = (audio, index) => (audio.samples[index].cts - audio.edts.elst.entries[0].media_time) / audio.mdia.mdhd.timescale;
    // A clip whose sound ends 0.25 s before its picture (as generated clips' sound
    // often ends a little early): four frames carry it to the next clip, three
    // silent ones and the next clip's start-up frame, which primes the decoder
    // so that clip's first frame sounds as it was encoded.
    let { bytes, durationSeconds, output, audio } = joined(['h264-aac-short-audio', 'h264-aac-2']);
    assert.equal(durationSeconds, 2);
    assert.deepEqual(shown(output, videoOf(output)), { from: 0, to: 2, movie: 2 });
    assert.equal(marks(bytes, audio), `${'#'.repeat(13)}SSS${'#'.repeat(17)}`);
    const nextClip = fixtures['h264-aac-2'];
    assert.deepEqual(sampleBytes(bytes, audio).slice(16), sampleBytes(nextClip, parse(nextClip).moov.traks[1]));
    assert.ok(Math.abs(playsAt(audio, 17) - 1) <= 0.032, `the second clip's sound starts at ${playsAt(audio, 17)} s`);
    // Every frame but the video's last counts in full, so the sound plays
    // without gaps and stays with the picture.
    assert.ok(audio.samples.every((sample, i) => (sample.duration === 1024 || i === audio.samples.length - 1)
      && (!i || sample.dts === audio.samples[i - 1].dts + 1024)));
    // A clip whose sound starts 0.25 s in (an empty edit, then the encoder's
    // start-up frame from 0.186 s): silence before it, in the middle of the video...
    ({ bytes, audio } = joined(['h264-aac-1', 'h264-aac-late-audio']));
    assert.equal(marks(bytes, audio), `${'#'.repeat(17)}SSS${'#'.repeat(13)}`);
    assert.ok(Math.abs(playsAt(audio, 21) - 1.25) <= 0.032, `the late sound starts at ${playsAt(audio, 21)} s`);
    // ...or at its start, where the silence is whole frames, enough to reach the
    // sound, and the video's edit starts inside the first of them: the sound
    // plays exactly on time. Starting at 0.15 s still takes three frames.
    ({ bytes, audio } = joined(['h264-aac-late-audio', 'h264-aac-1']));
    assert.equal(marks(bytes, audio), `SSS${'#'.repeat(29)}`);
    assert.equal(playsAt(audio, 4), 0.25);
    const sooner = patched('h264-aac-late-audio', (view, file) => {
      const { start } = audioOf(file).edts.elst;
      view.setUint32(start + 16, 150);
      view.setUint32(start + 28, 850);
    });
    ({ bytes, audio } = joined([sooner, 'h264-aac-1']));
    assert.equal(marks(bytes, audio), `SSS${'#'.repeat(29)}`);
    assert.equal(playsAt(audio, 3), 0.15);
    // A gap in a clip's own timing (one frame lasting three frames' time) is
    // filled with silence too, so the sound after it stays on time. The two
    // frames it pushes past the picture's end are dropped.
    const gappy = patched('h264-aac-fragmented-2', (view, file) => {
      const run = file.moofs[0].trafs.find(traf => traf.tfhd.track_id === audioOf(file).tkhd.track_id).truns[0];
      assert.equal(run.flags, 0x301, 'each sample\'s duration and size follow the data offset');
      view.setUint32(run.start + 20 + 8 * 8, 3 * 1024);
    });
    ({ bytes, audio } = joined(['h264-aac-fragmented-1', gappy]));
    assert.equal(marks(bytes, audio), `${'#'.repeat(25)}SS${'#'.repeat(6)}`);
    assert.ok(Math.abs(playsAt(audio, 27) - (1 + 10 * 1024 / 16000)) <= 0.032, `the sound after the gap starts at ${playsAt(audio, 27)} s`);
    // Sound may start late as long as it starts before the picture ends.
    const startingAt = milliseconds => patched('h264-aac-late-audio', (view, file) => view.setUint32(audioOf(file).edts.elst.start + 16, milliseconds));
    assert.ok(joined(['h264-aac-1', startingAt(999)]).bytes);
    assert.throws(() => joined(['h264-aac-1', startingAt(1000)]), error => error.message.includes('starts after the clip does'));
    // Only AAC-LC has a silent frame here: Opus, or the same clips marked as
    // HE-AAC, keep a clip whose sound starts late apart.
    assert.throws(() => joined(['vp9-opus-1', 'vp9-opus-late-audio']), error => error.message.includes('starts after the clip does'));
    const heAac = name => patched(name, (view, file) => {
      const { esds } = audioOf(file).mdia.minf.stbl.stsd.entries[0];
      const config = esds.esd.descs.find(desc => desc.tag === 4).descs.find(desc => desc.tag === 5).data;
      const box = boxBytes(fixtures[name], esds);
      const at = box.findIndex((_, i) => box[i - 1] === config.length && config.every((value, k) => box[i + k] === value));
      assert.ok(at > 0, 'the decoder configuration is in the esds box');
      view.setUint8(esds.start + at, (5 << 3) | (config[0] & 7));
    });
    assert.ok(joined([heAac('h264-aac-1'), heAac('h264-aac-2')]).bytes, 'HE-AAC clips that need no silence still join');
    assert.throws(() => joined([heAac('h264-aac-1'), heAac('h264-aac-late-audio')]), error => error.message.includes('starts after the clip does'));
    // So do AAC-LC clips whose timescale cannot count a frame in whole ticks.
    const oddTimescale = name => patched(name, (view, file) => {
      const { mdhd } = audioOf(file).mdia;
      assert.equal(mdhd.version, 0);
      view.setUint32(mdhd.start + 20, 15999);
    });
    assert.throws(() => joined([oddTimescale('h264-aac-1'), oddTimescale('h264-aac-late-audio')]), error => error.message.includes('starts after the clip does'));
  });

  test(`${build}: clips with different codec settings or tracks are not joined`, () => {
    for (const pair of [['h264-aac-1', 'h264-aac-48px'], ['h264-aac-1', 'vp9-opus-1']]) {
      assert.throws(() => join.joinMp4Clips(pair.map(name => fixtures[name])), error => error.code === 'clips_incompatible', pair.join('+'));
    }
    // The joined file shows every clip at the first clip's size and angle.
    for (const placed of [
      patched('h264-aac-2', (view, file) => view.setUint32(videoOf(file).tkhd.start + 84, 128 << 16)),
      patched('h264-aac-2', (view, file) => [0, 0x10000, 0, -0x10000, 0].forEach((value, i) => view.setInt32(videoOf(file).tkhd.start + 48 + i * 4, value))),
    ]) {
      assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], placed]), error => error.message.includes('different sizes or angles'));
    }
    // A clip cut short in the download is not read past its end.
    const cut = fixtures['h264-aac-2'].slice(0, -100);
    assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], cut]), error => error.code === 'not_mp4' && /incomplete/.test(error.message));
    assert.equal(join.mp4DurationSeconds(cut), null);
    assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], new Uint8Array([0, 0, 0, 8, 102, 114, 101, 101])]), error => error.code === 'not_mp4');
    assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], fixtures['h264-aac-2']], { maxBytes: 1000 }), error => error.code === 'too_large');
    // Nor are clips that claim to run for more than an hour (silence would fill
    // their sound for as long).
    const endless = patched('h264-aac-2', (view, file) => {
      const video = videoOf(file);
      const { stts } = video.mdia.minf.stbl;
      assert.deepEqual([stts.sample_deltas.length, video.mdia.mdhd.version], [1, 0]);
      view.setUint32(stts.start + 20, 1024 * 3700);
      view.setUint32(video.mdia.mdhd.start + 24, 12 * 1024 * 3700);
      view.setUint32(video.edts.elst.start + 16, 3700 * 1000);
    });
    assert.ok(join.mp4DurationSeconds(endless) > 3699);
    assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], endless]), error => error.code === 'too_large' && /an hour/.test(error.message));
    assert.equal(join.mp4DurationSeconds(new Uint8Array([1, 2, 3])), null);
  });

  test(`${build}: clips whose timing cannot be laid end to end are kept apart`, () => {
    const refused = (clips, reason) => assert.throws(() => join.joinMp4Clips(clips),
      error => error.code === 'clips_incompatible' && error.message.includes(reason), reason);
    const edited = ({ milliseconds = 1000, mediaTime = 2048 }) => patched('h264-aac-1', (view, file) => {
      const elst = videoOf(file).edts.elst;
      assert.equal(elst.version, 0);
      view.setUint32(elst.start + 16, milliseconds);
      view.setInt32(elst.start + 20, mediaTime);
    });
    // An edit list that hides whole frames (the last half second, or the first
    // frame) leaves them in the file, where a join would play them.
    assert.equal(join.mp4DurationSeconds(edited({ milliseconds: 500 })), 0.5);
    refused([fixtures['h264-aac-1'], edited({ milliseconds: 500 })], 'hides some of its frames');
    refused([fixtures['h264-aac-1'], edited({ mediaTime: 3072 })], 'hides some of its frames');
    // Shortening the last frame alone is fine. The sound past the shortened
    // picture is dropped (a frame that would start after it, or play mostly
    // after it), and the next clip's sound starts with its picture.
    for (const milliseconds of [960, 980]) {
      const shortened = join.joinMp4Clips([edited({ milliseconds }), fixtures['h264-aac-2']]);
      assert.ok(Math.abs(shortened.durationSeconds - (1 + milliseconds / 1000)) < 0.001);
      const sound = audioOf(parse(shortened.bytes));
      assert.equal(sound.samples.length, 32, 'each clip keeps 16 frames');
      assert.ok(Math.abs(sound.samples[16].cts - sound.edts.elst.entries[0].media_time - milliseconds * 16) <= 512);
    }
    // A one-second-longer composition delay keeps the picture where it was but
    // starts decoding a second earlier: such a clip can open a video, not follow one.
    const delayed = patched('h264-aac-2', (view, file) => {
      const ctts = videoOf(file).mdia.minf.stbl.ctts;
      ctts.sample_offsets.forEach((offset, i) => view.setUint32(ctts.start + 16 + i * 8 + 4, offset + 12288));
      view.setInt32(videoOf(file).edts.elst.start + 20, videoOf(file).edts.elst.entries[0].media_time + 12288);
    });
    assert.equal(join.mp4DurationSeconds(delayed), 1);
    refused([fixtures['h264-aac-1'], delayed], 'start decoding before the previous one ends');
    const output = parse(join.joinMp4Clips([delayed, fixtures['h264-aac-1']]).bytes);
    const video = videoOf(output);
    const times = video.samples.map(sample => sample.cts - video.edts.elst.entries[0].media_time).sort((a, b) => a - b);
    assert.deepEqual(times.map(value => value / 1024), Array.from({ length: 24 }, (_, i) => i));
    assert.deepEqual(shown(output, video), { from: 0, to: 2, movie: 2 });
    // An edit that plays at another speed, and a clip that does not open on a keyframe.
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => view.setInt16(videoOf(file).edts.elst.start + 26, 0x4000))],
      'complex edit list');
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => view.setUint32(videoOf(file).mdia.minf.stbl.stss.start + 16, 2))],
      'does not start with a keyframe');
    // Encrypted samples, samples kept in another file, and a different pre-roll.
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => 'enca'.split('').forEach((char, i) =>
      view.setUint8(audioOf(file).mdia.minf.stbl.stsd.entries[0].start + 4 + i, char.charCodeAt(0))))], 'encrypted');
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => view.setUint8(videoOf(file).mdia.minf.dinf.dref.entries[0].start + 11, 0))],
      'in another file');
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => view.setInt16(audioOf(file).mdia.minf.stbl.sgpds[0].start + 24, -2))],
      'different codec settings');
    // Sound whose own edit hides its last half second would play on in a
    // joined file; hiding less than a frame of it is fine.
    const soundEdit = milliseconds => patched('h264-aac-2', (view, file) => view.setUint32(audioOf(file).edts.elst.start + 16, milliseconds));
    refused([fixtures['h264-aac-1'], soundEdit(500)], 'ends a track early');
    assert.equal(join.joinMp4Clips([fixtures['h264-aac-1'], soundEdit(960)]).durationSeconds, 2);
  });

  test(`${build}: scenes fit the model's clip lengths and stay within two minutes`, () => {
    const { clips, total } = media.planVideoClips([{ prompt: 'Opening', duration: 12 }, { prompt: 'Long walk', duration: 4 }], [5, 10, 15]);
    assert.deepEqual(clips, [{ prompt: 'Opening', duration: 15 }, { prompt: 'Long walk', duration: 5 }]);
    assert.equal(total, 20);
    // A scene longer than the longest clip is the agent's to split: halves of
    // one prompt would be the same clip twice.
    assert.throws(() => media.planVideoClips([{ prompt: 'Opening', duration: 12 }, { prompt: 'Long walk', duration: 20 }], [5, 10, 15]),
      /^Error: Scene 2 is 20 s, and this model makes clips of up to 15 s\. Split it into scenes of up to 15 s, each with its own prompt/);
    assert.equal(media.planVideoClips(scenes(8, 15), grok.supported_durations).total, 120);
    assert.throws(() => media.planVideoClips(scenes(9, 15), grok.supported_durations), /up to 120 s/);
    assert.throws(() => media.planVideoClips(scenes(25, 4), grok.supported_durations), /at most 24/);
    assert.deepEqual(media.planVideoClips(scenes(2, 5), null), {
      clips: scenes(2, 5), total: 10,
    });
    assert.deepEqual(media.planVideoClips(scenes(4, 15), null), { clips: scenes(4, 15), total: 60 });
    assert.throws(() => media.planVideoClips(scenes(9, 15), null), /up to 120 s/);
    assert.throws(() => media.planVideoClips([{ prompt: ' ', duration: 5 }], [5]), /Scene 1 needs a prompt/);
  });

  test(`${build}: one clip sends only the duration, aspect ratio and resolution the model supports`, async () => {
    const api = videoApi({ entry: grok });
    const result = await generate({ prompt: 'A red apple', duration: 8, aspect_ratio: '9:16', resolution: '720p' }, { fetchImpl: api.fetchImpl });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(api.calls.submits, [{ model: grok.id, prompt: 'A red apple', duration: 8, aspect_ratio: '9:16', resolution: '720p' }]);
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.durationSeconds, 1, "the clip's real length");
    assert.deepEqual(await storedBytes(result.mediaId), fixtures['h264-aac-1']);
    // The tool's media argument picks the video model.
    const asked = videoApi({ entry: grok });
    const picked = await generate({ prompt: 'A red apple', media: 'video' }, { fetchImpl: asked.fetchImpl, config: { ...config, model: 'image-model', videoModel: grok.id } });
    assert.equal(picked.success, true, picked.error);
    assert.deepEqual(asked.calls.submits, [{ model: grok.id, prompt: 'A red apple' }]);
    const estimated = videoApi({ entry: { ...grok, supported_durations: [4, 8, 12] } });
    await media.runMediaGeneration({ prompt: 'A red apple', video: { estimated_duration: 7 }, config, fetchImpl: estimated.fetchImpl });
    assert.equal(estimated.calls.submits[0].duration, 8, 'an estimate rounds up to a clip length the model makes');
    for (const [video, pattern] of [
      [{ duration: 16 }, /needs more than one clip/],
      [{ estimated_duration: 40 }, /Describe it as scenes/],
      [{ aspect_ratio: '4:5' }, /does not support aspect_ratio "4:5"\. Supported: 16:9, 9:16, 1:1/],
      [{ resolution: '4K' }, /does not support resolution/],
      [{ scenes: scenes(2, 5) }, /estimated_duration/],
      [{ scenes: scenes(2, 5), estimated_duration: 10, duration: 5 }, /each scene its duration/],
    ]) {
      const rejected = videoApi({ entry: grok });
      await assert.rejects(media.runMediaGeneration({ prompt: 'A red apple', video, config, fetchImpl: rejected.fetchImpl }), pattern, JSON.stringify(video));
      assert.equal(rejected.calls.submits.length, 0, 'nothing is submitted');
    }
    // A video model setting that names an image model is refused before anything is submitted.
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', video: { duration: 5 }, config: { ...config, videoModel: 'image-model' },
      fetchImpl: async (url, init) => (init.method ? assert.fail(url) : url.endsWith('/images/models') ? json({ data: [{ id: 'image-model' }] }) : json({ data: [grok] })) }),
      /image-model makes images/);
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', media: 'image', video: { duration: 5 }, config, fetchImpl: async url => assert.fail(url) }),
      /are for videos/);
    // A local ComfyUI workflow sets its own length and shape.
    const workflow = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } };
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', video: { duration: 5 }, config: { provider: 'comfyui', workflow },
      fetchImpl: async url => assert.fail(url) }), /do not work with a local ComfyUI workflow/);
  });

  test(`${build}: video estimates cannot silently become shorter plans`, async () => {
    const cases = [
      [{ duration: 10, estimated_duration: 60 }, /A 1:00 video needs more than one clip/],
      [{ duration: 8, estimated_duration: 10 }, /requested video needs 10 s, but duration specifies only 8 s/],
      [{ scenes: scenes(1, 10), estimated_duration: 60 }, /scenes provide 10 s, but the requested video needs 60 s/],
      [{ scenes: scenes(7, 15), estimated_duration: 120 }, /scenes provide 105 s, but the requested video needs 120 s/],
    ];
    for (const provider of ['openrouter', 'fal']) for (const [video, pattern] of cases) {
      const api = provider === 'fal' ? falApi({ model: h3Max.id, schema: h3Max.schema }) : videoApi({ entry: grok });
      await assert.rejects(media.runMediaGeneration({ prompt: 'Explainer', video,
        config: provider === 'fal' ? falConfig(h3Max) : config, fetchImpl: api.fetchImpl, pollIntervalMs: 1 }), pattern);
      assert.equal(api.calls.submits.length, 0, `${provider}: a shorter plan spends nothing`);
    }
    for (const provider of ['openrouter', 'fal']) {
      const api = provider === 'fal' ? falApi({ model: h3Max.id, schema: null })
        : videoApi({ entry: { ...grok, supported_durations: undefined } });
      await assert.rejects(media.runMediaGeneration({ prompt: 'Explainer', video: { estimated_duration: 60 },
        config: provider === 'fal' ? falConfig(h3Max) : config, fetchImpl: api.fetchImpl, pollIntervalMs: 1 }),
        /1:00 video needs multiple clips with WebBrain's 8 s fallback.*keep estimated_duration: 60/);
      assert.equal(api.calls.submits.length, 0, `${provider}: an unknown length does not use a default clip`);
    }
  });

  test(`${build}: a video of two minutes or less generates without asking`, async () => {
    const api = videoApi({ entry: grok });
    const progress = [];
    let asked = 0;
    const result = await generate({ prompt: 'Flat motion graphics, navy background', scenes: scenes(4, 15), estimated_duration: 60 }, {
      fetchImpl: api.fetchImpl, onProgress: message => progress.push(message),
      confirmVideoLength: async () => { asked += 1; return 'once'; },
    });
    assert.equal(result.success, true, result.error);
    assert.equal(asked, 0, 'no card within the cap');
    assert.equal(api.calls.submits.length, 4);
    assert.ok(api.calls.maxInFlight <= 3, `at most three clips at a time (saw ${api.calls.maxInFlight})`);
    api.calls.submits.forEach((body, index) => {
      assert.equal(body.duration, 15);
      // The shared look, then the scene, with no scene number for the model to draw.
      assert.equal(body.prompt, `Flat motion graphics, navy background\n\nScene idea ${index + 1}`);
    });
    assert.equal(result.clipCount, 4);
    assert.equal(result.durationSeconds, 4, 'the real length of the joined clips');
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(join.mp4DurationSeconds(await storedBytes(result.mediaId)), 4, 'one joined asset');
    assert.deepEqual(progress, ['Generating 4 video clips…', 'Video clips: 1 of 4 ready', 'Video clips: 2 of 4 ready',
      'Video clips: 3 of 4 ready', 'Video clips: 4 of 4 ready', 'Joining 4 clips…']);
  });

  test(`${build}: a longer estimate asks first and generates nothing unless the user agrees`, async () => {
    for (const [answer, pattern] of [['deny', /chose not to generate the 2:00 version/], ['unavailable', /could not ask the user/], [null, /withdrawn/]]) {
      const api = videoApi({ entry: grok });
      const asked = [];
      const result = await generate({ prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, {
        fetchImpl: api.fetchImpl, confirmVideoLength: async details => { asked.push(details); return answer; },
      });
      assert.deepEqual(asked, [{ estimatedSeconds: 330, totalSeconds: 120, clipCount: 8, maxSeconds: 120 }]);
      assert.equal(result.success, false);
      assert.equal(result.declined, true);
      assert.match(result.error, /needs about 5:30/);
      assert.match(result.error, pattern);
      assert.equal(api.calls.submits.length, 0, `${answer}: nothing is submitted`);
    }
    const api = videoApi({ entry: grok });
    const approved = await generate({ prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, {
      fetchImpl: api.fetchImpl, confirmVideoLength: async () => 'once',
    });
    assert.equal(approved.success, true, approved.error);
    assert.equal(api.calls.submits.length, 8);
    assert.equal(approved.clipCount, 8);
    // The user's approved shorter version need not fill the entire 120 s cap.
    const shorterApi = videoApi({ entry: grok });
    const shorter = await media.runMediaGeneration({ prompt: 'Explainer', video: { scenes: scenes(6, 15), estimated_duration: 330 },
      config, fetchImpl: shorterApi.fetchImpl, confirmVideoLength: async details => {
        assert.equal(details.totalSeconds, 90);
        return 'once';
      } });
    assert.equal(shorter.clips.length, 6);
    assert.equal(shorterApi.calls.submits.length, 6);
    const withoutCard = videoApi({ entry: grok });
    const unasked = await generate({ prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, { fetchImpl: withoutCard.fetchImpl });
    assert.equal(unasked.declined, true, 'without a card nothing is generated');
    assert.equal(withoutCard.calls.submits.length, 0);
  });

  test(`${build}: a clip is retried once and a second failure ends the video`, async () => {
    const retried = videoApi({ entry: grok, fail: index => index === 1 });
    const recovered = await generate({ prompt: 'Story', scenes: scenes(3, 10), estimated_duration: 30 }, { fetchImpl: retried.fetchImpl });
    assert.equal(recovered.success, true, recovered.error);
    assert.equal(retried.calls.submits.length, 4, 'three clips and one retry');
    const failing = videoApi({ entry: grok, fail: (_index, body) => body.prompt.endsWith('Scene idea 2') });
    const stored = assets.size;
    const failed = await generate({ prompt: 'Story', scenes: scenes(3, 10), estimated_duration: 30 }, { fetchImpl: failing.fetchImpl });
    assert.equal(failed.success, false);
    assert.match(failed.error, /^Clip 2 of 3 failed: OpenRouter video submit failed \(HTTP 503\).*Provider overloaded/);
    assert.equal(assets.size, stored, 'no partial video is kept');
    // An account out of credit is not retried, and the error says so.
    const broke = videoApi({ entry: grok, fail: (_index, body) => body.prompt.endsWith('Scene idea 2') && 402 });
    const unpaid = await generate({ prompt: 'Story', scenes: scenes(3, 10), estimated_duration: 30 }, { fetchImpl: broke.fetchImpl });
    assert.equal(unpaid.success, false);
    assert.match(unpaid.error, /^Clip 2 of 3 failed: OpenRouter video submit failed \(HTTP 402\): the account is out of credit; add credit and try again: .*insufficient balance/);
    assert.equal(broke.calls.submits.filter(body => body.prompt.endsWith('Scene idea 2')).length, 1, 'tried once');
    assert.equal(failing.calls.submits.filter(body => body.prompt.endsWith('Scene idea 2')).length, 2, 'an overloaded provider is tried twice');
  });

  test(`${build}: Stop ends every clip of a video`, async () => {
    const controller = new AbortController();
    const api = videoApi({ entry: grok });
    const stored = assets.size;
    const result = await generate({ prompt: 'Story', scenes: scenes(5, 10), estimated_duration: 50 }, {
      signal: controller.signal,
      // The user presses Stop while the first clip downloads.
      fetchImpl: async (url, init) => {
        if (url.includes('/content')) {
          controller.abort(new Error('Stopped by user.'));
          init.signal.throwIfAborted();
        }
        return api.fetchImpl(url, init);
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Stopped by user.');
    assert.equal(api.calls.submits.length, 3, 'clips 4 and 5 never start');
    assert.equal(assets.size, stored);
  });

  test(`${build}: fal.ai scenes are made one clip each and joined into one video`, async () => {
    const api = falApi({ model: h3Max.id, schema: h3Max.schema });
    const progress = [];
    const result = await generate({
      prompt: 'Flat motion graphics, navy background', media: 'video', scenes: scenes(3, 10), estimated_duration: 30,
      aspect_ratio: '16:9', resolution: '768p',
    }, { config: falConfig(h3Max), fetchImpl: api.fetchImpl, pollIntervalMs: 1, onProgress: message => progress.push(message) });
    assert.equal(result.success, true, result.error);
    assert.equal(api.calls.schemas, 1, 'the schema is read once per video');
    // Each clip as the model takes it: its length as a number, the resolution as the model writes it.
    assert.deepEqual(api.calls.submits, [1, 2, 3].map(scene => ({
      prompt: `Flat motion graphics, navy background\n\nScene idea ${scene}`, duration: 10, aspect_ratio: '16:9', resolution: '768P',
    })));
    assert.deepEqual(api.calls.downloads.sort(), [0, 1, 2]);
    assert.deepEqual([result.provider, result.model, result.clipCount, result.durationSeconds, result.mimeType], ['fal', h3Max.id, 3, 3, 'video/mp4']);
    assert.equal(join.mp4DurationSeconds(await storedBytes(result.mediaId)), 3, 'one joined asset');
    assert.deepEqual(progress, ['Generating 3 video clips…', 'Video clips: 1 of 3 ready', 'Video clips: 2 of 3 ready',
      'Video clips: 3 of 3 ready', 'Joining 3 clips…']);
    // One clip without options needs no schema and stays a hosted video.
    const plain = falApi({ model: h3Max.id, schema: h3Max.schema });
    const single = await generate({ prompt: 'A red apple', media: 'video' }, { config: falConfig(h3Max), fetchImpl: plain.fetchImpl, pollIntervalMs: 1 });
    assert.equal(single.success, true, single.error);
    assert.deepEqual([plain.calls.schemas, plain.calls.submits, plain.calls.downloads], [0, [{ prompt: 'A red apple' }], []]);
    assert.equal(single.url, 'https://v3b.fal.media/files/b/clip-0.mp4');
  });

  test(`${build}: a hosted clip larger than 20 MB is kept when it is not joined`, async () => {
    // A valid clip padded past 20 MB with a top-level free box.
    const size = 21 * 1024 * 1024;
    const large = new Uint8Array(fixtures['h264-aac-1'].length + size);
    large.set(fixtures['h264-aac-1']);
    new DataView(large.buffer).setUint32(fixtures['h264-aac-1'].length, size);
    large.set([0x66, 0x72, 0x65, 0x65], fixtures['h264-aac-1'].length + 4);
    // One scene is stored as it is; two that cannot be joined are stored one by one.
    for (const [count, clip] of [[1, () => large], [2, index => (index ? fixtures['h264-aac-48px'] : large)]]) {
      const api = falApi({ model: h3Max.id, schema: h3Max.schema, clip });
      const result = await generate({ prompt: 'Story', scenes: scenes(count, 10), estimated_duration: 10 * count },
        { config: falConfig(h3Max), fetchImpl: api.fetchImpl, pollIntervalMs: 1 });
      assert.equal(result.success, true, result.error);
      assert.equal(result.clipCount, count);
      assert.deepEqual(await storedBytes(count === 1 ? result.mediaId : result.clips[0].mediaId), large);
    }
  });

  test(`${build}: fal.ai lengths are sent the way the model lists them`, async () => {
    const run = async (model, video) => {
      const api = falApi({ model: model.id, schema: model.schema });
      const result = await media.runMediaGeneration({ prompt: 'Story', video, config: falConfig(model), fetchImpl: api.fetchImpl, pollIntervalMs: 1 });
      return { result, durations: api.calls.submits.map(body => body.duration) };
    };
    // Scenes round up to the model's clip lengths: Hailuo 02 makes 6 and 10 s clips.
    const scenesRun = await run(hailuo, { scenes: [{ prompt: 'One', duration: 5 }, { prompt: 'Two', duration: 8 }], estimated_duration: 13 });
    assert.deepEqual([scenesRun.durations, scenesRun.result.totalSeconds, scenesRun.result.clips.length], [['6', '10'], 16, 2]);
    assert.deepEqual((await run(hailuo, { duration: 10 })).durations, ['10']);
    assert.deepEqual((await run(hailuo, { estimated_duration: 7 })).durations, ['10']);
    const ltx = { id: 'fal-ai/ltx-2.3/text-to-video', schema: falSchema({ duration: { type: 'integer', enum: [6, 8, 10] } }) };
    assert.deepEqual((await run(ltx, { scenes: [{ prompt: 'One', duration: 7 }], estimated_duration: 7 })).durations, [8]);
  });

  test(`${build}: fal.ai and Comfy Router refuse what the model's schema rules out, before submitting`, async () => {
    const pro = { id: 'fal-ai/minimax/hailuo-02/pro/text-to-video', schema: falSchema({ prompt_optimizer: { type: 'boolean' } }) };
    for (const [model, video, pattern] of [
      [hailuo, { duration: 7 }, /does not make 7 s clips\. Supported: 6, 10 s/],
      [hailuo, { duration: 16 }, /needs more than one clip: this model makes clips of up to 10 s/],
      [hailuo, { scenes: [{ prompt: 'Long', duration: 12 }], estimated_duration: 12 }, /Scene 1 is 12 s, and this model makes clips of up to 10 s/],
      [h3Max, { resolution: '4K' }, /does not support resolution "4K"\. Supported: 480P, 768P, 1080P/],
      [pro, { duration: 6 }, /This video model does not take duration/],
      [pro, { aspect_ratio: '16:9' }, /This video model does not take aspect_ratio/],
    ]) {
      const api = falApi({ model: model.id, schema: model.schema });
      await assert.rejects(media.runMediaGeneration({ prompt: 'Story', video, config: falConfig(model), fetchImpl: api.fetchImpl, pollIntervalMs: 1 }),
        pattern, `${model.id} ${JSON.stringify(video)}`);
      assert.equal(api.calls.submits.length, 0, 'nothing is submitted');
    }
    // Without a schema, one clip's options go to the model as given.
    const unknown = falApi({ model: 'fal-ai/kling-video/v2.1/standard/text-to-video', schema: null });
    await media.runMediaGeneration({ prompt: 'Story', video: { duration: 5, aspect_ratio: '1:1' },
      config: falConfig({ id: 'fal-ai/kling-video/v2.1/standard/text-to-video' }), fetchImpl: unknown.fetchImpl, pollIntervalMs: 1 });
    assert.deepEqual(unknown.calls.submits, [{ prompt: 'Story', duration: 5, aspect_ratio: '1:1' }]);
    // Comfy Router: no schema for the model, or a read it refuses.
    const comfyConfig = { provider: 'comfyrouter', apiKey: 'comfy-key', model: 'bfl/flux-2-pro', videoModel: 'minimax/hailuo-02' };
    for (const [schema, pattern] of [[401, /Comfy Router model schema failed \(HTTP 401\)/]]) {
      const api = comfyRouterApi({ model: 'minimax/hailuo-02', schema });
      await assert.rejects(media.runMediaGeneration({ prompt: 'Story', video: { scenes: scenes(2, 5), estimated_duration: 10 }, config: comfyConfig,
        fetchImpl: api.fetchImpl, pollIntervalMs: 1 }), pattern);
      assert.deepEqual([api.calls.schemas, api.calls.submits.length], [1, 0]);
    }
  });

  test(`${build}: missing clip metadata uses eight-second scenes and joins the full requested video`, async () => {
    const eightSeconds = join.joinMp4Clips(Array(8).fill(fixtures['h264-aac-1'])).bytes;
    for (const provider of ['fal', 'comfyrouter', 'openrouter']) {
      const api = provider === 'fal' ? falApi({ model: h3Max.id, schema: null, clip: () => eightSeconds })
        : provider === 'comfyrouter' ? comfyRouterApi({ model: rayTwo.id, schema: 404, clip: () => eightSeconds })
          : videoApi({ entry: { ...grok, supported_durations: undefined }, clip: () => eightSeconds });
      const selected = provider === 'fal' ? falConfig(h3Max)
        : provider === 'comfyrouter' ? { provider, apiKey: 'comfy-key', videoModel: rayTwo.id } : config;
      const result = await generate({ prompt: 'Consistent cast', scenes: scenes(8, 8), estimated_duration: 60 },
        { config: selected, fetchImpl: api.fetchImpl, pollIntervalMs: 1 });
      assert.equal(result.success, true, `${provider}: ${result.error}`);
      assert.deepEqual(api.calls.submits.map(body => body.duration), Array(8).fill(8));
      assert.deepEqual([result.estimatedSeconds, result.plannedSeconds, result.durationSeconds, result.fallbackClipSeconds],
        [60, 64, 64, 8], provider);
      assert.equal(result.durationStatus, 'enough');
      assert.equal(join.mp4DurationSeconds(await storedBytes(result.mediaId)), 64);
      const replay = journal.compactRunUiData('tool_result', { name: 'generate_image', result });
      assert.equal(replay.result.fallbackClipSeconds, 8);
    }
  });

  test(`${build}: fallback scenes respect published defaults and omit unsupported duration fields`, async () => {
    for (const [duration, expected] of [[{ type: 'string', default: '6s' }, '6s'], [{ type: 'string' }, '8'], [null, undefined]]) {
      const model = { id: 'provider/video', schema: falSchema(duration ? { duration } : {}) };
      const api = falApi({ model: model.id, schema: model.schema });
      const seconds = duration?.default ? 6 : 8;
      const result = await generate({ prompt: 'Story', scenes: scenes(2, seconds), estimated_duration: seconds * 2 },
        { config: falConfig(model), fetchImpl: api.fetchImpl, pollIntervalMs: 1 });
      assert.equal(result.success, true, result.error);
      assert.deepEqual(api.calls.submits.map(body => body.duration), [expected, expected]);
      assert.equal(result.fallbackClipSeconds, seconds);
    }
    const rejected = falApi({ model: h3Max.id, schema: null, fail: () => 422 });
    const failed = await generate({ prompt: 'Story', scenes: scenes(8, 8), estimated_duration: 60 },
      { config: falConfig(h3Max), fetchImpl: rejected.fetchImpl, pollIntervalMs: 1 });
    assert.equal(failed.success, false);
    assert.match(failed.error, /422/);
    assert.ok(rejected.calls.submits.length <= 3, 'a validation rejection is not retried');
    assert.deepEqual(rejected.calls.downloads, []);
  });

  test(`${build}: explicit scenes exceed fallback lengths and still respect unbounded constraints`, async () => {
    for (const [duration, requested, expected] of [
      [undefined, 15, 15],
      [{ type: 'integer', minimum: 1, default: 5 }, 15, 15],
      [{ type: 'integer', minimum: 10 }, 5, 10],
      [{ type: 'integer', minimum: 5, multipleOf: 5 }, 8, 10],
    ]) {
      const model = { id: 'provider/video', schema: duration ? falSchema({ duration }) : null };
      const api = falApi({ model: model.id, schema: model.schema });
      const result = await generate({ prompt: 'Story', scenes: scenes(4, requested), estimated_duration: requested * 4 },
        { config: falConfig(model), fetchImpl: api.fetchImpl, pollIntervalMs: 1 });
      assert.equal(result.success, true, result.error);
      assert.deepEqual(api.calls.submits.map(body => body.duration), Array(4).fill(expected));
      assert.equal(result.plannedSeconds, expected * 4);
      assert.equal(result.estimatedSeconds, requested * 4);
    }
  });

  test(`${build}: Comfy Router scenes take each clip's length over the saved model input`, async () => {
    const api = comfyRouterApi({ model: rayTwo.id, schema: rayTwo.schema, clip: index => fixtures[index ? 'h264-aac-2' : 'h264-aac-1'] });
    const config = { provider: 'comfyrouter', apiKey: 'comfy-key', model: 'bfl/flux-2-pro', videoModel: rayTwo.id,
      videoParameters: JSON.stringify({ model: 'ray-2', duration: '9s', loop: false }) };
    const result = await generate({ prompt: 'Paper cut-out style', scenes: [{ prompt: 'A fox wakes', duration: 4 }, { prompt: 'The fox runs', duration: 9 }],
      estimated_duration: 13, resolution: '720P' }, { config, fetchImpl: api.fetchImpl, pollIntervalMs: 1 });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(api.calls.submits, [
      { model: 'ray-2', duration: '5s', loop: false, prompt: 'Paper cut-out style\n\nA fox wakes', resolution: '720p' },
      { model: 'ray-2', duration: '9s', loop: false, prompt: 'Paper cut-out style\n\nThe fox runs', resolution: '720p' },
    ]);
    assert.deepEqual([result.provider, result.model, result.clipCount, result.durationSeconds], ['comfyrouter', rayTwo.id, 2, 2]);
    const joined = parse(await storedBytes(result.mediaId));
    const parts = [parse(fixtures['h264-aac-1']), parse(fixtures['h264-aac-2'])];
    assert.deepEqual(sampleBytes(await storedBytes(result.mediaId), videoOf(joined)),
      [...sampleBytes(fixtures['h264-aac-1'], videoOf(parts[0])), ...sampleBytes(fixtures['h264-aac-2'], videoOf(parts[1]))], 'the scenes in order');
    assert.deepEqual(api.calls.cancels, [], 'completed requests are not cancelled');
  });

  test(`${build}: fal.ai and Comfy Router clips are retried once, unless refused or in another format`, async () => {
    const video = { scenes: scenes(3, 10), estimated_duration: 30 };
    const fal = options => falApi({ model: h3Max.id, schema: h3Max.schema, ...options });
    const runFal = api => media.runMediaGeneration({ prompt: 'Story', video, config: falConfig(h3Max), fetchImpl: api.fetchImpl, pollIntervalMs: 1, retryDelayMs: 1 });
    const flaky = fal({ fail: index => index === 1 });
    assert.equal((await runFal(flaky)).clips.length, 3);
    assert.equal(flaky.calls.submits.length, 4, 'three clips and one retry');
    const broke = fal({ fail: (_index, body) => body.prompt.endsWith('Scene idea 2') && 402 });
    await assert.rejects(runFal(broke), /^Error: Clip 2 of 3 failed: fal\.ai submit failed \(HTTP 402\): the account is out of credit; add credit and try again: .*Exhausted balance/);
    assert.equal(broke.calls.submits.filter(body => body.prompt.endsWith('Scene idea 2')).length, 1, 'tried once');
    // fal.ai reports an input the model rejects when the result is read; that is not tried again either.
    const invalid = fal();
    const rejectInput = async (url, init) => (/\/requests\/req-0$/.test(url) ? json({ detail: [{ msg: 'Input should be at most 10' }] }, 422) : invalid.fetchImpl(url, init));
    await assert.rejects(media.runMediaGeneration({ prompt: 'Story', video, config: falConfig(h3Max), fetchImpl: rejectInput, pollIntervalMs: 1 }),
      /^Error: Clip 1 of 3 failed: fal\.ai result fetch failed \(HTTP 422\): .*Input should be at most 10/);
    assert.equal(invalid.calls.submits.filter(body => body.prompt.endsWith('Scene idea 1')).length, 1, 'a rejected input is tried once');
    const webm = fal({ clip: index => (index === 0 ? new TextEncoder().encode('\x1aE\xdf\xa3 webm') : fixtures['h264-aac-1']) });
    await assert.rejects(runFal(webm), /^Error: Clip 1 of 3 failed: fal\.ai did not return an MP4 video\./);
    assert.equal(webm.calls.submits.filter(body => body.prompt.endsWith('Scene idea 1')).length, 1, 'another format is not tried again');
    const comfy = comfyRouterApi({ model: rayTwo.id, schema: rayTwo.schema, fail: index => index === 0 && 402 });
    await assert.rejects(media.runMediaGeneration({ prompt: 'Story', video: { scenes: scenes(2, 5), estimated_duration: 10 },
      config: { provider: 'comfyrouter', apiKey: 'comfy-key', videoModel: rayTwo.id }, fetchImpl: comfy.fetchImpl, pollIntervalMs: 1 }),
    /^Error: Clip 1 of 2 failed: Comfy Router submit failed \(HTTP 402\): the account is out of credit; add credit and try again: .*Insufficient credits/);
    assert.equal(comfy.calls.submits.filter(body => body.prompt.endsWith('Scene idea 1')).length, 1);
  });

  test(`${build}: a fal.ai clip that is being made survives passing failures of its reads`, async () => {
    const video = { scenes: scenes(3, 10), estimated_duration: 30 };
    const run = fetchImpl => media.runMediaGeneration({ prompt: 'Story', video, config: falConfig(h3Max), fetchImpl, pollIntervalMs: 1, retryDelayMs: 1 });
    // One failure each: a status read answered 503, a status read that never
    // arrives, a result read answered 502 and a clip download answered 503.
    const api = falApi({ model: h3Max.id, schema: h3Max.schema });
    const failed = new Set();
    const first = key => !failed.has(key) && !!failed.add(key);
    const result = await run(async (url, init = {}) => {
      if (/\/req-0\/status$/.test(url) && first('status')) return json({ detail: 'Bad gateway' }, 503);
      if (/\/req-1\/status$/.test(url) && first('network')) throw new TypeError('Failed to fetch');
      if (/\/req-2$/.test(url) && first('result')) return json({ detail: 'Bad gateway' }, 502);
      if (/clip-1\.mp4$/.test(url) && first('download')) return json({ detail: 'Unavailable' }, 503);
      return api.fetchImpl(url, init);
    });
    assert.equal(failed.size, 4, 'every failure happened');
    assert.equal(result.clips.length, 3);
    assert.equal(api.calls.submits.length, 3, 'no clip is generated again');
    assert.deepEqual(api.calls.cancels, [], 'no running request is given up');
    // A refusal while polling ends the clip at once, as before.
    const refused = falApi({ model: h3Max.id, schema: h3Max.schema });
    let reads = 0;
    await assert.rejects(run(async (url, init = {}) => {
      if (/\/req-0\/status$/.test(url)) { reads += 1; return json({ detail: 'Forbidden' }, 403); }
      return refused.fetchImpl(url, init);
    }), /^Error: Clip 1 of 3 failed: fal\.ai status check failed \(HTTP 403\)/);
    assert.equal(reads, 1);
    assert.equal(refused.calls.submits.filter(body => body.prompt.endsWith('Scene idea 1')).length, 1);
    // A queue that stays unreachable is given up after five reads, and the clip's one retry follows.
    const down = falApi({ model: h3Max.id, schema: h3Max.schema });
    const polls = new Map();
    await assert.rejects(run(async (url, init = {}) => {
      const job = /\/(req-\d+)\/status$/.exec(url)?.[1];
      if (job && down.calls.submits[Number(job.slice(4))].prompt.endsWith('Scene idea 1')) {
        polls.set(job, (polls.get(job) || 0) + 1);
        return json({ detail: 'Bad gateway' }, 503);
      }
      return down.fetchImpl(url, init);
    }), /^Error: Clip 1 of 3 failed: fal\.ai status check failed \(HTTP 503\)/);
    assert.deepEqual([...polls.values()], [5, 5], 'five reads of the request, then five of its retry');
  });

  test(`${build}: a failed video keeps its finished clips, and the retry generates only the rest`, async () => {
    // fal.ai reports a scene the model refuses when its result is read.
    const refusing = api => async (url, init = {}) => {
      const job = /\/requests\/req-(\d+)$/.exec(url);
      if (job && init.method === undefined && api.calls.submits[job[1]].prompt.endsWith('flagged')) {
        await new Promise(done => setTimeout(done, 20));
        return json({ detail: [{ type: 'content_policy_violation', msg: 'The prompt was flagged.' }] }, 422);
      }
      return api.fetchImpl(url, init);
    };
    const story = last => ({ prompt: 'Story', scenes: [...scenes(3, 10), { prompt: last, duration: 10 }], estimated_duration: 40 });
    const run = (api, args, options) => generate(args, { config: falConfig(h3Max), fetchImpl: refusing(api), pollIntervalMs: 1, ...options });
    const first = falApi({ model: h3Max.id, schema: h3Max.schema });
    const stored = assets.size;
    const failed = await run(first, story('Something flagged'));
    assert.equal(failed.success, false);
    assert.match(failed.error, /^Clip 4 of 4 failed: fal\.ai result fetch failed \(HTTP 422\): .*content_policy_violation/);
    assert.match(failed.error, /3 of 4 clips are finished and kept for 30 minutes: a retry generates only the scenes that are missing or changed\./);
    assert.equal(failed.clipsKept, 3);
    assert.equal(first.calls.submits.length, 4);
    assert.equal(assets.size, stored, 'nothing is shown in the chat yet');
    // The agent rewrites the refused scene and leaves the others as they were.
    const second = falApi({ model: h3Max.id, schema: h3Max.schema });
    const progress = [];
    const retried = await run(second, story('Something fine'), { onProgress: message => progress.push(message) });
    assert.equal(retried.success, true, retried.error);
    assert.deepEqual(second.calls.submits.map(body => body.prompt), ['Story\n\nSomething fine'], 'only the changed scene is generated');
    assert.deepEqual([retried.clipCount, retried.reusedClips, retried.durationSeconds], [4, 3, 4]);
    assert.equal(join.mp4DurationSeconds(await storedBytes(retried.mediaId)), 4, 'one joined video of all four scenes');
    assert.deepEqual(progress, ['Generating 1 of 4 video clips; 3 kept from the last attempt…', 'Video clips: 4 of 4 ready', 'Joining 4 clips…']);
    // A video that succeeded is generated anew when it is asked for again.
    const again = falApi({ model: h3Max.id, schema: h3Max.schema });
    const repeated = await run(again, story('Something fine'));
    assert.equal(repeated.success, true, repeated.error);
    assert.equal(again.calls.submits.length, 4);
    assert.equal(repeated.reusedClips, undefined);
    // Kept clips are those of the same request: another shared look gets its own.
    const third = falApi({ model: h3Max.id, schema: h3Max.schema });
    assert.equal((await run(third, story('Something flagged'))).clipsKept, 3);
    const other = falApi({ model: h3Max.id, schema: h3Max.schema });
    const restyled = await run(other, { ...story('Something fine'), prompt: 'Another look' });
    assert.equal(restyled.success, true, restyled.error);
    assert.equal(other.calls.submits.length, 4);
    // Stop keeps what it has without changing what the user is told.
    media.forgetKeptVideoClips();
    const controller = new AbortController();
    const stopping = falApi({ model: h3Max.id, schema: h3Max.schema });
    const stopped = await generate(story('Something fine'), { config: falConfig(h3Max), pollIntervalMs: 1, signal: controller.signal,
      fetchImpl: async (url, init = {}) => {
        // The user presses Stop when the fourth clip is submitted, after the first three are ready.
        if (init.method === 'POST' && JSON.parse(init.body).prompt.endsWith('Something fine')) {
          controller.abort(new Error('Stopped by user.'));
          init.signal.throwIfAborted();
        }
        return stopping.fetchImpl(url, init);
      } });
    assert.deepEqual([stopped.success, stopped.error, stopped.clipsKept], [false, 'Stopped by user.', undefined]);
    const resumed = falApi({ model: h3Max.id, schema: h3Max.schema });
    const continued = await run(resumed, story('Something fine'));
    assert.equal(continued.success, true, continued.error);
    assert.ok(continued.reusedClips >= 1 && resumed.calls.submits.length === 4 - continued.reusedClips, 'the clips finished before Stop are used');
  });

  test(`${build}: kept clips are not used with another saved model input`, async () => {
    const story = last => ({ prompt: 'Story', scenes: [...scenes(3, 5), { prompt: last, duration: 5 }], estimated_duration: 20 });
    const settings = loop => ({ provider: 'comfyrouter', apiKey: 'comfy-key', videoModel: rayTwo.id, videoParameters: JSON.stringify({ model: 'ray-2', loop }) });
    // Comfy Router refuses the last scene when it is submitted, after the others are ready.
    const run = (api, loop, last) => generate(story(last), { config: settings(loop), pollIntervalMs: 1, fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST' && JSON.parse(init.body).prompt.endsWith('flagged')) {
        await new Promise(done => setTimeout(done, 20));
        return json({ detail: 'The prompt was flagged.', error_type: 'content_policy_violation' }, 422);
      }
      return api.fetchImpl(url, init);
    } });
    const first = comfyRouterApi({ model: rayTwo.id, schema: rayTwo.schema });
    const failed = await run(first, false, 'Something flagged');
    assert.match(failed.error, /^Clip 4 of 4 failed: Comfy Router submit failed \(HTTP 422\)/);
    assert.equal(failed.clipsKept, 3);
    // The user changes the saved video model input before the retry: every clip is made with it.
    const changed = comfyRouterApi({ model: rayTwo.id, schema: rayTwo.schema });
    const remade = await run(changed, true, 'Something fine');
    assert.equal(remade.success, true, remade.error);
    assert.deepEqual(changed.calls.submits.map(body => body.loop), [true, true, true, true]);
    assert.equal(remade.reusedClips, undefined);
    // With the input the kept clips were made with, they are used.
    const same = comfyRouterApi({ model: rayTwo.id, schema: rayTwo.schema });
    const retried = await run(same, false, 'Something fine');
    assert.equal(retried.success, true, retried.error);
    assert.deepEqual(same.calls.submits.map(body => [body.loop, body.prompt]), [[false, 'Story\n\nSomething fine']]);
    assert.equal(retried.reusedClips, 3);
  });

  test(`${build}: a failed clip waits before its retry, as long as the provider asks`, async () => {
    // One scene whose first submission is rate limited; the time between the two submissions.
    const wait = async (headers, retryDelayMs) => {
      const api = falApi({ model: h3Max.id, schema: h3Max.schema });
      const times = [];
      const result = await media.runMediaGeneration({ prompt: 'Story', video: { scenes: scenes(1, 10), estimated_duration: 10 },
        config: falConfig(h3Max), pollIntervalMs: 1, retryDelayMs, fetchImpl: async (url, init = {}) => {
          if (init.method === 'POST' && times.push(performance.now()) === 1) return json({ detail: 'Rate limited' }, 429, headers);
          return api.fetchImpl(url, init);
        } });
      assert.equal(result.clips.length, 1);
      return times[1] - times[0];
    };
    assert.ok(await wait({}, 40) >= 30, 'the given wait');
    const asked = await wait({ 'Retry-After': '0.04' }, 60000);
    assert.ok(asked >= 30 && asked < 5000, `Retry-After over the given wait (waited ${asked} ms)`);
  });

  test(`${build}: each clip of a joined video may end a frame early`, async () => {
    // Clips of 0.96 s for scenes of 1 s: a model that ends each clip on a frame boundary.
    const early = patched('h264-aac-1', (view, file) => view.setUint32(videoOf(file).edts.elst.start + 16, 960));
    for (const [count, seconds] of [[2, 1.9], [8, 7.7]]) {
      const api = falApi({ model: h3Max.id, schema: h3Max.schema, clip: () => early });
      const result = await generate({ prompt: 'Story', scenes: scenes(count, 1), estimated_duration: count },
        { config: falConfig(h3Max), fetchImpl: api.fetchImpl, pollIntervalMs: 1, videoDurationTarget: count });
      assert.equal(result.success, true, result.error);
      assert.deepEqual([result.clipCount, result.durationSeconds, result.durationStatus, result.notice], [count, seconds, 'enough', undefined]);
    }
    // Half of what was asked for is still short.
    const api = falApi({ model: h3Max.id, schema: h3Max.schema });
    const half = await generate({ prompt: 'Story', scenes: scenes(8, 2), estimated_duration: 16 },
      { config: falConfig(h3Max), fetchImpl: api.fetchImpl, pollIntervalMs: 1, videoDurationTarget: 16 });
    assert.deepEqual([half.durationSeconds, half.durationStatus], [8, 'short']);
  });

  test(`${build}: a refused fal.ai or Comfy Router clip cancels the clips still being made`, async () => {
    // Clip 2 is refused at once; clips 1 and 3 stay in progress until cancelled.
    const pending = api => async (url, init = {}) => {
      if (init.method !== 'POST' && /\/requests\/req-[02]\/status$/.test(url)) return json({ status: 'IN_PROGRESS' });
      return api.fetchImpl(url, init);
    };
    // The run's error and the cancellations sent before the test stops it; a
    // run that is still waiting fails the assertion.
    const outcome = async (api, options) => {
      const stop = new AbortController();
      try {
        const error = await settled(media.runMediaGeneration({ prompt: 'Story', fetchImpl: pending(api), pollIntervalMs: 1, signal: stop.signal, ...options })
          .catch(failure => failure.message));
        await new Promise(done => setTimeout(done, 20));
        return { error, cancels: api.calls.cancels.slice().sort() };
      } finally { stop.abort(new Error('Test over.')); }
    };
    const fal = falApi({ model: h3Max.id, schema: h3Max.schema, fail: index => index === 1 && 402 });
    const falRun = await outcome(fal, { video: { scenes: scenes(3, 10), estimated_duration: 30 }, config: falConfig(h3Max) });
    assert.match(falRun.error, /^Clip 2 of 3 failed: fal\.ai submit failed \(HTTP 402\)/);
    assert.deepEqual(falRun.cancels, [0, 2].map(index => `https://queue.fal.run/${h3Max.id}/requests/req-${index}/cancel`));
    const comfy = comfyRouterApi({ model: rayTwo.id, schema: rayTwo.schema, fail: index => index === 1 && 402 });
    const comfyRun = await outcome(comfy, { video: { scenes: scenes(3, 5), estimated_duration: 15 }, config: { provider: 'comfyrouter', apiKey: 'comfy-key', videoModel: rayTwo.id } });
    assert.match(comfyRun.error, /^Clip 2 of 3 failed: Comfy Router submit failed \(HTTP 402\)/);
    assert.deepEqual(comfyRun.cancels, [0, 2].map(index => `https://api.comfy.org/v2/models/${rayTwo.id}/requests/req-${index}/cancel`));
  });

  test(`${build}: Stop ends every clip of a fal.ai video`, async () => {
    const controller = new AbortController();
    const api = falApi({ model: h3Max.id, schema: h3Max.schema });
    const stored = assets.size;
    const result = await generate({ prompt: 'Story', scenes: scenes(5, 10), estimated_duration: 50 }, {
      config: falConfig(h3Max), pollIntervalMs: 1, signal: controller.signal,
      // The user presses Stop while the first clip downloads.
      fetchImpl: async (url, init) => {
        if (url.startsWith('https://v3b.fal.media/')) {
          controller.abort(new Error('Stopped by user.'));
          init.signal.throwIfAborted();
        }
        return api.fetchImpl(url, init);
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Stopped by user.');
    assert.equal(api.calls.submits.length, 3, 'clips 4 and 5 never start');
    assert.equal(assets.size, stored);
  });

  test(`${build}: clips that cannot be joined are kept and shown in order`, async () => {
    const api = videoApi({ entry: grok, clip: job => (job.index === 1 ? fixtures['h264-aac-48px'] : fixtures['h264-aac-1']) });
    const result = await generate({ prompt: 'Story', scenes: scenes(2, 10), estimated_duration: 20 }, { fetchImpl: api.fetchImpl });
    assert.equal(result.success, true, result.error);
    assert.equal(result.joined, false);
    assert.match(result.joinError, /different codec settings/, 'the trace shows why');
    assert.equal(result.clipCount, 2);
    assert.equal(result.durationSeconds, 2);
    assert.equal(result.mediaId, undefined);
    assert.deepEqual(result.clips.map(clip => clip.mimeType), ['video/mp4', 'video/mp4']);
    assert.deepEqual(await storedBytes(result.clips[1].mediaId), fixtures['h264-aac-48px']);
    const compacted = journal.compactRunUiData('tool_result', { name: 'generate_image', result });
    assert.deepEqual(compacted.result.clips, result.clips, 'the journal keeps the clips for replay');
    assert.equal(compacted.result.joined, false);
    assert.equal(compacted.result.clipCount, 2);
    const agent = new Agent({ getActive: () => chatProvider });
    const forModel = JSON.parse(agent._limitToolResult(result));
    assert.ok(forModel.clips.every(clip => !('mediaId' in clip)), 'asset handles stay out of model context');
    assert.match(forModel.note, /shows them one after another/);
    assert.match(forModel.note, /You have not seen it/);
    assert.match(forModel.note, /do not invent a hosted URL/);
  });

  test(`${build}: the chat shows a joined video as one video that plays to the end`, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/__media.html`);
      const shown = await page.evaluate(async ({ build, entry }) => {
        const { generateImage } = await import(`/src/${build}/src/agent/generative-media.js`);
        const { appendGeneratedMedia } = await import(`/src/${build}/src/ui/generated-media-view.js`);
        const { compactRunUiData } = await import(`/src/${build}/src/run-ui-journal.js`);
        const fixture = async name => (await fetch(`/test/fixtures/video/${name}.mp4`)).arrayBuffer();
        const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Retry-After': '0.001' } });
        const run = clips => {
          let submitted = 0;
          return generateImage({ prompt: 'Test pattern', scenes: clips.map((_, i) => ({ prompt: `Part ${i + 1}`, duration: 1 })), estimated_duration: clips.length }, {
            config: { provider: 'openrouter', apiKey: 'synthetic-key', model: entry.id },
            fetchImpl: async (url, init = {}) => {
              if (url.endsWith('/images/models')) return reply({ data: [] });
              if (url.endsWith('/videos/models')) return reply({ data: [entry] });
              if (init.method === 'POST') return reply({ id: `job-${submitted++}` }, 202);
              const [, index, content] = /job-(\d+)(\/content)?/.exec(url);
              return content ? new Response(await fixture(clips[index]), { headers: { 'Content-Type': 'video/mp4' } }) : reply({ status: 'completed' });
            },
          });
        };
        // What the side panel renders: the run journal's copy of the tool result.
        const show = async result => {
          if (!result.success) throw new Error(result.error);
          const container = document.createElement('div');
          document.querySelector('#chat').append(container);
          await appendGeneratedMedia(container, compactRunUiData('tool_result', { name: 'generate_image', result }).result, key => key);
          return container;
        };
        const joined = await run(['vp9-opus-1', 'vp9-opus-2']);
        const single = await show(joined);
        const video = single.querySelector('video');
        await new Promise((resolve, reject) => {
          if (video.readyState >= 1) resolve();
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error(`media error ${video.error?.code}`));
        });
        video.muted = true;
        video.playbackRate = 4;
        const ended = new Promise(resolve => { video.onended = () => resolve(true); setTimeout(() => resolve(false), 8000); });
        await video.play();
        const playedToEnd = await ended;
        const separate = await run(['vp9-opus-1', 'h264-aac-48px']);
        const several = await show(separate);
        return {
          joined: { clipCount: joined.clipCount, durationSeconds: joined.durationSeconds, videos: single.querySelectorAll('video').length,
            duration: video.duration, playedToEnd, frames: video.getVideoPlaybackQuality().totalVideoFrames,
            download: single.querySelector('a[download]')?.getAttribute('download') },
          separate: { joined: separate.joined, clips: separate.clips.map(clip => clip.mediaId),
            shown: [...several.querySelectorAll('.generated-media')].map(wrapper => wrapper.dataset.mediaId),
            playable: [...several.querySelectorAll('video')].map(element => element.src.startsWith('blob:')) },
        };
      }, { build, entry: grok });
      assert.deepEqual(shown.joined, { clipCount: 2, durationSeconds: 2, videos: 1, duration: 2, playedToEnd: true,
        frames: shown.joined.frames, download: 'webbrain-media.mp4' });
      assert.ok(shown.joined.frames >= 20, `rendered ${shown.joined.frames} frames`);
      assert.equal(shown.separate.joined, false);
      assert.deepEqual(shown.separate.shown, shown.separate.clips, 'unjoinable clips appear in order');
      assert.deepEqual(shown.separate.playable, [true, true]);
    } finally { await page.close(); }
  });

  test(`${build}: the agent asks on WebBrain's card, and an unattended run cannot`, async () => {
    const tab = 41, request = 'video-request', runId = 'video-run';
    const agent = new Agent({ getActive: () => chatProvider });
    agent._persist = () => {};
    agent._runningTabs.add(tab);
    agent.currentRunId.set(tab, runId);
    agent.conversations.set(tab, [{ role: 'system', content: 'Owned fixture.' }, { role: 'user', content: 'Turn this page into a video.' }]);
    agent._beginSteeringRun(tab, () => {}, { detachedRequestId: request });
    const details = { estimatedSeconds: 330, totalSeconds: 120, clipCount: 8, maxSeconds: 120 };
    const updates = [];
    const onUpdate = (type, data) => {
      updates.push({ type, data });
      if (type === 'clarify') agent._capturePendingClarificationForUi(tab, request, data, { seq: 1, runId });
    };
    const answer = agent._promptVideoLengthConfirmation(tab, details, onUpdate);
    const card = updates.find(update => update.type === 'clarify').data;
    assert.equal(card.promptKind, 'video_length');
    assert.deepEqual(card.videoLengthConfirmation, details);
    assert.deepEqual(card.options, ['once', 'deny']);
    assert.equal(card.timeoutSec, undefined, 'the card never times out');
    assert.match(card.question, /needs about 5:30.*up to 2:00.*2:00 version from 8 clips/);
    assert.deepEqual(agent.activeRunState(tab).pendingCurrentClarification.data.videoLengthConfirmation, details, 'a reopened panel can show the card');
    agent.submitClarifyResponse(tab, card.clarifyId, 'once', 'user');
    assert.equal(await settled(answer), 'once');
    const cancelled = agent._promptVideoLengthConfirmation(tab, details, onUpdate);
    agent._cancelClarifications(tab, 'Stopped');
    assert.equal(await settled(cancelled), null);
    updates.length = 0;
    agent.scheduledRunPolicies.set(tab, { requireConsequentialConfirmation: false });
    assert.equal(await settled(agent._promptVideoLengthConfirmation(tab, details, onUpdate)), 'unavailable');
    assert.equal(updates.length, 0, 'an unattended run shows no card');
    agent.scheduledRunPolicies.delete(tab);
    assert.equal(await settled(agent._promptVideoLengthConfirmation(tab, details, null)), 'unavailable');
    agent._cancelClarifications(tab, 'cleanup');
  });

  test(`${build}: a scheduled run keeps the video length card for a reopened panel`, async () => {
    let finish;
    const details = { estimatedSeconds: 330, totalSeconds: 120, clipCount: 8, maxSeconds: 120 };
    const h = makeSchedulerHarness(Scheduler, {
      processMessage: async (_tab, _message, onUpdate) => {
        onUpdate('clarify', { promptKind: 'video_length', clarifyId: 'video_length_1', options: ['once', 'deny'],
          question: 'This video needs about 5:30, but WebBrain makes videos up to 2:00. Generate a 2:00 version from 8 clips instead?',
          videoLengthConfirmation: details });
        await new Promise(resolve => { finish = resolve; });
        return 'done';
      },
    });
    const created = await h.manager.createResumeJob({ tabId: 77, conversationId: 'conv-1',
      args: { after_seconds: 60, reason: 'wait', resume_instruction: 'make the video' } });
    const running = h.manager.handleAlarm(h.alarmName(created.jobId));
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = h.jobs()[0].pendingClarify;
    assert.equal(h.jobs()[0].status, 'needs_user_input');
    assert.equal(pending.promptKind, 'video_length');
    assert.deepEqual(pending.options, ['once', 'deny']);
    assert.deepEqual(pending.videoLengthConfirmation, details);
    assert.equal(pending.timeoutSec, undefined, 'no countdown');
    finish();
    await running;
  });

  test(`${build}: generate_image in a run reports clip progress and asks before a long video`, async () => {
    const tab = 43;
    const agent = new Agent({ getActive: () => chatProvider });
    agent._persist = () => {};
    const updates = [];
    let answer = 'deny';
    const onUpdate = (type, data) => {
      updates.push({ type, data });
      if (type === 'clarify') agent.submitClarifyResponse(tab, data.clarifyId, answer, 'user');
    };
    const originalFetch = globalThis.fetch;
    try {
      const short = videoApi({ entry: grok });
      globalThis.fetch = short.fetchImpl;
      const result = await agent._executeToolImpl(tab, 'generate_image', { prompt: 'Explainer', scenes: scenes(2, 10), estimated_duration: 20 }, onUpdate, { imageGenConfig: config });
      assert.equal(result.success, true, result.error);
      assert.equal(result.clipCount, 2);
      assert.ok(assets.has(result.mediaId));
      assert.deepEqual(updates.map(({ type, data }) => [type, data.name, data.message]), [
        ['tool_progress', 'generate_image', 'Generating 2 video clips…'],
        ['tool_progress', 'generate_image', 'Video clips: 1 of 2 ready'],
        ['tool_progress', 'generate_image', 'Video clips: 2 of 2 ready'],
        ['tool_progress', 'generate_image', 'Joining 2 clips…'],
      ]);
      updates.length = 0;
      const long = videoApi({ entry: grok });
      globalThis.fetch = long.fetchImpl;
      const declined = await agent._executeToolImpl(tab, 'generate_image', { prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, onUpdate, { imageGenConfig: config });
      assert.deepEqual(updates.map(update => [update.type, update.data.promptKind]), [['clarify', 'video_length']]);
      assert.equal(declined.success, false);
      assert.match(declined.error, /The user chose not to generate the 2:00 version/);
      assert.equal(long.calls.submits.length, 0);
      answer = 'once';
      const approved = await agent._executeToolImpl(tab, 'generate_image', { prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, onUpdate, { imageGenConfig: config });
      assert.equal(approved.success, true, approved.error);
      assert.equal(approved.clipCount, 8);
      assert.equal(long.calls.submits.length, 8);
    } finally { globalThis.fetch = originalFetch; }
  });

  test(`${build}: the generate_image schema takes media and scenes, and nothing else`, async () => {
    const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
    const local = { get: async () => ({ imageGenModel: config }), set: async () => {}, remove: async () => {} };
    globalThis.chrome = globalThis.browser = {
      storage: { local, session: local }, runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
      tabs: { get: async id => ({ id, url: 'https://example.com', title: 'Example' }), sendMessage: async () => ({}) },
      scripting: { executeScript: async () => [{ result: null }] },
    };
    try {
      const provider = { supportsVision: false, promptTier: 'full' };
      const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
      agent._ensureGateSetting = async () => {};
      agent._persist = () => {};
      agent.permissions.check = () => ({ allowed: true });
      const dispatched = [], messages = [];
      agent.executeTool = async (_tab, _name, args) => { dispatched.push(args); return { success: false, error: 'Not generated in this test.' }; };
      const call = args => agent._executeToolBatch(12, [{ id: 'media-call', function: { name: 'generate_image', arguments: JSON.stringify(args) } }],
        messages, () => {}, provider, '', new Set(['generate_image']), 1);
      const valid = { prompt: 'Flat motion graphics', media: 'video', scenes: [{ prompt: 'Title card', duration: 6 }, { prompt: 'The idea', duration: 15 }],
        estimated_duration: 21, aspect_ratio: '16:9', resolution: '720p' };
      await call(valid);
      assert.deepEqual(dispatched, [valid]);
      for (const [invalid, path] of [
        [{ ...valid, scenes: [{ prompt: 'Title card', duration: 6, camera: 'drone' }] }, '$.scenes[0].camera'],
        [{ ...valid, scenes: [{ prompt: 'Title card' }] }, '$.scenes[0].duration'],
        [{ ...valid, estimated_duration: 0 }, '$.estimated_duration'],
        [{ ...valid, duration: '8s' }, '$.duration'],
        [{ ...valid, media: 'audio' }, '$.media'],
      ]) {
        messages.length = 0;
        await call(invalid);
        assert.match(messages[0].content, /invalid_tool_arguments/, path);
        assert.ok(messages[0].content.includes(path), `${path}: ${messages[0].content}`);
      }
      assert.equal(dispatched.length, 1, 'invalid calls are not dispatched');
    } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
  });

  test(`${build}: the side panel card states the length in the user's language`, async () => {
    const source = (await fs.readFile(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const extract = name => {
      const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
      assert.ok(start >= 0, name);
      return source.slice(start, source.indexOf('\n}', start) + 2);
    };
    const dictionary = (await import(`../src/${build}/src/ui/locales/tr.js`)).default;
    const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    for (const key of ['question', 'offer', 'generate', 'dont', 'seconds']) {
      assert.equal(typeof english[`sp.video_length.${key}`], 'string', key);
      assert.notEqual(dictionary[`sp.video_length.${key}`], english[`sp.video_length.${key}`], `tr ${key} is translated`);
    }
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="messages"><div class="message assistant" data-run-request-id="video-request"><div class="message-content"><div class="message-text"></div></div></div></div>');
      await page.evaluate(({ functions, dictionary }) => {
        const noop = () => {};
        Object.assign(window, {
          messagesEl: document.querySelector('#messages'), currentAssistantEl: document.querySelector('.assistant'), currentTabId: 7,
          submittedClarificationIds: new Set(), answers: [],
          t: (key, params) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => (params?.[name] != null ? String(params[name]) : `{${name}}`)),
          submitClarify: (_card, _tab, clarifyId, value, source) => window.answers.push({ clarifyId, value, source }),
          hideRecommendedActions: noop, resetChatNavigation: noop, hideActivity: noop, scrollToBottom: noop, applyClarifyTimeoutExtension: noop,
          addMessage: () => { throw new Error('no new message'); },
        });
        (0, eval)(functions);
        window.renderClarifyCard({ clarifyId: 'video_length_1', promptKind: 'video_length', question: 'English fallback',
          videoLengthConfirmation: { estimatedSeconds: 330, totalSeconds: 120, clipCount: 8, maxSeconds: 120 }, options: ['once', 'deny'] });
      }, { functions: ['renderClarifyCard', 'clarificationSubmissionKey'].map(extract).join('\n'), dictionary });
      const card = page.locator('.clarify-card[data-video-length-confirmation="1"]');
      assert.equal(await card.locator('.clarify-question').innerText(), 'Bu video yaklaşık 5:30 gerektiriyor, ancak WebBrain en fazla 2:00 uzunluğunda video üretiyor.');
      assert.equal(await card.locator('.clarify-reason').innerText(), 'Bunun yerine 8 klipten 2:00 uzunluğunda bir sürüm üretilsin mi?');
      assert.deepEqual(await card.locator('.clarify-option').allInnerTexts(), ['2:00 sürümünü üret', 'Üretme']);
      assert.equal(await card.locator('.clarify-input').count(), 0, 'fixed choices, no free text');
      await card.locator('.clarify-option[data-value="deny"]').click();
      assert.deepEqual(await page.evaluate(() => window.answers), [{ clarifyId: 'video_length_1', value: 'deny', source: 'option' }]);
    } finally { await page.close(); }
  });

  test(`${build}: video delivery preserves the target and reports measured shortfalls without losing assets`, async () => {
    const api = falApi({ model: h3Max.id, schema: h3Max.schema });
    const result = await generate({
      prompt: 'Consistent cast', media: 'video', scenes: scenes(4, 15), estimated_duration: 60,
    }, { config: falConfig(h3Max), fetchImpl: api.fetchImpl, pollIntervalMs: 1 });
    assert.equal(result.success, true, result.error);
    assert.deepEqual([result.estimatedSeconds, result.plannedSeconds, result.durationSeconds, result.durationStatus],
      [60, 60, 4, 'short'], 'provider fixtures return only one second per requested 15-second clip');
    assert.equal(api.calls.submits.length, 4, 'no extra paid generation to repair the shortfall');
    assert.ok((await storedBytes(result.mediaId)).length, 'the generated asset is still downloadable');
    const agent = new Agent({ getActive: () => chatProvider });
    const forModel = JSON.parse(agent._limitToolResult(result));
    assert.match(forModel.note, /planned 60 s/);
    assert.match(forModel.note, /incomplete/);
    assert.doesNotMatch(forModel.note, /Tell the user it is ready/);
    const compacted = journal.compactRunUiData('tool_result', { name: 'generate_image', result });
    for (const key of ['estimatedSeconds', 'plannedSeconds', 'durationSeconds', 'durationStatus', 'notice']) {
      assert.equal(compacted.result[key], result[key], key);
    }
    const incompatible = falApi({ model: h3Max.id, schema: h3Max.schema,
      clip: index => fixtures[index ? 'h264-aac-48px' : 'h264-aac-1'] });
    const separate = await generate({ prompt: 'Story', scenes: scenes(2, 15), estimated_duration: 30 },
      { config: falConfig(h3Max), fetchImpl: incompatible.fetchImpl, pollIntervalMs: 1 });
    assert.equal(separate.success, true, separate.error);
    assert.equal(separate.joined, false);
    assert.equal(separate.durationStatus, 'short');
    for (const clip of separate.clips) assert.ok((await storedBytes(clip.mediaId)).length);
    const separateForModel = JSON.parse(agent._limitToolResult(separate));
    assert.match(separateForModel.note, /incomplete/);
    assert.match(separateForModel.note, /could not be joined/);
  });

  test(`${build}: video delivery distinguishes a measured approved plan from an unmeasured hosted clip`, async () => {
    const api = videoApi({ entry: { ...grok, supported_durations: [1] } });
    const approved = await generate({
      prompt: 'Short version', scenes: scenes(2, 1), estimated_duration: 330,
    }, { fetchImpl: api.fetchImpl, confirmVideoLength: async () => 'once' });
    assert.equal(approved.success, true, approved.error);
    assert.deepEqual([approved.estimatedSeconds, approved.plannedSeconds, approved.durationSeconds, approved.durationStatus],
      [330, 2, 2, 'enough'], 'delivery is measured against the explicitly approved shorter plan');
    assert.equal(approved.notice, undefined);
    assert.equal(approved.approvedDurationSeconds, 2);
    assert.equal(journal.compactRunUiData('tool_result', { name: 'generate_image', result: approved }).result.approvedDurationSeconds, 2);

    const fal = falApi({ model: h3Max.id, schema: h3Max.schema });
    const hosted = await generate({ prompt: 'A short clip', media: 'video', duration: 10, estimated_duration: 10 },
      { config: falConfig(h3Max), fetchImpl: fal.fetchImpl, pollIntervalMs: 1 });
    assert.equal(hosted.success, true, hosted.error);
    assert.deepEqual([hosted.estimatedSeconds, hosted.plannedSeconds, hosted.durationSeconds, hosted.durationStatus],
      [10, 10, undefined, 'unverified']);
    assert.match(hosted.notice, /has not been measured/);
    assert.deepEqual(fal.calls.downloads, [], 'a hosted single clip remains a hosted result');
  });

  test(`${build}: the model reports a joined video's length, never its contents`, () => {
    const agent = new Agent({ getActive: () => chatProvider });
    const forModel = JSON.parse(agent._limitToolResult({ success: true, provider: 'openrouter', model: grok.id,
      mediaId: 'private-asset-id', mimeType: 'video/mp4', inlineMedia: true, durationSeconds: 112.5, clipCount: 8 }));
    assert.equal(forModel.mediaId, undefined);
    assert.equal(forModel.durationSeconds, 112.5);
    assert.equal(forModel.clipCount, 8);
    assert.match(forModel.note, /describe it only by what you asked for and by its durationSeconds and clipCount/);
    assert.doesNotMatch(forModel.note, /one after another/);
    const compacted = journal.compactRunUiData('tool_result', { name: 'generate_image', result: { success: true, mediaId: 'a', mimeType: 'video/mp4', durationSeconds: 112.5, clipCount: 8 } });
    assert.equal(compacted.result.durationSeconds, 112.5);
    assert.equal(compacted.result.clipCount, 8);
  });
}
