import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';

// Both builds' accessibility-tree.js run in Chromium (the only installed
// engine); the file is byte-identical across builds.
const ROOT = process.env.WEBBRAIN_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));
const url = 'https://www.google.com/maps/place/Acme+Bakery';
// A OneGoogle-style header with the signed-in account's avatar button, and a
// public Business Profile whose contact address is page content.
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:14px sans-serif}header{display:flex;gap:20px;align-items:center;height:60px;padding:0 20px}
#account{display:inline-block;width:40px;height:40px}#account img{width:32px;height:32px}main{padding:20px}
</style>
<header id="gb" role="banner">
  <a href="https://www.google.com/maps">Google Maps</a>
  <a id="manage" href="https://myaccount.google.com/?utm_source=OGB&amp;authuser=0">Jane Doe — Manage your account</a>
  <div class="gb_Ld">
    <a class="gb_A" id="account" aria-label="Google Account: Jane Doe&#10;(jane@example.com)"
       href="https://accounts.google.com/SignOutOptions?hl=en&amp;continue=https://www.google.com/maps/place/Acme%2BBakery&amp;service=local&amp;ec=GBRAOG"
       role="button" tabindex="0" aria-expanded="false"><img class="gbii" id="avatar" alt="Jane Doe"
       src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAACAkQBADs="></a>
  </div>
</header>
<main id="profile">
  <h1>Acme Bakery</h1>
  <p>Fresh bread every morning.</p>
  <a id="business-mail" href="mailto:hello@acmebakery.example">hello@acmebakery.example</a>
  <a id="terms" href="https://policies.google.com/terms?hl=en&amp;fg=1">Terms</a>
  <button id="directions">Directions</button>
