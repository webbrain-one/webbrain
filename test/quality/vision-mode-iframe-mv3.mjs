import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Vision mode in the installed MV3 extension on a form inside a same-origin
// iframe (QA case B2). Background, Agent, CDP capture, page monitors and
// trusted input are real; a loopback provider plays the model, which reads
// the frame label's scale and clicks the frame's field and then its Save
// button with click_at at their points. Before the fix every click_at into
// the frame was refused before dispatch ("The browser changed during action
// preparation") on this static page, so neither control was ever reached.
//   node test/quality/vision-mode-iframe-mv3.mjs
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-mode-iframe-mv3');
await fs.mkdir(out, { recursive: true });

// Top-level CSS geometry the "model" knows: the frame (no border) and the
// controls inside it, offset by the frame's position.
const FRAME = { x: 60, y: 120, w: 520, h: 240 };
const CITY = { x: 30, y: 40, w: 240, h: 36 };
const SAVE = { x: 30, y: 110, w: 160, h: 40 };
const inFrame = rect => ({ x: FRAME.x + rect.x, y: FRAME.y + rect.y, w: rect.w, h: rect.h });
const topHtml = `<!doctype html><meta charset="utf-8"><title>Shipping details</title>
<style>body{margin:0;font:16px sans-serif}h1{position:absolute;left:60px;top:30px;margin:0}
p{position:absolute;left:60px;top:80px;margin:0}
iframe{position:absolute;left:${FRAME.x}px;top:${FRAME.y}px;width:${FRAME.w}px;height:${FRAME.h}px;border:0;background:#f4f4f4}</style>
<h1>Shipping details</h1><p>Enter the delivery city in the embedded form, then save it.</p>
<iframe src="/iframe-inner" title="Shipping form"></iframe>`;
const innerHtml = `<!doctype html><meta charset="utf-8"><title>Delivery</title>
<style>body{margin:0;font:16px sans-serif}label{position:absolute;left:30px;top:14px}
#city{position:absolute;left:${CITY.x}px;top:${CITY.y}px;width:${CITY.w}px;height:${CITY.h}px;box-sizing:border-box;font:16px sans-serif}
#save{position:absolute;left:${SAVE.x}px;top:${SAVE.y}px;width:${SAVE.w}px;height:${SAVE.h}px;background:#1a73e8;color:#fff;border:0;font:16px sans-serif}
#status{position:absolute;left:30px;top:170px;width:400px;height:24px}</style>
<label for="city">Delivery city</label><input id="city" name="city" autocomplete="off">
<button id="save" type="button">Save city</button><div id="status" role="status"></div>
<script>window.qaClicks = [];
document.addEventListener('click', event => { if (event.isTrusted) qaClicks.push(event.target.id || event.target.tagName); }, true);
document.getElementById('save').addEventListener('click', async () => {
  const city = document.getElementById('city').value;
  await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city }) });
  document.getElementById('status').textContent = 'Saved delivery city: ' + city;
});</script>`;

const providerCalls = [];
const submissions = [];
let keyframe = null;
let actionCalls = 0;
const centre = (rect, image) => ({ x: Math.round((rect.x + rect.w / 2) / image.ratio), y: Math.round((rect.y + rect.h / 2) / image.ratio) });

const server = http.createServer(async (request, response) => {
  if (request.url === '/save') {
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
        const declared = /(\d+)x(\d+) image; 1 image px = ([\d.]+) CSS px/.exec(label);
        if (/SCREENSHOT f\d+/.test(label) && declared && message.content.some(block => block.type === 'image_url')) {
          keyframe = { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) };
        }
      }
      const step = actionCalls++;
      const results = new Map(input.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
      const pairs = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
        .map(item => ({ name: item.function.name, ok: /"success":true/.test(results.get(item.id) || '') }));
      const clicked = pairs.filter(pair => pair.name === 'click_at' && pair.ok).length;
      let call;
      if (!keyframe) call = { name: 'take_screenshot', args: {} };
      else if (clicked === 0) call = { name: 'click_at', args: centre(inFrame(CITY), keyframe) };
      else if (clicked === 1) call = { name: 'click_at', args: centre(inFrame(SAVE), keyframe) };
      else call = { name: 'done', args: { summary: 'The form was saved.', outcome: 'success' } };
      completion = { role: 'assistant', content: '', tool_calls: [call].flat().map((item, index) => ({ id: `frame-${step}-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(request.url === '/iframe-inner' ? innerHtml : topHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/iframe-form`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-vision-iframe-mv3-'));
let context;
try {
  const extension = path.resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.events = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') events.push({ type: event.type, data: event.data }); });
    // visionMode is deliberately left unset: vision mode is the default.
    await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 8, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false, leanMode: 'on' });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000, enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  const inner = page.frames().find(frame => frame !== page.mainFrame());
  await inner.waitForSelector('#city');
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  const result = await message('chat', { tabId, text: 'In the embedded shipping form, click the delivery city field, then save the form.', mode: 'act', requestId: 'vision-iframe-mv3', locale: 'en' });
  const events = await harness.evaluate(() => events);
  const clicks = await inner.evaluate(() => window.qaClicks);
  const finalUrl = page.url();
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, clicks, finalUrl, submissions, events, providerCalls },
    (_key, item) => typeof item === 'string' && item.startsWith('data:image/') ? '[image]' : item, 2));

  const actionRequests = providerCalls.filter(call => Array.isArray(call.tools) && call.tools.length);
  const history = actionRequests.at(-1)?.messages || [];
  const toolResults = history.filter(item => item.role === 'tool').map(item => String(item.content));
  assert.ok(keyframe, 'the model received a full frame');
  assert.ok(!toolResults.some(text => /changed during action preparation/.test(text)),
    `no vision input into the frame was refused as a browser change:\n${toolResults.join('\n').slice(0, 3000)}`);
  const clickResults = toolResults.filter(text => /"method":"cdp-vision-pointer"/.test(text));
  assert.equal(clickResults.length, 2, `both clicks went out at their points: ${toolResults.join('\n').slice(0, 2000)}`);
  assert.deepEqual(clicks, ['city', 'save'], 'each control inside the frame took exactly one trusted click');
  assert.deepEqual(submissions, [{ city: '' }], "the frame button's own handler ran once");
  assert.equal(finalUrl, url, 'the tab stayed on the page that embeds the form');
  assert.ok(actionRequests.length <= 4, `${actionRequests.length} model calls`);
  console.log(JSON.stringify({ passed: true, keyframe, actionRequests: actionRequests.length, clicks, submissions, finalUrl }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-iframe-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
