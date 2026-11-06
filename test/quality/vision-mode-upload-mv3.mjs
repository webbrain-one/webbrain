import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';
import { uploadReleaseHtml } from '../lib/upload-release-fixture.mjs';

// A file upload in a vision run, end to end in the installed MV3 extension:
// background, Agent, CDP capture, trusted input and the file-chooser guard are
// real; a loopback provider plays the model. Its click_at lands on a native
// file input, the guard stops the chooser, the next step gets the element
// tools and attaches the user's video with upload_file, and the step after
// that is back on screenshots, on a fresh full frame.
// The second page is a release form as a three-asset GitHub release met it:
// the binary input is hidden behind an "Attach binaries" button, on a page too
// deep for the page observation to certify. The first upload_file, with the
// selector the blocked click's result named, must attach the file; it used to
// be refused until the model read an inventory and sent the same call again.
//   node test/quality/vision-mode-upload-mv3.mjs
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-mode-upload-mv3');
await fs.mkdir(out, { recursive: true });

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(4), Buffer.from('mp42isom')]);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const LAYOUT = { upload: { x: 60, y: 140, w: 360, h: 48 } };
const body = `<!doctype html><meta charset="utf-8"><title>Vision upload fixture</title>
<style>body{margin:0;font:16px sans-serif}h1{position:absolute;left:60px;top:40px;margin:0}label{position:absolute;left:60px;top:112px}
#upload{position:absolute;left:${LAYOUT.upload.x}px;top:${LAYOUT.upload.y}px;width:${LAYOUT.upload.w}px;height:${LAYOUT.upload.h}px;box-sizing:border-box;font:16px sans-serif;background:#eef}
#status{position:absolute;left:60px;top:230px;width:500px;height:120px;font:20px sans-serif}</style>
<h1>Video upload</h1><label for="upload">QA video</label><input id="upload" name="video" type="file" accept="video/mp4,.mp4"><div id="status" role="status"></div>
<script>window.nativeAttachments = [];
document.getElementById('upload').addEventListener('change', async event => {
  const file = event.target.files[0];
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  window.nativeAttachments.push({ name: file.name, size: file.size, mime: file.type, sha256: Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('') });
  const status = document.getElementById('status');
  status.textContent = 'Attached ' + file.name;
  status.style.background = 'rgb(0,160,0)';
});</script>`;
// As upload-release-binding-mv3.mjs builds it: the general observation runs
// out of budget before it reaches the binary widget.
const releaseBody = uploadReleaseHtml.replace('<file-attachment id="binary-widget">',
  `<div aria-hidden="true" style="display:none">${'<span></span>'.repeat(5000)}</div><file-attachment id="binary-widget">`);

const providerCalls = [];
let actionCalls = 0;
// Where the scripted model clicks, in CSS px of the page (the scenario sets it).
let clickTarget = LAYOUT.upload;
const labelOf = message => (Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '');
const centre = (rect, frame) => ({ x: Math.round((rect.x + rect.w / 2) / frame.ratio), y: Math.round((rect.y + rect.h / 2) / frame.ratio) });