</main>
<script>window.qaActions=0;document.addEventListener('click',()=>qaActions++);</script>`;

async function withPage(build, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    await context.addInitScript({ content: await fs.readFile(path.join(ROOT, 'src', build, 'src/content/accessibility-tree.js'), 'utf8') });
    await context.route('https://www.google.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    const page = await context.newPage();
    await page.goto(url);
    await callback(page);
    assert.equal(await page.evaluate(() => qaActions), 0, 'AX observations must not perform actions');
  } finally { await browser.close(); }
}

const PRIVATE = [/Jane Doe/, /jane@example\.com/, /continue=/, /utm_source/, /authuser/];

for (const build of ['chrome', 'firefox']) {
  test(`${build}: signed-in Google account chrome stays out of every tree filter`, () => withPage(build, async page => {
    for (const filter of ['all', 'visible', 'interactive']) {
      const tree = await page.evaluate(filter => __generateAccessibilityTree(filter, 15, 6000), filter);
      for (const pattern of PRIVATE) assert.doesNotMatch(tree.pageContent, pattern, `${filter}: ${tree.pageContent}`);
      // The account menu stays reachable under its generic name, with its
      // role, its ref and where it leads.
      const line = tree.pageContent.split('\n').find(text => /\bbutton "Google account" \[ref_/.test(text));
      assert.ok(line, `${filter}: ${tree.pageContent}`);
      assert.match(line, /href="https:\/\/accounts\.google\.com\/SignOutOptions"/);
      const ref = line.match(/\[(ref_[A-Za-z0-9_-]+)\]/)[1];
      assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === document.getElementById('account'), ref), true);
      assert.match(tree.pageContent, /link "Google account" \[ref_[^\]]+\] href="https:\/\/myaccount\.google\.com\/"/);
      // Public page content, including the business's own address and
      // ordinary Google links with queries, is untouched.
      assert.match(tree.pageContent, /link "hello@acmebakery\.example" \[ref_[^\]]+\] href="mailto:hello@acmebakery\.example"/);
      assert.match(tree.pageContent, /link "Terms" \[ref_[^\]]+\] href="https:\/\/policies\.google\.com\/terms\?hl=en&fg=1"/);
      assert.match(tree.pageContent, /button "Directions"/);
      if (filter === 'all') assert.match(tree.pageContent, /heading "Acme Bakery"/);
    }
  }));

  test(`${build}: the avatar, hit-target, suggestion and inventory names are generic too`, () => withPage(build, async page => {
    const all = await page.evaluate(() => __generateAccessibilityTree('all', 15, 6000));
    assert.match(all.pageContent, /image "Google account" \[ref_/, 'the avatar alt text is the account name');
    const hit = await page.evaluate(() => {
      const rect = document.getElementById('avatar').getBoundingClientRect();
      return __wb_ax_resolve_visual_target(rect.x + rect.width / 2, rect.y + rect.height / 2);
    });
    assert.equal(hit?.name, 'Google account', JSON.stringify(hit));
    assert.equal(hit?.role, 'button');
    const suggestions = await page.evaluate(() => __wb_ax_suggest('not-a-ref', 50));
    assert.ok(suggestions.some(item => item.name === 'Google account'), JSON.stringify(suggestions));
    for (const pattern of PRIVATE) assert.doesNotMatch(JSON.stringify(suggestions), pattern);
    await page.evaluate(() => __generateAccessibilityTree('interactive', 15, 3500));
    const inventory = await page.evaluate(() => __wb_jev_snapshot());
    assert.ok(inventory?.controls?.some(control => control.name === 'Google account'), JSON.stringify(inventory));
    for (const pattern of PRIVATE) assert.doesNotMatch(JSON.stringify(inventory.controls), pattern);
  }));

  test(`${build}: generic account names keep tree reads deterministic`, () => withPage(build, async page => {
    const first = await page.evaluate(() => __generateAccessibilityTree('all', 15, 6000));
    const second = await page.evaluate(() => __generateAccessibilityTree('all', 15, 6000));
    assert.equal(second.pageContent, first.pageContent);
    assert.equal(second.treeRevision, first.treeRevision);
    // A different signed-in account renders the same model-facing tree.
    await page.evaluate(() => {
      const account = document.getElementById('account');
      account.setAttribute('aria-label', 'Google Account: Ali Veli\n(ali@example.org)');
      account.setAttribute('href', 'https://accounts.google.com/SignOutOptions?hl=tr&continue=https://www.google.com/maps');
      document.getElementById('avatar').setAttribute('alt', 'Ali Veli');
    });
    const third = await page.evaluate(() => __generateAccessibilityTree('all', 15, 6000));
    assert.equal(third.pageContent, first.pageContent);
    assert.doesNotMatch(third.pageContent, /Ali Veli|ali@example\.org/);
  }));
}

// ── Tool results built by content.js (click_ax, element and link lists) ──
// The real content scripts of each build run on a Gmail-like page: the
// account chrome sits in Google's bar, and an e-mail in the main region
// links to the account page as page content.
const call = (page, action, params = {}) => page.evaluate(message => new Promise(resolve => {
  for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
}), { target: 'content', action, params });

const mailHtml = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:14px sans-serif}header{display:flex;gap:20px;align-items:center;height:60px;padding:0 20px}
#account img{width:32px;height:32px}main{padding:20px}
</style>
<header id="gb" role="banner">
  <a href="https://mail.google.com/mail/u/0/#inbox">Gmail</a>
  <a id="manage" href="https://myaccount.google.com/?utm_source=OGB&amp;authuser=0"
     aria-label="Jane Doe — Manage your Google Account">Manage your Google Account</a>
  <a class="gb_A" id="account" aria-label="Google Account: Jane Doe&#10;(jane@example.com)"
     href="https://accounts.google.com/SignOutOptions?hl=en&amp;continue=https://mail.google.com/mail/&amp;service=mail"
     role="button"><img id="avatar" alt="Jane Doe" src="https://lh3.googleusercontent.com/a/ACg8ocJaneDoe=s32-c-mo"></a>
</header>
<main role="main">
  <h1>Security alert</h1>
  <div class="a3s">A new sign-in on Windows.
    <a id="activity" href="https://myaccount.google.com/alert/nt/123?rfn=1">Check activity</a></div>
  <a id="terms" href="https://policies.google.com/terms?hl=en&amp;fg=1">Terms</a>
</main>
<script>document.addEventListener('click', event => event.preventDefault());</script>`;

