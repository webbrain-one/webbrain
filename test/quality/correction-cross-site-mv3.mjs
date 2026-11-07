import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { sharedGuardXHtml } from '../fixtures/shared-action-guards-x.mjs';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';
import { fixedChoiceQuestion, fixtureFixedChoiceReply, fixturePageTextReply } from '../semantic-decision-stub.mjs';

// Your trace: "go to mastoturk.org and try to post something", the Mastodon
// post sent, then "ok now on X". Through the installed MV3 extension, with
// the run started on chrome://extensions as it was there:
//   mastodon-then-x: the X post goes ahead once, instead of being held to
//     find the Mastodon post on X while WebBrain went back and forth.
//   leave-prompt: WebBrain leaves a page with an unsent draft, and the
//     page's "Leave site?" prompt is answered by WebBrain for its own
//     navigation instead of waiting for the person.
//   restart-then-x: the run is stopped on X before posting, the extension's
//     worker restarts, and "continue" posts on X once: what the task attempted
//     was saved with the conversation, so WebBrain still knows X was not.
//   x-then-restart: the X post was sent, the worker restarts, and "continue"
//     tries to post it again: the saved record holds the second post.
//   xpro-then-x: the X post is made from X Pro (pro.x.com), whose Post
//     button WebBrain does not recognize, then the Mastodon post, then "ok
//     now on X": the X Pro post still counts, so x.com gets no second one.
//   xpro-slow-plain-then-x: the same with a plain Post button, while the
//     model takes six seconds to read captions, longer than WebBrain waits:
//     the button looks ordinary, and its post still counts.
//   xpro-enter-then-x: only Enter is pressed in an X Pro draft that is never
//     posted: that is no post, so the X post after the correction goes out.
// Pages, posts and the model are owned local fixtures; nothing leaves the host.
const require = createRequire(import.meta.url);
const library = (name, file) => fs.readFile(path.join(path.dirname(require.resolve(`${name}/package.json`)), file), 'utf8');
const libraryFiles = [['react.js', 'react', 'umd/react.development.js'], ['react-dom.js', 'react-dom', 'umd/react-dom.development.js'],
  ['immutable.js', 'immutable', 'dist/immutable.js'], ['draft.js', 'draft-js', 'dist/Draft.js']];
const assets = new Map(await Promise.all(libraryFiles.map(async ([name, module, file]) => [name, await library(module, file)])));
const xHtml = sharedGuardXHtml({ account: 'ownedqa', draftCss: await library('draft-js', 'dist/Draft.css'), libraryFiles });
const mastodonCompose = `<!doctype html><meta charset="utf-8"><title>Yeni gönderi - MastoTurk</title>
<style>body{font:16px sans-serif;margin:24px} textarea{width:500px;height:120px} button{padding:10px 18px}</style>
<h1>Yeni gönderi</h1><form id="compose" action="/api/v1/statuses" method="post">
<textarea name="status" aria-label="Aklında ne var?" placeholder="Aklında ne var?"></textarea>
<p><button type="submit">Gönder</button></p></form>
<script>
document.querySelector('#compose').addEventListener('submit', async event => {
  event.preventDefault();
  const response = await fetch('/api/v1/statuses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: document.querySelector('textarea').value }) });
  // Mastodon moves to the home timeline as soon as the post is accepted.
  if (response.ok) location.href = '/home';
});
</script>`;
const mastodonHome = posts => `<!doctype html><meta charset="utf-8"><title>Anasayfa - MastoTurk</title>
<h1>Anasayfa</h1><div role="feed" aria-label="Anasayfa">${posts.map((post, index) =>
  `<article aria-label="esokullu"><a href="/@esokullu/${1000 + index}">esokullu</a><p>${post.replace(/</g, '&lt;')}</p></article>`).join('')}</div>`;
