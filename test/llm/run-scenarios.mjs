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
// Prompt + tool tier:
//   --mode act|ask|dev   # override scenario mode; Dev requires --tier mid|full
//   --tier full           # SYSTEM_PROMPT_ACT + full tool set (default)
//   --tier mid            # SYSTEM_PROMPT_ACT_MID + MID_TOOL_NAMES subset
//   --tier compact        # SYSTEM_PROMPT_ACT_COMPACT + COMPACT_TOOL_NAMES subset
//
// Local chat-template compatibility:
//   --chat-template-compat off|fold-system|alternating|alternating-tools
//   # or set env: LLM_CHAT_TEMPLATE_COMPAT=alternating
//
// Freeze (pin everything to a previous snapshot, ignores --tier):
//   --freeze freeze/baseline-2026-05-23.json
//   # or set env: WB_FREEZE_BASELINE=freeze/baseline-2026-05-23.json
//
// Output:
//   test/llm/results-scenarios/<tag>_<browser>_<model>[_dev][_mid|_compact|_frozen]/NNN.json
//   test/llm/results-scenarios/<tag>_<browser>_<model>[_dev][_mid|_compact|_frozen]/summary.json
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
import {
  isActionMode,
  isFrozen,
  getFrozenMeta,
  loadFrozenBaseline,
  normalizeMode,
  normalizeTier,
} from './lib/build-payload.mjs';
import { scoreVerdict } from './lib/score.mjs';
import {
  chatTemplateCompatLabel,
  getChatTemplateCompat,
  prepareMessagesForChatTemplate,
  prepareToolsForChatTemplate,
} from './lib/chat-template-compat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const S_DIR = join(HERE, 'scenarios');
const RESULTS_DIR = join(HERE, 'results-scenarios');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage:
  node test/llm/run-scenarios.mjs [options]

Endpoint:
  --base URL                         OpenAI-compatible base URL (default: http://localhost:8080)
  --url URL                          Full /v1/chat/completions URL
  --model NAME                       Model name (default: local)
  --api-key KEY | --token KEY        Bearer token

Selection:
  --only IDS                         Comma-separated scenario ids, e.g. 81,82,90
  --category NAME                    Run only one scenario category
  --browser chrome|firefox           Browser prompt/tool source (default: chrome)
  --mode ask|act|dev                 Override scenario mode; Dev requires Mid/Full tier
  --tier full|mid|compact            Prompt/tool tier; ignored with --freeze
  --freeze PATH                      Pin system prompt + tools to a snapshot
  --unprotected                      Strip wrapper + untrusted-content instructions

Run:
  --tag NAME                         Results tag; default is current timestamp
  --concurrency N                    Parallel requests (default: 2)
  --timeout MS                       Per-request timeout (default: 90000)
  --no-save-request                  Do not write request payloads into result files

Local chat-template compatibility:
  --chat-template-compat off
      Send normal OpenAI-style system/user/tool messages and structured tools.
  --chat-template-compat fold-system
      Fold system messages into user messages; keep structured tools.
  --chat-template-compat alternating
      Alternating user/assistant transcript with no structured tools; asks for text <tool_call>.
      Use this to reproduce earlier Molmo text-call fallback behavior.
  --chat-template-compat alternating-tools
      Alternating user/assistant transcript while still sending structured tools.

Environment:
  LLM_BASE_URL, LLM_CHAT_URL, LLM_MODEL, LLM_API_KEY, OPENROUTER_API_KEY
  LLM_CHAT_TEMPLATE_COMPAT, WB_FREEZE_BASELINE

Examples:
  node test/llm/run-scenarios.mjs --base http://127.0.0.1:1234 --model molmo2-8b --only 81,88
  node test/llm/run-scenarios.mjs --base "$BASE" --model "$MODEL" --freeze freeze/baseline-2026-05-23.json --chat-template-compat alternating
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const BASE = args.base || process.env.LLM_BASE_URL || 'http://localhost:8080';
const CHAT_URL = args.url || process.env.LLM_CHAT_URL || chatCompletionsUrl(BASE);
const MODEL = args.model || process.env.LLM_MODEL || 'local';
const API_KEY = args['api-key'] || args.token || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '';
const BROWSER = args.browser || 'chrome';
const CONCURRENCY = Math.max(1, parseInt(args.concurrency || '2', 10));
const TIMEOUT_MS = parseInt(args.timeout || '90000', 10);
const SAVE_REQUEST = !args['no-save-request'];
const CHAT_TEMPLATE_COMPAT = getChatTemplateCompat({
  model: MODEL,
  value: args['chat-template-compat'],
});

// --mode ask|act|dev — optional override of the mode stored in each scenario.
// --tier full|mid|compact — picks SYSTEM_PROMPT_ACT[_MID|_COMPACT] and the
// corresponding tool subset. Default: full. ASK-mode scenarios ignore tier.
// --freeze <path> — alternative to WB_FREEZE_BASELINE env var. If set,
// system prompt + tools come from the snapshot and --tier is ignored.
if (args.freeze && args.freeze !== true) {
  loadFrozenBaseline(args.freeze);
}
const TIER = normalizeTier(args.tier);
const MODE_OVERRIDE = args.mode == null ? null : normalizeMode(args.mode);
// --unprotected: ABLATION. Strip BOTH the untrusted-content wrapper from the
// seed AND the untrusted-content instructions from the system prompt.
const UNPROTECTED = !!args.unprotected;

const onlySet = args.only && args.only !== true
  ? new Set(String(args.only).split(',').map(s => String(parseInt(s, 10)).padStart(3, '0')))
  : null;
const categoryFilter = args.category && args.category !== true ? String(args.category) : null;

const runTag = args.tag || new Date().toISOString().replace(/[:.]/g, '-');
const tagSuffix = (isFrozen()
  ? '_frozen'
  : `${MODE_OVERRIDE === 'dev' ? '_dev' : ''}${TIER === 'full' ? '' : `_${TIER}`}`) + (UNPROTECTED ? '_unprotected' : '');
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

// Scenarios live flat in scenarios/ plus foldered under scenarios/security/
// {protected,unprotected}/. Walk recursively and match NNN.json by basename;
// ids are globally unique so --only / sorting are unaffected by folder.
function walkScenarioFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkScenarioFiles(p));
    else if (/^\d{3}\.json$/.test(ent.name)) out.push(p);
  }
  return out;
}

