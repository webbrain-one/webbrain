#!/usr/bin/env node
// Vision probe — send a single screenshot to any OpenAI-compatible chat
// endpoint using the EXACT system prompt, user text, and params our vision
// sub-call uses inside the extension. Useful for sanity-checking whether
// a local vision model (llama.cpp, Ollama, LM Studio, vLLM, etc.) is
// actually capable of the terse structured caption the planner needs.
//
// Usage:
//   node vision-probe.mjs <image-path> [endpoint] [model]
//
// Examples:
//   node vision-probe.mjs ./screenshot.png
//   node vision-probe.mjs ./screenshot.png http://127.0.0.1:8080 Gemma-4-E2B-It
//   node vision-probe.mjs ./screenshot.png http://localhost:11434/v1 llava:13b
//
// The endpoint may be given with or without /v1 — we append /v1/chat/completions
// if it isn't already there.
//
// No API key handling: this script is meant for local/offline servers. If
// your endpoint needs a bearer token, set VISION_PROBE_KEY in the env.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

// Keep these two constants in sync with src/chrome/src/agent/agent.js —
// the whole point of this probe is to mirror what the extension sends.
const VISION_SYSTEM_PROMPT = `You are the vision subsystem of a web-automation agent. A screenshot of the current browser viewport is attached. Describe what is on screen so the planning agent can decide its next action.

Format — keep it terse, structured, no flowery prose:

1) Page purpose: one line (e.g. "GitHub repo issue list", "Gmail compose", "Stripe checkout form").
2) Visible text: list the EXACT strings on buttons, links, headings, tabs, and menu items. Quote them verbatim. Do not paraphrase.
3) Inputs: list each visible form field with its label, placeholder, current value, and whether it is focused/disabled.
4) State signals: loading spinners, toasts, modals, error banners, success messages, CAPTCHAs, cookie/consent banners, overlays.
5) Blockers: anything that would prevent the next likely action (overlay, disabled submit, missing data, auth prompt).
6) Unknowns: if you cannot read something clearly, say so. Do not guess numbers, names, or identifiers.

Rules: no prose intro, no conclusion, no "this screenshot shows...", no layout description unless it matters (e.g. "left nav is collapsed"). If the page is blank or still loading, say that in one line and stop.`;

const USER_TEXT = 'Describe this screenshot of the current browser viewport for a web-automation agent. Follow the format in the system prompt.';

function usage() {
  console.error(`usage: node vision-probe.mjs <image-path> [endpoint] [model]

Defaults:
  endpoint = http://127.0.0.1:8080
  model    = (omitted — the server decides)

Env:
  VISION_PROBE_FOLD_SYSTEM=1  fold system prompt into user text for
                              templates that reject system messages
`);
  process.exit(2);
}

const [, , imgArg, endpointArg, modelArg] = process.argv;
if (!imgArg) usage();

const imgPath = path.resolve(imgArg);
let endpoint = endpointArg || 'http://127.0.0.1:8080';
if (!endpoint.includes('/chat/completions')) {
  endpoint = endpoint.replace(/\/+$/, '');
  if (!/\/v\d/.test(endpoint)) endpoint += '/v1';
  endpoint += '/chat/completions';
}

let bytes;
try {
  bytes = await fs.readFile(imgPath);
} catch (e) {
  console.error(`[error] cannot read image: ${imgPath} (${e.message})`);
  process.exit(1);
}
const ext = path.extname(imgPath).slice(1).toLowerCase();
const mime = ext === 'jpg' ? 'image/jpeg' : ext ? `image/${ext}` : 'image/png';
const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
console.error(`[info] image:    ${imgPath}`);
console.error(`[info] size:     ${bytes.length} bytes  mime: ${mime}`);
console.error(`[info] endpoint: ${endpoint}`);
if (modelArg) console.error(`[info] model:    ${modelArg}`);

const foldSystemIntoUser = process.env.VISION_PROBE_FOLD_SYSTEM
  ? process.env.VISION_PROBE_FOLD_SYSTEM !== '0'
  : /molmo/i.test(modelArg || '');
if (foldSystemIntoUser) {
  console.error('[info] system:   folded into user message for chat-template compatibility');
}

const userContent = [
  {
    type: 'text',
    text: foldSystemIntoUser
      ? `${VISION_SYSTEM_PROMPT}\n\nUser request:\n${USER_TEXT}`
      : USER_TEXT,
  },
  { type: 'image_url', image_url: { url: dataUrl } },
];