async function withContentPage(build, { url = 'https://mail.google.com/mail/u/0/', html = mailHtml } = {}, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(url);
    await page.evaluate(() => {
      window.fixtureHandlers = [];
      const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p, sendMessage: () => Promise.resolve() };
      window.chrome = { runtime }; window.browser = { runtime };
    });
    for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
      await page.addScriptTag({ content: await fs.readFile(path.join(ROOT, 'src', build, 'src/content', file), 'utf8') });
    }
    await callback(page);
  } finally { await browser.close(); }
}

// What a tool result hands the model: everything but the content script's
// private fingerprints, which the agent reads and deletes (it keeps
// _fallbackName for a model reading, so that one counts).
const modelFacing = result => JSON.stringify(Object.fromEntries(Object.entries(result || {})
  .filter(([key]) => !key.startsWith('_') || key === '_fallbackName')));
const ACCOUNT_PRIVATE = [...PRIVATE, /ACg8ocJaneDoe/];

for (const build of ['chrome', 'firefox']) {
  test(`${build}: click_ax echoes the account control by its generic name and endpoint`, () => withContentPage(build, {}, async page => {
    const tree = await page.evaluate(() => __generateAccessibilityTree('interactive', 15, 3500).pageContent);
    const ref = tree.match(/button "Google account" \[(ref_[^\]]+)\]/)?.[1];
    assert.ok(ref, tree);
    const result = await call(page, 'click_ax', { ref_id: ref });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.name, 'Google account');
    assert.equal(result.href, 'https://accounts.google.com/SignOutOptions');
    assert.equal(result.resolvedHref, 'https://accounts.google.com/SignOutOptions');
    assert.equal(result.targetUrl, 'https://accounts.google.com/SignOutOptions');
    assert.match(result.hint, /navigating to https:\/\/accounts\.google\.com\/SignOutOptions\./);
    for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(modelFacing(result), pattern, modelFacing(result));
    // Internal matching keeps the raw name.
    assert.equal(await page.evaluate(() => __wb_ax_name(document.getElementById('account'))),
      'Google Account: Jane Doe\n(jane@example.com)');

    // Page content still reports what it is and where it leads.
    const activityRef = tree.match(/link "Check activity" \[(ref_[^\]]+)\]/)?.[1];
    assert.ok(activityRef, tree);
    const activity = await call(page, 'click_ax', { ref_id: activityRef });
    assert.equal(activity.name, 'Check activity');
    assert.equal(activity.href, 'https://myaccount.google.com/alert/nt/123?rfn=1');
  }));

  test(`${build}: element and link lists name the account control generically`, () => withContentPage(build, {}, async page => {
    for (const action of ['get_interactive_elements', 'get_interactive_elements_cdp']) {
      const elements = await call(page, action);
      const account = elements.find(entry => entry.id === 'account');
      assert.equal(account?.text, 'Google account', `${action}: ${JSON.stringify(elements)}`);
      assert.equal(account.href, 'https://accounts.google.com/SignOutOptions');
      assert.equal(elements.find(entry => entry.id === 'manage')?.href, 'https://myaccount.google.com/');
      assert.equal(elements.find(entry => entry.id === 'activity')?.text, 'Check activity');
      for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify(elements), pattern, action);
    }
    const stale = await call(page, 'click', { index: 999 });
    assert.ok(stale.available?.some(entry => entry.text === 'Google account'), JSON.stringify(stale));
    for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify(stale), pattern);

    for (const action of ['get_page_info_cdp', 'get_page_info']) {
      const info = await call(page, action);
      const links = info.links;
      assert.deepEqual(links.find(link => link.href.startsWith('https://accounts.google.com/')),
        { text: '', href: 'https://accounts.google.com/SignOutOptions' }, `${action}: ${JSON.stringify(links)}`);
      assert.deepEqual(links.find(link => link.href.startsWith('https://myaccount.google.com/?')
        || link.href === 'https://myaccount.google.com/'), { text: 'Google account', href: 'https://myaccount.google.com/' });
      assert.deepEqual(links.find(link => link.text === 'Check activity'),
        { text: 'Check activity', href: 'https://myaccount.google.com/alert/nt/123?rfn=1' });
      assert.ok(links.some(link => link.href === 'https://policies.google.com/terms?hl=en&fg=1'));
      // The avatar is account chrome, not page media.
      assert.equal(info.media.imageCount, 0, JSON.stringify(info.media));
      for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify(info), pattern, action);
    }
  }));
}