// X Pro: a deck with its own composer, whose Post button sits outside any
// form; on the second deck the button carries no app marker at all.
const xProHtml = ({ plain = false } = {}) => `<!doctype html><meta charset="utf-8"><title>X Pro</title>
<style>body{font:15px sans-serif;margin:24px} [role=textbox]{border:1px solid #888;min-height:80px;width:500px;padding:8px} button{padding:8px 16px}</style>
<main aria-label="Deck"><section aria-label="Compose a post">
<div role="textbox" contenteditable="true" aria-multiline="true" aria-label="Post text" data-testid="tweetTextarea_0"></div>
<div><button type="button" id="post"${plain ? '' : ' data-testid="tweetButton"'}>Post</button></div></section></main>
<script>
document.querySelector('#post').addEventListener('click', async () => {
  const box = document.querySelector('[role="textbox"]'), body = box.textContent;
  if (!body.trim()) return;
  await fetch('/owned-fixture/post', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
  box.textContent = '';
});
</script>`;
// X asks before a page with an unsent draft is left.
const leavePrompt = () => {
  if (location.hostname !== 'x.com') return;
  addEventListener('beforeunload', event => {
    if (document.querySelector('[data-testid="tweetTextarea_0"]')?.textContent.trim()) { event.preventDefault(); event.returnValue = ''; }
  });
};

const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
function objectFrom(content) {
  const text = textOf(content);
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
      }
    }
  }
  return null;
}
const toolMessages = messages => {
  const names = new Map((messages || []).flatMap(message => (message.tool_calls || []).map(call => [call.id, call.function?.name])));
  return (messages || []).filter(message => message.role === 'tool')
    .map(message => ({ id: message.tool_call_id, name: names.get(message.tool_call_id), result: objectFrom(message.content) }));
};
const refFrom = (tree, pattern) => String(tree?.result?.pageContent || '').split('\n').find(line => pattern.test(line))?.match(/\[(ref_\d+)\]/)?.[1];