function loadAll() {
  return walkScenarioFiles(S_DIR)
    .map(p => JSON.parse(readFileSync(p, 'utf8')))
    .filter(s => !onlySet || onlySet.has(s.id))
    .filter(s => !categoryFilter || s.category === categoryFilter)
    .sort((a, b) => a.id.localeCompare(b.id));
}

const scenarios = loadAll();

const promptMode = isFrozen()
  ? `frozen (${getFrozenMeta()?.sourceRun || 'unknown source'} @ ${getFrozenMeta()?.runTag || ''})`
  : `mode=${MODE_OVERRIDE || 'scenario'}, tier=${TIER}`;
console.error(`▸ ${scenarios.length} scenario(s), base=${BASE}, model=${MODEL}, browser=${BROWSER}, concurrency=${CONCURRENCY}`);
if (categoryFilter) console.error(`▸ category=${categoryFilter}`);
console.error(`▸ endpoint=${CHAT_URL}`);
console.error(`▸ prompt: ${promptMode}${UNPROTECTED ? ' — ⚠ UNPROTECTED (wrapper + untrusted-content instructions stripped)' : ''}`);
if (CHAT_TEMPLATE_COMPAT.mode !== 'off') {
  console.error(`▸ chat template compat: ${chatTemplateCompatLabel(CHAT_TEMPLATE_COMPAT)}`);
}
console.error(`▸ writing to ${runDir}`);

// Scoring (renderCall / matchesAntiPattern / deepEqual / scoreVerdict) lives in
// ./lib/score.mjs so the live runner and regrade.mjs share ONE grader — and the
// wildcard ("...") antiPattern handling + the `empty` verdict stay consistent
// between a live run and a re-score.

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
  const callMatch = trimmed.match(/^([A-Za-z_][\w.-]*)\s*\(([\s\S]*)\)\s*;?$/);
  if (callMatch) {
    return { name: callMatch[1], args: callMatch[2].trim() ? safeParse(callMatch[2]) : {} };
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
  const mode = MODE_OVERRIDE || normalizeMode(scenario.mode);
  const payload = buildScenarioPayload({ ...scenario, browser: scenario.browser || BROWSER, mode }, { tier: TIER, unprotected: UNPROTECTED });
  const messages = prepareMessagesForChatTemplate(payload.messages, CHAT_TEMPLATE_COMPAT, { tools: payload.tools });
  const tools = prepareToolsForChatTemplate(payload.tools, CHAT_TEMPLATE_COMPAT);
  const body = {
    model: MODEL,
    temperature: isActionMode(mode) ? 0.15 : 0.3,
    max_tokens: 4096,
    messages,
  };
  if (tools) body.tools = tools;

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

  // Scoring (shared grader — see ./lib/score.mjs for the verdict taxonomy).
  const { verdict, matchedAntiPattern } = scoreVerdict({
    error,
    firstToolCall,
    content: msg?.content,
    expected: scenario.expected,
  });
  const anti = matchedAntiPattern;
  const scoreNote = (!firstToolCall && verdict === 'ideal_name')
    ? `prose answer credited as ${scenario.expected.idealNextToolCall.name} (terminal tool; summary not arg-matched)`
    : null;

  return {
    id: scenario.id,
    category: scenario.category,
    description: scenario.description,
    mode,
    browser: scenario.browser || BROWSER,
    latencyMs,
    error,
    firstToolCall,
    toolCallSource,
    expected: scenario.expected,
    matchedAntiPattern: anti || null,
    verdict,
    scoreNote,
    finishReason: response?.choices?.[0]?.finish_reason || null,
    content: msg?.content || null,
    usage: response?.usage || null,
    request: SAVE_REQUEST ? {
      messages: body.messages,
      tools_summary: { count: payload.tools.length, sent: !!tools },
    } : undefined,
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
  if (!byCategory[c]) byCategory[c] = { ideal: 0, ideal_name: 0, anti: 0, other: 0, no_tool: 0, empty: 0, error: 0 };
  byCategory[c][r.verdict] = (byCategory[c][r.verdict] || 0) + 1;
}

const summary = {
  runTag, model: MODEL, base: BASE, browser: BROWSER,
  tier: isFrozen() ? null : TIER,
  modeOverride: isFrozen() ? null : MODE_OVERRIDE,
  unprotected: UNPROTECTED,
  chatTemplateCompat: CHAT_TEMPLATE_COMPAT.mode,
  structuredToolsSent: !CHAT_TEMPLATE_COMPAT.omitStructuredTools,
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
  console.error(`    ${cat.padEnd(20)} ideal=${ideal}/${total}  anti=${anti}  other=${dist.other || 0}  no_tool=${dist.no_tool || 0}  empty=${dist.empty || 0}`);
}
console.error(`▸ ${join(runDir, 'summary.json')}`);
