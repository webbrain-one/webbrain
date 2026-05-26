#!/usr/bin/env node
// Convert a webbrain-trace JSON file into a scenario stub with PII scrubbed.
//
// Usage:
//   node test/llm/_redact-trace.mjs path/to/trace.json
//   node test/llm/_redact-trace.mjs path/to/trace.json --challenge-step 5
//   node test/llm/_redact-trace.mjs path/to/trace.json --extra-pattern "ReplaceFAQ" --extra-pattern "Gnippets"
//
// Output: a JSON stub printed to stdout. Hand-edit the `expected` block
// (idealNextToolCall + antiPatterns + successRubric) before saving as
// test/llm/scenarios/NNN.json.
//
// What gets scrubbed (deterministic placeholders so the trace stays coherent):
//   - Email addresses → user@example.com
//   - Stripe-style IDs (acct_*, po_*, cus_*, prod_*, price_*, pi_*, sub_*,
//     ch_*, seti_*, txn_*, in_*, sk_live_*, sk_test_*, pk_live_*, pk_test_*,
//     rk_live_*, rk_test_*, whsec_*) → <prefix>_REDACTED
//   - JWT tokens → eyJREDACTED.REDACTED.REDACTED
//   - OpenAI keys (sk-...) → sk-REDACTED
//   - GitHub/OpenRouter PATs (gho_*, ghp_*, ghs_*, sk-or-...) → REDACTED
//   - Bearer tokens in URL params (?access_token=, ?token=) → REDACTED
//   - --extra-pattern values (substring, case-insensitive) → REDACTED
//
// This intentionally does NOT try to be exhaustive. Eyeball the output
// before committing — if you see anything personal, add --extra-pattern.

import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { extraPatterns: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--challenge-step') { out.challengeStep = parseInt(argv[++i], 10); continue; }
    if (a === '--extra-pattern') { out.extraPatterns.push(argv[++i]); continue; }
    if (a === '--keep-emails') { out.keepEmails = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--') && !out.tracePath) { out.tracePath = a; continue; }
  }
  return out;
}

const REDACTIONS = [
  // JWT tokens (catch first — they contain dots that other patterns might split)
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g, to: 'eyJREDACTED.REDACTED.REDACTED' },
  // OpenAI / OpenRouter / Anthropic keys
  { re: /sk-or-v[0-9]-[A-Za-z0-9]{20,}/g, to: 'sk-or-vREDACTED' },
  { re: /sk-ant-[A-Za-z0-9-]{20,}/g, to: 'sk-ant-REDACTED' },
  { re: /sk-[A-Za-z0-9-_]{20,}/g, to: 'sk-REDACTED' },
  { re: /gh[oprs]_[A-Za-z0-9]{20,}/g, to: 'ghX_REDACTED' },
  // Stripe-style IDs
  { re: /\b(acct|po|cus|prod|price|pi|sub|ch|seti|txn|in|rk_live|rk_test|sk_live|sk_test|pk_live|pk_test|whsec)_[A-Za-z0-9]{8,}/g, to: (_, p) => `${p}_REDACTED` },
  // Email addresses (catch BEFORE bare-token sweeps so we don't garble the @)
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: 'user@example.com' },
  // Bearer token in URL params
  { re: /([?&](?:access_token|token|api_key|apikey|auth)=)[A-Za-z0-9._-]{12,}/gi, to: '$1REDACTED' },
  // US phone numbers — require at least one separator so we don't clobber
  // 10-digit Unix timestamps (1775631600), Stripe-style numeric ids, etc.
  { re: /(?<!\d)(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)/g, to: '555-0100' },
];

function scrubString(s, extras) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const { re, to } of REDACTIONS) {
    out = out.replace(re, to);
  }
  for (const pat of extras) {
    if (!pat) continue;
    const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, 'REDACTED');
  }
  return out;
}

function scrub(value, extras) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value, extras);
  if (Array.isArray(value)) return value.map(v => scrub(v, extras));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, extras);
    return out;
  }
  return value;
}

