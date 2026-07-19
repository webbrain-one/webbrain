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
import { Agent } from '../../src/chrome/src/agent/agent.js';
import { CDPClient, cdpClient } from '../../src/chrome/src/cdp/cdp-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const accessibilityTreeJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'accessibility-tree.js');
const firefoxAccessibilityTreeJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'accessibility-tree.js');
const contentJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'content.js');
const firefoxContentJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'content.js');
const selectionShortcutJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'selection-shortcut.js');
const firefoxSelectionShortcutJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'selection-shortcut.js');
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

async function setupContentFixture(page, fixture, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.addInitScript(firefox ? stubFirefoxBrowser : stubChrome);
  await page.goto(fixtureUrl(fixture));
  const axSrc = await readFile(firefox ? firefoxAccessibilityTreeJsPath : accessibilityTreeJsPath, 'utf-8');
  await page.addScriptTag({ content: axSrc });
  const contentSrc = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  await page.addScriptTag({ content: contentSrc });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupFirefoxHtml(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: stubFirefoxBrowser });
  const src = await readFile(firefoxContentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupAccessibilityTreeHtml(page, html, sourcePath) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__generateAccessibilityTree === 'function');
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

async function readThroughCdpMirror(page, opts = {}) {
  const client = new CDPClient();
  client.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });
  return client.readPage(1, opts);
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

async function setupSelectionShortcut(page, sourcePath, { enabled = true, requiresManualOpen = false, locale = 'en' } = {}) {
  await page.setViewportSize({ width: 360, height: 280 });
  await page.setContent(`<!doctype html>
    <style>body{margin:0;font:18px/1.5 sans-serif} #copy{position:absolute;right:2px;bottom:2px;width:210px}</style>
    <p id="copy">Selected words near the viewport edge for WebBrain.</p>
    <div id="editor" contenteditable="true">Editable selection text.</div>`);
  await page.addScriptTag({ content: `
    window.__selectionMessages = [];
    window.__selectionStorage = { selectionShortcutEnabled: ${enabled ? 'true' : 'false'}, wbLocale: '${locale}' };
    window.__selectionRuntimeListeners = [];
    window.__selectionStorageListeners = [];
    window.chrome = {
      runtime: {
        sendMessage: async (message) => {
          window.__selectionMessages.push(message);
          return { ok: true, queued: true, requiresManualOpen: ${requiresManualOpen ? 'true' : 'false'} };
        },
        onMessage: { addListener: (listener) => window.__selectionRuntimeListeners.push(listener) }
      },
      storage: {
        local: {
          get: async (defaults) => ({ ...defaults, ...window.__selectionStorage }),
          set: async (update) => {
            const changes = {};
            for (const [key, value] of Object.entries(update)) {
              changes[key] = { oldValue: window.__selectionStorage[key], newValue: value };
              window.__selectionStorage[key] = value;
            }
            window.__selectionStorageListeners.forEach((listener) => listener(changes, 'local'));
          }
        },
        onChanged: { addListener: (listener) => window.__selectionStorageListeners.push(listener) }
      }
    };
    window.__setSelectionShortcutEnabled = async (value) => {
      await window.chrome.storage.local.set({ selectionShortcutEnabled: value });
    };
    window.__setSelectionShortcutLocale = async (value) => {
      await window.chrome.storage.local.set({ wbLocale: value });
    };
    window.__sendSelectionRuntimeMessage = (message) => {
      window.__selectionRuntimeListeners.forEach((listener) => listener(message, {}, () => {}));
    };
  ` });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__webbrainSelectionShortcut?.getState === 'function');
}