// A page whose content scripts are not (yet) installed.
async function withBarePage(html, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://mail.google.com/mail/u/0/');
    await callback(page);
  } finally { await browser.close(); }
}
const installTree = (build, page) => async () => page.addScriptTag({
  content: await fs.readFile(path.join(ROOT, 'src', build, 'src/content/accessibility-tree.js'), 'utf8') });

// An auto-screenshot pairs the image with a list of visible controls, read
// by the agent beside the content scripts (Chrome: chrome.scripting; Firefox:
// tabs.executeScript), so each entry is named for that exact element.
// `install` stands in for injecting accessibility-tree.js.
async function screenshotElements(build, page, install = async () => {}) {
  const originals = { chrome: globalThis.chrome, browser: globalThis.browser };
  try {
    if (build === 'chrome') {
      globalThis.chrome = { scripting: { executeScript: async ({ func, args = [], files }) => {
        if (files) { await install(files); return [{ result: undefined }]; }
        return [{ result: await page.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: String(func), args }) }];
      } } };
      return await new ChromeAgent({ getActive: () => ({ supportsVision: true }) })._getVisibleInteractiveElements(5);
    }
    globalThis.browser = { tabs: { executeScript: async (_tabId, { code, file }) => {
      if (file) { await install([file]); return [undefined]; }
      return [await page.evaluate(code)];
    } } };
    return await new FirefoxAgent({ getActive: () => ({ supportsVision: true }) })._getVisibleInteractiveElements(5);
  } finally {
    if (originals.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = originals.chrome;
    if (originals.browser === undefined) delete globalThis.browser; else globalThis.browser = originals.browser;
  }
}

// Where a point lookup missed the account control: under a dialog's scrim,
// or with its centre off-screen while part of it shows.
const SCREENSHOT_LAYOUTS = {
  plain: () => {},
  'under a scrim': () => {
    const scrim = document.createElement('div');
    scrim.style.cssText = 'position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.5)';
    document.body.append(scrim);
  },
  'with its centre off-screen': () => {
    document.getElementById('account').style.cssText = 'position:fixed;left:-30px;top:10px;display:block;width:40px;height:40px';
  },
};

