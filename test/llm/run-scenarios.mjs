#!/usr/bin/env node
// Run multi-turn scenarios from test/llm/scenarios/*.json against an
// OpenAI-compatible endpoint. Captures the model's NEXT turn after the
// seeded conversation history. Heuristic-scores by matching firstToolCall
// against expected.idealNextToolCall (name match) and expected.antiPatterns
// (substring match against rendered call signature).
//
// Usage (same flag conventions as run-llamacpp.mjs):
//   node test/llm/run-scenarios.mjs
//   node test/llm/run-scenarios.mjs --only 1,5,42
//   node test/llm/run-scenarios.mjs --category loop-bad-url
//   node test/llm/run-scenarios.mjs --base http://localhost:8080 --model gpt-oss-20b
//   node test/llm/run-scenarios.mjs --base https://openrouter.ai/api/v1 --model openai/gpt-oss-20b --api-key $OPENROUTER_API_KEY
//   node test/llm/run-scenarios.mjs --browser firefox
//
// Prompt + tool tier (ACT mode only; ASK ignores):
//   --tier full           # SYSTEM_PROMPT_ACT + full tool set (default)
//   --tier mid            # SYSTEM_PROMPT_ACT_MID + MID_TOOL_NAMES subset
//   --tier compact        # SYSTEM_PROMPT_ACT_COMPACT + COMPACT_TOOL_NAMES subset
//
// Freeze (pin everything to a previous snapshot, ignores --tier):
//   --freeze freeze/baseline-2026-05-23.json
//   # or set env: WB_FREEZE_BASELINE=freeze/baseline-2026-05-23.json
//
// Output:
//   test/llm/results-scenarios/<tag>_<browser>_<model>[_mid|_compact|_frozen]/NNN.json
//   test/llm/results-scenarios/<tag>_<browser>_<model>[_mid|_compact|_frozen]/summary.json
//
// Heuristic scoring (the judge LLM is OUT of scope for this runner — the
// rubric strings are written for a separate judge pass). Each scenario
// returns one of:
//   ideal       — first tool call name + args match idealNextToolCall
//   ideal_name  — first tool call name matches, args differ
//   anti        — first tool call matches an antiPattern substring
//   other       — neither ideal nor anti (judge needed)
//   no_tool     — model emitted text only / no tool call
//   error       — request failed

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenarioPayload } from './lib/scenario-payload.mjs';
import { normalizeTier, isFrozen, getFrozenMeta, loadFrozenBaseline } from './lib/build-payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const S_DIR = join(HERE, 'scenarios');
const RESULTS_DIR = join(HERE, 'results-scenarios');

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
const BROWSER = args.browser || 'chrome';
const CONCURRENCY = Math.max(1, parseInt(args.concurrency || '2', 10));
const TIMEOUT_MS = parseInt(args.timeout || '90000', 10);
const SAVE_REQUEST = !args['no-save-request'];

// --tier full|mid|compact — picks SYSTEM_PROMPT_ACT[_MID|_COMPACT] and the
// corresponding tool subset. Default: full. ASK-mode scenarios ignore tier.
// --freeze <path> — alternative to WB_FREEZE_BASELINE env var. If set,
// system prompt + tools come from the snapshot and --tier is ignored.
if (args.freeze && args.freeze !== true) {
  loadFrozenBaseline(args.freeze);
}
const TIER = normalizeTier(args.tier);

const onlySet = args.only && args.only !== true
  ? new Set(String(args.only).split(',').map(s => String(parseInt(s, 10)).padStart(3, '0')))
  : null;
const categoryFilter = args.category && args.category !== true ? String(args.category) : null;

const runTag = args.tag || new Date().toISOString().replace(/[:.]/g, '-');
const tagSuffix = isFrozen()
  ? '_frozen'
  : (TIER === 'full' ? '' : `_${TIER}`);
const runDir = join(RESULTS_DIR, `${runTag}_${BROWSER}_${MODEL.replace(/[^\w.-]+/g, '_')}${tagSuffix}`);
mkdirSync(runDir, { recursive: true });

function chatCompletionsUrl(base) {
  const t = String(base).replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(t)) return t;
  if (/\/v1$/.test(t)) return `${t}/chat/completions`;
  return `${t}/v1/chat/completions`;
}