// Stream the response so headers arrive immediately. With stream:false,
// large models (300B+ at low quant) can blow past undici's 5-minute
// headers timeout during prompt-eval and trip UND_ERR_HEADERS_TIMEOUT
// before the first byte. Generation content is identical either way.
const body = {
  messages: foldSystemIntoUser
    ? [{ role: 'user', content: userContent }]
    : [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
  temperature: 0,
  max_tokens: 800,
  stream: true,
  stream_options: { include_usage: true },
  // Suppress chain-of-thought preambles across the major reasoning model
  // families:
  //   - Qwen3/3.5/3.6: `enable_thinking: false`
  //   - NVIDIA Nemotron-Nano-Reasoning: `think: false`
  //   - DeepSeek R1 family (some variants): `thinking: false`
  // Servers ignore unknown kwargs, so packing all three is safe and lets
  // one probe handle every reasoning model we've benchmarked.
  chat_template_kwargs: { enable_thinking: false, think: false, thinking: false },
};
if (modelArg) body.model = modelArg;

const headers = { 'Content-Type': 'application/json' };
if (process.env.VISION_PROBE_KEY) {
  headers['Authorization'] = `Bearer ${process.env.VISION_PROBE_KEY}`;
}

// Use node:http directly instead of fetch — undici's default 5-minute
// headers timeout fires before the first byte for big multimodal models
// (300B+ at low quant), where prompt-eval alone can take longer than
// that.
const t0 = Date.now();
const url = new URL(endpoint);
const lib = url.protocol === 'https:' ? https : http;
const reqBody = JSON.stringify(body);
const req = lib.request({
  method: 'POST',
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: url.pathname + url.search,
  headers: { ...headers, 'Content-Length': Buffer.byteLength(reqBody) },
});
req.setTimeout(0); // disable inactivity timeout
req.on('error', (e) => {
  console.error(`[error] network: ${e.message}`);
  process.exit(1);
});
req.write(reqBody);
req.end();
const res = await new Promise((resolve) => req.once('response', resolve));
console.error(`[info] status ${res.statusCode}  ${Date.now() - t0} ms (headers)`);

if (res.statusCode < 200 || res.statusCode >= 300) {
  let buf = '';
  for await (const chunk of res) buf += chunk;
  console.error('[error] response body:');
  console.error(buf.slice(0, 4000));
  process.exit(1);
}

// Parse SSE stream. Each event is `data: <json>\n\n`; final event is
// `data: [DONE]`. Usage arrives in the last JSON event (before [DONE])
// when stream_options.include_usage is set. Some models (MiMo, DeepSeek)
// emit `reasoning_content` deltas alongside `content`; we capture both
// but only the visible content is the structured caption.
let content = '';
let reasoning = '';
let usage2 = {};
let timings = null;
let firstTokenAt = null;
let buffer = '';
res.setEncoding('utf8');
process.stdout.write('\n========== MODEL RESPONSE ==========\n');
for await (const chunk of res) {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const event = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const delta = evt?.choices?.[0]?.delta || {};
      if (delta.content) {
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          console.error(`[info] ttft:  ${firstTokenAt - t0} ms`);
        }
        content += delta.content;
        process.stdout.write(delta.content);
      }
      if (delta.reasoning_content) {
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          console.error(`[info] ttft:  ${firstTokenAt - t0} ms (reasoning)`);
        }
        reasoning += delta.reasoning_content;
      }
      if (evt?.usage) usage2 = evt.usage;
      if (evt?.choices?.[0]?.timings) timings = evt.choices[0].timings;
    }
  }
}
process.stdout.write('\n====================================\n\n');
console.error(`[info] total: ${Date.now() - t0} ms`);
if (reasoning) console.error(`[info] reasoning: ${reasoning.length} chars (suppressed; see model docs to disable)`);
console.error(`[info] usage:   ${JSON.stringify(usage2)}`);
if (timings) console.error(`[info] timings: prompt ${timings.prompt_n}t/${timings.prompt_ms?.toFixed(0)}ms (${timings.prompt_per_second?.toFixed(2)}t/s), predict ${timings.predicted_n}t/${timings.predicted_ms?.toFixed(0)}ms (${timings.predicted_per_second?.toFixed(2)}t/s)`);
