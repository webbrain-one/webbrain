import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Choosing a native <select> option in vision mode, end to end in the
// installed MV3 extension. A vision click on a native dropdown is refused
// (its popup never shows in a screenshot) with the hint to choose an option
// with type_text({text: "<option label>"}). That type_text used to walk the
// options with one ArrowDown per step: the first key changed the select the
// model's observation had certified, the page monitor took that change as
// "the browser changed during action preparation", vetoed the next key, and
// the call failed after leaving the select on the wrong option (Small instead
// of Large, the first contact instead of the named one). Here a loopback
// "model" clicks each dropdown and types a label: an exact label and a unique
// part of one select exactly that option, with one input and one change event
// and a verified result; an ambiguous part ("Alex") and a missing label fail
// and leave the selection exactly as it was, with no event at all; the option
// already shown is chosen without any event. Lean mode stays at its default,
// as in the run that found this: the observation then binds the focused select.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-native-select-mv3');
await fs.mkdir(out, { recursive: true });
// The page in normal document flow, as a plain form page lays it out; the
// "model" reads each dropdown's box from the page before it clicks.
const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preferences</title>
<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}label{display:block;margin:12px 0 4px}
select,textarea{font:inherit;padding:6px;width:100%;box-sizing:border-box}button{font:inherit;margin-top:16px;padding:8px 16px}</style>
</head><body><h1>Preferences</h1>
<form id="f"><label for="size">T-shirt size</label><select id="size" name="size">
<option value="">Choose...</option><option>Small</option><option>Medium</option><option>Large</option><option>X-Large</option></select>
<label for="to">To</label><select id="to" name="to"><option value="">Choose a contact...</option>
<option>Alex Kaya (test contact)</option><option>Alex Demir (test contact)</option><option>Sam Yilmaz (test contact)</option></select>
<label for="body">Message</label><textarea id="body" name="body" rows="3"></textarea>
<button type="submit">Save</button></form><p id="status" role="status"></p>
<script>
window.selectEvents = [];
for (const id of ['size', 'to']) for (const type of ['input', 'change']) {
  document.getElementById(id).addEventListener(type, event => window.selectEvents.push({ id, type, value: event.target.value }));
}
document.getElementById('f').addEventListener('submit', event => event.preventDefault());
</script></body></html>`;

// The step each chat run plays: the dropdown it clicks and the label it types.
const CASES = [
  { id: 'exact', select: 'size', text: 'Large', expectValue: 'Large', success: true },
  { id: 'unique-part', select: 'to', text: 'Sam Yilmaz', expectValue: 'Sam Yilmaz (test contact)', success: true },
  { id: 'ambiguous', select: 'to', text: 'Alex', expectValue: '', success: false, error: /Alex Kaya \(test contact\)[\s\S]*Alex Demir \(test contact\)/ },
  { id: 'missing', select: 'size', text: 'Purple', expectValue: '', success: false, error: /No option matches "Purple"[\s\S]*Options: Choose\.\.\., Small/ },
  { id: 'already-shown', select: 'size', text: 'Choose...', expectValue: '', success: true, unchanged: true },
];
let current = null;
// CSS boxes of the dropdowns, read from the live page.
let boxes = null;
const providerCalls = [];
const centre = (rect, image) => ({ x: Math.round((rect.x + rect.w / 2) / image.ratio), y: Math.round((rect.y + rect.h / 2) / image.ratio) });
const textOf = message => (Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  : String(message.content || ''));
const server = http.createServer(async (incoming, response) => {
  if (incoming.url === '/v1/chat/completions') {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const input = JSON.parse(text); providerCalls.push(input);
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    const fixedChoice = fixtureFixedChoiceReply(input.messages);
    let completion;
    if (fixedChoice) completion = { role: 'assistant', content: fixedChoice };
    else if (!isAction) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Scripted fixture.' }) };
    else {
      // Only this case's turn: everything after its own task message.
      const start = input.messages.findLastIndex(message => message.role === 'user' && textOf(message).includes(`[case ${current.id}]`));
      const turn = input.messages.slice(Math.max(0, start));
      let keyframe = null;
      for (const message of input.messages) {
        const declared = /SCREENSHOT f\d+[\s\S]*?(\d+)x(\d+) image; 1 image px = ([\d.]+) CSS px/.exec(textOf(message));
        if (declared) keyframe = { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) };
      }
      const results = new Map(turn.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
      const calls = turn.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
        .map(item => ({ name: item.function.name, result: results.get(item.id) || '' }));
      const clicked = calls.some(call => call.name === 'click_at' && /native dropdown/.test(call.result));
      const typed = calls.find(call => call.name === 'type_text');
      let call;
      if (!keyframe) call = { name: 'take_screenshot', args: {} };
      else if (!clicked) call = { name: 'click_at', args: centre(boxes[current.select], keyframe) };
      else if (!typed) call = { name: 'type_text', args: { text: current.text } };
      else call = { name: 'done', args: { summary: `Typed ${current.text} into the dropdown.`, outcome: current.success ? 'success' : 'partial' } };
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `select-${current.id}-${calls.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/preferences`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-vision-select-mv3-'));
let context;
const evidence = [];
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
  // visionMode is deliberately left unset: vision mode is the default.
  await harness.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 8, systemOneEnabled: false,
    tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000,
    enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  for (const item of CASES) {
    current = item;
    // Every case starts from a fresh page: both dropdowns on their placeholder.
    await page.goto(url);
    boxes = await page.evaluate(() => Object.fromEntries(['size', 'to'].map(id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return [id, { x: rect.left, y: rect.top, w: rect.width, h: rect.height }];
    })));
    const result = await message('chat', { tabId, text: `[case ${item.id}] Choose "${item.text}" in the dropdown.`, mode: 'act', requestId: `vision-select-${item.id}`, locale: 'en' });
    const toolResults = result.updates.filter(event => event.type === 'tool_result').map(event => ({ tool: event.data?.name, result: event.data?.result }));
    const typeResult = toolResults.find(entry => entry.tool === 'type_text')?.result || null;
    const state = await page.evaluate(() => ({
      size: document.getElementById('size').value, to: document.getElementById('to').value, events: window.selectEvents,
    }));
    evidence.push({ case: item.id, state, typeResult, tools: toolResults.map(entry => ({ tool: entry.tool, success: entry.result?.success, error: entry.result?.error })) });
    const detail = JSON.stringify({ typeResult, state, tools: evidence.at(-1).tools }).slice(0, 1500);
    assert.ok(typeResult, `${item.id}: the model's type_text ran: ${detail}`);
    assert.doesNotMatch(String(typeResult.error || ''), /browser changed/i, `${item.id}: WebBrain's own selection is not a page change: ${detail}`);
    assert.equal(state[item.select], item.expectValue, `${item.id}: the dropdown shows the intended option: ${detail}`);
    const other = item.select === 'size' ? 'to' : 'size';
    assert.equal(state[other], '', `${item.id}: the other dropdown is untouched: ${detail}`);
    if (item.success) {
      assert.equal(typeResult.success, true, `${item.id}: ${detail}`);
      assert.equal(typeResult.verified, true, `${item.id}: the selected option was read back: ${detail}`);
      // One user selection: one input and one change, both with the final
      // value; none for the option already shown.
      assert.deepEqual(state.events, item.unchanged ? [] : [
        { id: item.select, type: 'input', value: item.expectValue },
        { id: item.select, type: 'change', value: item.expectValue },
      ], `${item.id}: no option in between was selected: ${detail}`);
    } else {
      assert.equal(typeResult.success, false, `${item.id}: ${detail}`);
      assert.equal(typeResult.noDispatch, true, `${item.id}: nothing was sent: ${detail}`);
      assert.notEqual(typeResult.dispatched, true, `${item.id}: ${detail}`);
      assert.match(String(typeResult.error || ''), item.error, `${item.id}: the error names the options: ${detail}`);
      assert.deepEqual(state.events, [], `${item.id}: the selection never moved: ${detail}`);
    }
  }
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, installedMV3: true, cases: evidence.map(entry => ({ case: entry.case, value: entry.state, method: entry.typeResult?.method })) }));
} catch (error) {
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2)).catch(() => {});
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-select-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
