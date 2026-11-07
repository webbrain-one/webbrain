import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// A native date field in vision mode, end to end in the installed MV3
// extension with a Turkish browser locale (the field shows gg.aa.yyyy):
// background, Agent, page monitor, CDP capture and trusted input are real; a
// loopback provider plays the model. As in the QA run that found it, the
// "model" clicks the date field and types the digits it reads off the screen
// ("20112026"), which must be refused with nothing typed, then types the
// user's answer in words ("November 20, 2026"), which must set the field to
// 2026-11-20 and verify it, and books. On the old code every type_text into
// the field reported a readback mismatch and nothing was booked.
//   node test/quality/vision-native-date-mv3.mjs
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-native-date-mv3');
await fs.mkdir(out, { recursive: true });

const LAYOUT = {
  date: { x: 60, y: 140, w: 240, h: 36 },
  book: { x: 60, y: 220, w: 180, h: 44 },
};
const body = `<!doctype html><meta charset="utf-8"><title>Book a product demo</title>
<style>body{margin:0;font:16px sans-serif}h1{position:absolute;left:60px;top:40px;margin:0}label{position:absolute;left:60px;top:112px}
#date{position:absolute;left:${LAYOUT.date.x}px;top:${LAYOUT.date.y}px;width:${LAYOUT.date.w}px;height:${LAYOUT.date.h}px;box-sizing:border-box;font:16px sans-serif}
#book{position:absolute;left:${LAYOUT.book.x}px;top:${LAYOUT.book.y}px;width:${LAYOUT.book.w}px;height:${LAYOUT.book.h}px;background:#1a73e8;color:#fff;border:0;font:16px sans-serif}
#result{position:absolute;left:60px;top:300px;width:400px;height:30px}</style>
<h1>Book a product demo</h1>
<form id="booking"><label for="date">Demo date</label><input id="date" name="date" type="date" required>
<button id="book" type="button">Book demo</button></form><div id="result" role="status"></div>
<script>
window.dateEvents = [];
for (const kind of ['input', 'change']) document.getElementById('date').addEventListener(kind, event => dateEvents.push(kind + ':' + event.target.value));
document.getElementById('book').addEventListener('click', async () => {
  const form = document.getElementById('booking');
  if (!form.reportValidity()) return;
  const date = document.getElementById('date').value;
  await fetch('/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) });
  document.getElementById('result').textContent = 'Booked for ' + date;
});
</script>`;

const providerCalls = [];
const submissions = [];
let actionCalls = 0;
let keyframe = null;
let livePage = null;
// The field right after each type_text, as the "model" makes its next call.
const fieldAfterType = [];
const centre = (rect, image) => ({
  x: Math.round((rect.x + rect.w / 2) / image.ratio),
  y: Math.round((rect.y + rect.h / 2) / image.ratio),
});

