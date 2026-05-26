#!/usr/bin/env node
// Enrich a synthetic user message into the exact LLM request payload
// WebBrain would send. Two modes:
//
//   node test/llm/enrich.mjs --id 042
//   node test/llm/enrich.mjs --user "go to gmail" --url "about:home" --title "New Tab" [--mode act|ask]
//
// Output: JSON to stdout with `messages` and `tools`. Pipe into any
// OpenAI-compatible /chat/completions endpoint, or save and diff against
// a captured trace.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload } from './lib/build-payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function loadCase(id) {
  const path = join(HERE, 'questions', `${pad3(id)}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadAllCases() {
  const dir = join(HERE, 'questions');
  return readdirSync(dir)
    .filter((f) => /^\d{3}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function usage() {
  process.stderr.write(`Usage:
  node test/llm/enrich.mjs --id <NNN>
  node test/llm/enrich.mjs --all
  node test/llm/enrich.mjs --user "<text>" --url "<url>" [--title "<title>"] [--mode act|ask] [--browser chrome|firefox]

Options:
  --all               Enrich all question cases as a JSON array
  --browser           Browser source to mirror: chrome (default) or firefox
  --pretty            Pretty-print JSON output
  --no-tools          Omit the tools array (smaller diff)
  --no-adapters       Disable site-adapter injection (UNIVERSAL_PREAMBLE + per-site)
  --strict-secrets    Use the strict-mode \`done\` description

Examples:
  node test/llm/enrich.mjs --id 1 --pretty
  node test/llm/enrich.mjs --all --pretty > enriched.json
  node test/llm/enrich.mjs --user "log in pls" --url "https://addons.mozilla.org/" > req.json
`);
}

function enrich(caseRec, args) {
  const payload = buildPayload(caseRec, {
    useSiteAdapters: !args['no-adapters'],
    strictSecretMode: !!args['strict-secrets'],
    browser: args.browser,
  });

  if (args['no-tools']) {
    delete payload.tools;
  }

  return payload;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let output;

  if (args.all) {
    output = loadAllCases().map((caseRec) => enrich(caseRec, args));
  } else if (args.id != null && args.id !== true) {
    const n = parseInt(args.id, 10);
    if (!Number.isFinite(n) || n < 1) {
      process.stderr.write(`Bad --id: ${args.id}\n`);
      process.exit(2);
    }
    output = enrich(loadCase(n), args);
  } else if (typeof args.user === 'string') {
    output = enrich({
      mode: args.mode === 'ask' ? 'ask' : 'act',
      tab: { url: args.url || '', title: args.title || '' },
      user: args.user,
    }, args);
  } else {
    usage();
    process.exit(2);
  }

  const json = args.pretty
    ? JSON.stringify(output, null, 2)
    : JSON.stringify(output);
  process.stdout.write(json + '\n');
}

main();
