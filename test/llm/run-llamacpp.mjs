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
// Prompt + tool tier:
//   --mode act|ask|dev   # override case mode; Dev requires --tier mid|full
//   --tier full           # SYSTEM_PROMPT_ACT  + full tool set (default)
//   --tier mid            # SYSTEM_PROMPT_ACT_MID  + MID_TOOL_NAMES subset
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
// Run dirs get suffixed with the mode so the four can coexist:
//   results/<tag>_chrome_<model>             # tier=full (default, no suffix)
//   results/<tag>_chrome_<model>_mid         # tier=mid
//   results/<tag>_chrome_<model>_dev_mid     # mode=dev, tier=mid
//   results/<tag>_chrome_<model>_compact     # tier=compact
//   results/<tag>_chrome_<model>_frozen      # any --freeze run
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
import {
  buildPayload,
  isActionMode,
  isFrozen,
  getFrozenMeta,
  loadFrozenBaseline,
  normalizeBrowser,
  normalizeMode,
  normalizeTier,
} from './lib/build-payload.mjs';
import {
  chatTemplateCompatLabel,
  getChatTemplateCompat,
  prepareMessagesForChatTemplate,
  prepareToolsForChatTemplate,
} from './lib/chat-template-compat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const Q_DIR = join(HERE, 'questions');
const RESULTS_DIR = join(HERE, 'results');

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
  node test/llm/run-llamacpp.mjs [options]

Endpoint:
  --base URL                         OpenAI-compatible base URL (default: http://localhost:8080)
  --url URL                          Full /v1/chat/completions URL
  --model NAME                       Model name (default: local)
  --api-key KEY | --token KEY        Bearer token

Selection:
  --only IDS                         Comma-separated case ids, e.g. 1,5,42
  --browser chrome|firefox           Browser prompt/tool source (default: chrome)
  --mode ask|act|dev                 Override case mode; Dev requires Mid/Full tier
  --tier full|mid|compact            Prompt/tool tier; ignored with --freeze
  --freeze PATH                      Pin system prompt + tools to a snapshot

Run:
  --tag NAME                         Results tag; default is current timestamp
  --concurrency N                    Parallel requests (default: 2)
  --timeout MS                       Per-request timeout (default: 60000)
  --no-save-request                  Do not write request payloads into result files

Local chat-template compatibility:
  --chat-template-compat off
      Send normal OpenAI-style system/user messages and structured tools.
  --chat-template-compat fold-system
      Fold system messages into user messages; keep structured tools.
  --chat-template-compat alternating
      Alternating user/assistant transcript with no structured tools; asks for text <tool_call>.
      Use this to reproduce the earlier Molmo text-call fallback results.
  --chat-template-compat alternating-tools
      Alternating user/assistant transcript while still sending structured tools.

Environment:
  LLM_BASE_URL, LLM_CHAT_URL, LLM_MODEL, LLM_API_KEY, OPENROUTER_API_KEY
  LLM_CHAT_TEMPLATE_COMPAT, WB_FREEZE_BASELINE

Examples:
  node test/llm/run-llamacpp.mjs --base http://127.0.0.1:1234 --model molmo2-8b
  node test/llm/run-llamacpp.mjs --base "$BASE" --model "$MODEL" --freeze freeze/baseline-2026-05-23.json --chat-template-compat alternating
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
const BROWSER = normalizeBrowser(args.browser);
const SAVE_REQUEST = !args['no-save-request'];
const CONCURRENCY = Math.max(1, parseInt(args.concurrency || '2', 10));
const TIMEOUT_MS = parseInt(args.timeout || '60000', 10);
const CHAT_TEMPLATE_COMPAT = getChatTemplateCompat({
  model: MODEL,
  value: args['chat-template-compat'],
});

// --mode ask|act|dev — optional override of the mode stored in each case.
// --tier full|mid|compact — picks SYSTEM_PROMPT_ACT[_MID|_COMPACT] and the
// corresponding tool subset. Default: full. ASK-mode cases ignore tier.
// --freeze <path> — alternative to WB_FREEZE_BASELINE env var. If set,
// system prompt + tools come from the snapshot and --tier is ignored.
// Imports are hoisted, so the env-var path of build-payload's loader has
// already run by here — for the CLI flag we call the loader explicitly.
if (args.freeze && args.freeze !== true) {
  loadFrozenBaseline(args.freeze);
}
const TIER = normalizeTier(args.tier);
const MODE_OVERRIDE = args.mode == null ? null : normalizeMode(args.mode);

const onlySet = args.only && args.only !== true
  ? new Set(String(args.only).split(',').map(s => String(parseInt(s, 10)).padStart(3, '0')))
  : null;

const runTag = args.tag || new Date().toISOString().replace(/[:.]/g, '-');
// Encode tier (and freeze) in the run-dir name so concurrent / sequential
// runs of the same model at different tiers don't clobber each other.
const tagSuffix = isFrozen()
  ? '_frozen'
  : `${MODE_OVERRIDE === 'dev' ? '_dev' : ''}${TIER === 'full' ? '' : `_${TIER}`}`;
const runDir = join(RESULTS_DIR, `${runTag}_${BROWSER}_${MODEL.replace(/[^\w.-]+/g, '_')}${tagSuffix}`);
mkdirSync(runDir, { recursive: true });

const ids = readdirSync(Q_DIR)
  .filter(f => /^\d{3}\.json$/.test(f))
  .map(f => f.replace(/\.json$/, ''))
  .filter(id => !onlySet || onlySet.has(id))
  .sort();

const promptMode = isFrozen()
  ? `frozen (${getFrozenMeta()?.sourceRun || 'unknown source'} @ ${getFrozenMeta()?.runTag || ''})`
  : `mode=${MODE_OVERRIDE || 'case'}, tier=${TIER}`;
console.error(`▸ ${ids.length} case(s), base=${BASE}, model=${MODEL}, browser=${BROWSER}, concurrency=${CONCURRENCY}`);
console.error(`▸ endpoint=${CHAT_URL}`);
console.error(`▸ prompt: ${promptMode}`);
if (CHAT_TEMPLATE_COMPAT.mode !== 'off') {
  console.error(`▸ chat template compat: ${chatTemplateCompatLabel(CHAT_TEMPLATE_COMPAT)}`);
}
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
// This handles the common shapes: <tool_call>{...}</tool_call>, Cohere-style
// action JSON, naked JSON, and ```json fenced blocks. Returns { name, args } or null.
function extractToolCallFromContent(text) {
  if (!text || typeof text !== 'string') return null;
  let candidates = [];
  // 1. <tool_call>...</tool_call> wrapper
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    candidates.push(m[1]);
  }
  // 2. Native action wrapper used by Cohere/North templates.
  for (const m of text.matchAll(/<\|START_ACTION\|>\s*([\s\S]*?)\s*<\|END_ACTION\|>/g)) {
    candidates.push(m[1]);
  }
  // 3. ```json ... ``` fenced block
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)) {
    candidates.push(m[1]);
  }
  // 4. The whole content as JSON
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    candidates.push(trimmed);
  }
  // 5. A trailing JSON action after reasoning/prose.
  const trailingJson = trimmed.match(/(\[\s*\{[\s\S]*\}\s*\]|\{[\s\S]*\})\s*$/);
  if (trailingJson) candidates.push(trailingJson[1]);

  for (const raw of candidates) {
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    const tc = normalizeToolCall(obj);
    if (tc) return tc;
  }
  const callMatch = trimmed.match(/^([A-Za-z_][\w.-]*)\s*\(([\s\S]*)\)\s*;?$/);
  if (callMatch) {
    return { name: callMatch[1], args: callMatch[2].trim() ? safeParse(callMatch[2]) : {} };
  }
  return null;
}

function normalizeToolCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj) && obj[0]) {
    return normalizeToolCall(obj[0]);
  }
  // Shape: {name, arguments|args|parameters}
  if (typeof obj.name === 'string') {
    const args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
    return { name: obj.name, args: typeof args === 'string' ? safeParse(args) : args };
  }
  // Shape: {tool_name, parameters} (Cohere/North action JSON)
  if (typeof obj.tool_name === 'string') {
    const args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
    return { name: obj.tool_name, args: typeof args === 'string' ? safeParse(args) : args };
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
  const mode = MODE_OVERRIDE || normalizeMode(caseRec.mode);
  const payload = buildPayload({ ...caseRec, mode }, { browser: BROWSER, tier: TIER });
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
    mode,
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
  tier: isFrozen() ? null : TIER,
  modeOverride: isFrozen() ? null : MODE_OVERRIDE,
  chatTemplateCompat: CHAT_TEMPLATE_COMPAT.mode,
  structuredToolsSent: !CHAT_TEMPLATE_COMPAT.omitStructuredTools,
  freeze: isFrozen() ? {
    path: args.freeze && args.freeze !== true ? args.freeze : (process.env.WB_FREEZE_BASELINE || null),
    sourceRun: getFrozenMeta()?.sourceRun || null,
    sourceRunTag: getFrozenMeta()?.runTag || null,
    systemHash: getFrozenMeta()?.systemHash || null,
    toolCount: getFrozenMeta()?.toolCount || null,
  } : null,
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