const server = http.createServer(async (request, response) => {
  if (request.url === '/submit') {
    let text = ''; for await (const chunk of request) text += chunk;
    submissions.push(JSON.parse(text)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return;
  }
  if (request.url === '/v1/chat/completions') {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text); providerCalls.push(input);
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    const fixedChoice = fixtureFixedChoiceReply(input.messages);
    let completion;
    if (fixedChoice) completion = { role: 'assistant', content: fixedChoice };
    else if (!isAction) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Scripted fixture.' }) };
    else {
      for (const message of input.messages) {
        if (!Array.isArray(message.content)) continue;
        const label = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const declared = /SCREENSHOT f\d+[\s\S]*?(\d+)x(\d+) image; 1 image px = ([\d.]+) CSS px/.exec(label);
        if (declared) keyframe = { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) };
      }
      const step = actionCalls++;
      const results = new Map(input.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
      const calls = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
        .map(item => ({ name: item.function.name, args: JSON.parse(item.function.arguments || '{}'), result: results.get(item.id) || '' }));
      const typed = calls.filter(call => call.name === 'type_text');
      if (typed.length > fieldAfterType.length) {
        fieldAfterType.push(await livePage?.evaluate(() => ({ value: document.getElementById('date').value, events: window.dateEvents.slice() })).catch(() => null));
      }
      const booked = calls.some(call => call.name === 'click_at' && typed.some(type => /"verified":true/.test(type.result))
        && calls.indexOf(call) > calls.findLastIndex(item => item.name === 'type_text') && /"success":true/.test(call.result));
      let call;
      if (!keyframe) call = { name: 'take_screenshot', args: {} };
      // The digits the field shows in this locale, sent right after its click.
      else if (typed.length === 0) call = [{ name: 'click_at', args: centre(LAYOUT.date, keyframe) }, { name: 'type_text', args: { text: '20112026' } }];
      // The user's answer to the date question, in words.
      else if (typed.length === 1) call = { name: 'type_text', args: { text: 'November 20, 2026' } };
      else if (!booked) call = { name: 'click_at', args: centre(LAYOUT.book, keyframe) };
      else call = { name: 'done', args: { summary: 'The demo is booked for 2026-11-20.', outcome: 'success' } };
      completion = { role: 'assistant', content: '', tool_calls: [call].flat().map((item, index) => ({ id: `date-${step}-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/booking`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-vision-date-mv3-'));
let context;
try {
  const extension = path.resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: null, locale: 'tr-TR',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--lang=tr-TR', '--window-size=1280,900'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.events = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') events.push({ type: event.type, data: event.data }); });
    // Vision mode and lean mode stay at their defaults, as in the QA run.
    await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 12, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000, enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  livePage = page;
  assert.equal(await page.evaluate(() => navigator.language), 'tr-TR');
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  const result = await message('chat', { tabId, text: 'Book a product demo on this page for November 20, 2026.', mode: 'act', requestId: 'vision-date-mv3', locale: 'en' });
  const events = await harness.evaluate(() => events);
  const actionRequests = providerCalls.filter(call => Array.isArray(call.tools) && call.tools.length);
  const history = actionRequests.at(-1)?.messages || [];
  const results = new Map(history.filter(item => item.role === 'tool').map(item => [item.tool_call_id, String(item.content)]));
  const typeResults = history.filter(item => item.role === 'assistant').flatMap(item => item.tool_calls || [])
    .filter(item => item.function.name === 'type_text').map(item => results.get(item.id) || '');
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, submissions, fieldAfterType, typeResults, events, providerCalls },
    (_key, item) => typeof item === 'string' && item.startsWith('data:image/') ? '[image]' : item, 2));

  const tools = actionRequests[0]?.tools.map(tool => tool.function.name) || [];
  assert.ok(tools.includes('click_at') && !tools.includes('set_field'), `a vision run: ${tools}`);
  assert.equal(typeResults.length, 2, typeResults.join('\n').slice(0, 2000));
  // The screen's digits: refused before anything reached the field.
  assert.match(typeResults[0], /"success":false/, typeResults[0].slice(0, 800));
  assert.match(typeResults[0], /"noDispatch":true/);
  assert.match(typeResults[0], /YYYY-MM-DD/);
  assert.deepEqual(fieldAfterType[0], { value: '', events: [] }, 'the refused text left the field empty and fired nothing');
  // The answer in words: set as one value and verified, with no veto.
  assert.match(typeResults[1], /"success":true/, typeResults[1].slice(0, 800));
  assert.match(typeResults[1], /"verified":true/);
  assert.match(typeResults[1], /"method":"native-date-value"/);
  assert.doesNotMatch(typeResults.join('\n'), /Browser changed during action preparation|readback_mismatch/);
  assert.deepEqual(fieldAfterType[1], { value: '2026-11-20', events: ['input:2026-11-20', 'change:2026-11-20'] });
  assert.deepEqual(submissions, [{ date: '2026-11-20' }], JSON.stringify(events.filter(event => event.type === 'tool_result').map(event => event.data)).slice(0, 3000));
  // The model is told the form to use.
  const typeText = actionRequests[0].tools.find(tool => tool.function.name === 'type_text');
  assert.match(typeText.function.description, /native date or time field[\s\S]*YYYY-MM-DD/);
  console.log(JSON.stringify({ passed: true, actionRequests: actionRequests.length, typeResults: typeResults.map(text => text.slice(0, 160)), submissions }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-date-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
