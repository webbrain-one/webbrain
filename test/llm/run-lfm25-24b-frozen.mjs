#!/usr/bin/env node
// Replay the actual May 23 requests: do not rebuild their user messages.
// Usage: node test/llm/run-lfm25-24b-frozen.mjs --stage prepare|preflight|full|report
// Add --candidate bonsai --base http://HOST:PORT for Ternary Bonsai 2 27B.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { extractToolCallFromContent } from './lib/content-tool-call-parser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const date = '2026-11-15';
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const candidate = option('--candidate', 'lfm');
assert(['lfm', 'bonsai'].includes(candidate), 'Candidate must be lfm or bonsai.');
const concurrency = Number(option('--concurrency', '1'));
assert(Number.isInteger(concurrency) && concurrency > 0, 'Concurrency must be a positive integer.');
const timeoutMs = Number(option('--timeout', '180000'));
assert(Number.isInteger(timeoutMs) && timeoutMs > 0, 'Timeout must be a positive integer in milliseconds.');
const out = join(here, `analysis/${date}-16gb-frozen-comparison${candidate === 'bonsai' ? '-bonsai2' : ''}`);
const base = String(option('--base', candidate === 'lfm' ? 'http://192.168.1.51:8080' : '')).replace(/\/+$/, '');
const freezePath = join(here, 'freeze/baseline-2026-05-23.json');
const rubricPath = join(here, 'analysis/2026-10-03-nex-n25/rubrics.json');
const sources = [
  { label: 'Qwen 3.5 9B', date: '2026-05-23', dir: '2026-05-23T17-10-45-044Z_chrome_qwen3.5-9b' },
  { label: 'Gemma 4 26B-A4B', date: '2026-05-23', dir: '2026-05-23T17-12-24-636Z_chrome_google_gemma-4-26b-a4b' },
  { label: 'LFM 2.5 24B-A2B Q4_K_XL', date, dir: `${date}-lfm25-24b-q4-k-xl-may23-replay_chrome_lfm2.5-24b-a2b_frozen`, fresh: true },
];
if (candidate === 'bonsai') sources.push({ label: 'Ternary Bonsai 2 27B', date, fresh: true,
  dir: `${date}-ternary-bonsai2-27b-may23-replay_chrome_ternary-bonsai-2-27b_frozen` });
const activeSource = sources.at(-1);
const sonnetDir = join(here, 'results/2026-05-23T18-47-31-246Z_chrome_anthropic_claude-sonnet-4.6');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const repoPath = file => relative(root, file).replaceAll('\\', '/');
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const files = readdirSync(sonnetDir).filter(file => /^\d{3}\.json$/.test(file)).sort();
const freeze = read(freezePath);
const rubrics = read(rubricPath);
const stage = process.argv[process.argv.indexOf('--stage') + 1];
const resume = process.argv.includes('--resume');
assert(['prepare', 'preflight', 'full', 'report'].includes(stage), 'Specify --stage prepare|preflight|full|report.');
assert.equal(files.length, 100);
assert.equal(freeze.tools.length, 41);
assert.equal(sha(freeze.systemContent), freeze.meta.systemHash);
assert.equal(rubrics.sourceDate, '2026-05-23');
mkdirSync(out, { recursive: true });

function checkArchivedInputs() {
  const audit = [];
  for (const source of sources.filter(source => !source.fresh)) {
    for (const file of files) {
      const path = join(here, 'results', source.dir, file);
      const record = read(path), reference = read(join(sonnetDir, file));
      const request = record.request;
      assert.equal(request.messages[0].content, freeze.systemContent);
      assert.deepEqual(request.tools, freeze.tools);
      assert.deepEqual({ ...request, model: reference.request.model }, reference.request, `${source.label}/${file}: historical payload drift`);
      assert.equal(request.temperature, 0.15);
      assert.equal(request.max_tokens, 4096);
      audit.push({ model: source.label, id: record.id, source: repoPath(path), sha256: sha(readFileSync(path)),
        requestSha256: sha(JSON.stringify(request)), sonnetSha256: sha(readFileSync(join(sonnetDir, file))) });
    }
  }
  write(join(out, 'historical-input-audit.json'), { date, casesPerModel: 100, tools: 41,
    systemHash: freeze.meta.systemHash, freezeSha256: sha(readFileSync(freezePath)),
    rubricSource: repoPath(rubricPath), rubricSha256: sha(readFileSync(rubricPath)),
    note: 'All 200 historical requests equal the corresponding archived Sonnet request after replacing only model.', records: audit });
  console.log('Verified all 200 historical requests: identical messages, tools, temperature and output budget.');
}

