#!/usr/bin/env node
// Run every test/llm/questions/*.json against a local OpenAI-compatible
// endpoint (default: llama.cpp on http://localhost:8080) and write the
// model's first-turn response next to each case in results/NNN.json.
//
// Usage:
//   node test/llm/run-llamacpp.mjs                            # all cases
//   node test/llm/run-llamacpp.mjs --only 1,5,42              # subset
//   node test/llm/run-llamacpp.mjs --base http://localhost:8000
//   node test/llm/run-llamacpp.mjs --model gpt-oss-20b
//   node test/llm/run-llamacpp.mjs --concurrency 4
//   node test/llm/run-llamacpp.mjs --browser firefox
//   node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model openai/gpt-oss-20b --api-key $OPENROUTER_API_KEY
//   node test/llm/run-llamacpp.mjs --url https://openrouter.ai/api/v1/chat/completions --model openai/gpt-oss-20b --api-key $OPENROUTER_API_KEY
//   node test/llm/run-llamacpp.mjs --no-save-request                 # omit request from result files
//
// Output:
//   test/llm/results/<run-tag>/NNN.json   — { id, request?, response, latencyMs, error?, firstToolCall }
//   test/llm/results/<run-tag>/summary.json
//
// This runner does NOT execute tool calls or step the agent — it captures
// only the first model turn. That's what `idealFirstToolCall` scores
// against. For full multi-step evaluation, see the trace recorder in
// the extension itself.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload, normalizeBrowser } from './lib/build-payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const Q_DIR = join(HERE, 'questions');
const RESULTS_DIR = join(HERE, 'results');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE = args.base || process.env.LLM_BASE_URL || 'http://localhost:8080';
const CHAT_URL = args.url || process.env.LLM_CHAT_URL || chatCompletionsUrl(BASE);
const MODEL = args.model || process.env.LLM_MODEL || 'local';
const API_KEY = args['api-key'] || args.token || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '';
const BROWSER = normalizeBrowser(args.browser);
const SAVE_REQUEST = !args['no-save-request'];
const CONCURRENCY = Math.max(1, parseInt(args.concurrency || '2', 10));
const TIMEOUT_MS = parseInt(args.timeout || '60000', 10);

const onlySet = args.only && args.only !== true
  ? new Set(String(args.only).split(',').map(s => String(parseInt(s, 10)).padStart(3, '0')))
  : null;

const runTag = args.tag || new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(RESULTS_DIR, `${runTag}_${BROWSER}_${MODEL.replace(/[^\w.-]+/g, '_')}`);
mkdirSync(runDir, { recursive: true });

const ids = readdirSync(Q_DIR)
  .filter(f => /^\d{3}\.json$/.test(f))
  .map(f => f.replace(/\.json$/, ''))
  .filter(id => !onlySet || onlySet.has(id))
  .sort();

console.error(`▸ ${ids.length} case(s), base=${BASE}, model=${MODEL}, browser=${BROWSER}, concurrency=${CONCURRENCY}`);
console.error(`▸ endpoint=${CHAT_URL}`);
console.error(`▸ writing to ${runDir}`);

function chatCompletionsUrl(base) {
  const trimmed = String(base).replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function requestHeaders() {
  const headers = { 'content-type': 'application/json' };
  if (API_KEY) {
    headers.authorization = `Bearer ${API_KEY}`;
  }
  return headers;
}

// Some local models (e.g. browser-use/bu-30b-a3b-preview) emit their tool call
// as raw JSON in `content` instead of populating the OpenAI `tool_calls` field.
// This handles the common shapes: <tool_call>{...}</tool_call>, naked JSON,
// and ```json fenced blocks. Returns { name, args } or null.
function extractToolCallFromContent(text) {
  if (!text || typeof text !== 'string') return null;
  let candidates = [];
  // 1. <tool_call>...</tool_call> wrapper
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    candidates.push(m[1]);
  }
  // 2. ```json ... ``` fenced block
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)) {
    candidates.push(m[1]);
  }
  // 3. The whole content as a JSON object
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed);

  for (const raw of candidates) {
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    const tc = normalizeToolCall(obj);
    if (tc) return tc;
  }
  return null;
}

function normalizeToolCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // Shape: {name, arguments|args|parameters}
  if (typeof obj.name === 'string') {
    const args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
    return { name: obj.name, args: typeof args === 'string' ? safeParse(args) : args };
  }
  // Shape: {function: {name, arguments}}
  if (obj.function && typeof obj.function.name === 'string') {
    const args = obj.function.arguments ?? obj.function.args ?? {};
    return { name: obj.function.name, args: typeof args === 'string' ? safeParse(args) : args };
  }
  // Shape: {tool_calls: [{function: {...}}]} or {tool_calls: [{name, ...}]}
  if (Array.isArray(obj.tool_calls) && obj.tool_calls[0]) {
    return normalizeToolCall(obj.tool_calls[0]);
  }
  return null;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

async function runOne(id) {
  const caseRec = JSON.parse(readFileSync(join(Q_DIR, `${id}.json`), 'utf8'));
  const payload = buildPayload(caseRec, { browser: BROWSER });
  const body = {
    model: MODEL,
    temperature: caseRec.mode === 'act' ? 0.15 : 0.3,
    max_tokens: 4096,
    messages: payload.messages,
    tools: payload.tools,
  };

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let response = null, error = null;
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      error = `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`;
    } else {
      response = await res.json();
    }
  } catch (e) {
    error = e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : e.message;
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;
  const msg = response?.choices?.[0]?.message;
  const tc = msg?.tool_calls?.[0];
  let firstToolCall = null;
  let toolCallSource = null;
  if (tc) {
    let parsedArgs = {};
    try { parsedArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch {}
    firstToolCall = { name: tc.function.name, args: parsedArgs };
    toolCallSource = 'tool_calls';
  } else if (msg?.content) {
    const fallback = extractToolCallFromContent(msg.content);
    if (fallback) {
      firstToolCall = fallback;
      toolCallSource = 'content_fallback';
    }
  }

  const out = {
    id,
    user: caseRec.user,
    tab: caseRec.tab,
    latencyMs,
    error,
    firstToolCall,
    toolCallSource,
    finishReason: response?.choices?.[0]?.finish_reason || null,
    content: msg?.content || null,
    usage: response?.usage || null,
  };
  if (SAVE_REQUEST) {
    out.request = body;
  }
  writeFileSync(join(runDir, `${id}.json`), JSON.stringify(out, null, 2) + '\n');
  return out;
}

// Simple bounded-concurrency worker pool.
async function runAll() {
  const queue = ids.slice();
  const results = [];
  let inFlight = 0, idx = 0;
  return new Promise((resolve) => {
    const tick = () => {
      while (inFlight < CONCURRENCY && queue.length) {
        const id = queue.shift();
        inFlight++;
        const n = ++idx;
        runOne(id)
          .then(r => {
            results.push(r);
            const tag = r.error ? `✗ ${r.error.slice(0, 60)}` : (r.firstToolCall ? `→ ${r.firstToolCall.name}` : `(no tool)`);
            console.error(`[${n}/${ids.length}] ${id} ${tag} ${r.latencyMs}ms`);
          })
          .catch(e => {
            results.push({ id, error: e.message });
            console.error(`[${n}/${ids.length}] ${id} ✗ ${e.message}`);
          })
          .finally(() => {
            inFlight--;
            if (queue.length === 0 && inFlight === 0) resolve(results);
            else tick();
          });
      }
    };
    tick();
  });
}

const t0 = Date.now();
const results = await runAll();
const elapsed = Date.now() - t0;

const summary = {
  runTag,
  model: MODEL,
  browser: BROWSER,
  base: BASE,
  saveRequest: SAVE_REQUEST,
  cases: results.length,
  totalLatencyMs: elapsed,
  errors: results.filter(r => r.error).length,
  withToolCall: results.filter(r => r.firstToolCall).length,
  withToolCallFromContent: results.filter(r => r.toolCallSource === 'content_fallback').length,
  byTool: results.reduce((acc, r) => {
    const k = r.firstToolCall?.name || (r.error ? '(error)' : '(no_tool_call)');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {}),
};
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.error(`\n▸ done in ${elapsed}ms`);
console.error(`▸ tool-call dist:`, summary.byTool);
console.error(`▸ ${runDir}/summary.json`);
