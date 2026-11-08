import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Deleting a Mastodon post in vision mode, end to end in the installed MV3
// extension: the post's menu, Delete, then Mastodon's own confirmation
// dialog, all as click_at points. A Mastodon profile always shows an empty
// composer, and Mastodon shows no message after a deletion. done(success)
// used to be refused twice (the composer counted as a form left unsent, then
// the plan guard found no proof, since a vision run's confirmation receipt
// carried no document for the verdict to certify) and the answer ended with
// "WebBrain could not verify everything". The background, Agent, submit
// probe, guards, CDP capture and trusted input are real; a loopback provider
// plays the model and the judge, and the Mastodon origin is a local fixture.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-mastodon-delete-mv3');
await fs.mkdir(out, { recursive: true });
const origin = 'https://mastodon.example.test';
const account = 'qa_account_a';
const pageUrl = `${origin}/@${account}`;
const resource = `${pageUrl}/200`;
const task = 'Delete my test post that says Owned QA post 1.';
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['The test post is deleted.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Delete the test post.', steps: [{ id: '1', action: 'Delete the post and confirm.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
const icon = '<svg width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="7"></circle></svg>';
// Mastodon's markup (v4.4): a search form, the composer form with its icon
// buttons and Publish, the post with its menu button, and the confirmation
// modal the menu's Delete opens. No toast follows the deletion.
const pageBody = `<!doctype html><meta charset="utf-8"><title>Owned QA account</title>
<script id="initial-state" type="application/json">{"meta":{"delete_modal":true}}</script>
<style>body{font:18px sans-serif;margin:25px}form{padding:12px}textarea{display:block;width:600px;height:110px}
.status{margin:20px;padding:12px;border:1px solid #ccc}button{padding:12px;margin:4px}
.dropdown-menu{position:fixed;left:700px;top:420px;background:#fff;border:1px solid #333}
.safety-action-modal{position:fixed;inset:160px 250px;background:white;border:2px solid black;padding:30px}</style>
<form><input placeholder="Search or paste URL"></form>
<form class="compose-form"><div class="navigation-bar"><a class="account__display-name" href="/@${account}">@${account}</a></div>
<textarea class="autosuggest-textarea__textarea" placeholder="What is on your mind?"></textarea>
<div class="compose-form__buttons"><button type="button" aria-label="Add media">${icon}</button><button type="button" aria-label="Poll">${icon}</button><button type="button">Public</button></div>
<div class="compose-form__submit"><button type="submit">Publish</button></div></form>
<main id="statuses"><div class="status"><a class="status__relative-time" href="/@${account}/200">Now</a>
<a class="status__display-name" href="/@${account}">@${account}</a>
<div class="status__content__text--visible"><p>Owned QA post 1</p></div>
<div class="status__action-bar"><button id="more" type="button" class="icon-button" aria-label="More"><svg class="icon icon-ellipsis-h" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="7"></circle></svg></button></div></div></main><div id="modal"></div>
<script>
document.querySelector('#more').onclick = () => {
  const menu = document.createElement('div'); menu.className = 'dropdown-menu';
  menu.innerHTML = '<div class="dropdown-menu__container"><ul class="dropdown-menu__container__list"><li class="dropdown-menu__item dropdown-menu__item--dangerous"><button id="menu-delete" data-index="0">Delete</button></li></ul></div>';
  menu.querySelector('button').onclick = () => {
    document.querySelector('#modal').innerHTML = '<div role="dialog" aria-modal="true"><div class="modal-root__modal safety-action-modal"><div class="safety-action-modal__top"><div class="safety-action-modal__confirmation"><h1>Delete post?</h1><p>Are you sure you want to delete this post?</p></div></div><div class="safety-action-modal__bottom"><div class="safety-action-modal__actions"><button class="link-button" type="button">Cancel</button><button id="confirm" class="button" type="button">Delete</button></div></div></div></div>';
    document.querySelector('.link-button').onclick = () => document.querySelector('#modal').replaceChildren();
    document.querySelector('#confirm').onclick = async () => {
      const response = await fetch('/api/v1/statuses/200', { method: 'DELETE' });
      if (response.ok) { document.querySelector('#statuses').textContent = 'No posts here.'; document.querySelector('#modal').replaceChildren(); }
    };
  };
  document.querySelector('#modal').append(menu);
};
document.querySelector('form.compose-form').onsubmit = event => { event.preventDefault(); window.composerSubmitted = true; };
</script>`;

const providerCalls = [], deletes = [], offered = [];
let page = null, actionCalls = 0, judgeCalls = 0, blockedRemote = 0;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
// The point a model would click: the centre of the element on the latest frame.
const pointOn = async (selector, frame) => {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} is on screen`);
  return { x: Math.round((box.x + box.width / 2) / frame.ratio), y: Math.round((box.y + box.height / 2) / frame.ratio) };
};

const server = http.createServer(async (incoming, response) => {
  if (incoming.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let text = ''; for await (const chunk of incoming) text += chunk;
  const input = JSON.parse(text); providerCalls.push(input);
  const system = textOf(input.messages?.[0]?.content);
  const fixedChoice = fixtureFixedChoiceReply(input.messages, {
    // The request names this post by its text.
    deletion_request: ({ request }) => ({ choice: 'delete_this', evidence: request }),
  });
  let completion;
  if (fixedChoice) completion = { role: 'assistant', content: fixedChoice };
  else if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
    judgeCalls++;
    completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'The post is no longer on the profile.' }) };
  } else if (system.startsWith('Identify only the exact plain public Mastodon post authorized by the genuine user task.')) {
    completion = { role: 'assistant', content: JSON.stringify({ kind: 'unsupported', body: null, account: null }) };
  } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
  else {
    offered.push(input.tools.map(tool => tool.function?.name || tool.name));
    let frame = null;
    for (const message of input.messages) {
      if (!Array.isArray(message.content)) continue;
      const label = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const declared = /SCREENSHOT f\d+[\s\S]*?(\d+)x(\d+) image; 1 image px = ([\d.]+) CSS px/.exec(label);
      if (declared) frame = { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) };
    }
    const step = actionCalls++;
    const results = new Map(input.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
    const clicks = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
      .filter(item => item.function.name === 'click_at').map(item => /"success":true/.test(results.get(item.id) || ''));
    const landed = clicks.filter(Boolean).length;
    let call;
    if (!frame) call = { name: 'take_screenshot', args: {} };
    else if (clicks.length > landed) call = { name: 'done', args: { outcome: 'failed', summary: 'A click was refused.' } };
    else if (landed < 3) call = { name: 'click_at', args: await pointOn(['#more', '#menu-delete', '#confirm'][landed], frame) };
    else call = { name: 'done', args: { outcome: 'success', summary: 'The test post was deleted from the profile.' } };
    completion = { role: 'assistant', content: '', tool_calls: [{ id: `vision-mastodon-delete-${step}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-vision-mastodon-delete-mv3-'));
let context;
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  // The plan-execution guard is gone once the run ends: record what it held
  // each time the run loop asked it about a done.
  await fs.appendFile(path.join(extension, 'src/background.js'), `
globalThis.visionMastodonFixtureAgent = agent;
globalThis.visionMastodonPlanReads = [];
const visionMastodonPlanDecision = agent._planOnlyTerminalDecision;
agent._planOnlyTerminalDecision = function (tabId, ...rest) {
  const decision = visionMastodonPlanDecision.call(this, tabId, ...rest);
  const guard = this._planExecutionGuards.get(tabId);
  visionMastodonPlanReads.push({ viaDone: rest[1]?.viaDone === true, requiresSubmission: guard?.requiresSubmission,
    verified: guard?.verifiedSubmissionEvidence === true, verdict: this._completionVerdicts?.get(tabId)?.outcome,
    refused: !!decision?.retry, caveat: this._guardCaveatLine(tabId) });
  return decision;
};
`);
  context = await chromium.launchPersistentContext(path.join(profile, 'user'), {
    headless: true, channel: 'chromium', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  await context.route('**/*', async route => {
    const request = route.request(), requested = new URL(request.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (requested.origin === origin) {
      if (requested.pathname === '/api/v1/statuses/200' && request.method() === 'DELETE') {
        deletes.push(requested.pathname);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (request.isNavigationRequest() && requested.href === pageUrl) return route.fulfill({ contentType: 'text/html', body: pageBody });
      return route.fulfill({ status: 404, body: '' });
    }
    if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  // visionMode is left unset: vision mode is the default. Lean mode is off,
  // as it was in the QA run, so the completion guards and judge all run.
  await harness.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 10, systemOneEnabled: false,
    tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false,
    leanMode: 'off' }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000,
    enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  page = await context.newPage(); await page.goto(pageUrl);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, pageUrl);
  const result = await message('chat', { tabId, text: task, mode: 'act', requestId: 'vision-mastodon-delete-mv3', locale: 'en' });
  const diagnostic = await worker.evaluate(tabId => {
    const agent = globalThis.visionMastodonFixtureAgent, submit = agent._completionSubmitStates.get(tabId);
    return { submit: submit ? { mutationKind: submit.mutationKind, dispatched: submit.dispatched,
      semanticCommit: !!submit.semanticCommit, documentToken: submit.semanticCommit?.documentToken || '' } : null,
    planReads: globalThis.visionMastodonPlanReads };
  }, tabId);
  const doneResults = result.updates.filter(event => event.type === 'tool_result' && event.data?.name === 'done').map(event => event.data.result);
  const composer = await page.evaluate(() => ({ value: document.querySelector('textarea').value, submitted: window.composerSubmitted === true }));
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, diagnostic, deletes, doneResults, composer,
    judgeCalls, offered, blockedRemote }, (_key, item) => typeof item === 'string' && item.startsWith('data:image/') ? '[screenshot omitted]' : item, 2));

  for (const tools of offered) {
    assert.ok(tools.includes('click_at'), `a vision tool surface: ${tools}`);
    assert.ok(!tools.includes('get_accessibility_tree'), 'no tree tool in vision mode');
  }
  assert.deepEqual(deletes, ['/api/v1/statuses/200'], 'the post was deleted once, through the confirmation');
  assert.deepEqual(composer, { value: '', submitted: false }, 'the composer was left alone');
  assert.equal(diagnostic.submit?.semanticCommit, true, JSON.stringify(diagnostic));
  assert.equal(diagnostic.submit.mutationKind, 'delete');
  assert.deepEqual(doneResults.filter(item => item?.blockedDone).map(item => item.error), [], 'done was not refused');
  const done = doneResults.at(-1);
  assert.equal(done?.done, true, JSON.stringify(done));
  assert.equal(done.outcome, 'success');
  // The plan guard held this run to a submission proof, and the verdict on
  // the confirmation's own document was that proof.
  const reads = diagnostic.planReads;
  assert.deepEqual(reads.filter(read => read.refused), [], JSON.stringify(reads));
  assert.deepEqual(reads.at(-1), { viaDone: true, requiresSubmission: true, verified: true, verdict: 'succeeded',
    refused: false, caveat: '' }, JSON.stringify(reads));
  assert.ok(diagnostic.submit.documentToken, 'the confirmation is bound to the document it was sent in');
  assert.doesNotMatch(JSON.stringify(result), /could not verify everything|still looked unsubmitted|couldn't confirm that the deletion/i);
  assert.equal(judgeCalls, 1);
  console.log(JSON.stringify({ passed: true, installedMV3: true, deletes: deletes.length, doneCalls: doneResults.length, actionCalls, judgeCalls }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-mastodon-delete-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