async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(10000) });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}

async function checkContextCapacity(model, props) {
  const original = read(join(sonnetDir, files[0]));
  const request = { ...original.request, model };
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    assert(response.ok, `${path}: HTTP ${response.status}`);
    return response.json();
  };
  const applied = await post('/apply-template', request);
  assert.equal(typeof applied.prompt, 'string', 'The template endpoint did not return a prompt.');
  const tokenized = await post('/tokenize', { content: applied.prompt, add_special: false });
  assert(Array.isArray(tokenized.tokens), 'The tokenize endpoint did not return tokens.');
  const inputTokens = tokenized.tokens.length;
  const capacity = props.default_generation_settings?.n_ctx;
  const evidence = { checkedAt: new Date().toISOString(), model, case: original.id, inputTokens,
    maxOutputTokens: request.max_tokens, neededContext: inputTokens + request.max_tokens,
    contextPerSlot: capacity ?? null, promptSha256: sha(applied.prompt) };
  write(join(out, 'context-check.json'), evidence);
  if (capacity != null) assert(capacity >= evidence.neededContext,
    `Context per slot is ${capacity}, but case ${original.id} needs ${evidence.neededContext} tokens including the frozen output budget. Restart the server with at least 32768 context per slot.`);
  return evidence;
}

function parseResponse(response) {
  const message = response.choices?.[0]?.message;
  const native = message?.tool_calls?.[0];
  let firstToolCall = null, toolCallSource = null, malformedArguments = null;
  if (native?.function) {
    try {
      const args = typeof native.function.arguments === 'string' ? JSON.parse(native.function.arguments) : native.function.arguments;
      firstToolCall = { name: native.function.name, args };
    } catch {
      malformedArguments = native.function.arguments;
      firstToolCall = { name: native.function.name, args: {} };
    }
    toolCallSource = 'tool_calls';
  } else {
    firstToolCall = extractToolCallFromContent(message?.content, { tools: freeze.tools });
    if (firstToolCall) toolCallSource = 'content_fallback';
  }
  return { firstToolCall, toolCallSource, malformedArguments };
}