async function selectFixtureText(page, selector = '#copy') {
  await page.evaluate(async (targetSelector) => {
    const target = document.querySelector(targetSelector);
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, selector);
  await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().shortcutVisible);
  await page.waitForTimeout(20);
  return page.evaluate(() => window.__webbrainSelectionShortcut.getState());
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

for (const [label, browserKind] of [['Chrome', 'chrome'], ['Firefox', 'firefox']]) {
  test(`${label}: blocking NYTimes registration dialog suppresses article DOM`, async (page) => {
    await setupContentFixture(page, 'nyt-registration-gate.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.blocking !== true || result.pageGate?.surface !== 'dialog' || result.pageGate?.type !== 'registration') {
      throw new Error(`registration pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    const serializedResult = JSON.stringify(result);
    if (result.textSource !== 'page-gate' || /SECRET_NYT_(?:ARTICLE|LINK|IMAGE|FORM|SHADOW)/.test(serializedResult)) {
      throw new Error(`blocked article data leaked: ${serializedResult}`);
    }
    if (result.links?.length || result.forms?.length || result.shadowDOM?.length || result.iframes?.length || result.media?.imageCount || result.media?.videoCount) {
      throw new Error(`blocking gate retained auxiliary page data: ${serializedResult}`);
    }
    if (JSON.stringify(result).indexOf('"pageGate"') > JSON.stringify(result).indexOf('"text"')) {
      throw new Error('pageGate must serialize before long article text for trace visibility');
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (tree.pageGate?.blocking !== true || !/Create a free account/i.test(tree.pageGate.label || '')) {
      throw new Error(`accessibility tree omitted structured pageGate: ${JSON.stringify(tree.pageGate)}`);
    }
    if (tree.textSource !== 'page-gate' || /SECRET_NYT_ARTICLE_BODY/.test(tree.pageContent || '')) {
      throw new Error(`accessibility tree leaked blocked article text: ${JSON.stringify(tree)}`);
    }
    const gateButtonRef = /button "Continue" \[(ref_\d+)\]/.exec(tree.pageContent || '')?.[1];
    const gateEmailRef = /textbox "Email" \[(ref_\d+)\]/.exec(tree.pageContent || '')?.[1];
    if (!gateButtonRef || !gateEmailRef) {
      throw new Error(`accessibility tree omitted visible gate controls: ${JSON.stringify(tree)}`);
    }
    const clickResult = await call(page, 'click_ax', { ref_id: gateButtonRef });
    const gateControlClicked = await page.evaluate(() => window.__gateControlClicked === true);
    if (clickResult?.success !== true || !gateControlClicked) {
      throw new Error(`gate control ref was not actionable: ${JSON.stringify(clickResult)}`);
    }
    const basicResult = await call(page, 'get_page_info', {});
    if (/SECRET_NYT_(?:ARTICLE|LINK|IMAGE|FORM|SHADOW)/.test(JSON.stringify(basicResult))) {
      throw new Error(`basic page info leaked blocked article data: ${JSON.stringify(basicResult)}`);
    }
  });

  test(`${label}: The Athletic covering subscription overlay suppresses server-rendered body`, async (page) => {
    await setupContentFixture(page, 'athletic-subscription-overlay.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog') {
      throw new Error(`Athletic pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (/SECRET_ATHLETIC_(?:ARTICLE|LINK|FORM)/.test(JSON.stringify(result)) || result.textSource !== 'page-gate') {
      throw new Error(`Athletic article data leaked: ${JSON.stringify(result)}`);
    }
  });

  test(`${label}: inline article gate returns only the visible preview`, async (page) => {
    await setupContentFixture(page, 'inline-article-paywall.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.blocking !== true || result.pageGate?.surface !== 'inline') {
      throw new Error(`inline pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (!/VISIBLE_PREVIEW_PARAGRAPH/.test(result.text || '') || /SECRET_POST_GATE_PARAGRAPH/.test(result.text || '')) {
      throw new Error(`inline preview boundary mismatch: ${JSON.stringify(result.text)}`);
    }
    if (!/\(pre-gate\)$/.test(result.textSource || '')) {
      throw new Error(`inline textSource missing pre-gate marker: ${result.textSource}`);
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (!/VISIBLE_PREVIEW_PARAGRAPH/.test(tree.pageContent || '') || /SECRET_POST_GATE_PARAGRAPH/.test(tree.pageContent || '')) {
      throw new Error(`inline accessibility boundary mismatch: ${JSON.stringify(tree)}`);
    }
  });

  test(`${label}: readable article ignores header controls, inline upsells, and hidden gate markup`, async (page) => {
    await setupContentFixture(page, 'readable-article-no-gate.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate) throw new Error(`false-positive pageGate: ${JSON.stringify(result.pageGate)}`);
    if (!/READABLE_ARTICLE_BODY/.test(result.text || '') || !/READABLE_ARTICLE_AFTER_UPSELL/.test(result.text || '') || result.textSource === 'page-gate') {
      throw new Error(`readable article body missing: ${JSON.stringify({ textSource: result.textSource, text: result.text })}`);
    }
  });

  test(`${label}: non-article signup dialog preserves form controls`, async (page) => {
    await setupContentFixture(page, 'non-article-signup-dialog.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate) throw new Error(`non-article dialog became a page gate: ${JSON.stringify(result.pageGate)}`);
    if (result.forms?.length !== 1 || result.forms[0]?.inputs?.[0]?.name !== 'email') {
      throw new Error(`signup form was stripped from page info: ${JSON.stringify(result.forms)}`);
    }
    const basicResult = await call(page, 'get_page_info', {});
    if (basicResult.pageGate || basicResult.forms?.length !== 1) {
      throw new Error(`basic page info stripped the signup form: ${JSON.stringify(basicResult)}`);
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 6 });
    if (tree.pageGate || !/Work email/.test(tree.pageContent || '')) {
      throw new Error(`signup accessibility tree was stripped: ${JSON.stringify(tree)}`);
    }
  });
}

test('Chrome CDP mirror suppresses a blocking Athletic article body', async (page) => {
  await page.goto(fixtureUrl('athletic-subscription-overlay.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog') {
    throw new Error(`CDP pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
  }
  if (result.textSource !== 'page-gate' || /SECRET_ATHLETIC_(?:ARTICLE|LINK|FORM)/.test(JSON.stringify(result))) {
    throw new Error(`CDP mirror leaked blocked article data: ${JSON.stringify(result)}`);
  }
  if (result.links?.length || result.forms?.length || result.shadowHosts?.length || result.iframes?.length) {
    throw new Error(`CDP blocking gate retained auxiliary page data: ${JSON.stringify(result)}`);
  }
});

test('Chrome CDP mirror preserves a readable article across an inline upsell', async (page) => {
  await page.goto(fixtureUrl('readable-article-no-gate.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate || !/READABLE_ARTICLE_BODY/.test(result.text || '') || !/READABLE_ARTICLE_AFTER_UPSELL/.test(result.text || '')) {
    throw new Error(`CDP readable article mismatch: ${JSON.stringify({ pageGate: result.pageGate, text: result.text })}`);
  }
});

test('Chrome CDP mirror preserves a non-article signup dialog', async (page) => {
  await page.goto(fixtureUrl('non-article-signup-dialog.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate || result.forms?.length !== 1 || result.forms[0]?.inputs?.[0]?.name !== 'email') {
    throw new Error(`CDP non-article signup mismatch: ${JSON.stringify(result)}`);
  }
});

for (const [label, sourcePath, manualOpen] of [
  ['Chrome', selectionShortcutJsPath, false],
  ['Firefox', firefoxSelectionShortcutJsPath, true],
]) {
  test(`${label}: selection shortcut clamps to the viewport and supports keyboard dismissal`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const state = await selectFixtureText(page);
    const rect = state.shortcutRect;
    if (!rect || rect.left < 8 || rect.top < 8 || rect.right > 352 || rect.bottom > 272) {
      throw new Error(`shortcut was not clamped to the viewport: ${JSON.stringify(rect)}`);
    }
    await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
    let popupState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!popupState.popupVisible) throw new Error('popup did not open for the selected text');
    await page.keyboard.press('Escape');
    popupState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (popupState.popupVisible || !popupState.shortcutVisible) {
      throw new Error(`Escape should close the popup and retain the shortcut: ${JSON.stringify(popupState)}`);
    }
  });

  test(`${label}: selection dialog contains page shortcuts and keeps the selected text highlighted`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionPageKeys = [];
      window.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`window-capture:${event.key}`), true);
      document.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`document-capture:${event.key}`), true);
      document.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`down:${event.key}`));
      document.addEventListener('keypress', (event) => window.__selectionPageKeys.push(`press:${event.key}`));
      document.addEventListener('keyup', (event) => window.__selectionPageKeys.push(`up:${event.key}`));
    });
    const selectedState = await selectFixtureText(page);
    await page.mouse.click(
      selectedState.shortcutRect.left + selectedState.shortcutRect.width / 2,
      selectedState.shortcutRect.top + selectedState.shortcutRect.height / 2,
    );
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!openState.questionRect || openState.highlightRectCount < 1) {
      throw new Error(`popup should preserve a visual marker for the selected text: ${JSON.stringify(openState)}`);
    }
    await page.mouse.click(
      openState.questionRect.left + openState.questionRect.width / 2,
      openState.questionRect.top + openState.questionRect.height / 2,
    );
    await page.keyboard.type('j');
    const typedState = await page.evaluate(() => ({
      surface: window.__webbrainSelectionShortcut.getState(),
      pageKeys: window.__selectionPageKeys,
    }));
    if (typedState.surface.questionValue !== 'j' || typedState.surface.highlightRectCount < 1) {
      throw new Error(`typing should keep the custom question and sticky highlight: ${JSON.stringify(typedState)}`);
    }
    if (typedState.pageKeys.length) {
      throw new Error(`dialog keystrokes leaked to the page: ${JSON.stringify(typedState.pageKeys)}`);
    }
    await page.keyboard.press('Escape');
    const closedState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (closedState.popupVisible || closedState.highlightRectCount !== 0) {
      throw new Error(`closing the popup should remove the sticky highlight: ${JSON.stringify(closedState)}`);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().popupVisible);
    const reopenedState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    await page.mouse.click(
      reopenedState.questionRect.left + reopenedState.questionRect.width / 2,
      reopenedState.questionRect.top + reopenedState.questionRect.height / 2,
    );
    await page.keyboard.type('What is the point?');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const submittedState = await page.evaluate(() => ({
      message: window.__selectionMessages[0],
      surface: window.__webbrainSelectionShortcut.getState(),
      pageKeys: window.__selectionPageKeys,
    }));
    if (submittedState.message.action !== 'custom' || submittedState.message.question !== 'What is the point?') {
      throw new Error(`capture-phase containment broke keyboard submission: ${JSON.stringify(submittedState)}`);
    }
    if (submittedState.surface.popupVisible || submittedState.surface.highlightRectCount !== 0) {
      throw new Error(`keyboard submission should dismiss the surface and highlight: ${JSON.stringify(submittedState)}`);
    }
    if (submittedState.pageKeys.length) {
      throw new Error(`capture-phase dialog keystrokes leaked to the page: ${JSON.stringify(submittedState.pageKeys)}`);
    }
  });

  test(`${label}: selection highlight stays bounded for long documents`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const rawRectCount = await page.evaluate(() => {
      const article = document.createElement('article');
      article.id = 'long-selection';
      for (let index = 0; index < 600; index += 1) {
        const line = document.createElement('div');
        line.textContent = `Selected article line ${index + 1}`;
        article.appendChild(line);
      }
      document.body.appendChild(article);
      const range = document.createRange();
      range.selectNodeContents(article);
      return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).length;
    });
    if (rawRectCount <= 200) throw new Error(`fixture should create more than 200 selection rectangles, got ${rawRectCount}`);

    const selectedState = await selectFixtureText(page, '#long-selection');
    await page.mouse.click(
      selectedState.shortcutRect.left + selectedState.shortcutRect.width / 2,
      selectedState.shortcutRect.top + selectedState.shortcutRect.height / 2,
    );
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (openState.highlightRectCount < 1 || openState.highlightRectCount > 200) {
      throw new Error(`long selections should render 1-200 highlight rectangles: ${JSON.stringify(openState)}`);
    }
    if (openState.highlightRectCount >= rawRectCount) {
      throw new Error(`offscreen selection rectangles should not all render: ${JSON.stringify({ rawRectCount, openState })}`);
    }
  });

  test(`${label}: selection shortcut submits once and dismisses before delivery`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const selectedState = await selectFixtureText(page, '#editor');
    const shortcutRect = selectedState.shortcutRect;
    await page.mouse.click(shortcutRect.left + shortcutRect.width / 2, shortcutRect.top + shortcutRect.height / 2);
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const summarizeRect = openState.summarizeRect;
    if (!summarizeRect) throw new Error('Summarize action was not visible after opening the popup');
    await page.mouse.click(summarizeRect.left + summarizeRect.width / 2, summarizeRect.top + summarizeRect.height / 2);
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
    const result = await page.evaluate(() => ({
      messages: window.__selectionMessages,
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (result.messages.length !== 1) throw new Error(`expected exactly one submission, got ${result.messages.length}`);
    if (result.messages[0].action !== 'summarize' || !/Editable selection text/.test(result.messages[0].selectionText)) {
      throw new Error(`unexpected selection request: ${JSON.stringify(result.messages[0])}`);
    }
    if (result.state.shortcutVisible || result.state.popupVisible) {
      throw new Error(`surface should dismiss before delivery: ${JSON.stringify(result.state)}`);
    }

    await selectFixtureText(page);
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitCustom('   '));
    let messages = await page.evaluate(() => window.__selectionMessages.length);
    if (messages !== 1) throw new Error('blank custom questions should not submit');
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitCustom('What is the point?'));
    messages = await page.evaluate(() => window.__selectionMessages);
    if (messages.length !== 2 || messages[1].action !== 'custom' || messages[1].question !== 'What is the point?') {
      throw new Error(`custom question was not submitted correctly: ${JSON.stringify(messages)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('tr'));
    const translationSelection = await selectFixtureText(page);
    const translationShortcutRect = translationSelection.shortcutRect;
    await page.mouse.click(
      translationShortcutRect.left + translationShortcutRect.width / 2,
      translationShortcutRect.top + translationShortcutRect.height / 2,
    );
    const translateState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const translateRect = translateState.translateRect;
    if (!translateRect) throw new Error('Translate action was not visible in the popup');
    await page.mouse.click(translateRect.left + translateRect.width / 2, translateRect.top + translateRect.height / 2);
    await page.waitForFunction(() => window.__selectionMessages.length === 3);
    const translated = await page.evaluate(() => ({
      message: window.__selectionMessages[2],
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (translated.message.action !== 'translate' || translated.message.language !== 'tr') {
      throw new Error(`translation request was not submitted correctly: ${JSON.stringify(translated.message)}`);
    }
    if (translated.state.popupVisible || translated.state.shortcutVisible) {
      throw new Error(`Translate should submit directly and dismiss the surface: ${JSON.stringify(translated.state)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('fr'));
    const updatedLocaleSelection = await selectFixtureText(page);
    const updatedLocaleShortcutRect = updatedLocaleSelection.shortcutRect;
    await page.mouse.click(
      updatedLocaleShortcutRect.left + updatedLocaleShortcutRect.width / 2,
      updatedLocaleShortcutRect.top + updatedLocaleShortcutRect.height / 2,
    );
    const updatedLocaleState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    await page.mouse.click(
      updatedLocaleState.translateRect.left + updatedLocaleState.translateRect.width / 2,
      updatedLocaleState.translateRect.top + updatedLocaleState.translateRect.height / 2,
    );
    await page.waitForFunction(() => window.__selectionMessages.length === 4);
    const updatedLocaleMessage = await page.evaluate(() => window.__selectionMessages[3]);
    if (updatedLocaleMessage.action !== 'translate' || updatedLocaleMessage.language !== 'fr') {
      throw new Error(`Translate did not follow the updated plugin locale: ${JSON.stringify(updatedLocaleMessage)}`);
    }
  });

  test(`${label}: selection shortcut persists hiding and suppresses screenshot-time UI`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await selectFixtureText(page);
    if (manualOpen) {
      await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
      const toastState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
      if (!toastState.toastVisible) throw new Error(`manual-open guidance toast was not visible: ${JSON.stringify(toastState)}`);
    }
    await page.evaluate(() => window.__sendSelectionRuntimeMessage({ type: 'WB_HIDE_FOR_TOOL_USE' }));
    let state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!state.suppressed || state.shortcutVisible || state.toastVisible) {
      throw new Error(`tool-use hide should suppress the complete surface: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => window.__sendSelectionRuntimeMessage({ type: 'WB_SHOW_AFTER_TOOL_USE' }));
    await selectFixtureText(page);
    await page.evaluate(() => window.__webbrainSelectionShortcut.hideShortcut());
    let stored = await page.evaluate(() => window.__selectionStorage.selectionShortcutEnabled);
    if (stored !== false) throw new Error('Hide selection shortcut did not persist false');

    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.waitForTimeout(20);
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (state.shortcutVisible) throw new Error('disabled shortcut reappeared after selection');

    await page.evaluate(() => window.__setSelectionShortcutEnabled(true));
    state = await selectFixtureText(page);
    stored = await page.evaluate(() => window.__selectionStorage.selectionShortcutEnabled);
    if (stored !== true || !state.shortcutVisible) throw new Error('settings re-enable did not restore future shortcut detection');
  });
}

const gmailComposeRecipientFixture = `<!doctype html>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    [role="dialog"] { width: 620px; min-height: 360px; padding: 16px; }
    .recipient { width: 500px; height: 40px; }
    .field { display: block; width: 500px; height: 32px; margin-top: 8px; }
    .body { width: 500px; height: 160px; margin-top: 8px; }
    .hidden-to { position: absolute; width: 0; height: 0; opacity: 0; }
    .hidden-wrapper { display: none; }
  </style>
  <div role="dialog" aria-label="Compose: New Message">
    <div role="region" aria-label="New Message">
      <input class="hidden-to" role="combobox" aria-label="To recipients">
      <div class="recipient" tabindex="1">
        <span>Alex Russell (gmail.com)</span>
        <span style="display:none">Hidden stale recipient</span>
        <span style="opacity:0">Opacity hidden override</span>
        <span style="position:absolute;left:-10000px;width:200px">Offscreen hidden override</span>
        <span aria-hidden="true">ARIA hidden override</span>
      </div>
      <input class="field" aria-label="Subject" placeholder="Subject">
      <div class="body" role="textbox" contenteditable="true" aria-label="Message Body"></div>
      <div class="composite" tabindex="0"><span>Composite controls</span><button>Remove</button></div>
      <div class="hidden-wrapper" tabindex="0"><span>Hidden wrapper text</span></div>
      <div class="empty" tabindex="0"><span></span></div>
      <div class="overlong" tabindex="0"><span>${'x'.repeat(101)}</span></div>
    </div>
  </div>`;

let chromeGmailComposeTree = '';

function assertGmailComposeRecipientTree(tree, label) {
  const content = String(tree?.pageContent || '');
  if (!/generic "Alex Russell \(gmail\.com\)" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: selected recipient label missing from visible tree: ${content}`);
  }
  if (!/textbox "Subject" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: Subject missing from visible tree: ${content}`);
  }
  if (!/textbox "Message Body" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: Message Body missing from visible tree: ${content}`);
  }
  for (const forbidden of ['To recipients', 'Hidden stale recipient', 'Opacity hidden override', 'Offscreen hidden override', 'ARIA hidden override', 'Hidden wrapper text', 'generic "Composite controls', 'x'.repeat(101)]) {
    if (content.includes(forbidden)) throw new Error(`${label}: tree promoted forbidden generic text: ${forbidden}`);
  }
  return content;
}

