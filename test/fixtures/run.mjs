#!/usr/bin/env node
// Fixtures runner for v4.0.1 overlay defenses.
//
// Loads each fixture HTML in Chromium, injects the Chrome build's content.js
// with a stubbed `chrome.runtime`, and drives `click({text})` through the
// message handler. Asserts on response shape + which DOM element actually
// got the click.
//
// No LLM, no API keys, no real sites — just deterministic regression checks
// for _findTopmostModal scoping, the occlusion hit-test, and the rich
// ambiguity payload.
//
// Run: npm run test:fixtures

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const accessibilityTreeJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'accessibility-tree.js');
const contentJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'content.js');
const firefoxContentJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'content.js');
const smdJsPath = path.join(root, 'src', 'chrome', 'src', 'agent', 'social-media-downloader.js');

function fixtureUrl(name) {
  return 'file://' + path.join(__dirname, name);
}

// Stub enough of `chrome.runtime` for content.js to register its handler
// without throwing. We capture the handler on window.__wb_handler.
const stubChrome = `
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.runtime.onMessage = {
    addListener: (fn) => { window.__wb_handler = fn; }
  };
`;

const stubFirefoxBrowser = `
  window.browser = window.browser || {};
  window.browser.runtime = window.browser.runtime || {};
  window.browser.runtime.getURL = (path) => path;
  window.browser.runtime.onMessage = {
    addListener: (fn) => { window.__wb_handler = fn; }
  };
`;

async function setup(page, fixture) {
  await page.addInitScript(stubChrome);
  await page.goto(fixtureUrl(fixture));
  const axSrc = await readFile(accessibilityTreeJsPath, 'utf-8');
  await page.addScriptTag({ content: axSrc });
  const src = await readFile(contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  // Ensure handler is registered.
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupFirefoxHtml(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: stubFirefoxBrowser });
  const src = await readFile(firefoxContentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function call(page, action, params) {
  return page.evaluate(({ action, params }) => new Promise((resolve) => {
    const ret = window.__wb_handler(
      { target: 'content', action, params },
      {},
      (resp) => resolve(resp),
    );
    if (ret !== true && ret !== undefined) resolve(ret);
  }), { action, params });
}

async function clickedSentinel(page) {
  return page.evaluate(() => window.__clicked);
}

async function setupSmd(page, url, html) {
  const u = new URL(url);
  await page.route(`${u.origin}/**`, route => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ body: html, contentType: 'text/html' });
    }
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const src = await readFile(smdJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.SocialMediaDownloader === 'object');
}