function requestHeaders() {
  const h = { 'content-type': 'application/json' };
  if (API_KEY) h.authorization = `Bearer ${API_KEY}`;
  return h;
}

function loadAll() {
  return readdirSync(S_DIR)
    .filter(f => /^\d{3}\.json$/.test(f))
    .map(f => JSON.parse(readFileSync(join(S_DIR, f), 'utf8')))
    .filter(s => !onlySet || onlySet.has(s.id))
    .filter(s => !categoryFilter || s.category === categoryFilter)
    .sort((a, b) => a.id.localeCompare(b.id));
}

const scenarios = loadAll();

const promptMode = isFrozen()
  ? `frozen (${getFrozenMeta()?.sourceRun || 'unknown source'} @ ${getFrozenMeta()?.runTag || ''})`
  : `tier=${TIER}`;
console.error(`▸ ${scenarios.length} scenario(s), base=${BASE}, model=${MODEL}, browser=${BROWSER}, concurrency=${CONCURRENCY}`);
if (categoryFilter) console.error(`▸ category=${categoryFilter}`);
console.error(`▸ endpoint=${CHAT_URL}`);
console.error(`▸ prompt: ${promptMode}`);
console.error(`▸ writing to ${runDir}`);

// Render a tool call as a stable signature string for antiPattern matching.
// Format: name({arg1:"val", arg2:N}) — keys alphabetized, strings JSON-quoted,
// other types JSON-stringified. Matches the format used in scenario rubrics.
function renderCall(name, args) {
  const keys = Object.keys(args || {}).sort();
  const parts = keys.map(k => {
    const v = args[k];
    return `${k}:${JSON.stringify(v)}`;
  });
  return `${name}({${parts.join(', ')}})`;
}

function matchesAntiPattern(call, antiPatterns) {
  if (!call || !antiPatterns?.length) return null;
  const sig = renderCall(call.name, call.args);
  for (const ap of antiPatterns) {
    // Two strategies:
    // 1. Strict prefix-match on the rendered signature (handles canonical form)
    // 2. Substring match treating the antiPattern as a fragment
    if (sig === ap.match || sig.startsWith(ap.match)) return ap;
    // Loose: pattern often uses {key:"val"} short-form. Strip and substring-match.
    const looseAp = ap.match.replace(/\s+/g, '');
    const looseSig = sig.replace(/\s+/g, '');
    if (looseSig.includes(looseAp) || looseAp.includes(call.name)) {
      // require name match at minimum
      if (looseAp.startsWith(call.name + '(')) return ap;
    }
  }
  return null;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a == null || b == null) return false;
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!deepEqual(a[ka[i]], b[kb[i]])) return false;
  }
  return true;
}

// Same content-fallback parser as run-llamacpp.mjs (kept inline to avoid
// runner-runner coupling).
function extractToolCallFromContent(text) {
  if (!text || typeof text !== 'string') return null;
  const candidates = [];
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) candidates.push(m[1]);
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)) candidates.push(m[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed);
  for (const raw of candidates) {
    try { return normalizeToolCall(JSON.parse(raw)); } catch {}
  }
  return null;
}
function normalizeToolCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.name === 'string') {
    const a = obj.arguments ?? obj.args ?? obj.parameters ?? {};
    return { name: obj.name, args: typeof a === 'string' ? safeParse(a) : a };
  }
  if (obj.function && typeof obj.function.name === 'string') {
    const a = obj.function.arguments ?? obj.function.args ?? {};
    return { name: obj.function.name, args: typeof a === 'string' ? safeParse(a) : a };
  }
  if (Array.isArray(obj.tool_calls) && obj.tool_calls[0]) return normalizeToolCall(obj.tool_calls[0]);
  return null;
}
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