test('accessibility tree (Chrome): existing Gmail compose exposes the selected recipient chip', async (page) => {
  await setupAccessibilityTreeHtml(page, gmailComposeRecipientFixture, accessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('visible', 10, null, null, 1));
  chromeGmailComposeTree = assertGmailComposeRecipientTree(tree, 'chrome');
});

test('accessibility tree (Firefox): existing Gmail compose exposes the selected recipient chip with parity', async (page) => {
  await setupAccessibilityTreeHtml(page, gmailComposeRecipientFixture, firefoxAccessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('visible', 10, null, null, 1));
  const firefoxTree = assertGmailComposeRecipientTree(tree, 'firefox');
  if (firefoxTree !== chromeGmailComposeTree) throw new Error('Chrome/Firefox Gmail compose trees differ');
});

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
  if (resp?.dispatched !== false) throw new Error(`no-match must report dispatched:false, got: ${JSON.stringify(resp)}`);
  if (!/scoped to the open modal/i.test(resp?.error || '')) {
    throw new Error(`expected modal-scope note in error, got: ${resp?.error}`);
  }
});

// ─── occlusion ────────────────────────────────────────────────────────────
test('occlusion: click({text:"Submit"}) refuses when covered', async (page) => {
  await setup(page, 'occlusion.html');
  const resp = await call(page, 'click', { text: 'Submit' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (resp?.dispatched !== false) throw new Error(`occluded preflight must report dispatched:false, got: ${JSON.stringify(resp)}`);
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
  if (resp?.dispatched !== false) throw new Error(`ambiguity must report dispatched:false, got: ${JSON.stringify(resp)}`);
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
for (const browserKind of ['chrome', 'firefox']) {
  test(`click_ax (${browserKind}): stale refs are explicit pre-dispatch failures`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const result = await call(page, 'click_ax', { ref_id: 'ref_999999' });
    if (
      result?.success !== false
      || result?.dispatched !== false
      || result?.noDispatch !== true
      || result?.fallbackAttempted !== false
    ) {
      throw new Error(`expected explicit pre-dispatch markers, got: ${JSON.stringify(result)}`);
    }
    if (!/not found/i.test(result.error || '')) {
      throw new Error(`expected stale-ref error, got: ${JSON.stringify(result)}`);
    }
  });

  test(`input tools (${browserKind}): invalid targets and keys are explicit pre-dispatch failures`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const calls = [
      ['type', { text: 'should not be typed' }],
      ['type_ax', { ref_id: 'ref_999999', text: 'should not be typed' }],
      ['set_field', { ref_id: 'ref_999999', text: 'should not be typed' }],
      ['press_keys', { key: 'F5' }],
    ];
    for (const [action, params] of calls) {
      const result = await call(page, action, params);
      if (
        result?.success !== false
        || result?.dispatched !== false
        || result?.noDispatch !== true
      ) {
        throw new Error(`${action} should be an explicit pre-dispatch failure, got: ${JSON.stringify(result)}`);
      }
    }
  });
}

for (const browserKind of ['chrome', 'firefox']) {
  test(`click_ax (${browserKind}): aria-labelledby action returns bounded nearest card context`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/button "Add to cart" \[(ref_\d+)\]/);
    if (!match) throw new Error(`could not find product action in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (!result?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(result)}`);
    if (
      result.name !== 'Add to cart'
      || result.targetContext?.heading !== 'Cola Zero 6-pack'
      || !String(result.targetContext?.text || '').includes('Cola Zero 6-pack')
      || !String(result.targetContext?.href || '').endsWith('/products/cola-zero-six-pack')
    ) {
      throw new Error(`nearest product context missing or wrong: ${JSON.stringify(result)}`);
    }
    if (
      String(result.targetContext.text).length > 600
      || String(result.targetContext.heading).length > 160
      || String(result.targetContext.href).length > 500
    ) {
      throw new Error(`product context bounds regressed: ${JSON.stringify(result.targetContext)}`);
    }
  });
}