for (const build of ['chrome', 'firefox']) {
  for (const [layout, arrange] of Object.entries(SCREENSHOT_LAYOUTS)) {
    test(`${build}: a screenshot's visible-element list names the account control generically (${layout})`, () => withContentPage(build, {}, async page => {
      await page.evaluate(arrange);
      const elements = await screenshotElements(build, page);
      assert.ok(elements.some(entry => entry.text === 'Google account'
        && (layout !== 'with its centre off-screen' || entry.x < 0)), JSON.stringify(elements));
      assert.ok(elements.some(entry => entry.text === 'Check activity'), JSON.stringify(elements));
      for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify(elements), pattern, JSON.stringify(elements));
    }));
  }

  test(`${build}: a screenshot gets no element list where the model-facing names are missing`, () => withBarePage(mailHtml, async page => {
    // The tree cannot be installed: no list, rather than raw labels.
    const injected = [];
    assert.deepEqual(await screenshotElements(build, page, async files => { injected.push(...files); }), []);
    assert.deepEqual(injected.map(file => file.replace(/^\/+/, '')), ['src/content/accessibility-tree.js']);
    // Once installed, the list is read with its names.
    const elements = await screenshotElements(build, page, installTree(build, page));
    assert.ok(elements.some(entry => entry.text === 'Google account'), JSON.stringify(elements));
    for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify(elements), pattern, JSON.stringify(elements));
  }));

  // A scroll reports where it started, often the control just clicked.
  test(`${build}: a scroll from the account control names it generically`, () => withContentPage(build, {}, async page => {
    const tree = await page.evaluate(() => __generateAccessibilityTree('interactive', 15, 3500).pageContent);
    const ref = tree.match(/button "Google account" \[(ref_[^\]]+)\]/)?.[1];
    assert.ok(ref, tree);
    const scrolled = await call(page, 'scroll', { ref_id: ref, direction: 'down' });
    assert.equal(scrolled.originElement?.text, 'Google account', JSON.stringify(scrolled));
    await page.evaluate(() => document.getElementById('account').focus());
    const fromFocus = await call(page, 'scroll', { direction: 'down' });
    assert.equal(fromFocus.originElement?.text, 'Google account', JSON.stringify(fromFocus));
    for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify([scrolled, fromFocus]), pattern);
  }));

  // A click refused because something covers its target names the cover.
  test(`${build}: a click blocked by the account control names it generically`, () => withContentPage(build, {}, async page => {
    await page.evaluate(() => {
      document.getElementById('avatar').remove();
      document.getElementById('account').style.cssText = 'position:fixed;inset:0;display:block;z-index:10';
    });
    const blocked = await call(page, 'click', { selector: '#terms' });
    assert.equal(blocked.occluded, true, JSON.stringify(blocked));
    assert.equal(blocked.occludedBy.text, 'Google account');
    assert.match(blocked.error, /<a\[role=button\] "Google account">/);
    for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify(blocked), pattern, JSON.stringify(blocked));
  }));
}

// Chrome's hover and drag_drop echo the name content.js resolves for a ref.
test('chrome: hover and drag targets name the account control generically', () => withContentPage('chrome', {}, async page => {
  const tree = await page.evaluate(() => __generateAccessibilityTree('interactive', 15, 3500).pageContent);
  const account = tree.match(/button "Google account" \[(ref_[^\]]+)\]/)?.[1];
  const terms = tree.match(/link "Terms" \[(ref_[^\]]+)\]/)?.[1];
  assert.ok(account && terms, tree);
  const hover = await call(page, 'ax_resolve_rect', { ref_id: account });
  assert.equal(hover.name, 'Google account', JSON.stringify(hover));
  // A click's trusted-fallback target is named the same way; its state
  // fingerprints stay raw, compared only by the agent itself.
  const clickTarget = await call(page, 'ax_resolve_rect', { ref_id: account, forClickFallback: true });
  assert.equal(clickTarget.name, 'Google account', JSON.stringify(clickTarget));
  const drag = await call(page, 'ax_resolve_two_rects', { fromRefId: account, toRefId: terms });
  assert.equal(drag.from.name, 'Google account', JSON.stringify(drag));
  assert.equal(drag.to.name, 'Terms');
  for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify([hover, drag]), pattern);
}));

// Chrome's click({text}) scans the page's main world over CDP. Every name
// it hands back is resolved for its element beside the content scripts, and
// the elements' temporary marks are removed.
const cdpHtml = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px sans-serif}
header{display:flex;gap:20px;height:60px;align-items:center}#chip{display:inline-block;width:32px;height:32px}</style>
<header id="gb" role="banner"><a href="https://www.google.com/maps">Google Maps</a>
  <a id="account" aria-label="Google Account: Jane Doe&#10;(jane@example.com)" role="button"
     href="https://accounts.google.com/SignOutOptions?continue=https://mail.google.com/mail/"><img alt="Jane Doe" src="data:," width="32" height="32"></a>
  <a id="switcher" href="https://accounts.google.com/AccountChooser?continue=https://mail.google.com/mail/"><span id="chip" tabindex="0"
     aria-label="Switch from Jane Doe (jane@example.com)"></span></a></header>