async function collectSmd(page, mode = 'auto') {
  return page.evaluate((m) => {
    const r = window.SocialMediaDownloader._collect(m);
    return { urls: r.urls, mode: r.mode, profile: r.profile.name };
  }, mode);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── modal-scoping ────────────────────────────────────────────────────────
test('modal scoping: click({text:"Create"}) resolves to dialog Create', async (page) => {
  await setup(page, 'modal-scoping.html');
  const resp = await call(page, 'click', { text: 'Create' });
  if (!resp?.success) throw new Error(`expected success, got: ${JSON.stringify(resp)}`);
  const clicked = await clickedSentinel(page);
  if (clicked !== 'dlg-create') {
    throw new Error(`expected dlg-create, actually clicked: ${clicked}`);
  }
});

test('modal scoping: click({text:"Publish"}) returns no-match (scoped out)', async (page) => {
  await setup(page, 'modal-scoping.html');
  const resp = await call(page, 'click', { text: 'Publish release' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (!/scoped to the open modal/i.test(resp?.error || '')) {
    throw new Error(`expected modal-scope note in error, got: ${resp?.error}`);
  }
});

// ─── occlusion ────────────────────────────────────────────────────────────
test('occlusion: click({text:"Submit"}) refuses when covered', async (page) => {
  await setup(page, 'occlusion.html');
  const resp = await call(page, 'click', { text: 'Submit' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (!resp?.occluded) throw new Error(`expected occluded:true, got: ${JSON.stringify(resp)}`);
  if (!resp?.occludedBy) throw new Error(`expected occludedBy payload`);
  const clicked = await clickedSentinel(page);
  if (clicked !== null) throw new Error(`target should not have been clicked, got: ${clicked}`);
});

test('occlusion: click({x,y}) force-clicks (skips occlusion check)', async (page) => {
  await setup(page, 'occlusion.html');
  // Force via coords — the check is supposed to skip for x,y, so click
  // hits whatever elementFromPoint returns (the cover). Target stays unclicked.
  const resp = await call(page, 'click', { x: 180, y: 120 });
  if (!resp?.success) throw new Error(`expected success for coord click, got: ${JSON.stringify(resp)}`);
  // Either the cover or the button — we just verify no occlusion error thrown.
  if (resp?.occluded) throw new Error(`coord click should bypass occlusion check`);
});

// ─── ambiguity candidates ─────────────────────────────────────────────────
test('ambiguity: two Cancels return rich candidates with ancestor', async (page) => {
  await setup(page, 'ambiguity-candidates.html');
  const resp = await call(page, 'click', { text: 'Cancel' });
  if (resp?.success) throw new Error(`expected ambiguity, got success`);
  if (!Array.isArray(resp?.candidates)) throw new Error(`expected candidates array`);
  if (resp.candidates.length < 2) throw new Error(`expected ≥2 candidates, got ${resp.candidates.length}`);
  const ancestors = resp.candidates.map(c => c.ancestor || '');
  const hasForm = ancestors.some(a => /form/i.test(a) && /payment/i.test(a));
  const hasSection = ancestors.some(a => /section/i.test(a) && /shipping/i.test(a));
  if (!hasForm || !hasSection) {
    throw new Error(`expected form:Payment + section:Shipping ancestors, got: ${JSON.stringify(ancestors)}`);
  }
  for (const c of resp.candidates) {
    if (typeof c.cx !== 'number' || typeof c.cy !== 'number') {
      throw new Error(`candidate missing cx/cy: ${JSON.stringify(c)}`);
    }
  }
});

// ─── click_ax same-page anchors ─────────────────────────────────────────────
test('click_ax: same-page anchor reports hash and scroll completion', async (page) => {
  await setup(page, 'anchor-click.html');
  const before = await page.evaluate(() => ({ hash: location.hash, scrollY: window.scrollY }));
  if (before.hash !== '') throw new Error(`expected no initial hash, got ${before.hash}`);

  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "References" \[(ref_\d+)\] href="#References"/);
  if (!match) throw new Error(`could not find References link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#References') throw new Error(`expected href #References, got ${resp.href}`);
  if (resp.sameDocumentAnchor !== true) throw new Error(`expected sameDocumentAnchor:true, got ${JSON.stringify(resp)}`);
  if (resp.anchorTarget !== '#References') throw new Error(`expected anchorTarget #References, got ${resp.anchorTarget}`);
  if (!resp.afterUrl || !resp.afterUrl.endsWith('#References')) throw new Error(`expected afterUrl to end with #References, got ${resp.afterUrl}`);
  if (resp.scrollChanged !== true) throw new Error(`expected scrollChanged:true, got ${JSON.stringify(resp)}`);
  if (!(resp.afterScrollY > resp.beforeScrollY)) throw new Error(`expected afterScrollY > beforeScrollY, got ${JSON.stringify(resp)}`);
  if (!/Same-page anchor click completed/i.test(resp.hint || '')) throw new Error(`missing completion hint: ${resp.hint}`);

  const after = await page.evaluate(() => ({ hash: location.hash, scrollY: window.scrollY }));
  if (after.hash !== '#References') throw new Error(`expected page hash #References, got ${after.hash}`);
  if (!(after.scrollY > before.scrollY)) throw new Error(`expected page to scroll, before=${before.scrollY} after=${after.scrollY}`);
});

test('click_ax: base href fragment uses resolved anchor destination', async (page) => {
  await setup(page, 'anchor-base-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "References" \[(ref_\d+)\] href="#References"/);
  if (!match) throw new Error(`could not find References link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#References') throw new Error(`expected raw href #References, got ${resp.href}`);
  if (resp.resolvedHref !== 'https://example.com/docs/#References') throw new Error(`expected resolvedHref to honor <base>, got ${resp.resolvedHref}`);
  if (resp.targetUrl !== 'https://example.com/docs/#References') throw new Error(`expected targetUrl to honor <base>, got ${resp.targetUrl}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`base-resolved off-document href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.navigates !== true) throw new Error(`expected navigates:true, got ${JSON.stringify(resp)}`);
});

test('click_ax: placeholder popup anchor keeps popup guidance', async (page) => {
  await setup(page, 'anchor-popup-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "Options" \[(ref_\d+)\] href="#"/);
  if (!match) throw new Error(`could not find Options link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#') throw new Error(`expected href #, got ${resp.href}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`placeholder href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.opened_popup_likely !== true) throw new Error(`expected opened_popup_likely:true, got ${JSON.stringify(resp)}`);
  if (!/popup-opener/i.test(resp.hint || '')) throw new Error(`expected popup guidance, got: ${resp.hint}`);
  if (/Same-page anchor click completed/i.test(resp.hint || '')) throw new Error(`placeholder popup used same-page anchor hint: ${resp.hint}`);

  const opened = await page.evaluate(() => window.__menuOpened);
  if (opened !== true) throw new Error('expected click handler to run');
});

test('click_ax: hash popup anchor keeps popup guidance', async (page) => {
  await setup(page, 'anchor-popup-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "More" \[(ref_\d+)\] href="#menu"/);
  if (!match) throw new Error(`could not find More link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#menu') throw new Error(`expected href #menu, got ${resp.href}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`popup href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.opened_popup_likely !== true) throw new Error(`expected opened_popup_likely:true, got ${JSON.stringify(resp)}`);
  if (!/popup-opener/i.test(resp.hint || '')) throw new Error(`expected popup guidance, got: ${resp.hint}`);
  if (/Same-page anchor/i.test(resp.hint || '')) throw new Error(`hash popup used same-page anchor hint: ${resp.hint}`);

  const opened = await page.evaluate(() => window.__hashMenuOpened);
  if (opened !== true) throw new Error('expected hash popup click handler to run');
});

// ─── Firefox index/focus parity ───────────────────────────────────────────
test('Firefox: click({index}) matches full interactive ordering and preserves type focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #late { position: absolute; left: 20px; top: 180px; width: 120px; height: 40px; }
      #search { position: absolute; left: 20px; top: 20px; width: 240px; height: 40px; }
    </style>
    <button id="late" onclick="window.__clicked='late'">Later button</button>
    <input id="search" role="combobox" placeholder="Search">`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements?.[0]?.id !== 'search') {
    throw new Error(`expected visually first element to be search input, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected click success, got: ${JSON.stringify(click)}`);
  if (click.tag !== 'INPUT') throw new Error(`expected click index 0 to hit INPUT, got: ${JSON.stringify(click)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'search') throw new Error(`expected search input focus after click, got: ${activeId}`);

  const typed = await call(page, 'type', { text: 'mchiang0610' });
  if (!typed?.success) throw new Error(`expected type success, got: ${JSON.stringify(typed)}`);

  const value = await page.evaluate(() => document.getElementById('search').value);
  if (value !== 'mchiang0610') throw new Error(`expected typed value, got: ${value}`);
});

test('Firefox: indexed shadow-DOM click passes occlusion hit test', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #host { position: absolute; left: 20px; top: 20px; width: 180px; height: 44px; }
      #late { position: absolute; left: 20px; top: 160px; width: 120px; height: 40px; }
    </style>
    <div id="host"></div>
    <button id="late">Later button</button>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<style>button { width: 180px; height: 44px; }</style><button id="shadow-button">Shadow Action</button>';
      root.getElementById('shadow-button').addEventListener('click', () => { window.__shadowClicked = true; });
    </script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const shadowIndex = elements.findIndex(e => e.text === 'Shadow Action');
  if (shadowIndex < 0) throw new Error(`expected shadow button in elements, got: ${JSON.stringify(elements)}`);
  if (elements[shadowIndex].inShadowDOM !== true) {
    throw new Error(`expected inShadowDOM:true, got: ${JSON.stringify(elements[shadowIndex])}`);
  }

  const click = await call(page, 'click', { index: shadowIndex });
  if (!click?.success) throw new Error(`expected shadow click success, got: ${JSON.stringify(click)}`);
  if (click.occluded) throw new Error(`shadow click should not be reported occluded: ${JSON.stringify(click)}`);

  const clicked = await page.evaluate(() => window.__shadowClicked === true);
  if (!clicked) throw new Error('expected shadow button click handler to run');
});

test('Firefox: click-then-type preserves shadow-root input focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #host { position: absolute; left: 20px; top: 20px; width: 220px; height: 44px; }
    </style>
    <div id="host"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<style>input { width: 220px; height: 44px; box-sizing: border-box; }</style><input id="shadow-input" placeholder="Shadow Name">';
    </script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const shadowIndex = elements.findIndex(e => e.id === 'shadow-input');
  if (shadowIndex < 0) throw new Error(`expected shadow input in elements, got: ${JSON.stringify(elements)}`);
  if (elements[shadowIndex].inShadowDOM !== true) {
    throw new Error(`expected inShadowDOM:true, got: ${JSON.stringify(elements[shadowIndex])}`);
  }

  const click = await call(page, 'click', { index: shadowIndex });
  if (!click?.success) throw new Error(`expected shadow input click success, got: ${JSON.stringify(click)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'host') throw new Error(`expected document focus on shadow host, got: ${activeId}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected shadow input type success, got: ${JSON.stringify(typed)}`);

  const value = await page.evaluate(() => document.getElementById('host').shadowRoot.getElementById('shadow-input').value);
  if (value !== 'Ada') throw new Error(`expected typed shadow value, got: ${value}`);
});

test('Firefox: type_text returns an error after focus moves to a noneditable element', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
      #opener { position: absolute; left: 20px; top: 90px; width: 140px; height: 40px; }
    </style>
    <input id="field" placeholder="Name">
    <button id="opener">Open menu</button>`);

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected input click success, got: ${JSON.stringify(click)}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected first type success, got: ${JSON.stringify(typed)}`);

  await page.evaluate(() => document.getElementById('opener').focus());
  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'opener') throw new Error(`expected opener focus, got: ${activeId}`);

  const staleType = await call(page, 'type', { text: ' Lovelace' });
  if (staleType?.success) throw new Error(`expected type failure after button focus, got: ${JSON.stringify(staleType)}`);
  if (!/Focused element <button> is not an editable field/.test(staleType?.error || '')) {
    throw new Error(`expected focused button error, got: ${JSON.stringify(staleType)}`);
  }

  const value = await page.evaluate(() => document.getElementById('field').value);
  if (value !== 'Ada') throw new Error(`expected stale fallback not to mutate input, got: ${value}`);
});

test('Firefox: full indexed elements exclude inert background controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #background { position: absolute; left: 20px; top: 20px; }
      #dialog { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      button { width: 160px; height: 40px; }
    </style>
    <main id="background" aria-hidden="true">
      <button id="background-action" onclick="window.__backgroundClicked = true">Publish</button>
    </main>
    <section id="disabled-zone" inert>
      <button id="inert-action" onclick="window.__inertClicked = true">Archive</button>
    </section>
    <div id="dialog" role="dialog" aria-modal="true">
      <button id="dialog-action" onclick="window.__dialogClicked = true">Create</button>
    </div>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'background-action' || e.id === 'inert-action')) {
    throw new Error(`expected hidden/inert background controls to be filtered, got: ${JSON.stringify(elements)}`);
  }
  if (elements?.[0]?.id !== 'dialog-action') {
    throw new Error(`expected dialog action to be first actionable index, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected dialog click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    dialog: window.__dialogClicked === true,
    background: window.__backgroundClicked === true,
    inert: window.__inertClicked === true,
  }));
  if (!state.dialog || state.background || state.inert) {
    throw new Error(`expected only dialog action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: blocking overlay resolves sibling dialog content for indexed controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
      #dialog-panel { position: fixed; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #dialog-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <div id="backdrop" data-overlay></div>
    <section id="dialog-panel" role="dialog">
      <button id="dialog-action" onclick="window.__dialogClicked = true">Confirm</button>
    </section>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'page-action')) {
    throw new Error(`expected page action to be filtered behind overlay, got: ${JSON.stringify(elements)}`);
  }
  const dialogIndex = elements.findIndex(e => e.id === 'dialog-action');
  if (dialogIndex < 0) throw new Error(`expected sibling dialog action in elements, got: ${JSON.stringify(elements)}`);

  const click = await call(page, 'click', { index: dialogIndex });
  if (!click?.success) throw new Error(`expected dialog action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    dialog: window.__dialogClicked === true,
  }));
  if (state.page || !state.dialog) {
    throw new Error(`expected only dialog action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: non-modal dialogs do not hide full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #help-widget { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #help-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <aside id="help-widget" role="dialog" aria-label="Help">
      <button id="help-action" onclick="window.__helpClicked = true">Open help</button>
    </aside>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const pageIndex = elements.findIndex(e => e.id === 'page-action');
  const helpIndex = elements.findIndex(e => e.id === 'help-action');
  if (pageIndex < 0 || helpIndex < 0) {
    throw new Error(`expected page and non-modal dialog controls in elements, got: ${JSON.stringify(elements)}`);
  }

  const click = await call(page, 'click', { index: pageIndex });
  if (!click?.success) throw new Error(`expected page action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    help: window.__helpClicked === true,
  }));
  if (!state.page || state.help) {
    throw new Error(`expected only page action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: native non-modal dialog does not hide full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #native-help { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #help-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <dialog id="native-help" open>
      <button id="help-action" onclick="window.__helpClicked = true">Open help</button>
    </dialog>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const pageIndex = elements.findIndex(e => e.id === 'page-action');
  const helpIndex = elements.findIndex(e => e.id === 'help-action');
  if (pageIndex < 0 || helpIndex < 0) {
    throw new Error(`expected page and native non-modal dialog controls in elements, got: ${JSON.stringify(elements)}`);
  }

  const click = await call(page, 'click', { index: pageIndex });
  if (!click?.success) throw new Error(`expected page action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    help: window.__helpClicked === true,
  }));
  if (!state.page || state.help) {
    throw new Error(`expected only page action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: native modal dialog scopes full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #native-modal { width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #modal-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <dialog id="native-modal">
      <button id="modal-action" onclick="window.__modalClicked = true">Confirm</button>
    </dialog>
    <script>document.getElementById('native-modal').showModal();</script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'page-action')) {
    throw new Error(`expected page action to be filtered behind native modal, got: ${JSON.stringify(elements)}`);
  }
  if (elements?.[0]?.id !== 'modal-action') {
    throw new Error(`expected modal action to be first actionable index, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected modal action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    modal: window.__modalClicked === true,
  }));
  if (state.page || !state.modal) {
    throw new Error(`expected only modal action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: type_text rejects non-text input after it receives focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
      #button-input { position: absolute; left: 20px; top: 90px; width: 140px; height: 40px; }
    </style>
    <input id="field" placeholder="Name">
    <input id="button-input" type="button" value="Open" onclick="window.__buttonInputClicked = true">`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const fieldIndex = elements.findIndex(e => e.id === 'field');
  const buttonIndex = elements.findIndex(e => e.id === 'button-input');
  if (fieldIndex < 0 || buttonIndex < 0) throw new Error(`expected both controls in elements, got: ${JSON.stringify(elements)}`);

  const fieldClick = await call(page, 'click', { index: fieldIndex });
  if (!fieldClick?.success) throw new Error(`expected field click success, got: ${JSON.stringify(fieldClick)}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected field type success, got: ${JSON.stringify(typed)}`);

  const buttonClick = await call(page, 'click', { index: buttonIndex });
  if (!buttonClick?.success) throw new Error(`expected button input click success, got: ${JSON.stringify(buttonClick)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'button-input') throw new Error(`expected button input focus, got: ${activeId}`);

  const rejected = await call(page, 'type', { text: ' Lovelace' });
  if (rejected?.success) throw new Error(`expected non-text input type failure, got: ${JSON.stringify(rejected)}`);
  if (!/Focused element <input> is not an editable field/.test(rejected?.error || '')) {
    throw new Error(`expected focused input error, got: ${JSON.stringify(rejected)}`);
  }

  const values = await page.evaluate(() => ({
    field: document.getElementById('field').value,
    button: document.getElementById('button-input').value,
    clicked: window.__buttonInputClicked === true,
  }));
  if (values.field !== 'Ada' || values.button !== 'Open' || !values.clicked) {
    throw new Error(`expected no stale/non-text value mutation, got: ${JSON.stringify(values)}`);
  }
});

test('Firefox: type_text rejects disabled indexed text input fallback', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #disabled-field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
    </style>
    <input id="disabled-field" value="Locked" disabled>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const disabledIndex = elements.findIndex(e => e.id === 'disabled-field');
  if (disabledIndex < 0) throw new Error(`expected disabled field in elements, got: ${JSON.stringify(elements)}`);

  const click = await call(page, 'click', { index: disabledIndex });
  if (!click?.success) throw new Error(`expected disabled field click path to complete, got: ${JSON.stringify(click)}`);

  const activeTag = await page.evaluate(() => document.activeElement?.tagName || '');
  if (activeTag === 'INPUT') throw new Error('disabled input should not receive focus');

  const rejected = await call(page, 'type', { text: ' hacked' });
  if (rejected?.success) throw new Error(`expected disabled input type failure, got: ${JSON.stringify(rejected)}`);

  const value = await page.evaluate(() => document.getElementById('disabled-field').value);
  if (value !== 'Locked') throw new Error(`expected disabled value to remain unchanged, got: ${value}`);
});

// ─── main ─────────────────────────────────────────────────────────────────
// Social media downloader focus safety
test('SMD: Instagram auto mode downloads the open dialog image, not the feed', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/natgeo/', `<!doctype html>
    <style>
      body { margin: 0; }
      main { display: grid; grid-template-columns: repeat(3, 220px); gap: 12px; }
      main img { width: 220px; height: 220px; object-fit: cover; }
      [role="dialog"] { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.8); }
      [role="dialog"] img { width: 640px; height: 640px; object-fit: contain; }
    </style>
    <main>
      <article>
        ${Array.from({ length: 9 }, (_, i) =>
          `<img width="220" height="220" src="https://cdninstagram.com/feed-${i}.jpg">`
        ).join('')}
      </article>
    </main>
    <div role="dialog" aria-modal="true">
      <img width="640" height="640" src="https://cdninstagram.com/open-dialog-current.jpg">
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'instagram') throw new Error(`expected instagram profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/open-dialog-current\.jpg/.test(auto.urls[0])) {
    throw new Error(`expected dialog image, got ${auto.urls[0]}`);
  }

  const all = await collectSmd(page, 'all');
  if (all.urls.length <= 1) throw new Error(`explicit all mode should still expose bulk media, got ${all.urls.length}`);
});

test('SMD: Instagram focused video keeps blob URL ahead of poster image', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/reel/abc123/', `<!doctype html>
    <style>
      body { margin: 0; }
      main img { width: 220px; height: 220px; display: block; }
      [role="dialog"] { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.85); }
      video { width: 540px; height: 720px; background: #000; }
    </style>
    <main>
      <img width="220" height="220" src="https://cdninstagram.com/feed-still.jpg">
    </main>
    <div role="dialog" aria-modal="true">
      <video width="540" height="720"
        src="blob:https://www.instagram.com/focused-reel-video"
        poster="https://cdninstagram.com/focused-reel-poster.jpg"></video>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'instagram') throw new Error(`expected instagram profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!auto.urls[0].startsWith('blob:https://www.instagram.com/focused-reel-video')) {
    throw new Error(`expected focused blob video before poster, got ${auto.urls[0]}`);
  }
});

test('SMD: main mode orders focused video before poster when caller limits to one', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/p/video123/', `<!doctype html>
    <style>
      body { margin: 0; }
      main article video { width: 640px; height: 640px; background: #000; }
    </style>
    <main>
      <article>
        <video width="640" height="640"
          src="blob:https://www.instagram.com/main-post-video"
          poster="https://cdninstagram.com/main-post-poster.jpg"></video>
      </article>
    </main>`);

  const main = await collectSmd(page, 'main');
  if (main.profile !== 'instagram') throw new Error(`expected instagram profile, got ${main.profile}`);
  if (main.mode !== 'main') throw new Error(`expected main mode, got ${main.mode}`);
  if (!main.urls.length) throw new Error('expected main-mode URLs');
  if (!main.urls[0].startsWith('blob:https://www.instagram.com/main-post-video')) {
    throw new Error(`expected main-mode video before poster, got ${main.urls[0]}`);
  }
});

test('SMD: YouTube focused video prefers signed HTTP video over blob and poster', async (page) => {
  await setupSmd(page, 'https://www.youtube.com/watch?v=abc123', `<!doctype html>
    <script>
      window.ytInitialPlayerResponse = {
        streamingData: {
          formats: [
            { url: 'https://rr1---sn.googlevideo.com/videoplayback?expire=999&mime=video%2Fmp4&itag=18' }
          ]
        }
      };
    </script>
    <style>
      body { margin: 0; }
      #movie_player { width: 960px; height: 540px; }
      #movie_player video { width: 960px; height: 540px; background: #000; }
    </style>
    <div id="movie_player">
      <video width="960" height="540"
        src="blob:https://www.youtube.com/focused-player-video"
        poster="https://i.ytimg.com/vi/abc123/hqdefault.jpg"></video>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'youtube') throw new Error(`expected youtube profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/googlevideo\.com\/videoplayback/.test(auto.urls[0])) {
    throw new Error(`expected signed HTTP video before blob/poster, got ${auto.urls[0]}`);
  }
});

test('SMD: X photo modal wins over background timeline media', async (page) => {
  await setupSmd(page, 'https://x.com/NASA/status/123/photo/1', `<!doctype html>
    <style>
      body { margin: 0; }
      main article img { width: 300px; height: 300px; display: block; margin: 16px; }
      [aria-modal="true"] { position: fixed; inset: 0; display: grid; place-items: center; background: #000; }
      [aria-modal="true"] img { width: 720px; height: 480px; object-fit: contain; }
    </style>
    <main>
      <article data-testid="tweet">
        <div data-testid="tweetPhoto"><img width="300" height="300" src="https://pbs.twimg.com/media/background-one.jpg?name=small"></div>
        <div data-testid="tweetPhoto"><img width="300" height="300" src="https://pbs.twimg.com/media/background-two.jpg?name=small"></div>
      </article>
    </main>
    <div aria-modal="true" role="dialog">
      <div data-testid="tweetPhoto">
        <img width="720" height="480" src="https://pbs.twimg.com/media/current-photo.jpg?name=small">
      </div>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'twitter') throw new Error(`expected twitter profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/current-photo\.jpg\?name=orig/.test(auto.urls[0])) {
    throw new Error(`expected upgraded modal photo URL, got ${auto.urls[0]}`);
  }
});

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  let passed = 0, failed = 0;
  for (const t of tests) {
    const page = await context.newPage();
    try {
      await t.fn(page);
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${t.name}\n    ${e.message}`);
      failed++;
    } finally {
      await page.close();
    }
  }
  await browser.close();
  console.log(`\n  ${passed} passed, ${failed} failed (${tests.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
})();