test('click_ax: Agent.executeTool keeps synthetic-first behavior and uses trusted CDP only for an ignored generic row', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const trustedMatch = String(tree?.pageContent || '').match(/listitem "Defne Sokullu Yesterday Photo" \[(ref_\d+)\]/);
  const syntheticMatch = String(tree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
  const disclosureMatch = String(tree?.pageContent || '').match(/"Native disclosure" \[(ref_\d+)\]/);
  if (!trustedMatch || !syntheticMatch || !disclosureMatch) {
    throw new Error(`expected trusted, synthetic, and disclosure fixture rows in AX tree: ${tree?.pageContent}`);
  }

  const originalChrome = globalThis.chrome;
  const originals = {
    attach: cdpClient.attach,
    evaluate: cdpClient.evaluate,
    dispatch: cdpClient.dispatchMouseEvent,
  };
  const session = await page.context().newCDPSession(page);
  const dispatched = [];
  const listener = { addListener() {}, removeListener() {} };
  globalThis.chrome = {
    runtime: {},
    tabs: {
      async get(tabId) {
        return { id: tabId, url: page.url(), title: 'Trusted click fixture' };
      },
      async query() {
        return [{ id: 42, url: page.url() }];
      },
      async sendMessage(_tabId, message) {
        return call(page, message.action, message.params || {});
      },
    },
    downloads: { onCreated: listener },
    webRequest: { onBeforeRequest: listener },
    scripting: { async executeScript() {} },
  };

  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.evaluate = async (_tabId, expression) => ({
      result: { value: await page.evaluate(expression) },
    });
    cdpClient.dispatchMouseEvent = async (_tabId, type, x, y) => {
      dispatched.push({ type, x, y });
      return session.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    };

    const agent = new Agent({});
    agent._isPdfTab = async () => false;
    agent._currentUrl = async () => page.url();
    agent._clickAxFinalSettleMs = () => 60;

    const trustedResult = await agent.executeTool(42, 'click_ax', { ref_id: trustedMatch[1] });
    const afterTrusted = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      ambientStatus: document.getElementById('ambient-status').textContent,
      events: window.__trustedClickEvents,
      selected: document.getElementById('trusted-row').classList.contains('trusted-opened'),
      semanticSelected: document.getElementById('trusted-row').getAttribute('aria-current'),
    }));
    if (
      trustedResult?.success !== true
      || trustedResult.fallback !== 'cdp_after_synthetic_no_progress'
      || trustedResult.trusted !== true
      || trustedResult.verified !== true
    ) {
      throw new Error(`actual Agent/content/CDP chain did not complete trusted fallback: ${JSON.stringify(trustedResult)}`);
    }
    if (
      !trustedResult.observedHints?.includes('page_text')
      || !trustedResult.observedHints?.includes('target_state_weak')
    ) {
      throw new Error(`unrelated page/target churn should be retained only as diagnostic hints: ${JSON.stringify(trustedResult)}`);
    }
    if (
      afterTrusted.status !== 'trusted-opened'
      || afterTrusted.ambientStatus !== 'unrelated-chat-churn'
      || !afterTrusted.selected
      || afterTrusted.semanticSelected !== 'true'
    ) {
      throw new Error(`trusted CDP fallback did not activate the row: ${JSON.stringify(afterTrusted)}`);
    }
    if (
      afterTrusted.events.length !== 2
      || afterTrusted.events[0].trusted !== false
      || afterTrusted.events[1].trusted !== true
    ) {
      throw new Error(`expected one synthetic then one trusted event: ${JSON.stringify(afterTrusted.events)}`);
    }
    if (dispatched.map(event => event.type).join(',') !== 'mouseMoved,mousePressed,mouseReleased') {
      throw new Error(`unexpected trusted input sequence: ${JSON.stringify(dispatched)}`);
    }
    if (Object.keys(trustedResult).some(key => key.startsWith('_fallback') || key === '_syntheticClickStartedAt')) {
      throw new Error(`internal click state leaked into the agent result: ${JSON.stringify(trustedResult)}`);
    }

    await page.evaluate(() => { document.getElementById('status').textContent = 'idle'; });
    const dispatchCountBeforeNormal = dispatched.length;
    const normalResult = await agent.executeTool(42, 'click_ax', { ref_id: syntheticMatch[1] });
    const normalState = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      events: window.__syntheticClickEvents,
      selected: document.getElementById('synthetic-row').classList.contains('synthetic-opened'),
    }));
    if (
      normalResult?.success !== true
      || normalResult.trusted !== false
      || normalResult.verified !== true
      || normalResult.observedEffects?.[0] !== 'target_state'
    ) {
      throw new Error(`working synthetic target was not accepted from its local state change: ${JSON.stringify(normalResult)}`);
    }
    if (
      normalState.status !== 'synthetic-opened'
      || !normalState.selected
      || normalState.events.length !== 1
      || normalState.events[0].trusted !== false
    ) {
      throw new Error(`working synthetic click path regressed or double-activated: ${JSON.stringify(normalState)}`);
    }
    if (dispatched.length !== dispatchCountBeforeNormal) {
      throw new Error('working synthetic target unexpectedly received a trusted second click');
    }

    const dispatchCountBeforeDisclosure = dispatched.length;
    const disclosureResult = await agent.executeTool(42, 'click_ax', { ref_id: disclosureMatch[1] });
    const disclosureOpen = await page.evaluate(() => document.getElementById('native-details').open);
    if (
      disclosureResult?.success !== true
      || disclosureResult.trusted !== false
      || !/native\/button-like/.test(disclosureResult.fallbackSkipped || '')
    ) {
      throw new Error(`native disclosure did not stay on its synthetic-only path: ${JSON.stringify(disclosureResult)}`);
    }
    if (!disclosureOpen) {
      throw new Error('synthetic summary click should open the native disclosure exactly once');
    }
    if (dispatched.length !== dispatchCountBeforeDisclosure) {
      throw new Error('native disclosure unexpectedly received a trusted second click');
    }
  } finally {
    cdpClient.attach = originals.attach;
    cdpClient.evaluate = originals.evaluate;
    cdpClient.dispatchMouseEvent = originals.dispatch;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    await session.detach();
  }
});