<main role="main"><h1>Inbox</h1></main>`;

async function cdpTextClick(page, args, install = async () => {}) {
  const dispatched = [];
  const stubs = {
    attach: async () => ({ attached: true }),
    evaluate: async (_tabId, expression) => ({ result: { value: await page.evaluate(expression) } }),
    armFileInputClickGuard: async () => {},
    consumeFileInputClickGuard: async () => null,
    dispatchMouseEvent: async (_tabId, type, _x, _y, _button, options) => { options?.beforeSend?.(); dispatched.push(type); },
  };
  const originals = { chrome: globalThis.chrome };
  try {
    Object.assign(cdpClient, stubs);
    globalThis.chrome = {
      tabs: { get: async id => ({ id, url: page.url() }), query: async () => [], sendMessage: async () => ({}) },
      scripting: { executeScript: async ({ func, args = [], files }) => {
        if (files) { await install(files); return [{ result: undefined }]; }
        return [{ result: await page.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: String(func), args }) }];
      } },
    };
    const agent = new ChromeAgent({ getActive: () => ({ supportsVision: false }) });
    Object.assign(agent, {
      _showAgentTarget: () => {},
      _currentUrl: async () => page.url(),
      _clickProgressSnapshot: async () => null,
      _redirectTargetBlankClick: async () => null,
      _annotateClickProgress: async (_tabId, _name, _args, response) => response,
    });
    return { result: await agent.executeTool(10, 'click', args), dispatched };
  } finally {
    // The stubs shadow the client's own methods; removing them restores it.
    for (const key of Object.keys(stubs)) delete cdpClient[key];
    if (originals.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = originals.chrome;
  }
}

test('chrome: click({text}) names account controls generically in its candidates and its widened match', () => withContentPage('chrome',
  { html: cdpHtml }, async page => {
    const { result: ambiguous, dispatched } = await cdpTextClick(page, { text: 'google' });
    assert.equal(ambiguous.success, false, JSON.stringify(ambiguous));
    assert.deepEqual(ambiguous.candidates.map(candidate => candidate.text), ['google maps', 'Google account'], JSON.stringify(ambiguous));
    assert.ok(ambiguous.candidates.every(candidate => !('visibleText' in candidate)));
    assert.deepEqual(dispatched, []);
    // Only the widened scan sees the switcher's focusable chip.
    const { result: widened } = await cdpTextClick(page, { text: 'switch from' });
    assert.equal(widened.success, true, JSON.stringify(widened));
    assert.equal(widened.method, 'cdp-by-text');
    assert.equal(widened.text, 'Google account', JSON.stringify(widened));
    for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify([ambiguous, widened]), pattern);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-webbrain-model-name]').length), 0);
    // The widened scan also reaches into open shadow roots, and so does the
    // naming: the label is read for that element, then its mark removed.
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'host';
      document.querySelector('main').append(host);
      host.attachShadow({ mode: 'open' }).innerHTML = '<span tabindex="0" aria-label="Open shadow widget" style="display:inline-block;width:20px;height:20px"></span>';
    });
    const { result: shadow } = await cdpTextClick(page, { text: 'open shadow widget' });
    assert.equal(shadow.text, 'open shadow widget', JSON.stringify(shadow));
    assert.equal(await page.evaluate(() => document.getElementById('host').shadowRoot.querySelectorAll('[data-webbrain-model-name]').length), 0);
  }));

test('chrome: click({text}) installs the tree for its names, and without it reports visible text, never a label', () => withBarePage(cdpHtml, async page => {
  const { result: unnamed } = await cdpTextClick(page, { text: 'google' });
  assert.deepEqual(unnamed.candidates.map(candidate => candidate.text), ['google maps', ''], JSON.stringify(unnamed));
  const { result: named } = await cdpTextClick(page, { text: 'google' }, installTree('chrome', page));
  assert.deepEqual(named.candidates.map(candidate => candidate.text), ['google maps', 'Google account'], JSON.stringify(named));
  for (const pattern of ACCOUNT_PRIVATE) assert.doesNotMatch(JSON.stringify([unnamed, named]), pattern);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-webbrain-model-name]').length), 0);
}));

// Preparing Chrome's trusted click of a native button echoes the generic
// name, while the agent compares the raw one so an account switch between
// preparation and press still refuses.
test('chrome: a native account button is prepared under its generic name and compared by its raw one', () => withContentPage('chrome', {
  url: 'https://calendar.google.com/calendar/u/0/r',
  html: `<!doctype html><div id="gb"><button id="avatar-button" aria-label="Google Account: Jane Doe (jane@example.com)">JD</button></div>
    <main role="main"><h1>Calendar</h1></main>`,
}, async page => {
  const prepare = async () => {
    const tree = await page.evaluate(() => __generateAccessibilityTree('interactive', 15, 3500).pageContent);
    const ref = tree.match(/button "Google account" \[(ref_[^\]]+)\]/)?.[1];
    assert.ok(ref, tree);
    return call(page, 'click_ax', { ref_id: ref, _prepareTrustedNativeButton: true, _requireTrustedNativeButton: false });
  };
  const prepared = await prepare();
  assert.equal(prepared.trustedButtonRequired, true, JSON.stringify(prepared));
  assert.equal(prepared.name, 'Google account');
  assert.equal(prepared._rawName, 'Google Account: Jane Doe (jane@example.com)');
  await page.evaluate(() => document.getElementById('avatar-button').setAttribute('aria-label', 'Google Account: Ali Veli (ali@example.org)'));
  const switched = await prepare();
  assert.equal(switched.name, prepared.name);
  assert.notEqual(switched._rawName, prepared._rawName);
  const agentSource = await fs.readFile(path.join(ROOT, 'src/chrome/src/agent/agent.js'), 'utf8');
  assert.match(agentSource, /current\._rawName !== prepared\._rawName/);
}));

// ── Only Google's account chrome, never page content ────────────────────
const treeLines = async (page, filter = 'all') => (await page.evaluate(filter => __generateAccessibilityTree(filter, 15, 8000).pageContent, filter)).split('\n');

async function withTreePage(build, url, html, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    await context.addInitScript({ content: await fs.readFile(path.join(ROOT, 'src', build, 'src/content/accessibility-tree.js'), 'utf8') });
    await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const page = await context.newPage();
    await page.goto(url);
    await callback(page);
  } finally { await browser.close(); }
}

const accountBar = `<header id="gb" role="banner"><a id="account" aria-label="Google Account: Jane Doe (jane@example.com)"
  href="https://accounts.google.com/SignOutOptions?continue=https://myaccount.google.com/" role="button"><img alt="Jane Doe" src="data:,"></a></header>`;

for (const build of ['chrome', 'firefox']) {
  test(`${build}: Google's account pages keep their own names and links`, () => withTreePage(build, 'https://myaccount.google.com/',
    `<!doctype html>${accountBar}<nav><a href="security?hl=en">Security</a><a href="personal-info">Personal info</a></nav>
    <main><a href="/signinoptions/two-step-verification?rapt=abc"><h2>Turn on 2-Step Verification</h2></a></main>`, async page => {
      const tree = (await treeLines(page)).join('\n');
      assert.match(tree, /link "Security" \[ref_[^\]]+\] href="security\?hl=en"/);
      assert.match(tree, /link "Personal info" \[ref_[^\]]+\] href="personal-info"/);
      assert.match(tree, /link "Turn on 2-Step Verification" \[ref_[^\]]+\] href="\/signinoptions\/two-step-verification\?rapt=abc"/);
      assert.match(tree, /heading "Turn on 2-Step Verification"/);
      // The account itself is the subject of these pages.
      assert.match(tree, /button "Google Account: Jane Doe \(jane@example\.com\)"/);
      assert.doesNotMatch(tree, /"Google account"/);
    }));

  test(`${build}: account links in page content keep their names`, () => withTreePage(build, 'https://mail.google.com/mail/u/0/',
    `<!doctype html>${accountBar}<div role="main"><div role="listitem"><div class="a3s">A new sign-in on Windows.
      <a href="https://myaccount.google.com/alert/nt/123?rfn=1">Check activity</a></div></div></div>
    <article><header><a href="https://myaccount.google.com/security">Review your security settings</a></header></article>`, async page => {
      const tree = (await treeLines(page)).join('\n');
      assert.match(tree, /link "Check activity" \[ref_[^\]]+\] href="https:\/\/myaccount\.google\.com\/alert\/nt\/123\?rfn=1"/);
      assert.match(tree, /link "Review your security settings" \[ref_[^\]]+\] href="https:\/\/myaccount\.google\.com\/security"/);
      // Google's bar on the same page is still account chrome.
      assert.match(tree, /button "Google account" \[ref_[^\]]+\] href="https:\/\/accounts\.google\.com\/SignOutOptions"/);
      assert.doesNotMatch(tree, /Jane Doe|jane@example\.com|continue=/);
    }));

  test(`${build}: a button of Google's bar named with an e-mail address is account chrome`, () => withTreePage(build, 'https://calendar.google.com/calendar/u/0/r',
    `<!doctype html><div id="gb"><button id="avatar-button" aria-label="Compte Google : Jane Doe (jane@example.com)"><img alt="Jane Doe" src="data:,"></button>
      <button aria-label="Applications Google">apps</button></div>
    <header role="banner"><button aria-label="Signed in as support@vendor.example">Support</button></header>
    <main><button aria-label="Share with ali@example.org">Share</button></main>`, async page => {
      const tree = (await treeLines(page)).join('\n');
      assert.match(tree, /button "Google account" \[ref_[^\]]+\] dom_id="avatar-button"/);
      assert.match(tree, /image "Google account"/);
      assert.doesNotMatch(tree, /Jane Doe|jane@example\.com/);
      assert.match(tree, /button "Applications Google"/);
      // Narrow: outside Google's bar an address in a name is page text.
      assert.match(tree, /button "Signed in as support@vendor\.example"/);
      assert.match(tree, /button "Share with ali@example\.org"/);
    }));

  // A link to the account switch or sign-out endpoint names only the
  // signed-in session wherever a page puts it; the signed-out "Sign in" link
  // and the account page outside the bar are ordinary links.
  test(`${build}: session links are account chrome anywhere, and the signed-out Sign in link is not`, () => withTreePage(build, 'https://www.youtube.com/',
    `<!doctype html><div class="masthead"><a href="https://accounts.google.com/SignOutOptions?continue=https://www.youtube.com/"
      aria-label="Google Account: Jane Doe (jane@example.com)"><img alt="Jane Doe" src="data:,"></a></div>
    <div role="menu"><a href="https://accounts.google.com/AccountChooser?continue=https://www.youtube.com/">Switch from jane@example.com</a>
      <a href="https://accounts.google.com/Logout?continue=https://www.youtube.com/">Sign out of Jane Doe</a></div>
    <header role="banner"><a href="https://accounts.google.com/ServiceLogin?continue=https://www.youtube.com/">Sign in</a></header>
    <main><a href="https://myaccount.google.com/security">Review your security settings</a></main>`, async page => {
      const tree = (await treeLines(page)).join('\n');
      for (const endpoint of ['SignOutOptions', 'AccountChooser', 'Logout']) {
        assert.match(tree, new RegExp(`link "Google account" \\[ref_[^\\]]+\\] href="https://accounts\\.google\\.com/${endpoint}"`), tree);
      }
      assert.match(tree, /image "Google account"/);
      assert.doesNotMatch(tree, /Jane Doe|jane@example\.com/);
      assert.match(tree, /link "Sign in" \[ref_[^\]]+\] href="https:\/\/accounts\.google\.com\/ServiceLogin\?continue=https:\/\/www\.youtube\.com\/"/);
      assert.match(tree, /link "Review your security settings" \[ref_[^\]]+\] href="https:\/\/myaccount\.google\.com\/security"/);
    }));
}

test('both builds ship the same accessibility tree', async () => {
  const [chrome, firefox] = await Promise.all(['chrome', 'firefox'].map(build => fs.readFile(
    path.join(ROOT, 'src', build, 'src/content/accessibility-tree.js'), 'utf8')));
  assert.equal(firefox, chrome);
});