const request = 'go to mastoturk.org and try to post something';
const correction = 'ok now on X';
const variants = {
  'mastodon-then-x': {
    before: [
      () => ({ name: 'navigate', args: { url: 'https://mastoturk.org/publish' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'set_field', args: { ref_id: refFrom(tree, /textbox "Aklında ne var\?"/), text: 'WebBrain test gönderisi', submit: false } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Gönder"/) } }),
      // The correction arrives once the Mastodon post was sent.
      async (_tree, run) => { await run.steer(); return { name: 'get_accessibility_tree', args: { filter: 'all' } }; },
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
    ],
    after: [
      () => ({ name: 'navigate', args: { url: 'https://x.com/home' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      () => ({ name: 'done', args: { outcome: 'success', summary: 'Posted on mastoturk.org, then on X.' } }),
    ],
  },
  'restart-then-x': {
    before: [
      () => ({ name: 'navigate', args: { url: 'https://mastoturk.org/publish' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'set_field', args: { ref_id: refFrom(tree, /textbox "Aklında ne var\?"/), text: 'WebBrain test gönderisi', submit: false } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Gönder"/) } }),
      async (_tree, run) => { await run.steer(); return { name: 'get_accessibility_tree', args: { filter: 'all' } }; },
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
    ],
    after: [
      () => ({ name: 'navigate', args: { url: 'https://x.com/home' } }),
      // The person presses Stop before anything is posted on X.
      async (_tree, run) => { await run.stop(); return { name: 'get_accessibility_tree', args: { filter: 'all' } }; },
    ],
    again: [
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      () => ({ name: 'done', args: { outcome: 'success', summary: 'Posted on X.' } }),
    ],
  },
  'x-then-restart': {
    before: [
      () => ({ name: 'navigate', args: { url: 'https://mastoturk.org/publish' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'set_field', args: { ref_id: refFrom(tree, /textbox "Aklında ne var\?"/), text: 'WebBrain test gönderisi', submit: false } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Gönder"/) } }),
      async (_tree, run) => { await run.steer(); return { name: 'get_accessibility_tree', args: { filter: 'all' } }; },
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
    ],
    after: [
      () => ({ name: 'navigate', args: { url: 'https://x.com/home' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      () => ({ name: 'done', args: { outcome: 'success', summary: 'Posted on mastoturk.org, then on X.' } }),
    ],
    // After the restart the model, unsure the post went out, posts it again.
    again: [
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'done', args: { outcome: 'partial', summary: 'The X post was not sent again.' } }),
    ],
  },
  'xpro-then-x': {
    task: 'try to post something on X from X Pro (pro.x.com), then on mastoturk.org',
    before: [
      () => ({ name: 'navigate', args: { url: 'https://pro.x.com/i/decks/1' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'navigate', args: { url: 'https://mastoturk.org/publish' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'set_field', args: { ref_id: refFrom(tree, /textbox "Aklında ne var\?"/), text: 'WebBrain test gönderisi', submit: false } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Gönder"/) } }),
      async (_tree, run) => { await run.steer(); return { name: 'get_accessibility_tree', args: { filter: 'all' } }; },
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
    ],
    after: [
      () => ({ name: 'navigate', args: { url: 'https://x.com/home' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'done', args: { outcome: 'partial', summary: 'The post was already made on X from X Pro; it was not posted again.' } }),
    ],
  },
  'xpro-slow-plain-then-x': {
    task: 'try to post something on X from X Pro (pro.x.com), then on mastoturk.org',
    slowCaptionReadings: true,
    before: [
      () => ({ name: 'navigate', args: { url: 'https://pro.x.com/i/decks/2' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'navigate', args: { url: 'https://mastoturk.org/publish' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'set_field', args: { ref_id: refFrom(tree, /textbox "Aklında ne var\?"/), text: 'WebBrain test gönderisi', submit: false } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Gönder"/) } }),
      async (_tree, run) => { await run.steer(); return { name: 'get_accessibility_tree', args: { filter: 'all' } }; },
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
    ],
    after: [
      () => ({ name: 'navigate', args: { url: 'https://x.com/home' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'done', args: { outcome: 'partial', summary: 'The post was already made on X from X Pro; it was not posted again.' } }),
    ],
  },
  'xpro-enter-then-x': {
    task: 'write a two-line draft on X Pro (pro.x.com) without posting it, then try to post something on mastoturk.org',
    before: [
      () => ({ name: 'navigate', args: { url: 'https://pro.x.com/i/decks/1' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'First line', clear: true } }),
      () => ({ name: 'press_keys', args: { key: 'Enter' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      () => ({ name: 'navigate', args: { url: 'https://mastoturk.org/publish' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'set_field', args: { ref_id: refFrom(tree, /textbox "Aklında ne var\?"/), text: 'WebBrain test gönderisi', submit: false } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Gönder"/) } }),
      async (_tree, run) => { await run.steer(); return { name: 'get_accessibility_tree', args: { filter: 'all' } }; },
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
    ],
    after: [
      () => ({ name: 'navigate', args: { url: 'https://x.com/home' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'WebBrain test post', clear: true } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Post"/) } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      () => ({ name: 'done', args: { outcome: 'success', summary: 'Drafted on X Pro, posted on mastoturk.org and on X.' } }),
    ],
  },
  'leave-prompt': {
    before: [
      () => ({ name: 'navigate', args: { url: 'https://x.com/home' } }),
      () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
      tree => ({ name: 'type_ax', args: { ref_id: refFrom(tree, /textbox "Post text"/), text: 'Unsent WebBrain draft', clear: true } }),
      () => ({ name: 'navigate', args: { url: 'https://mastoturk.org/home' } }),
      () => ({ name: 'done', args: { outcome: 'success', summary: 'Left the unsent X draft and opened the MastoTurk home timeline.' } }),
    ],
    after: [],
  },
};

const only = process.env.WEBBRAIN_QUALITY_CASE_FILTER ? new RegExp(process.env.WEBBRAIN_QUALITY_CASE_FILTER) : null;
for (const [variant, script] of Object.entries(variants)) if (!only || only.test(variant)) await runVariant(variant, script);

async function runVariant(variant, script) {
  const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
    ? path.join(process.env.WEBBRAIN_QUALITY_ARTIFACTS, variant)
    : `ci/artifacts/quality-audit-2026-10-15/correction-cross-site-mv3/${variant}`);
  await fs.mkdir(out, { recursive: true });
  const task = script.task || (variant === 'leave-prompt'
    ? 'open x.com, write a draft post without posting it, then go to mastoturk.org/home' : request);
  const mastodonPosts = [], xPosts = [], xProPosts = [], unknownPrompts = [], dialogs = [], settleDialogs = [];
  let slowReadings = 0;
  let steered = false, judgeCalls = 0, blockedRemote = 0, base = '', harnessAnswered = 0;
  const phase = { name: 'before', index: 0, lastId: null, emitted: 0 };
  const completionRecovery = { reads: 0 };
  const intent = () => ({ request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
    requires_submission: variant !== 'leave-prompt', messaging: null,
    deliverables: [variant === 'leave-prompt' ? 'An unsent X draft, then the MastoTurk home timeline open'
      : steered ? 'A post on X' : 'A post on mastoturk.org'],
    completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
    read_scope: 'visible_page', summary: steered ? 'Post something on X.' : 'Post something on mastoturk.org.',
    steps: [{ id: '1', action: steered ? 'Compose and publish a post on X, then verify it.' : 'Compose and publish a post, then verify it.' }],
    memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] });
  const contract = input => {
    if (!steered) return { version: 1, status: 'none', actions: [], requirements: null, prohibited: [],
      reason: 'No X or Bluesky publication is requested.' };
    const { sources } = JSON.parse(textOf(input.messages.find(message => message.role === 'user')?.content));
    const [source] = Object.entries(sources).find(([key, value]) => ['request', 'task'].includes(key) && value.includes('try to post something'));
    return { version: 1, status: 'ready', actions: [{ id: 'p1', platform: 'twitter', account: null,
      posts: [{ body: { kind: 'compose', source: { source, start: 'try to post something', end: 'try to post something' } },
        media: { kind: 'count', type: 'any', format: null, min: 0, max: 0 }, context: { kind: 'post', target: null } }] }],
      requirements: 'p1', prohibited: [], reason: 'The latest correction moves the requested post to X.' };
  };
  let context, page, panel, tabId = null;
  const run = {
    async stop() {
      await panel.evaluate(tabId => chrome.runtime.sendMessage({ target: 'background', action: 'abort', tabId }), tabId);
    },
    async steer() {
      for (let wait = 0; !mastodonPosts.length && wait < 50; wait++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(mastodonPosts.length, 1, 'The Mastodon post was sent before the correction');
      const accepted = await panel.evaluate(({ tabId, text }) => chrome.runtime.sendMessage({ target: 'background', action: 'chat_steer',
        tabId, requestId: 'owned-cross-site', messageId: 'owned-ok-now-on-x', text }), { tabId, text: correction });
      assert.equal(accepted?.accepted, true, JSON.stringify(accepted));
      steered = true;
    },
  };
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of incoming) raw += part;
    const input = JSON.parse(raw), system = textOf(input.messages?.[0]?.content);
    let completion;
    // A slow model: caption readings take longer than WebBrain waits for
    // them, until the X Pro post is out.
    if (script.slowCaptionReadings && !xProPosts.length && fixedChoiceQuestion(input.messages)?.kind === 'control_effect') {
      slowReadings++;
      await new Promise(resolve => setTimeout(resolve, 6000));
    }
    try {
      if (system.startsWith('Extract stable user preferences')) completion = { role: 'assistant', content: '{"memories":[]}' };
      // The provider check made when the provider is saved.
      else if (system === 'Hi' || textOf(input.messages?.at(-1)?.content) === 'Hi') completion = { role: 'assistant', content: 'Hello' };
      // "Post something" names no exact body, so no exact Mastodon post can be
      // identified for later verification.
      else if (system.startsWith('Identify only the exact plain public Mastodon post')) completion = { role: 'assistant',
        content: JSON.stringify({ kind: 'unsupported', body: null, account: null }) };
      else if (system.startsWith("Compile the user's social-publication intent")) completion = { role: 'assistant', content: JSON.stringify(contract(input)) };
      else if (fixturePageTextReply(input.messages)) completion = { role: 'assistant', content: fixturePageTextReply(input.messages) };
      else if (fixedChoiceQuestion(input.messages)) {
        completion = { role: 'assistant', content: /^- "mode_claim":/m.test(system) ? JSON.stringify({ choice: 'result', evidence: '' })
          : fixtureFixedChoiceReply(input.messages, { deletion_prerequisite: 'keep_previous', user_turn_kind: 'continue' }) };
      } else if (system.startsWith('Check one separately proposed consequential action')) {
        const trusted = JSON.parse(textOf(input.messages[1].content)), proposed = objectFrom(input.messages[2].content);
        completion = { role: 'assistant', content: JSON.stringify({ key: proposed.key, authorized: true,
          latestRequestEvidence: trusted.latestAcceptedRequest }) };
      } else if (system.startsWith('Independently check whether the authentic user request authorizes')) {
        const audit = JSON.parse(textOf(input.messages.find(message => message.role === 'user')?.content));
        completion = { role: 'assistant', content: JSON.stringify({ key: audit.key, actionId: audit.action.id, authorized: true,
          reason: 'The latest correction asks for a post on X, and the draft is a post.' }) };
      } else if (system.startsWith('Evaluate only the observable requirements')) {
        judgeCalls++;
        completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'The requested pages show the expected result.' }) };
      } else if (!input.tools?.length) {
        if (!system.startsWith('You are the intent and compact planning subsystem') && !system.startsWith('You are the planning subsystem')) {
          unknownPrompts.push(system.slice(0, 120));
        }
        completion = { role: 'assistant', content: JSON.stringify(intent()) };
      } else {
        // A step advances only once its result is back; a call superseded
        // before it ran is asked again.
        const tools = toolMessages(input.messages);
        if (steered && phase.name === 'before' && JSON.stringify(input.messages).includes(correction)) Object.assign(phase, { name: 'after', index: 0, lastId: null });
        else if (run.continued && phase.name === 'after') Object.assign(phase, { name: 'again', index: 0, lastId: null });
        else if (phase.lastId && tools.some(tool => tool.id === phase.lastId)) phase.index++;
        const steps = script[phase.name];
        const tree = tools.findLast(tool => tool.name === 'get_accessibility_tree' && tool.result?.pageContent);
        const step = steps[Math.min(phase.index, steps.length - 1)];
        const call = conformFixtureCompletionCall(input, await step(tree, run), completionRecovery);
        assert.ok(Object.values(call.args).every(value => value !== undefined), `${variant}: a step found no ref in ${JSON.stringify(tree?.result?.pageContent || '').slice(0, 400)}`);
        phase.lastId = `owned-${variant}-${phase.name}-${phase.index}-${++phase.emitted}`;
        completion = { role: 'assistant', content: '', tool_calls: [{ id: phase.lastId, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
      }
    } catch (error) {
      unknownPrompts.push(`provider error: ${error.message}`);
      response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `response-${phase.emitted}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-cross-site-mv3-'));
  try {
    const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
    await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.crossSiteFixtureAgent = agent;\n');
    context = await chromium.launchPersistentContext(path.join(profile, 'user'), { headless: true, channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    await context.route('**/*', async route => {
      const routed = route.request(), requested = new URL(routed.url());
      if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
      if (requested.origin === 'https://mastoturk.org') {
        if (requested.pathname === '/api/v1/statuses' && routed.method() === 'POST') {
          mastodonPosts.push(JSON.parse(routed.postData() || '{}').status);
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"1000"}' });
        }
        if (requested.pathname === '/publish') return route.fulfill({ contentType: 'text/html', body: mastodonCompose });
        if (requested.pathname === '/home') return route.fulfill({ contentType: 'text/html', body: mastodonHome(mastodonPosts) });
        return route.fulfill({ status: 404, body: '' });
      }
      if (requested.origin === 'https://x.com') {
        if (requested.pathname.startsWith('/owned-fixture/') && assets.has(requested.pathname.split('/').at(-1)))
          return route.fulfill({ contentType: 'text/javascript', body: assets.get(requested.pathname.split('/').at(-1)) });
        if (requested.pathname === '/owned-fixture/post' && routed.method() === 'POST') {
          xPosts.push(JSON.parse(routed.postData() || '{}').body);
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        }
        if (routed.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: xHtml });
        return route.fulfill({ status: 404, body: '' });
      }
      if (requested.origin === 'https://pro.x.com') {
        if (requested.pathname === '/owned-fixture/post' && routed.method() === 'POST') {
          xProPosts.push(JSON.parse(routed.postData() || '{}').body);
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        }
        if (routed.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: xProHtml({ plain: requested.pathname === '/i/decks/2' }) });
        return route.fulfill({ status: 404, body: '' });
      }
      if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    const settings = await context.newPage(); await settings.goto(`${extensionOrigin}/src/ui/settings.html`);
    panel = await context.newPage(); await panel.goto(`${extensionOrigin}/src/ui/sidepanel.html`);
    const message = (action, data = {}) => settings.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
    await settings.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, userMemoryEnabled: false, tracingEnabled: false,
      autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never',
      visionMode: 'off', maxAgentSteps: 30, systemOneEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false,
      openaiAskStreamingEnabled: false }));
    assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
      baseUrl: `${base}/v1`, model: 'minimax/minimax-m3', enabled: true, contextWindow: 1000000,
      supportsAskStreaming: false, supportsVision: false } })).ok, true);
    assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
    await worker.evaluate(() => { crossSiteFixtureAgent.clarifyTimeoutSec = -1; });
    // The run starts where the debugger cannot attach, as in the trace.
    page = await context.newPage();
    await page.addInitScript(leavePrompt);
    // A prompt WebBrain does not answer waits; after eight seconds the
    // harness closes it the way a person would, and that counts against it.
    page.on('dialog', dialog => {
      dialogs.push(dialog.type());
      const timer = setTimeout(() => dialog.dismiss().then(() => { harnessAnswered++; }, () => {}), 8000);
      // Playwright still counts a prompt WebBrain answered over its own
      // connection as open; settle it quietly before the browser closes.
      settleDialogs.push(() => { clearTimeout(timer); return dialog.dismiss().catch(() => {}); });
    });
    await page.goto('chrome://extensions/');
    tabId = await settings.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url.startsWith('chrome://extensions'))?.id);
    assert.ok(tabId, 'The run starts on chrome://extensions');
    const resultsOf = result => (result.updates || []).filter(event => event.type === 'tool_result').map(event => ({ name: event.data?.name,
      success: event.data?.result?.success, reason: event.data?.result?.actionGuard?.reason || event.data?.result?.reasonCode || null,
      error: event.data?.result?.error || null }));
    const result = await message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-cross-site', locale: 'en' });
    const toolResults = resultsOf(result);
    let continuedResults = null, workerRestarted = null, xPostsBeforeRestart = null, continuedReply = null;
    if (script.again) {
      // The extension's own worker stops, as Chrome stops an idle one, and
      // the person continues the task in the fresh worker.
      xPostsBeforeRestart = xPosts.length;
      const devtools = await context.newCDPSession(settings), versions = new Map();
      devtools.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => updates.forEach(version => versions.set(version.versionId, version)));
      await devtools.send('ServiceWorker.enable');
      let version; const deadline = Date.now() + 5000;
      while (!version && Date.now() < deadline) {
        version = [...versions.values()].find(item => item.runningStatus === 'running' && item.scriptURL.startsWith(`${extensionOrigin}/`));
        if (!version) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(version, 'The extension worker is running');
      const boot = await worker.evaluate(() => globalThis.__crossSiteBoot ??= crypto.randomUUID());
      await devtools.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      await devtools.detach().catch(() => {});
      await message('agent_run_state', { tabId });
      const fresh = context.serviceWorkers().find(item => item.url().startsWith(`${extensionOrigin}/`));
      workerRestarted = await fresh.evaluate(() => globalThis.__crossSiteBoot ?? null) !== boot;
      assert.equal(workerRestarted, true, 'The worker actually restarted');
      await fresh.evaluate(() => { crossSiteFixtureAgent.clarifyTimeoutSec = -1; });
      run.continued = true;
      // The existing duplicate-publication guard may ask for a one-time hard
      // approval. Deny it as the owner and assert the exact card below.
      const deniedCards = [];
      let answering = variant === 'x-then-restart';
      const answerer = (async () => {
        const seen = new Set();
        while (answering) {
          const ids = await fresh.evaluate(id => [...(crossSiteFixtureAgent._pendingClarifications.get(id)?.keys() || [])], tabId);
          for (const id of ids) if (!seen.has(id)) {
            seen.add(id); deniedCards.push(id);
            await message('clarify_response', { tabId, clarifyId: id, answer: 'deny', source: 'option' });
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      })();
      let continued;
      try { continued = await message('chat', { tabId, text: 'continue', mode: 'act', requestId: 'owned-cross-site-continue', locale: 'en' }); }
      finally { answering = false; await answerer; }
      if (variant === 'x-then-restart') {
        assert.equal(deniedCards.length, 1, 'The uncertain repeated publication needs one explicit decision.');
        const card = (continued.updates || []).find(event => event.type === 'clarify' && event.data?.clarifyId === deniedCards[0])?.data?.unverifiedStepConfirmation;
        assert.equal(card?.guardId, 'social-publication-authorization-guard');
        assert.equal(card?.hard, true);
        assert.equal(card?.action, 'publish');
        assert.equal(card?.reason, 'repeat_unverified');
      }
      continuedResults = resultsOf(continued);
      continuedReply = String(continued?.content || '').slice(0, 400);
    }
    const evidence = { variant, toolResults, continuedResults, continuedReply, workerRestarted, xPostsBeforeRestart, mastodonPosts, xPosts, xProPosts, dialogs,
      harnessAnswered, steered, unknownPrompts, judgeCalls, blockedRemote, finalUrl: page.url(),
      done: result.updates?.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result || null };
    await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    assert.deepEqual(unknownPrompts, [], 'Every model question was one the fixture answers');
    const held = toolResults.filter(item => item.reason === 'prior_effect_unreconciled');
    if (variant === 'mastodon-then-x') {
      assert.deepEqual(mastodonPosts, ['WebBrain test gönderisi'], 'One Mastodon post');
      assert.equal(steered, true);
      assert.deepEqual(held, [], `No post was held to find the Mastodon post on X: ${JSON.stringify(held)}`);
      assert.deepEqual(xPosts, ['WebBrain test post'], `One X post: ${JSON.stringify(toolResults)}`);
      const navigations = toolResults.filter(item => item.name === 'navigate');
      assert.equal(navigations.length, 2, `No back and forth between the sites: ${JSON.stringify(navigations)}`);
      assert.equal(harnessAnswered, 0);
    } else if (variant === 'restart-then-x') {
      assert.deepEqual(mastodonPosts, ['WebBrain test gönderisi'], 'One Mastodon post');
      assert.equal(xPostsBeforeRestart, 0, 'Nothing was posted on X before the restart');
      const stopped = [...toolResults, ...continuedResults].filter(item => ['prior_effect_unreconciled', 'attempt_history_unknown',
        'earlier_attempt_on_platform'].includes(item.reason));
      assert.deepEqual(stopped, [], `After the restart the X post was not held: ${JSON.stringify(continuedResults)}`);
      assert.deepEqual(xPosts, ['WebBrain test post'], `One X post after "continue": ${JSON.stringify(continuedResults)}`);
    } else if (variant === 'x-then-restart') {
      assert.deepEqual(mastodonPosts, ['WebBrain test gönderisi'], 'One Mastodon post');
      assert.equal(xPostsBeforeRestart, 1, `The X post went out before the restart: ${JSON.stringify(toolResults)}`);
      assert.deepEqual(xPosts, ['WebBrain test post'], `No second X post after "continue": ${JSON.stringify(continuedResults)}`);
      const again = continuedResults.filter(item => item.name === 'click_ax');
      assert.deepEqual(again.map(item => item.reason), ['earlier_attempt_on_platform'], JSON.stringify(continuedResults));
    } else if (variant === 'xpro-then-x' || variant === 'xpro-slow-plain-then-x') {
      if (script.slowCaptionReadings) assert.ok(slowReadings > 0, 'A caption reading was slower than WebBrain waits');
      assert.deepEqual(xProPosts, ['WebBrain test post'], `The X Pro post went out: ${JSON.stringify(toolResults)}`);
      assert.deepEqual(mastodonPosts, ['WebBrain test gönderisi'], 'One Mastodon post');
      assert.deepEqual(xPosts, [], `No second X post on x.com: ${JSON.stringify(toolResults)}`);
      const xClick = toolResults.filter(item => item.name === 'click_ax').at(-1);
      assert.equal(xClick?.reason, 'earlier_attempt_on_platform', JSON.stringify(toolResults));
    } else if (variant === 'xpro-enter-then-x') {
      assert.deepEqual(xProPosts, [], 'The X Pro draft was never posted');
      assert.deepEqual(mastodonPosts, ['WebBrain test gönderisi'], 'One Mastodon post');
      const stopped = toolResults.filter(item => ['earlier_attempt_on_platform', 'attempt_history_unknown'].includes(item.reason));
      assert.deepEqual(stopped, [], `Enter in a draft is no post: ${JSON.stringify(toolResults)}`);
      assert.deepEqual(xPosts, ['WebBrain test post'], `One X post: ${JSON.stringify(toolResults)}`);
    } else {
      assert.ok(dialogs.includes('beforeunload'), `The X page asked before it was left: ${JSON.stringify(dialogs)}`);
      assert.equal(harnessAnswered, 0, 'WebBrain answered the leave prompt for its own navigation; nobody else had to');
      const left = toolResults.filter(item => item.name === 'navigate').at(-1);
      assert.equal(left?.success, true, `The navigation away from the draft arrived: ${JSON.stringify(left)}`);
      assert.equal(new URL(page.url()).origin, 'https://mastoturk.org');
      assert.deepEqual(xPosts, [], 'The draft was never posted');
    }
    console.log(JSON.stringify({ passed: true, installedMV3: true, variant, mastodonPosts: mastodonPosts.length, xPosts: xPosts.length,
      ...(xProPosts.length ? { xProPosts: xProPosts.length } : {}),
      ...(workerRestarted !== null ? { workerRestarted, xPostsBeforeRestart } : {}),
      dialogs, harnessAnswered, navigations: toolResults.filter(item => item.name === 'navigate').length, judgeCalls, blockedRemote }));
  } finally {
    for (const settle of settleDialogs) await settle();
    await context?.close(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-cross-site-mv3-')) throw new Error('Unexpected temporary profile path.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