// Validate the schema that was actually sent, without current runtime defaults
// or stricter, newer tool policies. The May snapshot uses these six keywords.
function schemaErrors(value, schema, path = '$') {
  const supported = new Set(['type', 'description', 'enum', 'properties', 'required', 'items']);
  for (const key of Object.keys(schema)) assert(supported.has(key), `Unsupported frozen schema keyword: ${key}`);
  const types = { object: item => item !== null && typeof item === 'object' && !Array.isArray(item),
    array: Array.isArray, string: item => typeof item === 'string', boolean: item => typeof item === 'boolean',
    number: item => typeof item === 'number' && Number.isFinite(item), integer: Number.isInteger };
  if (schema.type && !types[schema.type]?.(value)) return [`${path}: expected ${schema.type}`];
  const errors = [];
  if (schema.enum && !schema.enum.some(option => isDeepStrictEqual(option, value))) errors.push(`${path}: invalid enum`);
  for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], child, `${path}.${key}`));
  }
  if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${path}[${index}]`)));
  return errors;
}

async function run() {
  assert(/^https?:\/\//.test(base), 'Provide the model server with --base http://HOST:PORT.');
  checkArchivedInputs();
  const models = await get('/v1/models'), props = await get('/props');
  if (props.total_slots != null) assert(concurrency <= props.total_slots, 'Requested concurrency exceeds available server slots.');
  const modelPattern = candidate === 'lfm' ? /lfm2\.5-24b-a2b/i : /(?:ternary[-_ ]*)?bonsai[-_ ]*2[-_ ]*27b/i;
  const model = models.data?.find(item => modelPattern.test(item.id));
  assert(model, `The server is not advertising ${activeSource.label}.`);
  const checkpoint = props.model_path || model.id;
  let quantization;
  if (candidate === 'lfm') {
    assert.match(checkpoint, /UD-Q4_K_XL\.gguf$/i, 'The user-approved Q4_K_XL checkpoint is not active.');
    quantization = 'UD-Q4_K_XL';
  } else {
    assert.match(checkpoint, modelPattern, 'The checkpoint path does not identify Ternary Bonsai 2 27B.');
    quantization = checkpoint.match(/(?:PTQ1_0|PQ2_0|Q2_0)/i)?.[0];
    assert(quantization, 'Expected a packed ternary PTQ1_0, PQ2_0 or Q2_0 checkpoint.');
  }
  assert.match(props.chat_template, /<think>/, 'The active template does not expose the expected reasoning prefix.');
  const contextCheck = await checkContextCapacity(model.id, props);
  const runDir = join(here, 'results', activeSource.dir + (stage === 'preflight' ? '_preflight' : ''));
  mkdirSync(runDir, { recursive: true });
  const selected = stage === 'preflight' ? ['001.json', '070.json', '092.json'] : files;
  const existing = selected.filter(file => existsSync(join(runDir, file)));
  assert(resume || existing.length === 0, 'Refusing to overwrite existing case results; --resume preserves successes and retries transport errors only.');
  const originalMetadata = existsSync(join(runDir, 'run-metadata.json')) ? read(join(runDir, 'run-metadata.json')) : null;
  const previousSummary = existsSync(join(runDir, 'summary.json')) ? read(join(runDir, 'summary.json')) : null;
  if (resume) {
    assert(originalMetadata, 'Cannot resume without original metadata.');
    assert.equal(originalMetadata.model, model.id, 'Cannot resume with a different model.');
    assert.equal(originalMetadata.quantization, quantization, 'Cannot resume with a different quantization.');
    assert.equal(originalMetadata.chatTemplateSha256, sha(props.chat_template), 'Cannot resume after a chat-template change.');
    assert.deepEqual(originalMetadata.props.default_generation_settings.params, props.default_generation_settings.params,
      'Cannot resume with changed server sampling defaults.');
  }
  const pending = selected.filter(file => !existsSync(join(runDir, file)) || read(join(runDir, file)).error);
  const records = selected.filter(file => existsSync(join(runDir, file)) && !read(join(runDir, file)).error)
    .map(file => read(join(runDir, file)));
  const failedAttemptFiles = previousSummary?.failedAttemptFiles?.slice() ?? [];
  for (const file of pending.filter(file => existsSync(join(runDir, file)))) {
    let number = 1, archive;
    do { archive = join(runDir, `${file.slice(0, 3)}.failed-attempt-${number++}.json`); } while (existsSync(archive));
    writeFileSync(archive, readFileSync(join(runDir, file)), { flag: 'wx' });
    failedAttemptFiles.push(repoPath(archive));
  }
  if (stage === 'full') {
    const preflight = read(join(here, 'results', activeSource.dir + '_preflight', 'summary.json'));
    assert.equal(preflight.errors, 0);
    assert.equal(preflight.cases, 3);
    assert.equal(preflight.model, model.id);
    assert.equal(preflight.chatTemplateSha256, sha(props.chat_template));
  }
  const metadata = { date, startedAt: new Date().toISOString(), stage, base, model: model.id,
    quantization, candidate, models, props, contextCheck, chatTemplateSha256: sha(props.chat_template),
    protocol: 'Exact per-case May 23 request replay; only model changes. No browser actions are executed.',
    thinking: candidate === 'lfm'
      ? 'The server chat template unconditionally prefixes assistant generation with <think>; no disabling override is sent.'
      : 'Thinking uses the model template default; no disabling or reasoning-effort override is sent. Raw response evidence is retained.',
    source: repoPath(sonnetDir), systemHash: freeze.meta.systemHash, toolCount: 41,
    concurrency, timeoutMs, temperature: 0.15, maxTokens: 4096, resumed: resume,
    successfulCasesPreserved: records.length, campaignStartedAt: originalMetadata?.startedAt ?? new Date().toISOString() };
  let metadataFile = 'run-metadata.json';
  if (resume) {
    let number = 1;
    do { metadataFile = `resume-${String(number++).padStart(3, '0')}-metadata.json`; } while (existsSync(join(runDir, metadataFile)));
  }
  write(join(runDir, metadataFile), metadata);
  const runMetadataFiles = previousSummary?.runMetadataFiles?.slice() ?? (resume ? ['run-metadata.json'] : []);
  runMetadataFiles.push(metadataFile);
  if (resume) console.log(`Resuming: ${records.length} successful cases preserved; ${pending.length} missing or failed cases queued.`);
  console.log(`Concurrency: ${concurrency}; context per slot: ${contextCheck.contextPerSlot}.`);
  const runOne = async file => {
    const original = read(join(sonnetDir, file));
    const request = structuredClone({ ...original.request, model: model.id });
    let response = null, error = null;
    const started = Date.now();
    try {
      const http = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs) });
      const body = await http.text();
      if (!http.ok) throw new Error(`HTTP ${http.status}: ${body.slice(0, 1200)}`);
      response = JSON.parse(body);
      assert(response.choices?.[0]?.message && !response.error, 'Response has no assistant message.');
      assert.equal(response.model, model.id, 'Served model changed during the run.');
    } catch (e) { error = e.message; }
    const parsed = response ? parseResponse(response) : { firstToolCall: null, toolCallSource: null, malformedArguments: null };
    const record = { id: original.id, user: original.user, tab: original.tab, request, response, error,
      latencyMs: Date.now() - started, ...parsed, content: response?.choices?.[0]?.message?.content ?? null,
      finishReason: response?.choices?.[0]?.finish_reason ?? null, usage: response?.usage ?? null,
      runMetadataFile: metadataFile,
      sourceRequestSha256: sha(JSON.stringify(original.request)), sourceRecordSha256: sha(readFileSync(join(sonnetDir, file))) };
    write(join(runDir, file), record);
    records.push(record);
    write(join(runDir, 'summary.json'), { ...metadata, props: undefined, models: undefined, finishedAt: new Date().toISOString(),
      complete: records.length === selected.length && records.every(item => !item.error), cases: records.length, errors: records.filter(item => item.error).length,
      runMetadataFiles, failedAttemptFiles,
      transportFailures: failedAttemptFiles.length + records.filter(item => item.error).length,
      withToolCall: records.filter(item => item.firstToolCall).length,
      withToolCallFromContent: records.filter(item => item.toolCallSource === 'content_fallback').length,
      lengthLimited: records.filter(item => item.finishReason === 'length').length });
    const message = response?.choices?.[0]?.message;
    const reasoningChars = (message?.reasoning_content ?? message?.reasoning ?? '').length;
    console.log(`[${records.length}/${selected.length}] ${original.id} ${error ?? parsed.firstToolCall?.name ?? '(no tool)'}; ${parsed.toolCallSource ?? 'prose'}; finish=${record.finishReason}; reasoningChars=${reasoningChars}`);
    return !error;
  };
  let next = 0, stop = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (!stop && next < pending.length) {
      const file = pending[next++];
      const ok = await runOne(file);
      if (!ok) stop = true;
    }
  }));
  assert(records.every(record => !record.error), 'Stopped after a request failure; successful responses and failed evidence are retained. Resume retries errors only.');
  const after = await get('/v1/models');
  assert(after.data.some(item => item.id === model.id), 'Served checkpoint changed before completion.');
  write(join(runDir, 'server-after.json'), after);
  console.log(repoPath(runDir));
}

function report() {
  checkArchivedInputs();
  const rows = [], evidence = [], failedAttempts = [];
  for (const source of sources) {
    const dir = join(here, 'results', source.dir);
    assert.equal(readdirSync(dir).filter(file => /^\d{3}\.json$/.test(file)).length, 100);
    const summary = read(join(dir, 'summary.json'));
    const row = { model: source.label, date: source.date, source: repoPath(dir), quantization: summary.quantization ?? null, cases: 100, errors: 0,
      transportFailures: summary.transportFailures ?? 0, concurrencyByCase: source.fresh ? {} : null,
      emittedCalls: 0, schemaValidCalls: 0, exactIdeal: 0, idealToolName: 0, sonnetMatches: 0,
      sonnetTooledMatches: 0, nativeCalls: source.fresh ? 0 : null, contentFallbackCalls: source.fresh ? 0 : null,
      lengthLimited: source.fresh ? 0 : null, reasoningEvidenceCases: source.fresh ? 0 : null, byTool: {}, invalidCalls: [], disagreements: [] };
    for (const file of files) {
      const path = join(dir, file), record = read(path), reference = read(join(sonnetDir, file));
      assert.deepEqual({ ...record.request, model: reference.request.model }, reference.request, `Request drift: ${source.label}/${file}`);
      assert(!record.error, `${source.label}/${file}: transport failures cannot be quality scores.`);
      if (source.fresh) {
        assert(record.response?.choices?.[0]?.message, `Missing raw response: ${file}`);
        assert.equal(record.response.model, summary.model);
        const metadata = read(join(dir, record.runMetadataFile ?? 'run-metadata.json'));
        assert.equal(metadata.model, summary.model, 'Case metadata names a different model.');
        assert.equal(metadata.quantization, summary.quantization, 'Case metadata names a different quantization.');
        assert.equal(metadata.temperature, record.request.temperature);
        assert.equal(metadata.maxTokens, record.request.max_tokens);
        assert.equal(metadata.chatTemplateSha256, sha(metadata.props.chat_template));
        const workers = String(metadata.concurrency);
        row.concurrencyByCase[workers] = (row.concurrencyByCase[workers] ?? 0) + 1;
        const parsed = parseResponse(record.response);
        assert.deepEqual(record.firstToolCall, parsed.firstToolCall);
        assert.equal(record.toolCallSource, parsed.toolCallSource);
      }
      const call = record.firstToolCall, ideal = rubrics.cases[record.id].idealFirstToolCall;
      row.sonnetMatches += (call?.name ?? null) === (reference.firstToolCall?.name ?? null) ? 1 : 0;
      row.sonnetTooledMatches += reference.firstToolCall && call?.name === reference.firstToolCall.name ? 1 : 0;
      if (call?.name === ideal.name) { row.idealToolName++; if (isDeepStrictEqual(call.args, ideal.args)) row.exactIdeal++; }
      else row.disagreements.push({ id: record.id, expected: ideal, actual: call });
      if (call) {
        row.emittedCalls++;
        const schema = freeze.tools.find(tool => tool.function.name === call.name)?.function.parameters;
        const errors = schema ? schemaErrors(call.args, schema) : ['Unknown tool name'];
        if (record.malformedArguments != null) errors.push('Malformed native argument JSON');
        if (errors.length === 0) row.schemaValidCalls++;
        else row.invalidCalls.push({ id: record.id, call, errors, malformedArguments: record.malformedArguments ?? null });
      }
      if (source.fresh) {
        row.nativeCalls += record.toolCallSource === 'tool_calls' ? 1 : 0;
        row.contentFallbackCalls += record.toolCallSource === 'content_fallback' ? 1 : 0;
        const msg = record.response.choices[0].message;
        if (msg.reasoning_content || msg.reasoning || /<think>|<\/think>/.test(msg.content ?? '')) row.reasoningEvidenceCases++;
      }
      if (source.fresh) row.lengthLimited += record.finishReason === 'length' ? 1 : 0;
      const name = call?.name ?? '(no tool)'; row.byTool[name] = (row.byTool[name] ?? 0) + 1;
      evidence.push({ model: row.model, id: record.id, path: repoPath(path), sha256: sha(readFileSync(path)),
        requestSha256: sha(JSON.stringify(record.request)), referenceSha256: sha(readFileSync(join(sonnetDir, file))) });
    }
    for (const archived of summary.failedAttemptFiles ?? []) {
      const path = join(root, archived), failed = read(path), successful = read(join(dir, `${failed.id}.json`));
      assert(failed.error, 'An archived transport failure must contain an error.');
      assert.deepEqual(failed.request, successful.request, 'A transport retry changed the request.');
      failedAttempts.push({ model: row.model, id: failed.id, path: archived, error: failed.error, sha256: sha(readFileSync(path)) });
    }
    assert.equal(row.emittedCalls, summary.withToolCall);
    row.sonnetTooledCases = files.filter(file => read(join(sonnetDir, file)).firstToolCall).length;
    assert.equal(row.sonnetTooledCases, 92);
    row.sonnetTooledAlignmentPct = 100 * row.sonnetTooledMatches / row.sonnetTooledCases;
    if (!source.fresh) assert.deepEqual([row.sonnetMatches, row.exactIdeal, row.idealToolName], source === sources[0] ? [70, 15, 35] : [71, 13, 30]);
    rows.push(row);
  }
  const comparison = { date, cases: 100, toolCount: 41, systemHash: freeze.meta.systemHash,
    method: `All ${rows.length === 3 ? 'three' : 'four'} models receive identical archived May 23 messages, tool schemas, temperature 0.15 and 4096-token output budget; only model changes.`,
    caveats: ['Qwen and Gemma reuse May 23 local responses; LFM is a new local Q4_K_XL run.',
      ...(candidate === 'bonsai' ? ['Ternary Bonsai 2 27B is an additional local run; its exact ternary packing is recorded in run metadata.'] : []),
      'Backends, quantizations, hardware and model-side templates differ. Historical thinking settings are unverified.',
      'Sonnet agreement compares tool names, including shared no-tool answers. Ideal tool-name counts include exact matches.',
      'Schema validity uses only the archived advertised JSON schemas; it does not apply newer runtime policies or default normalization.',
      'Historical validity checks use saved parsed calls because the old files do not retain full raw API responses.',
      ...(failedAttempts.length ? [`${failedAttempts.length} failed transport attempt(s) were archived and repeated with identical requests; successful responses alone enter quality scores.`] : []),
      'Only the first action is graded; browser tools are not executed. Response times are not compared.'],
    rubricSource: repoPath(rubricPath), rubricSha256: sha(readFileSync(rubricPath)), failedAttempts, rows };
  write(join(out, 'comparison.json'), comparison);
  write(join(out, 'evidence-audit.json'), evidence);
  const table = '| Model | Tool calls / 100 | Schema-valid / emitted | Sonnet agreement / 100 | Sonnet tool agreement / 92 | Expected tool / 100 | Exact action / 100 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n'
    + rows.map(row => `| ${row.model} | ${row.emittedCalls} | ${row.schemaValidCalls} / ${row.emittedCalls} | ${row.sonnetMatches} | ${row.sonnetTooledMatches} | ${row.idealToolName} | ${row.exactIdeal} |`).join('\n');
  const details = rows.filter(row => row.nativeCalls !== null).map(row => `${row.model}: ${row.nativeCalls} native first calls, ${row.contentFallbackCalls} content-parsed calls, ${row.reasoningEvidenceCases} responses with visible reasoning evidence, ${row.lengthLimited} output-length limits.`).join('\n\n');
  writeFileSync(join(out, 'report.md'), `# 16 GB model comparison: archived May 23 frozen protocol\n\n${comparison.method}\n\n${table}\n\n${comparison.caveats.map(note => '- ' + note).join('\n')}\n\n${details}\n`, 'utf8');
  console.log(table);
}

if (stage === 'prepare') checkArchivedInputs();
else if (stage === 'report') report();
else await run();
