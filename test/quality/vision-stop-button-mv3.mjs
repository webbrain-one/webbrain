import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// The page's own Stop WebBrain button never takes the agent's click, in the
// installed MV3 extension: background, Agent, CDP capture and trusted input
// are real; a loopback provider plays the model. The fixture's cookie bar has
// its "Accept all" button centred near the bottom of the viewport, right
// where the Stop button sits while a run is active. Screenshots are taken
// with the Stop button hidden, so the model sees only the banner and clicks
// its button. That click must accept the banner and the run must end with
// done; before the fix it pressed the Stop button and stopped the run.
//   node test/quality/vision-stop-button-mv3.mjs
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-stop-button-mv3');
await fs.mkdir(out, { recursive: true });

const body = `<!doctype html><meta charset="utf-8"><title>Stop button fixture</title>
<style>body{margin:0;font:16px sans-serif}h1{margin:40px 60px}
#bar{position:fixed;left:0;right:0;bottom:0;height:80px;background:#e8e8e8}
#accept{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);width:240px;height:40px;margin:0;background:#1a73e8;color:#fff;border:0;font:16px sans-serif}</style>
<h1>Welcome</h1><p style="margin:0 60px">This site uses cookies.</p>
<div id="bar"><button id="accept" type="button">Accept all</button></div>
<script>document.getElementById('accept').addEventListener('click', async () => {
  await fetch('/accepted', { method: 'POST' });
  document.getElementById('bar').remove();
});</script>`;

const providerCalls = [];
let accepted = 0;
let livePage = null;
// What the page looked like each time the model chose the click.
const aims = [];
let stopAtDone = null;

const pageGeometry = () => livePage.evaluate(() => {
  const box = element => {
    const r = element?.getBoundingClientRect();
    return r && r.width > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
  };
  return {
    height: document.documentElement.clientHeight,
    accept: box(document.getElementById('accept')),
    stop: box(document.getElementById('webbrain-agent-stop-container')),
  };
});

const server = http.createServer(async (request, response) => {
  if (request.url === '/accepted') {
    accepted++;
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return;
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
      // The scale of the last full frame, as its label declares it.
      let ratio = null;
      for (const message of input.messages) {
        if (!Array.isArray(message.content)) continue;
        const label = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const declared = /SCREENSHOT f\d+[\s\S]*?\d+x\d+ image; 1 image px = ([\d.]+) CSS px/.exec(label);
        if (declared) ratio = Number(declared[1]);
      }
      const results = new Map(input.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
      const clicked = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
        .some(item => item.function.name === 'click_at' && /"success":true/.test(results.get(item.id) || ''));
      let call;
      if (!ratio) call = { name: 'take_screenshot', args: {} };
      else if (!clicked) {
        const geometry = await pageGeometry();
        aims.push(geometry);
        const { accept } = geometry;
        call = { name: 'click_at', args: {
          x: Math.round((accept.left + accept.right) / 2 / ratio), y: Math.round((accept.top + accept.bottom) / 2 / ratio),
        } };
      } else {
        stopAtDone = (await pageGeometry()).stop;
        call = { name: 'done', args: { summary: 'The cookie banner was accepted.', outcome: 'success' } };
      }
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `stop-${providerCalls.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/cookies`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-stop-button-mv3-'));
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
    // visionMode is left unset: vision mode is the default.
    await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 8, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false, leanMode: 'on' });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000, enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  livePage = page;
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  const result = await message('chat', { tabId, text: 'Accept the cookie banner.', mode: 'act', requestId: 'stop-button-mv3', locale: 'en' });
  const events = await harness.evaluate(() => events);
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, accepted, aims, stopAtDone, events, providerCalls },
    (_key, item) => typeof item === 'string' && item.startsWith('data:image/') ? '[image]' : item, 2));

  // The scenario is real: when the model chose its point, the Stop button
  // was drawn over the banner's button there.
  const aim = aims[0];
  assert.ok(aim?.accept && aim.stop, `the model aimed with the Stop button shown: ${JSON.stringify(aims)}`);
  const point = { x: (aim.accept.left + aim.accept.right) / 2, y: (aim.accept.top + aim.accept.bottom) / 2 };
  assert.ok(point.x > aim.stop.left && point.x < aim.stop.right && point.y > aim.stop.top && point.y < aim.stop.bottom,
    `the Stop button covered the point: ${JSON.stringify({ point, stop: aim.stop })}`);
  // The trusted click reached the page, and the run went on to done.
  const toolResults = events.filter(event => event.type === 'tool_result').map(event => JSON.stringify(event.data));
  assert.equal(accepted, 1, `the banner's button got the click: ${toolResults.join('\n').slice(0, 2000)}`);
  assert.equal(aims.length, 1, 'one click was enough');
  // The model-facing click result names the exact-point CDP path.
  const modelResults = providerCalls.filter(call => Array.isArray(call.tools) && call.tools.length).at(-1).messages
    .filter(message => message.role === 'tool').map(message => String(message.content));
  assert.ok(modelResults.some(text => /"method":"cdp-vision-pointer"/.test(text) && /"success":true/.test(text)), modelResults.join('\n').slice(0, 2000));
  assert.ok(stopAtDone && stopAtDone.bottom < aim.height / 2, `the Stop button moved to the top edge: ${JSON.stringify(stopAtDone)}`);
  assert.ok(events.some(event => event.type === 'done' || /accepted/i.test(JSON.stringify(event.data || ''))),
    `the run ended with done: ${JSON.stringify(result).slice(0, 600)}`);
  assert.ok(!events.some(event => /stopped by user/i.test(JSON.stringify(event.data || ''))), 'the run was not stopped');
  console.log(JSON.stringify({ ok: true, accepted, stopAtDone, providerCalls: providerCalls.length }));
} finally {
  await context?.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