async function runOne(scenario) {
  const payload = buildScenarioPayload({ ...scenario, browser: scenario.browser || BROWSER }, { tier: TIER });
  const body = {
    model: MODEL,
    temperature: scenario.mode === 'act' ? 0.15 : 0.3,
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
  let firstToolCall = null;
  let toolCallSource = null;
  if (msg?.tool_calls?.[0]) {
    const tc = msg.tool_calls[0];
    let pa = {};
    try { pa = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch {}
    firstToolCall = { name: tc.function.name, args: pa };
    toolCallSource = 'tool_calls';
  } else if (msg?.content) {
    const fb = extractToolCallFromContent(msg.content);
    if (fb) { firstToolCall = fb; toolCallSource = 'content_fallback'; }
  }

  // Scoring
  const ideal = scenario.expected.idealNextToolCall;
  const anti = matchesAntiPattern(firstToolCall, scenario.expected.antiPatterns);
  let verdict = 'other';
  if (error) verdict = 'error';
  else if (!firstToolCall) verdict = 'no_tool';
  else if (anti) verdict = 'anti';
  else if (firstToolCall.name === ideal.name) {
    verdict = deepEqual(firstToolCall.args, ideal.args) ? 'ideal' : 'ideal_name';
  }

  return {
    id: scenario.id,
    category: scenario.category,
    description: scenario.description,
    mode: scenario.mode,
    browser: scenario.browser || BROWSER,
    latencyMs,
    error,
    firstToolCall,
    toolCallSource,
    expected: scenario.expected,
    matchedAntiPattern: anti || null,
    verdict,
    finishReason: response?.choices?.[0]?.finish_reason || null,
    content: msg?.content || null,
    usage: response?.usage || null,
    request: SAVE_REQUEST ? { messages: payload.messages, tools_summary: { count: payload.tools.length } } : undefined,
  };
}

// Worker pool
async function runAll() {
  const queue = scenarios.slice();
  const results = [];
  let inFlight = 0, idx = 0;
  return new Promise(resolve => {
    const tick = () => {
      while (inFlight < CONCURRENCY && queue.length) {
        const s = queue.shift();
        inFlight++;
        const n = ++idx;
        runOne(s)
          .then(r => {
            results.push(r);
            writeFileSync(join(runDir, `${r.id}.json`), JSON.stringify(r, null, 2) + '\n');
            const tag = r.error ? `✗ ${r.error.slice(0, 50)}` : `[${r.verdict}] ${r.firstToolCall?.name || '(no tool)'}`;
            console.error(`[${n}/${scenarios.length}] ${r.id} (${r.category}) ${tag} ${r.latencyMs}ms`);
          })
          .catch(e => {
            results.push({ id: s.id, error: e.message, verdict: 'error' });
            console.error(`[${n}/${scenarios.length}] ${s.id} ✗ ${e.message}`);
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

// Aggregate
const byVerdict = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
const byCategory = {};
for (const r of results) {
  const c = r.category || 'unknown';
  if (!byCategory[c]) byCategory[c] = { ideal: 0, ideal_name: 0, anti: 0, other: 0, no_tool: 0, error: 0 };
  byCategory[c][r.verdict] = (byCategory[c][r.verdict] || 0) + 1;
}

const summary = {
  runTag, model: MODEL, base: BASE, browser: BROWSER,
  tier: isFrozen() ? null : TIER,
  freeze: isFrozen() ? {
    path: args.freeze && args.freeze !== true ? args.freeze : (process.env.WB_FREEZE_BASELINE || null),
    sourceRun: getFrozenMeta()?.sourceRun || null,
    sourceRunTag: getFrozenMeta()?.runTag || null,
    systemHash: getFrozenMeta()?.systemHash || null,
    toolCount: getFrozenMeta()?.toolCount || null,
  } : null,
  scenarios: results.length,
  totalLatencyMs: elapsed,
  byVerdict,
  byCategory,
};
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.error(`\n▸ done in ${elapsed}ms`);
console.error(`▸ verdicts:`, byVerdict);
console.error(`▸ by category:`);
for (const [cat, dist] of Object.entries(byCategory)) {
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  const ideal = (dist.ideal || 0) + (dist.ideal_name || 0);
  const anti = dist.anti || 0;
  console.error(`    ${cat.padEnd(20)} ideal=${ideal}/${total}  anti=${anti}  other=${dist.other || 0}  no_tool=${dist.no_tool || 0}`);
}
console.error(`▸ ${join(runDir, 'summary.json')}`);
