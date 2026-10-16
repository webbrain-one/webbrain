#!/usr/bin/env node
// Inference-free, non-destructive regrade of stored Compact outputs after the
// LFM2 content-parser fix. Writes only a new content-addressed analysis tree.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload } from './lib/build-payload.mjs';
import { buildScenarioPayload } from './lib/scenario-payload.mjs';
import { extractToolCallFromContent } from './lib/content-tool-call-parser.mjs';
import { scoreVerdict } from './lib/score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);

function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function fileSha(path) { return sha256(readFileSync(path)); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const pairs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--pair') throw new Error(`unknown argument: ${argv[i]}`);
    const value = argv[++i];
    const [label, first, scenarios] = value.split('::');
    if (!label || !first || !scenarios) throw new Error(`bad --pair: ${value}`);
    pairs.push({ label, first: resolve(first), scenarios: resolve(scenarios) });
  }
  if (!pairs.length) throw new Error('at least one --pair is required');
  return pairs;
}

function jsonFiles(dir) {
  return readdirSync(dir).filter((name) => /^\d{3}\.json$/u.test(name)).sort();
}

function availableTools(kind, id, row, summary) {
  try {
    if (kind === 'first-turn') {
      const question = JSON.parse(readFileSync(join(HERE, 'questions', `${id}.json`), 'utf8'));
      return buildPayload({ ...question, mode: row.mode }, {
        browser: summary.browser || 'chrome', tier: summary.tier || 'compact',
      }).tools;
    }
    const scenario = JSON.parse(readFileSync(join(HERE, 'scenarios', `${id}.json`), 'utf8'));
    return buildScenarioPayload({
      ...scenario, browser: row.browser || summary.browser || 'chrome', mode: row.mode,
    }, { tier: summary.tier || 'compact', unprotected: !!summary.unprotected }).tools;
  } catch {
    return null;
  }
}

function expectedFor(kind, id, row) {
  if (kind === 'scenarios') return row.expected;
  const source = JSON.parse(readFileSync(join(HERE, 'expected', `${id}.json`), 'utf8'));
  return { idealNextToolCall: source.idealFirstToolCall, antiPatterns: [] };
}

function emptyCounts() {
  return { exact: 0, name_only: 0, other: 0, no_tool: 0, anti: 0, empty: 0, error: 0, skipped: 0 };
}

function bucket(verdict) {
  return ({ ideal: 'exact', ideal_name: 'name_only' })[verdict] || verdict;
}

function gradeDir(kind, dir) {
  if (!existsSync(dir)) throw new Error(`missing run dir: ${dir}`);
  const summaryPath = join(dir, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const counts = emptyCounts();
  const rows = [];
  let structured = 0; let fallback = 0;
  for (const name of jsonFiles(dir)) {
    const path = join(dir, name);
    const row = JSON.parse(readFileSync(path, 'utf8'));
    const id = name.slice(0, 3);
    const tools = availableTools(kind, id, row, summary);
    let call = row.firstToolCall || null;
    let source = row.toolCallSource || (call ? 'stored_structured' : null);
    if (!call && row.content) {
      call = extractToolCallFromContent(row.content, { tools });
      if (call) source = 'content_fallback_lfm2_v2';
    }
    if (source === 'content_fallback_lfm2_v2') fallback += 1;
    else if (call) structured += 1;
    const expected = expectedFor(kind, id, row);
    const scored = scoreVerdict({
      skipped: row.skipped,
      error: row.error,
      firstToolCall: call,
      content: row.content,
      expected,
      tools: row.gradingTools || tools,
      tier: row.tier || summary.tier || 'compact',
      mode: row.mode,
      browser: row.browser || summary.browser || 'chrome',
    });
    counts[bucket(scored.verdict)] += 1;
    rows.push({
      id,
      inputSha256: fileSha(path),
      source,
      firstToolCall: call,
      verdict: bucket(scored.verdict),
      originalVerdict: row.verdict || null,
      matchedAntiPattern: scored.matchedAntiPattern || null,
      contentSha256: row.content ? sha256(row.content) : null,
    });
  }
  return {
    kind, sourceDir: dir, sourceSummarySha256: fileSha(summaryPath),
    rows: rows.length, structured, fallback, toolCalls: structured + fallback,
    toolCallRate: rows.length ? (structured + fallback) / rows.length : 0,
    counts, decisions: rows,
  };
}

const pairs = parseArgs(process.argv.slice(2));
const implementation = {
  regrader: { path: SCRIPT, sha256: fileSha(SCRIPT) },
  contentParser: { path: join(HERE, 'lib', 'content-tool-call-parser.mjs'), sha256: fileSha(join(HERE, 'lib', 'content-tool-call-parser.mjs')) },
  grader: { path: join(HERE, 'lib', 'score.mjs'), sha256: fileSha(join(HERE, 'lib', 'score.mjs')) },
};
const graded = pairs.map((pair) => {
  const firstTurn = gradeDir('first-turn', pair.first);
  const scenarios = gradeDir('scenarios', pair.scenarios);
  const combined = emptyCounts();
  for (const key of Object.keys(combined)) combined[key] = firstTurn.counts[key] + scenarios.counts[key];
  return {
    label: pair.label,
    firstTurn,
    scenarios,
    combined: {
      rows: firstTurn.rows + scenarios.rows,
      toolCalls: firstTurn.toolCalls + scenarios.toolCalls,
      toolCallRate: (firstTurn.toolCalls + scenarios.toolCalls) / (firstTurn.rows + scenarios.rows),
      counts: combined,
    },
  };
});

const signature = sha256(stable({
  implementation,
  inputs: graded.map(({ label, firstTurn, scenarios }) => ({
    label,
    firstTurn: { sourceDir: firstTurn.sourceDir, sourceSummarySha256: firstTurn.sourceSummarySha256, decisions: firstTurn.decisions.map((r) => r.inputSha256) },
    scenarios: { sourceDir: scenarios.sourceDir, sourceSummarySha256: scenarios.sourceSummarySha256, decisions: scenarios.decisions.map((r) => r.inputSha256) },
  })),
}));
const outputDir = join(HERE, 'analysis', `compact-parser-regrade-v2-${signature.slice(0, 16)}`);
mkdirSync(outputDir, { recursive: false });

for (const model of graded) {
  writeFileSync(join(outputDir, `${model.label}.rows.json`), `${JSON.stringify(model, null, 2)}\n`, { flag: 'wx' });
}
const summaryBody = {
  schema: 'webbrain-compact-parser-regrade-v2',
  createdAt: new Date().toISOString(),
  inferenceRequests: 0,
  inputSignatureSha256: signature,
  implementation,
  models: graded.map(({ label, firstTurn, scenarios, combined }) => ({
    label,
    firstTurn: { rows: firstTurn.rows, toolCalls: firstTurn.toolCalls, toolCallRate: firstTurn.toolCallRate, counts: firstTurn.counts },
    scenarios: { rows: scenarios.rows, toolCalls: scenarios.toolCalls, toolCallRate: scenarios.toolCallRate, counts: scenarios.counts },
    combined,
  })),
};
const reportSha = sha256(stable(summaryBody));
const report = join(outputDir, `summary-${reportSha}.json`);
writeFileSync(report, `${JSON.stringify({ ...summaryBody, reportSha256: reportSha }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: 'regraded', outputDir, report, reportSha256: reportSha, models: summaryBody.models }, null, 2));