// Walk the trace's events list and reconstruct a chat message history up
// through the step BEFORE `challengeStep`. The challenge step is the LLM
// turn we want the scenario to test — its inputs become the seed, its
// output becomes the comparison target.
function buildSeedFromTrace(trace, challengeStep) {
  const events = trace.events || [];
  const seed = [{ role: 'user', content: contextLine(trace.run) + (trace.run?.userMessage || '') }];

  for (const ev of events) {
    if (ev.kind === 'llm_response') {
      const step = ev.data?.step;
      if (challengeStep != null && step >= challengeStep) break;
      const tcs = (ev.data?.toolCalls || []).map((tc, i) => ({
        id: tc.id || `call_${step}_${i}`,
        type: 'function',
        function: { name: tc.name, arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}) },
      }));
      seed.push({
        role: 'assistant',
        content: ev.data?.content || '',
        ...(tcs.length ? { tool_calls: tcs } : {}),
      });
    } else if (ev.kind === 'tool') {
      // Find the most recent assistant tool_call to attach this result to
      const lastAssistant = [...seed].reverse().find(m => m.role === 'assistant' && m.tool_calls);
      const matchingCall = lastAssistant?.tool_calls?.find(tc => tc.function.name === ev.data?.name);
      if (matchingCall) {
        seed.push({
          role: 'tool',
          tool_call_id: matchingCall.id,
          name: ev.data.name,
          content: typeof ev.data.result === 'string' ? ev.data.result : JSON.stringify(ev.data.result),
        });
      }
    }
  }

  return seed;
}

function contextLine(run) {
  const url = run?.tabUrl || '';
  const title = run?.tabTitle || '';
  if (!url) return '';
  return `[Current page context — applies to this user message and supersedes older page context for phrases like "this page". URL: ${url}${title ? ` — Title: ${title}` : ''}]\n\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.tracePath) {
    process.stderr.write(`Usage: node test/llm/_redact-trace.mjs path/to/trace.json [--challenge-step N] [--extra-pattern STR]+
Outputs a scenario stub to stdout. Hand-edit the expected block before saving.\n`);
    process.exit(args.help ? 0 : 2);
  }

  const trace = JSON.parse(readFileSync(args.tracePath, 'utf8'));
  const extras = args.extraPatterns;

  // Scrub the entire trace first
  const cleanTrace = scrub(trace, extras);

  // Determine challenge step
  const totalSteps = (cleanTrace.events || []).filter(e => e.kind === 'llm_response').length;
  const challengeStep = args.challengeStep || totalSteps; // default: last LLM turn

  const seed = buildSeedFromTrace(cleanTrace, challengeStep);

  // Find the actual LLM response at challengeStep (for human reference,
  // NOT for scoring — author writes expected manually).
  const challengeEvent = (cleanTrace.events || []).find(
    e => e.kind === 'llm_response' && e.data?.step === challengeStep,
  );
  const actualNextCall = challengeEvent?.data?.toolCalls?.[0]
    ? { name: challengeEvent.data.toolCalls[0].name, args: safeParse(challengeEvent.data.toolCalls[0].args) }
    : null;
  const actualNextContent = challengeEvent?.data?.content || null;

  const stub = {
    id: '???',
    category: '???',  // FIXME: pick from loop-bad-url, tool-error-pivot, csp-blocked-eval, truncation-cascade, counter-polarity, stale-refid, mode-boundary, cross-lingual
    mode: cleanTrace.run?.mode || 'act',
    browser: 'chrome',  // FIXME: set based on the trace source
    tab: { url: cleanTrace.run?.tabUrl || '', title: cleanTrace.run?.tabTitle || '' },
    description: `[FROM TRACE ${cleanTrace.run?.runId || '?'}, step ${challengeStep}] — FIXME: describe the failure mode in one sentence.`,
    seed,
    expected: {
      idealNextToolCall: { name: 'FIXME', args: {} },
      antiPatterns: actualNextCall ? [
        { match: `${actualNextCall.name}(${JSON.stringify(actualNextCall.args)})`, reason: 'FIXME: explain why the original model\'s actual next call was wrong.' },
      ] : [],
      successRubric: 'FIXME: 1-3 sentences describing what counts as a correct continuation.',
    },
    _trace_meta: {
      sourceTrace: cleanTrace.run?.runId || null,
      sourceModel: cleanTrace.run?.model || null,
      challengeStep,
      actualNextCall,
      actualNextContent: actualNextContent ? actualNextContent.slice(0, 500) : null,
      note: 'Remove _trace_meta before saving as scenarios/NNN.json. It is for your reference only.',
    },
  };

  process.stdout.write(JSON.stringify(stub, null, 2) + '\n');
  process.stderr.write(`\n▸ Stubbed scenario from ${args.tracePath} (challengeStep=${challengeStep})\n`);
  process.stderr.write(`▸ Fill in: id, category, description, expected.{idealNextToolCall, antiPatterns, successRubric}\n`);
  process.stderr.write(`▸ Eyeball the seed[] for any PII that slipped past the regex scrubs.\n`);
  process.stderr.write(`▸ Delete _trace_meta before saving.\n`);
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

main();