test('ax_resolve_rect: trusted fallback eligibility rejects interactive descendants, hidden, mutating, stateful, native, form, and download targets', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const content = String(tree?.pageContent || '');
  const refs = {
    nestedButton: content.match(/listitem "Nested button row" \[(ref_\d+)\]/)?.[1],
    nestedLink: content.match(/listitem "Nested link row" \[(ref_\d+)\]/)?.[1],
    nestedInput: content.match(/listitem "Nested input row" \[(ref_\d+)\]/)?.[1],
    native: content.match(/button "Native button" \[(ref_\d+)\]/)?.[1],
    disclosure: content.match(/"Native disclosure" \[(ref_\d+)\]/)?.[1],
    destructive: content.match(/listitem "Delete account" \[(ref_\d+)\]/)?.[1],
    sendMessage: content.match(/listitem "Send message" \[(ref_\d+)\]/)?.[1],
    orderLunch: content.match(/listitem "Order lunch" \[(ref_\d+)\]/)?.[1],
    bookNow: content.match(/listitem "Book now" \[(ref_\d+)\]/)?.[1],
    indirectDestructive: content.match(/listitem "Delete account indirectly" \[(ref_\d+)\]/)?.[1],
    localizedDestructive: content.match(/listitem "Hesabı sil" \[(ref_\d+)\]/)?.[1],
    statefulRole: content.match(/treeitem "Expandable row" \[(ref_\d+)\]/)?.[1],
    statefulAttribute: content.match(/listitem "Stateful list row" \[(ref_\d+)\]/)?.[1],
    input: content.match(/textbox "Native input" \[(ref_\d+)\]/)?.[1],
    select: content.match(/combobox "Native select" \[(ref_\d+)\]/)?.[1],
    editable: content.match(/textbox "Editable row" \[(ref_\d+)\]/)?.[1],
    download: content.match(/listitem "Export report" \[(ref_\d+)\]/)?.[1],
    form: content.match(/listitem "Form row" \[(ref_\d+)\]/)?.[1],
    covered: content.match(/listitem "Covered row" \[(ref_\d+)\]/)?.[1],
    opacity: content.match(/listitem "Opacity row" \[(ref_\d+)\]/)?.[1],
    pointer: content.match(/listitem "Pointer disabled row" \[(ref_\d+)\]/)?.[1],
    zero: content.match(/listitem "Zero row" \[(ref_\d+)\]/)?.[1],
  };
  const safeRefs = {
    tabindexNegative: content.match(/listitem "Generic row with tabindex minus one wrapper" \[(ref_\d+)\]/)?.[1],
    tabindexZero: content.match(/listitem "Generic row with tabindex zero wrapper" \[(ref_\d+)\]/)?.[1],
    dataAction: content.match(/listitem "Generic data action row" \[(ref_\d+)\]/)?.[1],
    properName: content.match(/listitem "Post Malone" \[(ref_\d+)\]/)?.[1],
  };
  await page.evaluate(() => {
    document.getElementById('opacity-row').style.opacity = '0';
  });
  for (const [label, ref] of Object.entries(refs)) {
    if (!ref) throw new Error(`missing ${label} ref in AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (!result?.success) throw new Error(`${label} ref did not resolve: ${JSON.stringify(result)}`);
    if (result.fallbackEligible !== false || !result.fallbackBlockedReason) {
      throw new Error(`${label} target should be blocked from trusted fallback: ${JSON.stringify(result)}`);
    }
  }
  for (const [label, ref] of Object.entries(safeRefs)) {
    if (!ref) throw new Error(`missing ${label} ref in AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (!result?.success || result.fallbackEligible !== true || result.fallbackBlockedReason) {
      throw new Error(`${label} generic row should remain eligible for trusted fallback: ${JSON.stringify(result)}`);
    }
  }
  for (const label of ['nestedButton', 'nestedLink', 'nestedInput']) {
    const result = await call(page, 'ax_resolve_rect', { ref_id: refs[label], forClickFallback: true });
    if (!/interactive descendant/.test(result.fallbackBlockedReason || '')) {
      throw new Error(`${label} should be blocked specifically by its interactive center descendant: ${JSON.stringify(result)}`);
    }
    if (!result.interactiveDescendantTag) {
      throw new Error(`${label} should report the interactive descendant tag: ${JSON.stringify(result)}`);
    }
  }

  const ordinaryResolve = await call(page, 'ax_resolve_rect', { ref_id: refs.destructive });
  if (
    ordinaryResolve.fallbackEligible !== undefined
    || ordinaryResolve.fallbackState !== undefined
    || ordinaryResolve.fallbackStrongState !== undefined
    || ordinaryResolve.fallbackWeakState !== undefined
    || ordinaryResolve.documentToken !== undefined
  ) {
    throw new Error(`fallback-only metadata leaked into ordinary ref resolution: ${JSON.stringify(ordinaryResolve)}`);
  }
});

test('ax_resolve_rect: English action labels stay blocked under Turkish locale casing', async (page) => {
  await page.addInitScript(() => {
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function (...locales) {
      return original.apply(this, locales.length ? locales : ['tr-TR']);
    };
  });
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const content = String(tree?.pageContent || '');
  const refs = {
    install: content.match(/listitem "Install app" \[(ref_\d+)\]/)?.[1],
    invite: content.match(/listitem "Invite teammate" \[(ref_\d+)\]/)?.[1],
  };
  for (const [label, ref] of Object.entries(refs)) {
    if (!ref) throw new Error(`missing ${label} ref in Turkish-locale AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (
      result?.fallbackEligible !== false
      || !/potentially mutating/.test(result.fallbackBlockedReason || '')
    ) {
      throw new Error(`${label} must remain blocked regardless of default locale casing: ${JSON.stringify(result)}`);
    }
  }
});

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