const server = http.createServer(async (request, response) => {
  if (request.url === '/v1/chat/completions') {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text); providerCalls.push(input);
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    const judge = String(input.messages?.[0]?.content || '').startsWith('Evaluate only the observable requirements of the genuine user task');
    const fixedChoice = fixtureFixedChoiceReply(input.messages);
    let completion;
    if (fixedChoice) completion = { role: 'assistant', content: fixedChoice };
    else if (judge) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Scripted fixture.' }) };
    else if (!isAction) {
      completion = { role: 'assistant', content: JSON.stringify({
        request_kind: 'execute', scope_relation: 'new', deliverables: ['Attach the uploaded video to the page input'],
        requires_state_change: true, requires_submission: false, messaging: null,
        completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
        read_scope: 'visible_page', summary: 'Attach the uploaded video clip to the QA video input.',
        steps: [{ id: '1', action: 'Attach the video to the QA video input.' }],
        memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [],
      }) };
    } else {
      const offered = input.tools.map(tool => tool.function.name);
      // The current full frame, as a model reading its label would size it.
      const frameMessage = input.messages.findLast(message => /UNTRUSTED SCREENSHOT f\d+/.test(labelOf(message)) && message.content.some(block => block.type === 'image_url'));
      const declared = frameMessage && /(\d+)x(\d+) image; 1 image px = ([\d.]+) CSS px/.exec(labelOf(frameMessage));
      const frame = declared ? { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) } : null;
      const results = new Map(input.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
      const pairs = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
        .map(item => ({ name: item.function.name, text: results.get(item.id) || '' }));
      const blocked = pairs.find(pair => pair.name === 'click_at' && /"filePickerBlocked":true/.test(pair.text));
      const uploaded = pairs.some(pair => pair.name === 'upload_file' && /"success":true/.test(pair.text));
      const attachmentId = JSON.stringify(input.messages).match(/attachment_[A-Za-z0-9]+_\d+(?= \(clip\.mp4\))/)?.[0];
      let call;
      if (offered.includes('upload_file') && blocked && !uploaded) {
        call = { name: 'upload_file', args: { selector: /"selector":"((?:[^"\\]|\\.)+)"/.exec(blocked.text)?.[1]?.replace(/\\"/g, '"') || '#upload', attachmentId } };
      } else if (offered.includes('click_at') && !blocked && frame) call = { name: 'click_at', args: centre(clickTarget, frame) };
      else if (offered.includes('take_screenshot') && !frame) call = { name: 'take_screenshot', args: {} };
      else call = { name: 'done', args: { summary: 'The clip was attached to the upload input.', outcome: 'success' } };
      const step = actionCalls++;
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `vision-upload-${step}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(request.url === '/release' ? releaseBody : body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-vision-upload-mv3-'));
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
    await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 12, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false, leanMode: 'on' });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `${base}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000, enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);

  // One vision run on `pathname`: the scripted model clicks `target` (a rect,
  // or a function of the page that measures one) and uploads the clip.
  const runScenario = async (pathname, { requestId, text, target, evidence }) => {
    providerCalls.length = 0;
    const url = `${base}${pathname}`;
    const page = await context.newPage(); await page.goto(url);
    clickTarget = typeof target === 'function' ? await target(page) : target;
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
    assert.ok(Number.isInteger(tabId), 'the fixture tab is known');
    await harness.evaluate(() => { window.events = []; });
    const result = await message('chat', {
      tabId, text, mode: 'act', requestId, locale: 'en',
      attachments: [{ kind: 'video', name: 'clip.mp4', dataUrl: `data:video/mp4;base64,${mp4.toString('base64')}`, mimeType: 'video/mp4', size: mp4.length }],
    });
    const events = await harness.evaluate(() => events);
    const calls = [...providerCalls];
    const pageState = await page.evaluate(() => ({ nativeAttachments: window.nativeAttachments, attachmentEvents: window.attachmentEvents, chooserClicks: window.chooserClicks }));
    await fs.writeFile(path.join(out, evidence), JSON.stringify({ result, events, pageState, providerCalls: calls },
      (_key, item) => typeof item === 'string' && item.startsWith('data:image/') ? `[image ${item.length} chars]` : item, 2));

    const actionRequests = calls.filter(call => Array.isArray(call.tools) && call.tools.length);
    const offered = actionRequests.map(call => call.tools.map(tool => tool.function.name));
    const toolTexts = request => request.messages.filter(item => item.role === 'tool').map(item => String(item.content));
    const toolResults = (result.updates || []).filter(event => event.type === 'tool_result');
    const summary = JSON.stringify({ offered: offered.map(names => (names.includes('click_at') ? 'vision' : names.includes('upload_file') ? 'tree' : names.join(','))), tools: toolResults.map(event => ({ name: event.data?.name, result: JSON.stringify(event.data?.result).slice(0, 300) })) }, null, 1);
    assert.ok(offered[0]?.includes('click_at') && !offered[0].includes('upload_file'), `the run starts on screenshots: ${summary}`);
    const handoffAt = offered.findIndex(names => names.includes('upload_file'));
    assert.ok(handoffAt > 0, `a later step offers upload_file: ${summary}`);
    assert.ok(!offered[handoffAt].includes('click_at'), 'the handoff step is on the element tools');
    // The real CDP click reached the file input and the guard stopped its chooser.
    const blocked = toolTexts(actionRequests[handoffAt]).find(text => /"filePickerBlocked":true/.test(text)) || '';
    assert.match(blocked, /"uploadHandoff":true/, blocked);
    assert.match(blocked, /"dispatched":true/, blocked);
    assert.match(blocked, /"selector":"[^"]+"/, `the guard named the input: ${blocked}`);
    // The first upload_file attaches the file: no binding refusal, no inventory.
    const uploads = toolResults.filter(event => event.data?.name === 'upload_file');
    assert.equal(uploads.length, 1, summary);
    assert.equal(uploads[0].data.result.success, true, JSON.stringify(uploads[0].data.result));
    assert.equal(toolResults.some(event => event.data?.name === 'get_interactive_elements'), false, summary);
    assert.equal(JSON.stringify(toolResults).includes('action_binding_unavailable'), false, summary);
    // The step after the upload is back on screenshots, on a fresh full frame.
    const backAt = offered.findIndex((names, index) => index > handoffAt && names.includes('click_at'));
    assert.ok(backAt > handoffAt, `vision resumed after the upload: ${summary}`);
    assert.ok(!offered[backAt].includes('upload_file'));
    const back = actionRequests[backAt];
    const frameAt = back.messages.findLastIndex(item => /UNTRUSTED SCREENSHOT f\d+/.test(labelOf(item)) && item.content.some(block => block.type === 'image_url'));
    assert.ok(frameAt >= 0, 'the resumed step has a full frame');
    const frameLabel = labelOf(back.messages[frameAt]);
    assert.match(frameLabel, /\(vision resumed\)/, frameLabel);
    assert.notEqual(/SCREENSHOT (f\d+)/.exec(frameLabel)[1], 'f1');
    assert.ok(back.messages.slice(frameAt + 1).every(item => !/UNTRUSTED SCREEN/.test(labelOf(item))), 'the fresh frame is the latest screen');
    const olderImages = back.messages.slice(0, frameAt).flatMap(item => (Array.isArray(item.content) ? item.content : [])).filter(block => block.type === 'image_url').length;
    assert.equal(olderImages, 0, 'screenshots from before the handoff left the request');
    assert.equal(events.findLast(event => event.type === 'run_complete')?.data?.status, 'completed', summary);
    assert.equal(JSON.stringify(calls).includes(mp4.toString('base64')), false, 'the video bytes never reach the model');
    return { offered: offered.map(names => (names.includes('click_at') ? 'vision' : 'tree')), frame: /SCREENSHOT (f\d+)/.exec(frameLabel)[1], blocked, pageState };
  };

  const video = await runScenario('/upload', { requestId: 'vision-upload-mv3', text: 'Attach the clip I uploaded to the QA video input.',
    target: LAYOUT.upload, evidence: 'evidence.json' });
  assert.deepEqual(video.pageState.nativeAttachments, [{ name: 'clip.mp4', size: mp4.length, mime: 'video/mp4', sha256: sha(mp4) }], 'the page input received the exact bytes once');

  const release = await runScenario('/release', { requestId: 'vision-upload-release-mv3', text: 'Attach the clip I uploaded to the release binaries.',
    target: async page => {
      const box = await page.locator('#binary-button').boundingBox();
      return { x: box.x, y: box.y, w: box.width, h: box.height };
    }, evidence: 'evidence-release.json' });
  // The button's own handler called click() on the hidden input; the guard
  // named that input, and the clip reached it, not the Markdown slot.
  assert.match(release.blocked, /"selector":"#releases-upload"/, release.blocked);
  assert.equal(release.pageState.chooserClicks, 1);
  assert.deepEqual(release.pageState.attachmentEvents, { markdown: [], binary: [[{ name: 'clip.mp4', size: mp4.length }]] });
  console.log(JSON.stringify({ passed: true, video: { offered: video.offered, frame: video.frame, attachment: video.pageState.nativeAttachments[0] },
    release: { offered: release.offered, frame: release.frame, attachment: release.pageState.attachmentEvents.binary[0][0] } }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-upload-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
