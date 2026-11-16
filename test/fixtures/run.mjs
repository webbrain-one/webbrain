#!/usr/bin/env node
// Fixtures runner for v4.0.1 overlay defenses.
//
// Loads fixture HTML in Chromium, plus targeted Firefox-engine regressions,
// injects the matching build's content.js with a stubbed extension runtime,
// and drives tools through the message handler. Asserts on response shape +
// which DOM element actually received the interaction.
//
// No LLM, no API keys, no real sites — just deterministic regression checks
// for _findTopmostModal scoping, the occlusion hit-test, and the rich
// ambiguity payload.
//
// Run: npm run test:fixtures

import { chromium, firefox as playwrightFirefox } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../../src/firefox/src/agent/agent.js';
import {
  applyReadPageWindow as applyChromeReadPageWindow,
  fitReadPageWindowResult as fitChromeReadPageWindowResult,
} from '../../src/chrome/src/agent/read-page-window.js';
import {
  applyReadPageWindow as applyFirefoxReadPageWindow,
  fitReadPageWindowResult as fitFirefoxReadPageWindowResult,
} from '../../src/firefox/src/agent/read-page-window.js';
import { CDPClient, cdpClient } from '../../src/chrome/src/cdp/cdp-client.js';
import { fixturePageBlockerReading } from '../semantic-decision-stub.mjs';
import {
  SELECTION_SHORTCUT_LOCALES,
  getSelectionShortcutLocalization,
} from '../../src/chrome/src/selection-shortcut-i18n.js';
import { registerRichTextToolbarFixtures } from './rich-text-toolbar.mjs';
import { registerMessageRecipientNavigationFixtures } from './message-recipient-navigation.mjs';
import { registerInteractionReviewRegressions } from './interaction-review-regressions.mjs';
import { xComposeUploadHtml } from '../lib/upload-release-fixture.mjs';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const accessibilityTreeJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'accessibility-tree.js');
const firefoxAccessibilityTreeJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'accessibility-tree.js');
const contentJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'content.js');
const firefoxContentJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'content.js');
// content.js delegates the toolbar heuristic to this module, which the
// manifests load immediately before it. Fixtures must mirror that order or
// every candidate scores null.
const toolbarHeuristicJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'rich-text-toolbar-heuristic.js');
const firefoxToolbarHeuristicJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'rich-text-toolbar-heuristic.js');

// cdp-client normally reads this file through chrome.runtime.getURL, which
// does not exist here. Feed it the same source the content scripts get so the
// main-world probe scores identically under test.
CDPClient._heuristicSourceOverride = await readFile(toolbarHeuristicJsPath, 'utf-8');
const redactionRegionsJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'redaction-regions.js');
const firefoxRedactionRegionsJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'redaction-regions.js');
const filePickerGuardPageJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'file-picker-guard-page.js');
const firefoxFilePickerGuardPageJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'file-picker-guard-page.js');
const selectionShortcutJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'selection-shortcut.js');
const firefoxSelectionShortcutJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'selection-shortcut.js');
const smdJsPath = path.join(root, 'src', 'chrome', 'src', 'agent', 'social-media-downloader.js');
const selectionShortcutLocalizations = Object.fromEntries(
  SELECTION_SHORTCUT_LOCALES.map((locale) => [locale, getSelectionShortcutLocalization(locale)]),
);

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

async function setup(page, fixture, { asHost = '' } = {}) {
  await page.addInitScript(stubChrome);
  if (asHost) {
    // Serve the fixture as if from another host, without touching the network.
    const body = await readFile(path.join(__dirname, fixture), 'utf-8');
    await page.route(`${asHost}/**`, route => route.fulfill({ contentType: 'text/html', body }));
    await page.goto(`${asHost}/fixture`);
  } else {
    await page.goto(fixtureUrl(fixture));
  }
  const axSrc = await readFile(accessibilityTreeJsPath, 'utf-8');
  await page.addScriptTag({ content: axSrc });
  await page.addScriptTag({ content: await readFile(toolbarHeuristicJsPath, 'utf-8') });
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
  await page.addScriptTag({ content: await readFile(firefox ? firefoxToolbarHeuristicJsPath : toolbarHeuristicJsPath, 'utf-8') });
  const contentSrc = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  await page.addScriptTag({ content: contentSrc });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupContentHtml(page, html, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const pageGuardSrc = await readFile(
    firefox ? firefoxFilePickerGuardPageJsPath : filePickerGuardPageJsPath,
    'utf-8',
  );
  await page.addScriptTag({ content: pageGuardSrc });
  // Simulate manifest injection followed by extension-reload recovery.
  await page.addScriptTag({ content: pageGuardSrc });
  await page.addScriptTag({ content: firefox ? stubFirefoxBrowser : stubChrome });
  await page.addScriptTag({
    content: await readFile(firefox ? firefoxAccessibilityTreeJsPath : accessibilityTreeJsPath, 'utf-8'),
  });
  await page.addScriptTag({ content: await readFile(firefox ? firefoxToolbarHeuristicJsPath : toolbarHeuristicJsPath, 'utf-8') });
  const src = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupIsolatedContentHtml(page, html, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const pageGuardSrc = await readFile(
    firefox ? firefoxFilePickerGuardPageJsPath : filePickerGuardPageJsPath,
    'utf-8',
  );
  await page.addScriptTag({ content: pageGuardSrc });
  // Simulate recovery reinjection while keeping the content world separate.
  await page.addScriptTag({ content: pageGuardSrc });

  const session = await page.context().newCDPSession(page);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  const frameTree = await session.send('Page.getFrameTree');
  const isolatedWorld = await session.send('Page.createIsolatedWorld', {
    frameId: frameTree.frameTree.frame.id,
    worldName: `webbrain-${browserKind}-fixture`,
  });
  const contextId = isolatedWorld.executionContextId;
  const contentSrc = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  const heuristicSrc = await readFile(firefox ? firefoxToolbarHeuristicJsPath : toolbarHeuristicJsPath, 'utf-8');
  const injected = await session.send('Runtime.evaluate', {
    contextId,
    expression: `${firefox ? stubFirefoxBrowser : stubChrome}\n${heuristicSrc}\n${contentSrc}`,
    awaitPromise: true,
  });
  if (injected.exceptionDetails) {
    throw new Error(`isolated content injection failed: ${injected.exceptionDetails.text}`);
  }

  const rawIsolatedCall = async (action, params) => {
    const message = JSON.stringify({ target: 'content', action, params });
    const evaluated = await session.send('Runtime.evaluate', {
      contextId,
      expression: `new Promise((resolve) => {
        const ret = window.__wb_handler(${message}, {}, (resp) => resolve(resp));
        if (ret !== true && ret !== undefined) resolve(ret);
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(`isolated content call failed: ${evaluated.exceptionDetails.text}`);
    }
    return evaluated.result.value;
  };

  return async (action, params) => {
    const response = await rawIsolatedCall(action, params);
    const guardId = response?._filePickerGuardId;
    if (!guardId) return response;

    const originalResponse = { ...response };
    delete originalResponse._filePickerGuardId;
    await page.waitForTimeout(525);
    let settled = await rawIsolatedCall('consume_file_picker_guard', { guardId });
    if (settled?.settled === false) {
      await page.waitForTimeout(50);
      settled = await rawIsolatedCall('consume_file_picker_guard', { guardId });
    }
    if (!settled?.filePickerBlocked) return originalResponse;

    const blockedResponse = { ...settled };
    delete blockedResponse.settled;
    return {
      ...blockedResponse,
      ...(originalResponse.rect ? { rect: originalResponse.rect } : {}),
      ...(originalResponse.ref_id ? { ref_id: originalResponse.ref_id } : {}),
    };
  };
}

async function setupFirefoxHtml(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: stubFirefoxBrowser });
  await page.addScriptTag({ content: await readFile(firefoxToolbarHeuristicJsPath, 'utf-8') });
  const src = await readFile(firefoxContentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupChromeHtml(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: stubChrome });
  await page.addScriptTag({ content: await readFile(toolbarHeuristicJsPath, 'utf-8') });
  const src = await readFile(contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupAccessibilityTreeHtml(page, html, sourcePath) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__generateAccessibilityTree === 'function');
}

async function setupAccessibilityTreeGmailHtml(page, html, sourcePath) {
  await page.route('https://mail.google.com/**', route => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ body: html, contentType: 'text/html' });
    }
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.goto('https://mail.google.com/mail/u/0/#inbox/FMfc123', { waitUntil: 'domcontentloaded' });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__generateAccessibilityTree === 'function');
}

async function setupContentGmailHtml(page, html, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.route('https://mail.google.com/**', route => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ body: html, contentType: 'text/html' });
    }
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.addInitScript(firefox ? stubFirefoxBrowser : stubChrome);
  await page.goto('https://mail.google.com/mail/u/0/#inbox/FMfc123', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({
    content: await readFile(firefox ? firefoxAccessibilityTreeJsPath : accessibilityTreeJsPath, 'utf-8'),
  });
  await page.addScriptTag({
    content: await readFile(firefox ? firefoxToolbarHeuristicJsPath : toolbarHeuristicJsPath, 'utf-8'),
  });
  await page.addScriptTag({
    content: await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8'),
  });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function rawContentCall(page, action, params) {
  return page.evaluate(({ action, params }) => new Promise((resolve) => {
    const ret = window.__wb_handler(
      { target: 'content', action, params },
      {},
      (resp) => resolve(resp),
    );
    if (ret !== true && ret !== undefined) resolve(ret);
  }), { action, params });
}

async function call(page, action, params) {
  const response = await rawContentCall(page, action, params);
  const guardId = response?._filePickerGuardId;
  if (!guardId) return response;

  const originalResponse = { ...response };
  delete originalResponse._filePickerGuardId;
  await page.waitForTimeout(525);
  let settled = await rawContentCall(page, 'consume_file_picker_guard', { guardId });
  if (settled?.settled === false) {
    await page.waitForTimeout(50);
    settled = await rawContentCall(page, 'consume_file_picker_guard', { guardId });
  }
  if (!settled?.filePickerBlocked) return originalResponse;

  const blockedResponse = { ...settled };
  delete blockedResponse.settled;
  return {
    ...blockedResponse,
    ...(originalResponse.rect ? { rect: originalResponse.rect } : {}),
    ...(originalResponse.ref_id ? { ref_id: originalResponse.ref_id } : {}),
  };
}

// A text as the agent keys a reading of it (its _pageTextKey), so a reading
// handed back reaches the page only when the page keyed the text alike.
const agentReadingKey = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// The way the agent reads the overlay and article-block texts a page read
// consulted unread (a model; the fixture oracle stands in): at most 48 of
// them, then the page once more, up to three times while texts get read.
// `stats.needed` records how many texts each read reported.
async function readGateTextsLikeTheAgent(readOnce, readings, stats = null) {
  let result = await readOnce();
  for (let pass = 0; pass < 3; pass += 1) {
    const needed = (result?.pageTextsNeeded || []).filter(entry => entry?.kind === 'page_blocker');
    stats?.needed?.push(needed.length);
    const texts = [...new Set(needed.map(entry => agentReadingKey(entry.text)))].filter(Boolean).slice(0, 48);
    if (!texts.length) break;
    for (const text of texts) readings[text] = fixturePageBlockerReading(text);
    result = await readOnce();
  }
  if (result && typeof result === 'object') delete result.pageTextsNeeded;
  return result;
}

async function readThroughCdpMirror(page, opts = {}, stats = null) {
  const client = new CDPClient();
  client.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });
  const readings = { ...(opts.pageBlockerReadings || {}) };
  return readGateTextsLikeTheAgent(() => client.readPage(1, { ...opts, pageBlockerReadings: readings }), readings, stats);
}

// A page read the way the agent reads it: overlay and article-block texts the
// page-gate check consulted unread are read by a model (the fixture oracle
// stands in) and the page is read again with those readings.
async function readWithGateReadings(page, action, params = {}, stats = null) {
  const readings = {};
  return readGateTextsLikeTheAgent(() => call(page, action, { ...params, __wbPageReadings: { page_blocker: readings } }), readings, stats);
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

async function setupSelectionShortcut(page, sourcePath, { enabled = true, requiresManualOpen = false, locale = 'en', promiseDetect = false, holdLocalization = false, failLocalization = false } = {}) {
  await page.setViewportSize({ width: 360, height: 280 });
  await page.setContent(`<!doctype html>
    <style>body{margin:0;font:18px/1.5 sans-serif} #copy{position:absolute;right:2px;bottom:2px;width:210px}</style>
    <p id="copy">Selected words near the viewport edge for WebBrain.</p>
    <div id="editor" contenteditable="true">Editable selection text.</div>`);
  await page.addScriptTag({ content: `
    window.__selectionMessages = [];
    window.__selectionInlineMessages = [];
    window.__selectionCancelMessages = [];
    window.__selectionLocalizationRequests = 0;
    window.__selectionLocalizationGate = ${holdLocalization ? 'new Promise((resolve) => { window.__releaseLocalization = resolve; })' : 'null'};
    window.__selectionDetectedLanguage = '';
    window.__selectionInlineHandler = async (message) => ({
      ok: true,
      text: 'Mock ' + message.action + ' answer for ' + message.language,
    });
    window.__selectionStorage = { selectionShortcutEnabled: ${enabled ? 'true' : 'false'}, wbLocale: '${locale}' };
    window.__selectionLocalizations = ${JSON.stringify(selectionShortcutLocalizations)};
    window.__selectionRuntimeListeners = [];
    window.__selectionStorageListeners = [];
    window.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === 'WB_SELECTION_SHORTCUT_LOCALIZATION') {
            window.__selectionLocalizationRequests += 1;
            if (window.__selectionLocalizationGate) await window.__selectionLocalizationGate;
            if (${failLocalization ? 'true' : 'false'}) throw new Error('The language bundle is unavailable.');
            const locale = String(message.locale || 'en').toLowerCase().split('-')[0];
            return { ok: true, ...(window.__selectionLocalizations[locale] || window.__selectionLocalizations.en) };
          }
          if (message.type === 'WB_SELECTION_SHORTCUT_INLINE') {
            window.__selectionInlineMessages.push(message);
            return window.__selectionInlineHandler(message);
          }
          if (message.type === 'WB_SELECTION_SHORTCUT_INLINE_CANCEL') {
            window.__selectionCancelMessages.push(message);
            return { ok: true };
          }
          window.__selectionMessages.push(message);
          return { ok: true, queued: true, requiresManualOpen: ${requiresManualOpen ? 'true' : 'false'} };
        },
        onMessage: { addListener: (listener) => window.__selectionRuntimeListeners.push(listener) }
      },
      i18n: {
        detectLanguage: (text, callback) => {
          const result = window.__selectionDetectedLanguage
            ? { isReliable: true, languages: [{ language: window.__selectionDetectedLanguage, percentage: 100 }] }
            : { isReliable: false, languages: [] };
          if (${promiseDetect ? 'true' : 'false'}) return Promise.resolve(result);
          callback(result);
        }
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
    if (${promiseDetect ? 'true' : 'false'}) window.browser = window.chrome;
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


async function clickRectCenter(page, rect) {
  await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

async function waitForCardStatus(page, status) {
  await page.waitForFunction(
    (expected) => window.__webbrainSelectionShortcut.getState().cardStatus === expected,
    status,
  );
  return page.evaluate(() => window.__webbrainSelectionShortcut.getState());
}

async function openInlineCard(page, kind, selector = '#copy') {
  const selected = await selectFixtureText(page, selector);
  await clickRectCenter(page, selected.inlineRects[kind]);
  await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().cardVisible);
  return selected;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('expired content messages are rejected before page mutation in both builds', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <button id="late-action" onclick="window.__lateActionClicks = (window.__lateActionClicks || 0) + 1">Late action</button>
    `, browserKind);
    const response = await page.evaluate(() => new Promise((resolve) => {
      window.__wb_handler({
        target: 'content',
        action: 'click',
        params: { selector: '#late-action' },
        actionDeadlineAt: Date.now() - 1,
      }, {}, resolve);
    }));
    const clicks = await page.evaluate(() => window.__lateActionClicks || 0);
    if (
      response?.success !== false
      || response.dispatched !== false
      || response.noDispatch !== true
      || response.deadlineExpired !== true
      || clicks !== 0
    ) {
      throw new Error(`${browserKind} expired content message mutated the page: ${JSON.stringify({ response, clicks })}`);
    }
  }
});

test('set_field cannot submit after its page-action deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <form id="deadline-form">
        <input id="deadline-field" aria-label="Deadline field">
      </form>
      <script>
        window.__deadlineSubmits = 0;
        document.getElementById('deadline-form').addEventListener('submit', event => {
          event.preventDefault();
          window.__deadlineSubmits += 1;
        });
      </script>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const refId = window.__wb_ax_ref(document.getElementById('deadline-field'));
      window.__wb_handler({
        target: 'content',
        action: 'set_field',
        params: { ref_id: refId, text: 'typed before expiry', submit: true },
        actionDeadlineAt: Date.now() + 20,
      }, {}, response => resolve({
        response,
        value: document.getElementById('deadline-field').value,
        submits: window.__deadlineSubmits,
      }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.submitted !== false
      || result.response.dispatched !== true
      || result.value !== 'typed before expiry'
      || result.submits !== 0
    ) {
      throw new Error(`${browserKind} set_field submitted after expiry: ${JSON.stringify(result)}`);
    }
  }
});

test('set_field stops before mutation when focus handlers cross the deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <input id="late-set-field" aria-label="Late set field">
      <script>
        document.getElementById('late-set-field').addEventListener('focus', () => {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
        });
      </script>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const field = document.getElementById('late-set-field');
      const refId = window.__wb_ax_ref(field);
      window.__wb_handler({
        target: 'content',
        action: 'set_field',
        params: { ref_id: refId, text: 'must not appear' },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({ response, value: field.value }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.value !== ''
    ) {
      throw new Error(`${browserKind} set_field crossed its mutation deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('set_field releases Enter when a keydown listener crosses the deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <input id="deadline-key-field" aria-label="Deadline key field">
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const field = document.getElementById('deadline-key-field');
      window.__deadlineKeydowns = 0;
      window.__deadlineKeyups = 0;
      window.__deadlineKeyTimes = {};
      field.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        window.__deadlineKeydowns += 1;
        window.__deadlineKeyTimes.keydownStart = Date.now();
        const stopAt = performance.now() + 650;
        while (performance.now() < stopAt) {}
        window.__deadlineKeyTimes.keydownEnd = Date.now();
      });
      field.addEventListener('keyup', event => {
        if (event.key === 'Enter') window.__deadlineKeyups += 1;
      });
      const refId = window.__wb_ax_ref(field);
      const startedAt = Date.now();
      const deadlineAt = startedAt + 500;
      window.__wb_handler({
        target: 'content',
        action: 'set_field',
        params: { ref_id: refId, text: 'typed before key dispatch', submit: true },
        actionDeadlineAt: deadlineAt,
      }, {}, response => {
        resolve({
          response,
          startedAt,
          deadlineAt,
          completedAt: Date.now(),
          keyTimes: window.__deadlineKeyTimes,
          keydowns: window.__deadlineKeydowns,
          keyups: window.__deadlineKeyups,
        });
      });
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== true
      || result.response.outcomeUnknown !== true
      || result.response.retryable !== false
      || result.keydowns !== 1
      || result.keyups !== 1
    ) {
      throw new Error(`${browserKind} set_field left Enter pressed after expiry: ${JSON.stringify(result)}`);
    }
  }
});

test('Firefox synthetic hover reports a deadline crossed by its last listener', async (page) => {
  await setupContentHtml(page, `
    <button id="deadline-hover">Hover target</button>
    <script>
      window.__deadlineMousemoves = 0;
      document.getElementById('deadline-hover').addEventListener('mousemove', () => {
        window.__deadlineMousemoves += 1;
        const stopAt = Date.now() + 150;
        while (Date.now() < stopAt) {}
      });
    </script>
  `, 'firefox');
  const result = await page.evaluate(() => new Promise((resolve) => {
    const target = document.getElementById('deadline-hover');
    window.__wb_handler({
      target: 'content',
      action: 'hover',
      params: { ref_id: window.__wb_ax_ref(target) },
      actionDeadlineAt: Date.now() + 100,
    }, {}, response => resolve({ response, moves: window.__deadlineMousemoves }));
  }));
  if (
    result.response?.success !== false
    || result.response.deadlineExpired !== true
    || result.response.dispatched !== true
    || result.response.outcomeUnknown !== true
    || result.moves !== 1
  ) {
    throw new Error(`firefox hover hid its last-listener deadline: ${JSON.stringify(result)}`);
  }
});

test('Firefox synthetic drag releases a held pointer after expiry', async (page) => {
  await setupContentHtml(page, `
    <button id="deadline-drag-from">Drag source</button>
    <button id="deadline-drag-to">Drag target</button>
    <script>
      window.__deadlinePointerdowns = 0;
      window.__deadlinePointerups = 0;
      document.getElementById('deadline-drag-from').addEventListener('pointerdown', () => {
        window.__deadlinePointerdowns += 1;
        const stopAt = Date.now() + 450;
        while (Date.now() < stopAt) {}
      });
      document.getElementById('deadline-drag-to').addEventListener('pointerup', () => {
        window.__deadlinePointerups += 1;
      });
    </script>
  `, 'firefox');
  const result = await page.evaluate(() => new Promise((resolve) => {
    const from = document.getElementById('deadline-drag-from');
    const to = document.getElementById('deadline-drag-to');
    window.__wb_handler({
      target: 'content',
      action: 'drag_drop',
      params: {
        fromRefId: window.__wb_ax_ref(from),
        toRefId: window.__wb_ax_ref(to),
        steps: 2,
      },
      actionDeadlineAt: Date.now() + 300,
    }, {}, response => resolve({
      response,
      pointerdowns: window.__deadlinePointerdowns,
      pointerups: window.__deadlinePointerups,
    }));
  }));
  if (
    result.response?.success !== false
    || result.response.deadlineExpired !== true
    || result.response.dispatched !== true
    || result.response.outcomeUnknown !== true
    || result.pointerdowns !== 1
    || result.pointerups !== 1
  ) {
    throw new Error(`firefox drag left the pointer held after expiry: ${JSON.stringify(result)}`);
  }
});

test('click_ax rechecks its page-action deadline at the click boundary', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <div id="slow-context"><button id="late-click">Late click</button></div>
      <script>
        window.__lateAxClicks = 0;
        document.getElementById('late-click').addEventListener('click', () => { window.__lateAxClicks += 1; });
        Object.defineProperty(document.getElementById('slow-context'), 'innerText', {
          configurable: true,
          get() {
            const stopAt = Date.now() + 30;
            while (Date.now() < stopAt) {}
            return 'Slow click context';
          },
        });
      </script>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const refId = window.__wb_ax_ref(document.getElementById('late-click'));
      window.__wb_handler({
        target: 'content',
        action: 'click_ax',
        params: { ref_id: refId },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({ response, clicks: window.__lateAxClicks }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.clicks !== 0
    ) {
      throw new Error(`${browserKind} click_ax crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('press_keys rechecks its deadline after recipient validation', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <style>
        #recipient { position: fixed; top: 20px; left: 320px; width: 240px; height: 32px; }
        #composer { position: fixed; bottom: 20px; left: 280px; width: 360px; height: 80px; }
      </style>
      <h1 id="recipient">Alice</h1>
      <textarea id="composer" aria-label="Message composer">Hello Alice</textarea>
    `, browserKind);
    const binding = await page.evaluate(() => new Promise((resolve) => {
      const composer = document.getElementById('composer');
      composer.focus();
      window.__wb_handler({
        target: 'content',
        action: 'probe_message_recipient_guard',
        params: {
          tool: 'press_keys',
          args: { key: 'Enter' },
          bindDispatch: true,
        },
      }, {}, response => resolve(response?.messageRecipientDispatchBinding || null));
    }));
    if (!binding?.token) {
      throw new Error(`${browserKind} could not prepare the recipient-bound key fixture`);
    }
    const result = await page.evaluate((messageRecipientDispatchBinding) => new Promise((resolve) => {
      const composer = document.getElementById('composer');
      const recipient = document.getElementById('recipient');
      window.__recipientBoundKeyEvents = 0;
      composer.addEventListener('keydown', () => { window.__recipientBoundKeyEvents += 1; });
      composer.addEventListener('keyup', () => { window.__recipientBoundKeyEvents += 1; });
      Object.defineProperty(recipient, 'innerText', {
        configurable: true,
        get() {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
          return 'Alice';
        },
      });
      window.__wb_handler({
        target: 'content',
        action: 'press_keys',
        params: {
          key: 'Enter',
          messageRecipientGuardRequired: true,
          messageRecipientDispatchBinding,
        },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({
        response,
        keyEvents: window.__recipientBoundKeyEvents,
      }));
    }), binding);
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.keyEvents !== 0
    ) {
      throw new Error(`${browserKind} recipient-bound key crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('click rechecks its deadline after recipient validation', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <style>
        #recipient { position: fixed; top: 20px; left: 320px; width: 240px; height: 32px; }
        #message-form { position: fixed; bottom: 20px; left: 280px; width: 460px; height: 90px; }
        #composer { width: 360px; height: 80px; }
        #send { width: 70px; height: 40px; }
      </style>
      <h1 id="recipient">Alice</h1>
      <form id="message-form">
        <textarea id="composer" aria-label="Message composer">Hello Alice</textarea>
        <button id="send" type="button">Send</button>
      </form>
      <script>
        window.__recipientBoundClicks = 0;
        document.getElementById('send').addEventListener('click', () => { window.__recipientBoundClicks += 1; });
      </script>
    `, browserKind);
    const binding = await page.evaluate(() => new Promise((resolve) => {
      document.getElementById('composer').focus();
      window.__wb_handler({
        target: 'content',
        action: 'probe_message_recipient_guard',
        params: {
          tool: 'click',
          args: { selector: '#send' },
          bindDispatch: true,
        },
      }, {}, response => resolve(response?.messageRecipientDispatchBinding || null));
    }));
    if (!binding?.token) {
      throw new Error(`${browserKind} could not prepare the recipient-bound click fixture`);
    }
    const result = await page.evaluate((messageRecipientDispatchBinding) => new Promise((resolve) => {
      const recipient = document.getElementById('recipient');
      Object.defineProperty(recipient, 'innerText', {
        configurable: true,
        get() {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
          return 'Alice';
        },
      });
      window.__wb_handler({
        target: 'content',
        action: 'click',
        params: {
          selector: '#send',
          messageRecipientGuardRequired: true,
          messageRecipientDispatchBinding,
        },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({
        response,
        clicks: window.__recipientBoundClicks,
      }));
    }), binding);
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.clicks !== 0
    ) {
      throw new Error(`${browserKind} recipient-bound click crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('fallback typing stops when focus handlers cross the deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <input id="late-type" aria-label="Late type field">
      <script>
        document.getElementById('late-type').addEventListener('focus', () => {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
        });
      </script>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      window.__wb_handler({
        target: 'content',
        action: 'type',
        params: { selector: '#late-type', text: 'must not appear' },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({
        response,
        value: document.getElementById('late-type').value,
      }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.value !== ''
    ) {
      throw new Error(`${browserKind} fallback typing crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('fallback scrolling stops when target scans cross the deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <style>
        html, body { margin: 0; height: 100%; overflow: hidden; }
        #scroller { width: 300px; height: 120px; overflow-y: auto; }
        #scroll-content { height: 1000px; }
      </style>
      <div id="scroller"><div id="scroll-content">Scrollable content</div></div>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const scroller = document.getElementById('scroller');
      const refId = window.__wb_ax_ref(document.getElementById('scroll-content'));
      const nativeGetComputedStyle = window.getComputedStyle.bind(window);
      window.getComputedStyle = (element, ...args) => {
        if (element === scroller) {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
        }
        return nativeGetComputedStyle(element, ...args);
      };
      window.__wb_handler({
        target: 'content',
        action: 'scroll',
        params: { ref_id: refId, direction: 'down', amount: 100 },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({ response, scrollTop: scroller.scrollTop }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.scrollTop !== 0
    ) {
      throw new Error(`${browserKind} fallback scroll crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});
const firefoxTests = [];
function firefoxTest(name, fn) { firefoxTests.push({ name, fn }); }

test('exact iframe rect handshake distinguishes same-URL sibling frames', async (page) => {
  for (const [browserKind, sourcePath] of [
    ['chrome', redactionRegionsJsPath],
    ['firefox', firefoxRedactionRegionsJsPath],
  ]) {
    await page.setContent(`<!doctype html>
      <style>
        body { margin: 0; height: 1200px; }
        #first { position: absolute; top: 180px; left: 100px; width: 300px; height: 180px; border: 0; }
      </style>
      <iframe id="first" srcdoc="<input>"></iframe>
      <div id="shadow-host"></div>
      <script>
        (() => {
          const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
          root.innerHTML = '<iframe id="second" style="position:absolute;top:180px;left:600px;width:300px;height:180px;border:0" srcdoc="<input>"></iframe>';
        })();
      </script>`);
    await page.waitForFunction(() => {
      const first = document.getElementById('first');
      const second = document.getElementById('shadow-host')?.shadowRoot?.getElementById('second');
      return !!first?.contentWindow && !!second?.contentWindow;
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => window.scrollTo(0, 100));
    const runtimeStub = browserKind === 'firefox' ? `
      window.browser = window.browser || {};
      window.browser.runtime = {
        onMessage: { addListener: fn => { window.__redaction_handler = fn; } }
      };` : `
      window.chrome = window.chrome || {};
      window.chrome.runtime = {
        onMessage: { addListener: fn => { window.__redaction_handler = fn; } }
      };`;
    const source = await readFile(sourcePath, 'utf-8');
    for (const frame of page.frames()) {
      await frame.addScriptTag({ content: runtimeStub });
      await frame.addScriptTag({ content: source });
    }
    const childFrames = page.frames().filter(frame => frame !== page.mainFrame());
    if (childFrames.length !== 2) throw new Error(`${browserKind}: expected two child frames, got ${childFrames.length}`);
    const shadowChildFrame = (await Promise.all(childFrames.map(async frame => ({
      frame,
      id: await frame.evaluate(() => window.frameElement?.id || ''),
    })))).find(entry => entry.id === 'second')?.frame;
    if (!shadowChildFrame) throw new Error(`${browserKind}: shadow child frame was not reachable`);
    const token = `fixture-${browserKind}-${Date.now()}`;
    const parentWait = page.evaluate(probeToken => new Promise(resolve => {
      const keepAlive = window.__redaction_handler({
        target: 'redaction-content',
        action: 'wait_for_exact_child_frame_rect',
        params: { token: probeToken },
      }, {}, resolve);
      if (keepAlive !== true) resolve({ found: false, keepAlive });
    }), token);
    await new Promise(resolve => setTimeout(resolve, 10));
    const announced = await shadowChildFrame.evaluate(probeToken => new Promise(resolve => {
      window.__redaction_handler({
        target: 'redaction-content',
        action: 'announce_exact_child_frame',
        params: { token: probeToken },
      }, {}, resolve);
    }), token);
    const exact = await parentWait;
    if (
      announced?.announced !== true
      || exact?.found !== true
      || Math.round(exact.outerRect?.x) !== 600
      || Math.round(exact.outerRect?.y) !== 80
      || Math.round(exact.outerRect?.pageY) !== 180
    ) {
      throw new Error(`${browserKind}: expected exact shadow-frame geometry, got: ${JSON.stringify({ announced, exact })}`);
    }
  }
});

for (const [label, browserKind] of [['Chrome', 'chrome'], ['Firefox', 'firefox']]) {
  test(`${label}: type_text verifies after controlled field reconciliation`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <input id="controlled" value="requested content already">
      <textarea id="accepted"></textarea>
      <script>
        const controlled = document.getElementById('controlled');
        controlled.addEventListener('input', () => {
          setTimeout(() => { controlled.value = 'requested content alreadY'; }, 0);
        });
      </script>`, browserKind);
    const rejected = await call(page, 'type', {
      selector: '#controlled',
      text: 'requested content',
      clear: false,
    });
    // Controlled reformatting is exactly the case that must not be reported as
    // a failed action: the edit dispatched, the page rewrote the value, so the
    // exact-match proof cannot pass. Unproven is signalled by omitting
    // `verified`, never by setting it false.
    if (rejected?.success !== true || 'verified' in (rejected || {})) {
      throw new Error(`controlled normalization without the requested insertion must be unproven, not refuted: ${JSON.stringify(rejected)}`);
    }
    const accepted = await call(page, 'type', {
      selector: '#accepted',
      text: 'requested content',
      clear: true,
    });
    if (accepted?.success !== true || accepted?.verified !== true) {
      throw new Error(`persisted text must be verified: ${JSON.stringify(accepted)}`);
    }
  });
}

for (const [label, browserKind] of [['Chrome', 'chrome'], ['Firefox', 'firefox']]) {
  test(`${label}: blocking NYTimes registration dialog suppresses article DOM`, async (page) => {
    await setupContentFixture(page, 'nyt-registration-gate.html', browserKind);
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {});
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
    const tree = await readWithGateReadings(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
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
    const basicResult = await readWithGateReadings(page, 'get_page_info', {});
    if (/SECRET_NYT_(?:ARTICLE|LINK|IMAGE|FORM|SHADOW)/.test(JSON.stringify(basicResult))) {
      throw new Error(`basic page info leaked blocked article data: ${JSON.stringify(basicResult)}`);
    }
  });

  test(`${label}: The Athletic covering subscription overlay suppresses server-rendered body`, async (page) => {
    await setupContentFixture(page, 'athletic-subscription-overlay.html', browserKind);
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {});
    if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog') {
      throw new Error(`Athletic pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (/SECRET_ATHLETIC_(?:ARTICLE|LINK|FORM)/.test(JSON.stringify(result)) || result.textSource !== 'page-gate') {
      throw new Error(`Athletic article data leaked: ${JSON.stringify(result)}`);
    }
  });

  test(`${label}: inline article gate returns only the visible preview`, async (page) => {
    await setupContentFixture(page, 'inline-article-paywall.html', browserKind);
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {});
    if (result.pageGate?.blocking !== true || result.pageGate?.surface !== 'inline') {
      throw new Error(`inline pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (!/VISIBLE_PREVIEW_PARAGRAPH/.test(result.text || '') || /SECRET_POST_GATE_PARAGRAPH/.test(result.text || '')) {
      throw new Error(`inline preview boundary mismatch: ${JSON.stringify(result.text)}`);
    }
    if (!/\(pre-gate\)$/.test(result.textSource || '')) {
      throw new Error(`inline textSource missing pre-gate marker: ${result.textSource}`);
    }
    const tree = await readWithGateReadings(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (!/VISIBLE_PREVIEW_PARAGRAPH/.test(tree.pageContent || '') || /SECRET_POST_GATE_PARAGRAPH/.test(tree.pageContent || '')) {
      throw new Error(`inline accessibility boundary mismatch: ${JSON.stringify(tree)}`);
    }
  });

  test(`${label}: a wall inside the block its preview begins leaves that preview readable`, async (page) => {
    await setupContentFixture(page, 'inline-wrapped-preview-paywall.html', browserKind);
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {});
    if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'inline') {
      throw new Error(`wrapped preview pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (!/WRAPPED_PREVIEW_PARAGRAPH/.test(result.text || '') || /SECRET_WRAPPED_REST_PARAGRAPH/.test(result.text || '')) {
      throw new Error(`wrapped preview boundary mismatch: ${JSON.stringify(result.text)}`);
    }
    if (!/Subscribe to continue reading/.test(result.pageGate.label || '')) {
      throw new Error(`wrapped preview label does not start at the wall: ${JSON.stringify(result.pageGate)}`);
    }
    const tree = await readWithGateReadings(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (!/WRAPPED_PREVIEW_PARAGRAPH/.test(tree.pageContent || '') || /SECRET_WRAPPED_REST_PARAGRAPH/.test(tree.pageContent || '')) {
      throw new Error(`wrapped preview accessibility boundary mismatch: ${JSON.stringify(tree)}`);
    }
  });

  test(`${label}: a wall after more than 400 characters of preview still withholds the rest`, async (page) => {
    await setupContentFixture(page, 'inline-long-preview-paywall.html', browserKind);
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {});
    if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'inline') {
      throw new Error(`long preview pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (/SECRET_LONG_REST_PARAGRAPH/.test(JSON.stringify(result))) {
      throw new Error(`long preview leaked the rest of the article: ${JSON.stringify(result.text)}`);
    }
    for (const marker of ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX']) {
      if (!new RegExp(`LONG_PREVIEW_${marker}`).test(result.text || '')) {
        throw new Error(`long preview lost LONG_PREVIEW_${marker}: ${JSON.stringify(result.text)}`);
      }
    }
    const tree = await readWithGateReadings(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (tree.pageGate?.type !== 'subscription' || /SECRET_LONG_REST_PARAGRAPH/.test(tree.pageContent || '')
      || !/LONG_PREVIEW_SIX/.test(tree.pageContent || '')) {
      throw new Error(`long preview accessibility read mismatch: ${JSON.stringify(tree)}`);
    }
  });

  for (const [fixture, secret, visible, what] of [
    ['inline-bare-prompt-paywall.html', /SECRET_BARE_(?:BETWEEN|AFTER)/, null, 'a wall text standing directly in its block, repeated after the withheld article'],
    ['inline-close-repeat-paywall.html', /SECRET_CLOSE_(?:SHORT|AFTER)/, /VISIBLE_CLOSE_PREVIEW/, 'a line reading like the wall a short sentence after it'],
    ['inline-long-hidden-paywall.html', /HIDDEN_LINE_\d\d/, /PREVIEW_LINE_12/, 'a wall after twelve preview lines with twelve withheld lines rendered after it'],
    ['inline-long-paragraph-paywall.html', /SECRET_PARAGRAPH_REST/, /LONG_PARAGRAPH_ONE/, 'a long wall paragraph after long preview paragraphs'],
    ['inline-many-blocks-paywall.html', /SECRET_MANY_REST/, /STORY_LINE_20/, 'a wall among several blocks named like paywalls'],
    ['inline-middle-wall-paywall.html', /SECRET_MIDDLE_REST/, /MIDDLE_PREVIEW_06/, 'a wall between a long preview and a long withheld article in one block'],
    ['inline-span-words-paywall.html', /SECRET_SPAN_REST/, /SPAN_PREVIEW_5_word1\b/, 'a wall after long preview paragraphs of inline words'],
    ['inline-locked-box-paywall.html', /SECRET_LOCKED/, null, 'a wall box holding the locked article right after its heading'],
  ]) {
    test(`${label}: ${what} withholds the article after it`, async (page) => {
      await setupContentFixture(page, fixture, browserKind);
      for (const [action, field] of [['get_page_info_cdp', 'text'], ['get_accessibility_tree', 'pageContent']]) {
        const result = await readWithGateReadings(page, action, action === 'get_accessibility_tree' ? { filter: 'visible', maxDepth: 6 } : {});
        if (!['subscription', 'registration', 'login'].includes(result.pageGate?.type) || result.pageGate?.surface !== 'inline') {
          throw new Error(`${action}: wall missed: ${JSON.stringify(result.pageGate)}`);
        }
        if (secret.test(JSON.stringify(result))) {
          throw new Error(`${action}: the withheld article was returned: ${JSON.stringify({ pageGate: result.pageGate, text: result[field] })}`);
        }
        if (visible && !visible.test(result[field] || '')) {
          throw new Error(`${action}: the preview before the wall was withheld: ${JSON.stringify(result[field])}`);
        }
      }
    });
  }

  test(`${label}: an overlay wall in the middle of a long text, or among two hundred other blocks, is still read`, async (page) => {
    for (const [fixture, secret] of [['dialog-long-intro-wall.html', /SECRET_DIALOG_ARTICLE_BODY/],
      ['overlay-among-many-blocks.html', /SECRET_NOTES_ARTICLE_BODY/]]) {
      await setupContentFixture(page, fixture, browserKind);
      for (const action of ['get_page_info_cdp', 'get_accessibility_tree']) {
        const result = await readWithGateReadings(page, action, action === 'get_accessibility_tree' ? { filter: 'visible', maxDepth: 6 } : {});
        if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog' || secret.test(JSON.stringify(result))) {
          throw new Error(`${fixture} ${action}: overlay wall mismatch: ${JSON.stringify({ pageGate: result.pageGate, textSource: result.textSource })}`);
        }
      }
    }
  });

  // From review: a wall whose number changes on every read, such as a
  // countdown, was read as a wall each time but never met that reading
  // again. A text that differs from a wall only in its numbers is now that
  // wall at once and is still read: a quota that stops being a wall when its
  // number changes reads as what it is once a model has read it. A text read
  // as no wall is read again when its number changes.
  test(`${label}: a wall whose number changes stays a wall while its new text is read, and a changed counter is read again`, async (page) => {
    const countdown = n => `Okumaya devam etmek için abone olun. Kalan süre: ${n} sn`;
    await setupContentHtml(page, `<!doctype html><meta property="og:type" content="article">
      <article><h1>Geri sayım</h1><p>SECRET_COUNTDOWN_BODY sunucuda çizilmiştir.</p></article>
      <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff">
        <p id="count">${countdown(59)}</p><button>Abone ol</button></div>`, browserKind);
    const readings = {};
    const readOnce = (action, params = {}) => call(page, action, { ...params, __wbPageReadings: { page_blocker: readings } });
    const first = await readGateTextsLikeTheAgent(() => readOnce('get_page_info_cdp'), readings);
    if (first.pageGate?.type !== 'subscription' || /SECRET_COUNTDOWN_BODY/.test(JSON.stringify(first))) {
      throw new Error(`countdown wall was not applied: ${JSON.stringify({ pageGate: first.pageGate })}`);
    }
    for (const n of [58, 9]) {
      await page.evaluate(text => { document.querySelector('#count').textContent = text; }, countdown(n));
      for (const [action, params] of [['get_page_info_cdp', {}], ['get_accessibility_tree', { filter: 'visible', maxDepth: 6 }]]) {
        // Before any model reads the new text, the wall already stands.
        const ticked = await readOnce(action, params);
        if (ticked.pageGate?.type !== 'subscription' || /SECRET_COUNTDOWN_BODY/.test(JSON.stringify(ticked))) {
          throw new Error(`${action} at ${n} s: the countdown wall fell before its new text was read: ${JSON.stringify({ pageGate: ticked.pageGate })}`);
        }
        // At 58 s the new text is reported to be read; once two texts of
        // its shape read as the wall, a new number is not read again.
        const reported = (ticked.pageTextsNeeded || []).some(entry => /Kalan süre/.test(entry.text));
        if (action === 'get_page_info_cdp' && reported !== (n === 58)) {
          throw new Error(`${action} at ${n} s: the countdown's new text was ${reported ? '' : 'not '}reported to be read`);
        }
        if (action === 'get_accessibility_tree' && !/Abone ol/.test(ticked.pageContent || '')) {
          throw new Error(`${action} at ${n} s: the wall's own control is gone`);
        }
        const read = await readGateTextsLikeTheAgent(() => readOnce(action, params), readings);
        if (read.pageGate?.type !== 'subscription' || /SECRET_COUNTDOWN_BODY/.test(JSON.stringify(read))) {
          throw new Error(`${action} at ${n} s: the read countdown wall fell: ${JSON.stringify({ pageGate: read.pageGate })}`);
        }
      }
    }

    // A quota read as a wall at 0, shown again with another number: a wall
    // until a model reads the new text, then what that reading says.
    const quota = n => `Bu ay ${n} ücretsiz makale hakkınız kaldı. Kayıt olun.`;
    await setupContentHtml(page, `<!doctype html><meta property="og:type" content="article">
      <article><h1>Kota</h1><p>QUOTA_ARTICLE_BODY bu ay okunabilir.</p></article>
      <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff">
        <p id="count">${quota(3)}</p><button>Kapat</button></div>`, browserKind);
    const quotaText = (await call(page, 'get_page_info_cdp', {})).pageTextsNeeded
      ?.find(entry => /ücretsiz makale/.test(entry.text))?.text || '';
    if (!quotaText) throw new Error('the quota text was not reported');
    const quotaReadings = { [quotaText.replace('3', '0')]: 'registration' };
    const provisional = await call(page, 'get_page_info_cdp', { __wbPageReadings: { page_blocker: quotaReadings } });
    if (provisional.pageGate?.type !== 'registration' || /QUOTA_ARTICLE_BODY/.test(JSON.stringify(provisional))) {
      throw new Error(`a text like a wall but for its number was not that wall at once: ${JSON.stringify({ pageGate: provisional.pageGate })}`);
    }
    if (!(provisional.pageTextsNeeded || []).some(entry => entry.text === quotaText)) {
      throw new Error('a text taken for a wall by its numbers was not reported to be read');
    }
    quotaReadings[quotaText] = 'other';
    const corrected = await call(page, 'get_page_info_cdp', { __wbPageReadings: { page_blocker: quotaReadings } });
    if (corrected.pageGate || !/QUOTA_ARTICLE_BODY/.test(corrected.text || '')) {
      throw new Error(`a quota read as no wall stayed a wall: ${JSON.stringify({ pageGate: corrected.pageGate })}`);
    }
    // Its shape now has a reading as no wall, so another number is asked
    // about, not guessed.
    await page.evaluate(text => { document.querySelector('#count').textContent = text; }, quota(5));
    const another = await call(page, 'get_page_info_cdp', { __wbPageReadings: { page_blocker: quotaReadings } });
    if (another.pageGate || !(another.pageTextsNeeded || []).some(entry => /5 ücretsiz makale/.test(entry.text))) {
      throw new Error(`a quota with a reading as no wall was guessed at another number: ${JSON.stringify({ pageGate: another.pageGate })}`);
    }

    const counter = n => `Bu ay ${n} ücretsiz makale hakkınız kaldı.`;
    await setupContentHtml(page, `<!doctype html><meta property="og:type" content="article">
      <article><h1>Sayaç</h1><p>READABLE_COUNTER_BODY herkes okuyabilir.</p></article>
      <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff">
        <p id="count">${counter(3)}</p><button>Kapat</button></div>`, browserKind);
    const counterReadings = {};
    const read = await readGateTextsLikeTheAgent(
      () => call(page, 'get_page_info_cdp', { __wbPageReadings: { page_blocker: counterReadings } }), counterReadings);
    if (read.pageGate || !/READABLE_COUNTER_BODY/.test(read.text || '')) {
      throw new Error(`a counter read as no wall withheld the page: ${JSON.stringify({ pageGate: read.pageGate })}`);
    }
    await page.evaluate(text => { document.querySelector('#count').textContent = text; }, counter(2));
    const changed = await call(page, 'get_page_info_cdp', { __wbPageReadings: { page_blocker: counterReadings } });
    if (changed.pageGate || !/READABLE_COUNTER_BODY/.test(changed.text || '')) {
      throw new Error(`a changed counter was taken for a wall: ${JSON.stringify({ pageGate: changed.pageGate })}`);
    }
    if (!(changed.pageTextsNeeded || []).some(entry => /2 ücretsiz makale/.test(entry.text))) {
      throw new Error(`a counter read as no wall was not read again when its number changed: ${JSON.stringify(changed.pageTextsNeeded)}`);
    }
  });

  test(`${label}: an article whose body is named for a paywall reads whole, at a bounded cost`, async (page) => {
    await setupContentFixture(page, 'paywall-class-article-no-wall.html', browserKind);
    const stats = { needed: [] };
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {}, stats);
    if (result.pageGate || !/READABLE_BODY_01/.test(result.text || '') || !/READABLE_BODY_30/.test(result.text || '')) {
      throw new Error(`readable paywall-named article mismatch: ${JSON.stringify({ pageGate: result.pageGate, text: String(result.text || '').slice(-300) })}`);
    }
    if (!(stats.needed[0] > 0 && stats.needed[0] <= 12)) {
      throw new Error(`a readable article asked for ${JSON.stringify(stats.needed)} wall readings; at most 12 expected`);
    }
  });

  test(`${label}: a wall's text repeated after the withheld article does not open what lies between`, async (page) => {
    await setupContentFixture(page, 'inline-repeated-prompt-paywall.html', browserKind);
    for (const [action, field] of [['get_page_info_cdp', 'text'], ['get_accessibility_tree', 'pageContent']]) {
      const result = await readWithGateReadings(page, action, action === 'get_accessibility_tree' ? { filter: 'visible', maxDepth: 5 } : {});
      if (result.pageGate?.type !== 'subscription' || !/VISIBLE_REPEAT_PREVIEW/.test(result[field] || '')
        || /SECRET_BETWEEN_PROMPTS|SECRET_AFTER_SECOND_PROMPT/.test(JSON.stringify(result))) {
        throw new Error(`${action}: repeated prompt boundary mismatch: ${JSON.stringify({ pageGate: result.pageGate, text: result[field] })}`);
      }
    }
  });

  test(`${label}: readable article ignores header controls, inline upsells, and hidden gate markup`, async (page) => {
    await setupContentFixture(page, 'readable-article-no-gate.html', browserKind);
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {});
    if (result.pageGate) throw new Error(`false-positive pageGate: ${JSON.stringify(result.pageGate)}`);
    if (!/READABLE_ARTICLE_BODY/.test(result.text || '') || !/READABLE_ARTICLE_AFTER_UPSELL/.test(result.text || '') || result.textSource === 'page-gate') {
      throw new Error(`readable article body missing: ${JSON.stringify({ textSource: result.textSource, text: result.text })}`);
    }
  });

  test(`${label}: a Turkish subscription wall is read by meaning before the article is withheld`, async (page) => {
    await setupContentFixture(page, 'turkish-subscription-overlay.html', browserKind);
    // Unread, the wall decides nothing: the page reads as before and the
    // wall's text goes back to the agent to be read.
    const unread = await call(page, 'get_page_info_cdp', {});
    if (unread.pageGate || !(unread.pageTextsNeeded || []).some(entry => entry.kind === 'page_blocker'
      && /Okumaya devam etmek için abone olun/.test(entry.text))) {
      throw new Error(`unread wall text was not reported: ${JSON.stringify({ pageGate: unread.pageGate, needed: unread.pageTextsNeeded })}`);
    }
    // Read as a subscription wall, it withholds the article and its links.
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {});
    if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog' || result.textSource !== 'page-gate') {
      throw new Error(`Turkish pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (/SECRET_TURKISH_(?:ARTICLE|LINK)/.test(JSON.stringify(result))) {
      throw new Error(`Turkish wall leaked the article: ${JSON.stringify(result)}`);
    }
    const tree = await readWithGateReadings(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (tree.pageGate?.type !== 'subscription' || /SECRET_TURKISH_ARTICLE_BODY/.test(tree.pageContent || '')) {
      throw new Error(`Turkish wall accessibility read mismatch: ${JSON.stringify(tree)}`);
    }
  });

  test(`${label}: non-article signup dialog preserves form controls`, async (page) => {
    await setupContentFixture(page, 'non-article-signup-dialog.html', browserKind);
    const result = await readWithGateReadings(page, 'get_page_info_cdp', {});
    if (result.pageGate) throw new Error(`non-article dialog became a page gate: ${JSON.stringify(result.pageGate)}`);
    if (result.forms?.length !== 1 || result.forms[0]?.inputs?.[0]?.name !== 'email') {
      throw new Error(`signup form was stripped from page info: ${JSON.stringify(result.forms)}`);
    }
    const basicResult = await readWithGateReadings(page, 'get_page_info', {});
    if (basicResult.pageGate || basicResult.forms?.length !== 1) {
      throw new Error(`basic page info stripped the signup form: ${JSON.stringify(basicResult)}`);
    }
    const tree = await readWithGateReadings(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 6 });
    if (tree.pageGate || !/Work email/.test(tree.pageContent || '')) {
      throw new Error(`signup accessibility tree was stripped: ${JSON.stringify(tree)}`);
    }
  });
}

const layeredReadingHtml = `<!doctype html>
  <style>
    body { margin: 0; }
    header { position: fixed; top: 0; width: 100%; height: 40px; z-index: 5; background: white; }
    article { padding: 70px 20px 20px; }
    #read-target { position: absolute; left: 70px; top: 130px; width: 100px; height: 36px; }
    [role="dialog"] { position: fixed; left: 50px; top: 100px; width: 240px; height: 120px; z-index: 20; background: white; }
    [role="toolbar"] { position: fixed; right: 0; bottom: 0; width: 160px; height: 40px; z-index: 10; background: white; }
  </style>
  <header>Pinned navigation</header>
  <article>
    <button id="read-target">Read target</button>
    <p>${'UNDERLYING_ARTICLE_TEXT describes the public inventory and its normal display. '.repeat(8)}</p>
    <table><tr><th>Item</th><th>Count</th></tr><tr><td>Widget</td><td>42</td></tr></table>
  </article>
  <div role="dialog" aria-label="Open filters">Open filters dialog <button>Close filters</button></div>
  <div data-overlay style="position:absolute;left:330px;top:120px;width:140px;height:60px;z-index:11;background:white">Floating panel</div>
  <div role="toolbar">Floating tools</div>
  <div role="dialog" style="display:none">Hidden dialog</div>`;

function assertLayeredPageInfo(result, label) {
  if (result?.pageGate || !result?.text?.includes('UNDERLYING_ARTICLE_TEXT')) {
    throw new Error(`${label}: underlying article was lost: ${JSON.stringify(result)}`);
  }
  const layers = result.visibleLayers || [];
  if (!layers.some(layer => layer.role === 'dialog' && layer.text.includes('Open filters dialog'))
    || !layers.some(layer => layer.role === 'toolbar' && layer.text.includes('Floating tools'))
    || !layers.some(layer => layer.role === 'header' && layer.text.includes('Pinned navigation'))
    || !layers.some(layer => layer.role === 'div' && layer.position === 'absolute' && layer.text.includes('Floating panel'))
    || layers.some(layer => layer.text.includes('Hidden dialog'))
    || layers.some(layer => !Number.isFinite(layer.rect?.x) || !Number.isFinite(layer.rect?.y))) {
    throw new Error(`${label}: visible layer context is incomplete: ${JSON.stringify(layers)}`);
  }
}

async function assertLayeredContentReading(page, browserKind) {
  await setupContentHtml(page, layeredReadingHtml, browserKind);
  const overlapsTarget = await page.evaluate(() => {
    const r = document.getElementById('read-target').getBoundingClientRect();
    return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[role="dialog"]');
  });
  if (!overlapsTarget) throw new Error(`${browserKind}: fixture dialog does not cover the target`);
  const pageInfo = await call(page, 'get_page_info_cdp', {});
  assertLayeredPageInfo(pageInfo, browserKind);
  const basicPageInfo = await call(page, 'get_page_info', {});
  if (!basicPageInfo?.visibleLayers?.some(layer => layer.role === 'dialog' && layer.text.includes('Open filters dialog'))) {
    throw new Error(`${browserKind}: basic page info omitted the dialog: ${JSON.stringify(basicPageInfo?.visibleLayers)}`);
  }
  const tables = await call(page, 'extract_data', { type: 'tables' });
  if (tables?.[0]?.rows?.[1]?.join('|') !== 'Widget|42') {
    throw new Error(`${browserKind}: underlying table data was lost: ${JSON.stringify(tables)}`);
  }
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 8, maxChars: 20000 });
  if (!/button "Read target" \[ref_\d+\][^\n]*occluded=true/.test(tree?.pageContent || '')) {
    throw new Error(`${browserKind}: accessibility tree did not mark the covered target: ${tree?.pageContent}`);
  }
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    for (let i = 0; i < 5; i++) {
      const nav = document.createElement('nav');
      nav.textContent = `Floating navigation ${i}`;
      nav.style.cssText = `position:fixed;left:0;top:${390 + i * 42}px;width:180px;height:32px;background:white`;
      document.body.insertBefore(nav, dialog);
    }
  });
  const crowded = await call(page, 'get_page_info_cdp', {});
  if (crowded.visibleLayers?.length > 4
    || !crowded.visibleLayers?.some(layer => layer.role === 'dialog' && layer.text.includes('Open filters dialog'))) {
    throw new Error(`${browserKind}: dialog was displaced by navigation layers: ${JSON.stringify(crowded.visibleLayers)}`);
  }
}

test('Chrome: layered page read keeps underlying data and visible surfaces', page =>
  assertLayeredContentReading(page, 'chrome'));
firefoxTest('Firefox: layered page read keeps underlying data and visible surfaces', page =>
  assertLayeredContentReading(page, 'firefox'));

test('Chrome CDP mirror: layered page read keeps underlying data and visible surfaces', async (page) => {
  await page.setContent(layeredReadingHtml);
  assertLayeredPageInfo(await readThroughCdpMirror(page), 'CDP mirror');
});

test('read_page windows keep layer context when oversized output is compacted', async () => {
  for (const [label, applyWindow, fitWindow] of [
    ['chrome', applyChromeReadPageWindow, fitChromeReadPageWindowResult],
    ['firefox', applyFirefoxReadPageWindow, fitFirefoxReadPageWindowResult],
  ]) {
    const raw = {
      url: 'https://example.test/article',
      title: 'Layered article',
      text: 'Article text. '.repeat(500),
      visibleLayers: [{ role: 'dialog', text: 'Open filters dialog', position: 'fixed', rect: { x: 50, y: 100, w: 240, h: 120 } }],
      links: Array.from({ length: 100 }, (_, i) => ({ text: `Link ${i}`, href: `https://example.test/${i}` })),
    };
    const fitted = fitWindow(applyWindow(raw, { limit: 6000 }), 1200);
    if (JSON.stringify(fitted).length > 1200 || fitted.visibleLayers?.[0]?.text !== 'Open filters dialog') {
      throw new Error(`${label}: bounded read lost the visible layer: ${JSON.stringify(fitted)}`);
    }
    const oversized = {
      ...raw,
      visibleLayers: [
        { ...raw.visibleLayers[0], role: 'dialog' + 'x'.repeat(10000) },
        ...Array.from({ length: 3 }, (_, i) => ({
          role: 'toolbar', text: `Toolbar ${i} ${'x'.repeat(220)}`, position: 'fixed',
          rect: { x: 0, y: i * 30, w: 800, h: 30 },
        })),
      ],
    };
    const bounded = fitWindow(applyWindow(oversized, { limit: 6000 }), 1200);
    if (JSON.stringify(bounded).length > 1200
      || bounded.visibleLayers?.[0]?.text !== 'Open filters dialog'
      || bounded.visibleLayers[0].role.length > 80) {
      throw new Error(`${label}: oversized layer metadata broke the read_page cap: ${JSON.stringify(bounded)}`);
    }
  }
});

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

test('Chrome CDP mirror keeps a wrapped preview readable and withholds the rest after a long preview', async (page) => {
  await page.goto(fixtureUrl('inline-wrapped-preview-paywall.html'));
  const wrapped = await readThroughCdpMirror(page);
  if (wrapped.pageGate?.type !== 'subscription' || wrapped.pageGate?.surface !== 'inline'
    || !/WRAPPED_PREVIEW_PARAGRAPH/.test(wrapped.text || '') || /SECRET_WRAPPED_REST_PARAGRAPH/.test(JSON.stringify(wrapped))) {
    throw new Error(`CDP wrapped preview mismatch: ${JSON.stringify({ pageGate: wrapped.pageGate, text: wrapped.text })}`);
  }
  await page.goto(fixtureUrl('inline-long-preview-paywall.html'));
  const long = await readThroughCdpMirror(page);
  if (long.pageGate?.type !== 'subscription' || !/LONG_PREVIEW_SIX/.test(long.text || '')
    || /SECRET_LONG_REST_PARAGRAPH/.test(JSON.stringify(long))) {
    throw new Error(`CDP long preview mismatch: ${JSON.stringify({ pageGate: long.pageGate, text: long.text })}`);
  }
});

test('Chrome CDP mirror does not open the article between a wall text and its repeat', async (page) => {
  await page.goto(fixtureUrl('inline-repeated-prompt-paywall.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate?.type !== 'subscription' || !/VISIBLE_REPEAT_PREVIEW/.test(result.text || '')
    || /SECRET_BETWEEN_PROMPTS|SECRET_AFTER_SECOND_PROMPT/.test(JSON.stringify(result))) {
    throw new Error(`CDP repeated prompt mismatch: ${JSON.stringify({ pageGate: result.pageGate, text: result.text })}`);
  }
});

test('Chrome CDP mirror withholds the article after walls the content script finds', async (page) => {
  for (const [fixture, secret] of [
    ['inline-bare-prompt-paywall.html', /SECRET_BARE_(?:BETWEEN|AFTER)/],
    ['inline-close-repeat-paywall.html', /SECRET_CLOSE_(?:SHORT|AFTER)/],
    ['inline-long-hidden-paywall.html', /HIDDEN_LINE_\d\d/],
    ['inline-long-paragraph-paywall.html', /SECRET_PARAGRAPH_REST/],
    ['inline-many-blocks-paywall.html', /SECRET_MANY_REST/],
    ['inline-middle-wall-paywall.html', /SECRET_MIDDLE_REST/],
    ['inline-span-words-paywall.html', /SECRET_SPAN_REST/],
    ['inline-locked-box-paywall.html', /SECRET_LOCKED/],
    ['dialog-long-intro-wall.html', /SECRET_DIALOG_ARTICLE_BODY/],
    ['overlay-among-many-blocks.html', /SECRET_NOTES_ARTICLE_BODY/],
  ]) {
    await page.goto(fixtureUrl(fixture));
    const result = await readThroughCdpMirror(page);
    if (!['subscription', 'registration', 'login'].includes(result.pageGate?.type) || secret.test(JSON.stringify(result))) {
      throw new Error(`CDP ${fixture} mismatch: ${JSON.stringify({ pageGate: result.pageGate, text: result.text })}`);
    }
  }
  await page.goto(fixtureUrl('paywall-class-article-no-wall.html'));
  const stats = { needed: [] };
  const readable = await readThroughCdpMirror(page, {}, stats);
  if (readable.pageGate || !/READABLE_BODY_30/.test(readable.text || '') || !(stats.needed[0] > 0 && stats.needed[0] <= 12)) {
    throw new Error(`CDP readable paywall-named article mismatch: ${JSON.stringify({ pageGate: readable.pageGate, needed: stats.needed })}`);
  }
});

test('Chrome CDP mirror keys a wall text cut at its length limit as the agent does', async (page) => {
  // The overlay's text has a space at its 400th and at its 600th character,
  // where a page read cuts it; the agent keys its reading without that space.
  const opening = 'Okumaya devam etmek için abone olun. ';
  const text = opening + 'x'.repeat(399 - opening.length) + ' ' + 'z'.repeat(199) + ' ' + 'CUT_TAIL ' + 'y'.repeat(80);
  if (text[399] !== ' ' || text[599] !== ' ') throw new Error('the fixture text must have spaces at its 400th and 600th characters');
  await page.setContent(`<!doctype html><meta property="og:type" content="article">
    <article><h1>Kesik duvar</h1><p>SECRET_CUT_ARTICLE_BODY sunucuda çizilmiştir.</p></article>
    <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff"><p>${text}</p></div>`);
  const result = await readThroughCdpMirror(page);
  if (result.pageGate?.type !== 'subscription' || result.textSource !== 'page-gate' || /SECRET_CUT_ARTICLE_BODY/.test(JSON.stringify(result))) {
    throw new Error(`CDP cut wall text mismatch: ${JSON.stringify({ pageGate: result.pageGate, textSource: result.textSource })}`);
  }
});

test('Chrome CDP mirror keeps a wall whose number changes a wall while its new text is read', async (page) => {
  const countdown = n => `Okumaya devam etmek için abone olun. Kalan süre: ${n} sn`;
  await page.setContent(`<!doctype html><meta property="og:type" content="article">
    <article><h1>Geri sayım</h1><p>SECRET_COUNTDOWN_BODY sunucuda çizilmiştir.</p></article>
    <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff">
      <p id="count">${countdown(59)}</p><button>Abone ol</button></div>`);
  const client = new CDPClient();
  client.evaluate = async (_tabId, expression) => ({ result: { value: await page.evaluate(expression) } });
  const readings = {};
  const first = await readGateTextsLikeTheAgent(() => client.readPage(1, { pageBlockerReadings: readings }), readings);
  if (first.pageGate?.type !== 'subscription' || /SECRET_COUNTDOWN_BODY/.test(JSON.stringify(first))) {
    throw new Error(`CDP countdown wall was not applied: ${JSON.stringify({ pageGate: first.pageGate })}`);
  }
  await page.evaluate(text => { document.querySelector('#count').textContent = text; }, countdown(58));
  const ticked = await client.readPage(1, { pageBlockerReadings: readings });
  if (ticked.pageGate?.type !== 'subscription' || /SECRET_COUNTDOWN_BODY/.test(JSON.stringify(ticked))
      || !(ticked.pageTextsNeeded || []).some(entry => /Kalan süre: 58 sn/.test(entry.text))) {
    throw new Error(`CDP countdown wall mismatch: ${JSON.stringify({ pageGate: ticked.pageGate, needed: ticked.pageTextsNeeded })}`);
  }
  // Read at 58 s too, the shape is confirmed: 57 s is the wall without a read.
  await readGateTextsLikeTheAgent(() => client.readPage(1, { pageBlockerReadings: readings }), readings);
  await page.evaluate(text => { document.querySelector('#count').textContent = text; }, countdown(57));
  const confirmed = await client.readPage(1, { pageBlockerReadings: readings });
  if (confirmed.pageGate?.type !== 'subscription' || /SECRET_COUNTDOWN_BODY/.test(JSON.stringify(confirmed))
      || (confirmed.pageTextsNeeded || []).some(entry => /Kalan süre/.test(entry.text))) {
    throw new Error(`CDP confirmed countdown mismatch: ${JSON.stringify({ pageGate: confirmed.pageGate, needed: confirmed.pageTextsNeeded })}`);
  }
  // A quota like a wall but for its number is a wall until its own text is read.
  const quota = n => `Bu ay ${n} ücretsiz makale hakkınız kaldı. Kayıt olun.`;
  await page.setContent(`<!doctype html><meta property="og:type" content="article">
    <article><h1>Kota</h1><p>QUOTA_ARTICLE_BODY bu ay okunabilir.</p></article>
    <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff">
      <p id="count">${quota(3)}</p><button>Kapat</button></div>`);
  const quotaText = (await client.readPage(1, {})).pageTextsNeeded?.find(entry => /ücretsiz makale/.test(entry.text))?.text || '';
  const quotaReadings = { [quotaText.replace('3', '0')]: 'registration' };
  const provisional = await client.readPage(1, { pageBlockerReadings: quotaReadings });
  if (!quotaText || provisional.pageGate?.type !== 'registration' || /QUOTA_ARTICLE_BODY/.test(JSON.stringify(provisional))
      || !(provisional.pageTextsNeeded || []).some(entry => entry.text === quotaText)) {
    throw new Error(`CDP provisional quota wall mismatch: ${JSON.stringify({ pageGate: provisional.pageGate, needed: provisional.pageTextsNeeded })}`);
  }
  quotaReadings[quotaText] = 'other';
  const corrected = await client.readPage(1, { pageBlockerReadings: quotaReadings });
  if (corrected.pageGate || !/QUOTA_ARTICLE_BODY/.test(JSON.stringify(corrected))) {
    throw new Error(`CDP quota read as no wall stayed a wall: ${JSON.stringify({ pageGate: corrected.pageGate })}`);
  }
  // A counter read as no wall is read again when its number changes.
  const counter = n => `Bu ay ${n} ücretsiz makale hakkınız kaldı.`;
  await page.setContent(`<!doctype html><meta property="og:type" content="article">
    <article><h1>Sayaç</h1><p>READABLE_COUNTER_BODY herkes okuyabilir.</p></article>
    <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff">
      <p id="count">${counter(3)}</p><button>Kapat</button></div>`);
  const counterReadings = {};
  await readGateTextsLikeTheAgent(() => client.readPage(1, { pageBlockerReadings: counterReadings }), counterReadings);
  await page.evaluate(text => { document.querySelector('#count').textContent = text; }, counter(2));
  const changed = await client.readPage(1, { pageBlockerReadings: counterReadings });
  if (changed.pageGate || !(changed.pageTextsNeeded || []).some(entry => /2 ücretsiz makale/.test(entry.text))) {
    throw new Error(`CDP changed counter mismatch: ${JSON.stringify({ pageGate: changed.pageGate, needed: changed.pageTextsNeeded })}`);
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
  test(`${label}: selection shortcut localizes labels, direction, and fixed-action language`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, locale: 'zh' });
    const localized = await selectFixtureText(page);
    if (localized.summarizeLabel !== '总结'
        || localized.quizLabel !== '测验我'
        || localized.popupActions.join('|') !== 'summarize|quiz|humanize'
        || localized.actionIconCount !== 3
        || localized.barLabels.join('|') !== '翻译|解释|校对|更多…'
        || localized.followUpPlaceholder !== '继续追问'
        || localized.direction !== 'ltr') {
      throw new Error(`Chinese shortcut localization mismatch: ${JSON.stringify(localized)}`);
    }

    await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('explain'));
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const submitted = await page.evaluate(() => window.__selectionMessages[0]);
    if (submitted.action !== 'explain'
        || submitted.language !== 'zh'
        || Object.prototype.hasOwnProperty.call(submitted, 'includePageContext')) {
      throw new Error(`fixed action did not carry the Chinese interface language: ${JSON.stringify(submitted)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('ar'));
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().direction === 'rtl');
    const rtl = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (rtl.summarizeLabel !== 'تلخيص' || rtl.actionIconCount !== 3) {
      throw new Error(`live Arabic localization mismatch: ${JSON.stringify(rtl)}`);
    }
  });

  test(`${label}: custom selection questions default to page context and retain a scoped choice`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, locale: 'zh' });
    const initial = await selectFixtureText(page);
    if (!initial.includePageContextChecked
        || initial.includePageContextLabel !== '包含页面和对话上下文'
        || initial.hideLabel !== '隐藏此项') {
      throw new Error(`full-context choice should be localized and on by default: ${JSON.stringify(initial)}`);
    }
    await page.evaluate(() => {
      window.__webbrainSelectionShortcut.setIncludePageContext(false);
      return window.__webbrainSelectionShortcut.submitCustom('仅根据选中内容回答。');
    });
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const submitted = await page.evaluate(() => window.__selectionMessages[0]);
    if (submitted.action !== 'custom'
        || submitted.question !== '仅根据选中内容回答。'
        || submitted.includePageContext !== false) {
      throw new Error(`custom question lost its explicit scoped-context choice: ${JSON.stringify(submitted)}`);
    }

    await page.waitForFunction(() => !window.__webbrainSelectionShortcut.getState().submitting);
    const nextSelection = await selectFixtureText(page);
    if (!nextSelection.includePageContextChecked) {
      throw new Error(`a new selection should restore the default-on page-context choice: ${JSON.stringify(nextSelection)}`);
    }
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitCustom('现在有哪些跨平台框架？'));
    await page.waitForFunction(() => window.__selectionMessages.length === 2);
    const submittedAgain = await page.evaluate(() => window.__selectionMessages[1]);
    if (submittedAgain.action !== 'custom'
        || submittedAgain.question !== '现在有哪些跨平台框架？'
        || submittedAgain.includePageContext !== true) {
      throw new Error(`the default custom question did not request page and conversation context: ${JSON.stringify(submittedAgain)}`);
    }
  });

  test(`${label}: selection shortcut clamps to the viewport and supports keyboard dismissal`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const state = await selectFixtureText(page);
    const rect = state.shortcutRect;
    if (!rect || rect.left < 8 || rect.top < 8 || rect.right > 352 || rect.bottom > 272) {
      throw new Error(`shortcut was not clamped to the viewport: ${JSON.stringify(rect)}`);
    }
    if (!state.selectionRect || rect.bottom > state.selectionRect.top) {
      throw new Error(`shortcut should prefer the top of the selected text: ${JSON.stringify(state)}`);
    }
    if (state.shortcutLabel !== 'Ask WebBrain about this'
        || state.shortcutBackground !== 'rgb(255, 255, 255)'
        || state.shortcutColor !== 'rgb(23, 23, 34)'
        || state.shortcutBoxShadow === 'none'
        || state.barLabels.join('|') !== 'Translate|Explain|Proofread|More…') {
      throw new Error(`shortcut should be a white action bar: Translate, Explain, Proofread, More: ${JSON.stringify(state)}`);
    }
    const moreRect = state.moreRect;
    await page.mouse.click(moreRect.left + moreRect.width / 2, moreRect.top + moreRect.height / 2);
    let popupState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!popupState.popupVisible) throw new Error('popup did not open for the selected text');
    await page.keyboard.press('Escape');
    popupState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (popupState.popupVisible || !popupState.shortcutVisible) {
      throw new Error(`Escape should close the popup and retain the shortcut: ${JSON.stringify(popupState)}`);
    }

    await page.mouse.move(0, 0);

    await page.evaluate(() => {
      const topCopy = document.createElement('p');
      topCopy.id = 'top-copy';
      topCopy.style.cssText = 'position:absolute;left:74px;top:2px;width:210px;margin:0';
      topCopy.textContent = 'A multiline selection near the top edge must keep the shortcut below every selected line.';
      document.body.appendChild(topCopy);
    });
    const topState = await selectFixtureText(page, '#top-copy');
    if (!topState.selectionRect
        || topState.selectionRect.top >= 52
        || !topState.selectionBottom
        || topState.shortcutRect.top < topState.selectionBottom + 7) {
      throw new Error(`top-edge fallback should clear the full visible selection: ${JSON.stringify(topState)}`);
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
      selectedState.moreRect.left + selectedState.moreRect.width / 2,
      selectedState.moreRect.top + selectedState.moreRect.height / 2,
    );
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!openState.questionRect || openState.highlightRectCount < 1) {
      throw new Error(`popup should preserve a visual marker for the selected text: ${JSON.stringify(openState)}`);
    }
    if (!openState.hideRect
        || openState.hideLabel !== 'Hide this'
        || openState.hideRect.width >= openState.summarizeRect.width
        || Math.abs(openState.hideRect.right - openState.summarizeRect.right) > 0.5) {
      throw new Error(`Hide this should be a compact right-aligned footer action: ${JSON.stringify(openState)}`);
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
    // Dismissal moves focus before the chord finishes. Hold both keys until
    // that happens so the modifier-release ownership race is deterministic.
    await page.keyboard.down('Control');
    await page.keyboard.down('Enter');
    await page.waitForFunction(() => !window.__webbrainSelectionShortcut.getState().popupVisible);
    await page.keyboard.up('Enter');
    await page.keyboard.up('Control');
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
    await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
    await page.keyboard.press('Control');
    const unrelatedKeys = await page.evaluate(() => window.__selectionPageKeys);
    if (!unrelatedKeys.includes('down:Control') || !unrelatedKeys.includes('up:Control')) {
      throw new Error(`completed dialog chord swallowed a new page key stroke: ${JSON.stringify(unrelatedKeys)}`);
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
      selectedState.moreRect.left + selectedState.moreRect.width / 2,
      selectedState.moreRect.top + selectedState.moreRect.height / 2,
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
    const moreRect = selectedState.moreRect;
    await page.mouse.click(moreRect.left + moreRect.width / 2, moreRect.top + moreRect.height / 2);
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
    if (result.messages[0].language !== 'en') {
      throw new Error(`fixed action did not carry the interface language: ${JSON.stringify(result.messages[0])}`);
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
    const translationShortcutRect = translationSelection.moreRect;
    await page.mouse.click(
      translationShortcutRect.left + translationShortcutRect.width / 2,
      translationShortcutRect.top + translationShortcutRect.height / 2,
    );
    const presetState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const presetRect = presetState.summarizeRect;
    if (!presetRect) throw new Error('Summarize action was not visible in the popup');
    await page.mouse.click(presetRect.left + presetRect.width / 2, presetRect.top + presetRect.height / 2);
    await page.waitForFunction(() => window.__selectionMessages.length === 3);
    const summarized = await page.evaluate(() => ({
      message: window.__selectionMessages[2],
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (summarized.message.action !== 'summarize' || summarized.message.language !== 'tr') {
      throw new Error(`popup preset was not submitted correctly: ${JSON.stringify(summarized.message)}`);
    }
    if (summarized.state.popupVisible || summarized.state.shortcutVisible) {
      throw new Error(`a popup preset should submit directly and dismiss the surface: ${JSON.stringify(summarized.state)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('fr'));
    const updatedLocaleSelection = await selectFixtureText(page);
    const updatedLocaleShortcutRect = updatedLocaleSelection.moreRect;
    await page.mouse.click(
      updatedLocaleShortcutRect.left + updatedLocaleShortcutRect.width / 2,
      updatedLocaleShortcutRect.top + updatedLocaleShortcutRect.height / 2,
    );
    const updatedLocaleState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    await page.mouse.click(
      updatedLocaleState.summarizeRect.left + updatedLocaleState.summarizeRect.width / 2,
      updatedLocaleState.summarizeRect.top + updatedLocaleState.summarizeRect.height / 2,
    );
    await page.waitForFunction(() => window.__selectionMessages.length === 4);
    const updatedLocaleMessage = await page.evaluate(() => window.__selectionMessages[3]);
    if (updatedLocaleMessage.action !== 'summarize' || updatedLocaleMessage.language !== 'fr') {
      throw new Error(`the popup preset did not follow the updated plugin locale: ${JSON.stringify(updatedLocaleMessage)}`);
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

  test(`${label}: Explain answers in a page card and renders the answer safely`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionInlineHandler = async () => ({
        ok: true,
        text: 'It means **words** near the edge, *roughly*.\n\n- First point with `code`\n- Second point, 2 * 3 * 4 stays literal\n<img src=x onerror="window.__xss=1">',
      });
    });
    await openInlineCard(page, 'explain');
    const loading = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!loading.cardVisible || loading.shortcutVisible || loading.cardKind !== 'explain' || loading.highlightRectCount < 1) {
      throw new Error(`Explain should replace the bar with a card and keep the selection marked: ${JSON.stringify(loading)}`);
    }
    const ready = await waitForCardStatus(page, 'ready');
    const inline = await page.evaluate(() => window.__selectionInlineMessages);
    const sidebar = await page.evaluate(() => window.__selectionMessages);
    if (inline.length !== 1 || sidebar.length !== 0
        || inline[0].action !== 'explain'
        || inline[0].language !== 'en'
        || !/Selected words near the viewport edge/.test(inline[0].selectionText)) {
      throw new Error(`Explain should make one in-page request and no side-panel request: ${JSON.stringify({ inline, sidebar })}`);
    }
    if (!/<strong>words<\/strong>/.test(ready.cardHtml)
        || !/<code>code<\/code>/.test(ready.cardHtml)
        || (ready.cardHtml.match(/<li>/g) || []).length !== 2
        || !/<em>roughly<\/em>/.test(ready.cardHtml)
        || !/2 \* 3 \* 4 stays literal/.test(ready.cardHtml)
        || /<img/i.test(ready.cardHtml)
        || await page.evaluate(() => window.__xss === 1)) {
      throw new Error(`the answer should render as safe text with bold, code and bullets: ${ready.cardHtml}`);
    }
    const card = ready.cardRect;
    if (card.left < 8 || card.top < 8 || card.right > 352 || card.bottom > 272
        || card.bottom > ready.selectionRect.top + 0.5
        || ready.cardSide !== 'above') {
      throw new Error(`the card should stay in the viewport and clear the selected text: ${JSON.stringify(ready)}`);
    }
    if (ready.followUpPlaceholder !== 'Ask a follow-up') {
      throw new Error(`the card should offer a follow-up input: ${JSON.stringify(ready)}`);
    }

    // Escape closes the card, keeps the bar, and returns focus to the button that opened it.
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (closed.cardVisible || !closed.shortcutVisible || closed.highlightRectCount !== 0) {
      throw new Error(`Escape should close the card and restore the bar: ${JSON.stringify(closed)}`);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().cardVisible);
    await waitForCardStatus(page, 'ready');
    if ((await page.evaluate(() => window.__selectionInlineMessages.length)) !== 2) {
      throw new Error('focus should return to the Explain button so Enter reopens the card');
    }

    // A click outside dismisses the card and the bar.
    await page.mouse.click(5, 5);
    const outside = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (outside.cardVisible || outside.shortcutVisible) {
      throw new Error(`a click outside should dismiss the card: ${JSON.stringify(outside)}`);
    }
  });

  test(`${label}: a card follow-up continues in the side panel with the answer as context`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionPageKeys = [];
      for (const type of ['keydown', 'keypress', 'keyup']) {
        document.addEventListener(type, (event) => window.__selectionPageKeys.push(`${type}:${event.key}`));
      }
    });
    await openInlineCard(page, 'explain');
    let state = await waitForCardStatus(page, 'ready');
    await clickRectCenter(page, state.followUpRect);
    // An empty follow-up must not send anything.
    await page.keyboard.press('Enter');
    if ((await page.evaluate(() => window.__selectionMessages.length)) !== 0) {
      throw new Error('an empty follow-up should not be sent');
    }
    await page.keyboard.type('Why does it matter?');
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (state.followUpValue !== 'Why does it matter?' || state.followUpSendDisabled) {
      throw new Error(`typing should enable the follow-up send button: ${JSON.stringify(state)}`);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const result = await page.evaluate(() => ({
      message: window.__selectionMessages[0],
      surface: window.__webbrainSelectionShortcut.getState(),
      pageKeys: window.__selectionPageKeys,
    }));
    const message = result.message;
    if (message.action !== 'custom'
        || message.question !== 'Why does it matter?'
        || message.priorAction !== 'explain'
        || message.priorAnswer !== 'Mock explain answer for en'
        || message.includePageContext !== true
        || message.language !== undefined
        || !/Selected words near the viewport edge/.test(message.selectionText)) {
      throw new Error(`the follow-up should carry the selection, question and earlier answer: ${JSON.stringify(message)}`);
    }
    if (result.surface.cardVisible || result.surface.shortcutVisible || result.surface.highlightRectCount !== 0) {
      throw new Error(`sending a follow-up should dismiss the card: ${JSON.stringify(result.surface)}`);
    }
    if (result.pageKeys.length) throw new Error(`card keystrokes leaked to the page: ${JSON.stringify(result.pageKeys)}`);

    // The arrow button sends too.
    await page.waitForFunction(() => !window.__webbrainSelectionShortcut.getState().submitting);
    await openInlineCard(page, 'proofread');
    state = await waitForCardStatus(page, 'ready');
    await clickRectCenter(page, state.followUpRect);
    await page.keyboard.type('Any other fixes?');
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    await clickRectCenter(page, state.followUpSendRect);
    await page.waitForFunction(() => window.__selectionMessages.length === 2);
    const second = await page.evaluate(() => window.__selectionMessages[1]);
    if (second.question !== 'Any other fixes?' || second.priorAction !== 'proofread') {
      throw new Error(`the send button should send the follow-up: ${JSON.stringify(second)}`);
    }
  });

  test(`${label}: Translate detects the source language and lets the target change`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, promiseDetect: manualOpen });
    await page.evaluate(() => { window.__selectionDetectedLanguage = 'fr'; });
    await openInlineCard(page, 'translate');
    let state = await waitForCardStatus(page, 'ready');
    if (state.cardSourceLabel !== 'French'
        || state.cardTarget !== 'en'
        || state.cardTargetLabel !== 'English'
        || state.cardTargetOptionCount !== 24
        || !/Selected words near the viewport edge/.test(state.cardQuote)
        || state.cardText !== 'Mock translate answer for en') {
      throw new Error(`Translate should show source, target, original and translation: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => window.__webbrainSelectionShortcut.chooseTarget('de'));
    await page.waitForFunction(() => window.__selectionInlineMessages.length === 2
      && window.__webbrainSelectionShortcut.getState().cardStatus === 'ready');
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const messages = await page.evaluate(() => window.__selectionInlineMessages);
    if (messages[1].action !== 'translate' || messages[1].language !== 'de'
        || state.cardText !== 'Mock translate answer for de'
        || state.cardTargetLabel !== 'German') {
      throw new Error(`changing the target should translate again: ${JSON.stringify({ messages, state })}`);
    }
  });

  test(`${label}: Translate waits for a target when the text is already in the interface language`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => { window.__selectionDetectedLanguage = 'en'; });
    await openInlineCard(page, 'translate');
    let state = await waitForCardStatus(page, 'idle');
    if (state.cardSourceLabel !== 'English' || state.cardTarget !== '' || state.cardTargetLabel !== 'Translate to') {
      throw new Error(`Translate should ask for a target instead of echoing the text: ${JSON.stringify(state)}`);
    }
    if ((await page.evaluate(() => window.__selectionInlineMessages.length)) !== 0) {
      throw new Error('no model call should be made when source and target are the same language');
    }
    await page.evaluate(() => window.__webbrainSelectionShortcut.chooseTarget('es'));
    state = await waitForCardStatus(page, 'ready');
    const messages = await page.evaluate(() => window.__selectionInlineMessages);
    if (messages.length !== 1 || messages[0].language !== 'es') {
      throw new Error(`choosing a target should start the translation: ${JSON.stringify(messages)}`);
    }
  });

  test(`${label}: Translate still offers a target list when the language bundle cannot be loaded`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, failLocalization: true });
    await page.evaluate(() => { window.__selectionDetectedLanguage = 'en'; });
    await openInlineCard(page, 'translate');
    let state = await waitForCardStatus(page, 'idle');
    const options = await page.evaluate(() => window.__webbrainSelectionShortcut.getState().cardTargetOptions);
    if (state.cardTargetLabel !== 'Translate to' || !(options > 20)) {
      throw new Error(`the English fallback card should still list target languages: ${JSON.stringify({ state, options })}`);
    }
    await page.evaluate(() => window.__webbrainSelectionShortcut.chooseTarget('es'));
    state = await waitForCardStatus(page, 'ready');
    const messages = await page.evaluate(() => window.__selectionInlineMessages);
    if (messages.length !== 1 || messages[0].language !== 'es') {
      throw new Error(`choosing a target should start the translation: ${JSON.stringify(messages)}`);
    }
  });

  test(`${label}: Proofread follows the interface language and direction`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, locale: 'ar' });
    await openInlineCard(page, 'proofread');
    const state = await waitForCardStatus(page, 'ready');
    const messages = await page.evaluate(() => window.__selectionInlineMessages);
    if (messages.length !== 1 || messages[0].action !== 'proofread' || messages[0].language !== 'ar'
        || state.direction !== 'rtl'
        || state.barLabels[1] !== 'شرح'
        || state.cardText !== 'Mock proofread answer for ar') {
      throw new Error(`Proofread should use the Arabic interface: ${JSON.stringify({ messages, state })}`);
    }
  });

  test(`${label}: Proofread preserves whitespace-sensitive corrections`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const correction = '    def example():\n    return {\n        "answer": 42,\n    }\n';
    await page.evaluate((text) => {
      window.__selectionInlineHandler = async () => ({ ok: true, text });
    }, correction);
    await openInlineCard(page, 'proofread');
    const state = await waitForCardStatus(page, 'ready');
    if (state.cardText !== correction) {
      throw new Error(`Proofread should preserve its whitespace: ${JSON.stringify(state.cardText)}`);
    }
  });

  test(`${label}: inline responses preserve edge whitespace`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const answer = '    key: value\n';
    await page.evaluate((text) => {
      window.__selectionInlineHandler = async () => ({ ok: true, text });
    }, answer);
    await openInlineCard(page, 'translate');
    const state = await waitForCardStatus(page, 'ready');
    if (state.cardText !== answer) {
      throw new Error(`an inline response should preserve edge whitespace: ${JSON.stringify(state.cardText)}`);
    }
  });

  test(`${label}: a failed card answer offers a retry, and a follow-up waits for an answer`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionInlineCalls = 0;
      window.__selectionInlineHandler = async () => {
        window.__selectionInlineCalls += 1;
        if (window.__selectionInlineCalls === 1) return { ok: false, error: 'No provider configured' };
        if (window.__selectionInlineCalls === 2) throw new Error('Extension context invalidated');
        return { ok: true, text: 'Recovered answer' };
      };
    });
    await openInlineCard(page, 'explain');
    let state = await waitForCardStatus(page, 'error');
    if (state.cardError !== 'No provider configured' || !state.retryRect) {
      throw new Error(`a failed answer should show the reason and a retry button: ${JSON.stringify(state)}`);
    }
    await clickRectCenter(page, state.retryRect);
    await page.waitForFunction(() => window.__selectionInlineCalls === 2);
    state = await waitForCardStatus(page, 'error');
    if (!/Extension context invalidated/.test(state.cardError)) {
      throw new Error(`a rejected request should also end in the error state: ${JSON.stringify(state)}`);
    }
    await clickRectCenter(page, state.retryRect);
    state = await waitForCardStatus(page, 'ready');
    if (state.cardText !== 'Recovered answer') throw new Error(`retry should recover: ${JSON.stringify(state)}`);

    await page.evaluate(() => {
      window.__selectionInlineHandler = async () => ({ ok: false, error: 'Offline' });
    });
    await page.keyboard.press('Escape');
    await openInlineCard(page, 'explain');
    state = await waitForCardStatus(page, 'error');
    await clickRectCenter(page, state.followUpRect);
    await page.keyboard.type('Still there?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(60);
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const sentAfterFailure = await page.evaluate(() => window.__selectionMessages.length);
    if (sentAfterFailure !== 0 || !state.cardVisible || state.followUpValue !== 'Still there?' || !state.followUpSendDisabled) {
      throw new Error(`a follow-up must not be sent when there is no answer to continue from: ${JSON.stringify({ sentAfterFailure, state })}`);
    }
  });

  test(`${label}: a follow-up typed while the answer loads is held until it arrives`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionInlineHandler = () => new Promise((resolve) => { window.__resolveInline = resolve; });
    });
    await openInlineCard(page, 'explain');
    let state = await waitForCardStatus(page, 'loading');
    await clickRectCenter(page, state.followUpRect);
    await page.keyboard.type('And why?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(60);
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const early = await page.evaluate(() => ({
      sent: window.__selectionMessages.length,
      cancels: window.__selectionCancelMessages.length,
    }));
    if (early.sent !== 0 || early.cancels !== 0 || state.cardStatus !== 'loading'
        || state.followUpValue !== 'And why?' || !state.followUpSendDisabled) {
      throw new Error(`sending while loading must neither dismiss the card nor cancel its request: ${JSON.stringify({ early, state })}`);
    }
    await page.evaluate(() => window.__resolveInline({ ok: true, text: 'Because it matters.' }));
    state = await waitForCardStatus(page, 'ready');
    if (state.followUpSendDisabled || state.followUpValue !== 'And why?') {
      throw new Error(`the typed follow-up should become sendable once the answer is there: ${JSON.stringify(state)}`);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const message = await page.evaluate(() => window.__selectionMessages[0]);
    if (message.question !== 'And why?' || message.priorAnswer !== 'Because it matters.' || message.priorAction !== 'explain') {
      throw new Error(`the follow-up should carry the answer it continues from: ${JSON.stringify(message)}`);
    }
  });

  test(`${label}: closing a card ignores its late answer`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionInlineHandler = () => new Promise((resolve) => { window.__resolveInline = resolve; });
    });
    await openInlineCard(page, 'explain');
    const loading = await waitForCardStatus(page, 'loading');
    if (!loading.cardRect || loading.cardRect.height < 60) {
      throw new Error(`the loading card should reserve room for the answer: ${JSON.stringify(loading)}`);
    }
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__resolveInline({ ok: true, text: 'Late answer' }));
    await page.waitForTimeout(40);
    const state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (state.cardVisible || state.cardStatus !== '' || state.cardText || !state.shortcutVisible) {
      throw new Error(`a late answer must not reopen or fill a closed card: ${JSON.stringify(state)}`);
    }
  });

  for (const [locale, width] of [['en', 320], ['de', 320], ['ru', 300], ['tr', 300], ['en', 240]]) {
    test(`${label}: every bar action stays reachable at ${width}px in ${locale}`, async (page) => {
      await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, locale });
      await page.setViewportSize({ width, height: 280 });
      const selected = await selectFixtureText(page);
      const bar = selected.shortcutRect;
      const buttons = { ...selected.inlineRects, more: selected.moreRect };
      for (const [name, rect] of Object.entries(buttons)) {
        const inside = rect
          && rect.left >= bar.left - 0.5 && rect.right <= bar.right + 0.5
          && rect.left >= 0 && rect.right <= width
          && rect.width >= 24;
        if (!inside) {
          throw new Error(`the ${name} button is clipped or off screen: ${JSON.stringify({ bar, rect, labels: selected.barLabels })}`);
        }
      }
      if (bar.left < 0 || bar.right > width + 0.5) {
        throw new Error(`the bar overflows the viewport: ${JSON.stringify(bar)}`);
      }
      await clickRectCenter(page, selected.moreRect);
      await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().popupVisible);
    });
  }

  test(`${label}: an output limit with no text left offers only the side panel, not a retry`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionInlineHandler = async () => ({
        ok: false,
        truncated: true,
        error: 'The answer was cut off before any text was produced.',
      });
    });
    await openInlineCard(page, 'proofread');
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().cardTruncated);
    let state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (state.cardStatus !== 'error' || state.retryRect || state.cardError || !state.continueRect || !state.cutNoticeText) {
      throw new Error(`a cut-off without text should show the notice and the side-panel button only: ${JSON.stringify(state)}`);
    }
    await clickRectCenter(page, state.continueRect);
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const message = await page.evaluate(() => window.__selectionMessages[0]);
    if (message.action !== 'proofread' || !/Selected words near the viewport edge/.test(message.selectionText)) {
      throw new Error(`continuing should hand the same action to the side panel: ${JSON.stringify(message)}`);
    }

    // A plain failure is unchanged: the reason and a retry, no side-panel button.
    await page.evaluate(() => {
      window.__selectionInlineHandler = async () => ({ ok: false, error: 'No provider configured' });
    });
    await openInlineCard(page, 'explain');
    state = await waitForCardStatus(page, 'error');
    if (state.cardTruncated || state.continueRect || !state.retryRect || state.cardError !== 'No provider configured') {
      throw new Error(`an ordinary failure must keep its retry and reason: ${JSON.stringify(state)}`);
    }
  });

  test(`${label}: a double click while the language bundle loads starts one card and one model call`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, holdLocalization: true });
    const selected = await selectFixtureText(page);
    await clickRectCenter(page, selected.inlineRects.explain);
    await clickRectCenter(page, selected.inlineRects.explain);
    // The start-up request plus one per click are now waiting on the held bundle.
    await page.waitForFunction(() => window.__selectionLocalizationRequests >= 3);
    await page.evaluate(() => window.__releaseLocalization());
    await waitForCardStatus(page, 'ready');
    await page.waitForTimeout(60);
    const result = await page.evaluate(() => ({
      inline: window.__selectionInlineMessages.length,
      cancels: window.__selectionCancelMessages.length,
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (result.inline !== 1 || result.cancels !== 0 || !result.state.cardVisible || result.state.cardText !== 'Mock explain answer for en') {
      throw new Error(`a double click opened more than one paid request: ${JSON.stringify(result)}`);
    }
  });

  test(`${label}: More clicked while an action's language bundle loads replaces that action without a model call`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, holdLocalization: true });
    const selected = await selectFixtureText(page);
    await clickRectCenter(page, selected.inlineRects.explain);
    await clickRectCenter(page, selected.moreRect);
    // The start-up request plus one per click are now waiting on the held bundle.
    await page.waitForFunction(() => window.__selectionLocalizationRequests >= 3);
    await page.evaluate(() => window.__releaseLocalization());
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().popupVisible);
    await page.waitForTimeout(60);
    const result = await page.evaluate(() => ({
      inline: window.__selectionInlineMessages.length,
      cancels: window.__selectionCancelMessages.length,
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (result.inline !== 0 || result.cancels !== 0 || result.state.cardVisible || !result.state.popupVisible) {
      throw new Error(`the abandoned action still reached the model or showed a card: ${JSON.stringify(result)}`);
    }
  });

  test(`${label}: closing, retargeting or retrying a card cancels the call it abandons`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionInlineHandler = () => new Promise(() => {});
    });
    await openInlineCard(page, 'explain');
    await page.waitForFunction(() => window.__selectionInlineMessages.length === 1);
    let result = await page.evaluate(() => ({
      inline: window.__selectionInlineMessages, cancels: window.__selectionCancelMessages,
    }));
    const firstId = result.inline[0].jobId;
    if (!/^[a-z0-9]{8,64}$/.test(firstId) || result.cancels.length !== 0) {
      throw new Error(`a running card should carry a well-formed job id and nothing to cancel yet: ${JSON.stringify(result)}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__selectionCancelMessages.length === 1);
    result = await page.evaluate(() => window.__selectionCancelMessages);
    if (result[0].jobId !== firstId) {
      throw new Error(`closing the card should cancel its own call: ${JSON.stringify({ firstId, result })}`);
    }

    // Retargeting a Translate card replaces the running call with a new one.
    await openInlineCard(page, 'translate');
    await page.waitForFunction(() => window.__selectionInlineMessages.length === 2);
    await page.evaluate(() => window.__webbrainSelectionShortcut.chooseTarget('de'));
    await page.waitForFunction(() => window.__selectionInlineMessages.length === 3);
    result = await page.evaluate(() => ({
      ids: window.__selectionInlineMessages.map((message) => message.jobId),
      cancels: window.__selectionCancelMessages.map((message) => message.jobId),
    }));
    if (new Set(result.ids).size !== 3 || result.cancels.length !== 2 || result.cancels[1] !== result.ids[1]) {
      throw new Error(`a new target should cancel the call it replaces and use a fresh id: ${JSON.stringify(result)}`);
    }

    // Closing mid-flight cancels the third call too, but a call that already finished has nothing to cancel.
    await page.evaluate(() => {
      window.__selectionInlineHandler = async () => ({ ok: true, text: 'Done' });
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__selectionCancelMessages.length === 3);
    await openInlineCard(page, 'proofread');
    await waitForCardStatus(page, 'ready');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    const cancels = await page.evaluate(() => window.__selectionCancelMessages.length);
    if (cancels !== 3) throw new Error(`closing a finished card should not send a cancel: ${cancels}`);

    // A page that unloads mid-flight (reload, navigation, closed tab) never closes its card,
    // so the unload itself has to cancel the call. An idle page has nothing to cancel.
    await page.evaluate(() => {
      window.__selectionInlineHandler = () => new Promise(() => {});
    });
    const before = await page.evaluate(() => window.__selectionInlineMessages.length);
    await openInlineCard(page, 'explain');
    await page.waitForFunction((count) => window.__selectionInlineMessages.length === count + 1, before);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await page.waitForFunction(() => window.__selectionCancelMessages.length === 4);
    const unloaded = await page.evaluate(() => ({
      cancelled: window.__selectionCancelMessages.at(-1).jobId,
      running: window.__selectionInlineMessages.at(-1).jobId,
      visible: window.__webbrainSelectionShortcut.getState().cardVisible,
    }));
    if (unloaded.cancelled !== unloaded.running || unloaded.visible) {
      throw new Error(`unloading should cancel the running call and hide the card: ${JSON.stringify(unloaded)}`);
    }
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForTimeout(60);
    const afterIdle = await page.evaluate(() => window.__selectionCancelMessages.length);
    if (afterIdle !== 4) throw new Error(`unloading a page with no call in flight should not send a cancel: ${afterIdle}`);
  });

  test(`${label}: a cut-off card answer says so and continues in the side panel`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, locale: 'zh' });
    await page.evaluate(() => {
      window.__selectionInlineHandler = async (message) => ({
        ok: true,
        text: 'Partial ' + message.action + ' answer',
        truncated: message.action === 'translate',
      });
    });
    const zh = await page.evaluate(() => window.__selectionLocalizations.zh.strings);
    await openInlineCard(page, 'translate');
    await page.evaluate(() => window.__webbrainSelectionShortcut.chooseTarget('de'));
    let state = await waitForCardStatus(page, 'ready');
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().cardTruncated);
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (state.cutNoticeText !== zh.cutOff || !state.continueRect || state.cardText !== 'Partial translate answer') {
      throw new Error(`a capped answer should be flagged in the interface language: ${JSON.stringify({ state, zh: zh.cutOff })}`);
    }
    if (state.continueLabel !== zh.continueInPanel) {
      throw new Error(`the continue button should be localized: ${state.continueLabel}`);
    }
    await clickRectCenter(page, state.continueRect);
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const handoff = await page.evaluate(() => ({
      message: window.__selectionMessages[0],
      cancels: window.__selectionCancelMessages.length,
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (handoff.message.action !== 'translate' || handoff.message.language !== 'de'
        || !/Selected words near the viewport edge/.test(handoff.message.selectionText)
        || handoff.state.cardVisible || handoff.cancels > 1) {
      throw new Error(`continuing should hand the same translation to the side panel: ${JSON.stringify(handoff)}`);
    }
    if (handoff.message.continueFrom !== 'Partial translate answer') {
      throw new Error(`continuing should carry the unfinished text so the panel resumes it: ${JSON.stringify(handoff.message)}`);
    }

    // A complete answer shows no notice, and a follow-up never carries a resume text.
    await openInlineCard(page, 'explain');
    state = await waitForCardStatus(page, 'ready');
    if (state.cardTruncated || state.continueRect || state.cutNoticeText) {
      throw new Error(`a complete answer must not look cut off: ${JSON.stringify(state)}`);
    }
  });

  test(`${label}: a card answer says so when its request reached the cost allowance`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const notice = 'Cloud cost allowance reached: total cloud/router usage is $5.00 against the $5.00 limit.';
    await page.evaluate((text) => {
      window.__selectionInlineHandler = async (message) => {
        if (message.action === 'explain') return { ok: true, text: 'Plain explanation', notice: 42 };
        if (message.action === 'translate') return { ok: true, text: 'Long notice answer', notice: 'n'.repeat(500) };
        return { ok: true, text: 'Answer from the last allowed call', notice: text };
      };
    }, notice);
    await openInlineCard(page, 'proofread');
    let state = await waitForCardStatus(page, 'ready');
    if (state.cardText !== 'Answer from the last allowed call' || state.cardNotice !== notice || state.cardError) {
      throw new Error(`the answer should be shown together with the allowance notice: ${JSON.stringify(state)}`);
    }
    // The notice belongs to that answer: another card without one shows none.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__webbrainSelectionShortcut.getState().cardVisible);
    await selectFixtureText(page);
    await openInlineCard(page, 'explain');
    state = await waitForCardStatus(page, 'ready');
    if (state.cardText !== 'Plain explanation' || state.cardNotice) {
      throw new Error(`a card whose answer has no usable notice must not show one: ${JSON.stringify(state)}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__webbrainSelectionShortcut.getState().cardVisible);
    await selectFixtureText(page);
    await openInlineCard(page, 'translate');
    state = await waitForCardStatus(page, 'ready');
    if (state.cardText !== 'Long notice answer' || state.cardNotice.length !== 300) {
      throw new Error(`a notice is bounded: ${JSON.stringify(state)}`);
    }
  });

  test(`${label}: a textless cut-off card preserves the cost allowance notice`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const notice = 'Cloud cost allowance reached: total cloud/router usage is $5.00 against the $5.00 limit.';
    await page.evaluate((text) => {
      window.__selectionInlineHandler = async () => ({
        ok: false,
        truncated: true,
        notice: text,
        error: 'The answer was cut off before any text was produced.',
      });
    }, notice);
    await openInlineCard(page, 'proofread');
    const state = await waitForCardStatus(page, 'error');
    if (state.cardNotice !== notice || !state.cardTruncated || !state.continueRect || state.cardError) {
      throw new Error(`a textless cut-off should show its allowance notice: ${JSON.stringify(state)}`);
    }
  });

  test(`${label}: an empty card response preserves its cost allowance notice`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const notice = 'Cloud cost allowance reached: total cloud/router usage is $5.00 against the $5.00 limit.';
    await page.evaluate((text) => {
      window.__selectionInlineHandler = async () => ({
        ok: false,
        notice: text,
        error: 'The model returned an empty answer.',
      });
    }, notice);
    await openInlineCard(page, 'proofread');
    const state = await waitForCardStatus(page, 'error');
    if (state.cardNotice !== notice || state.cardTruncated || !state.cardError) {
      throw new Error(`an empty response should show its allowance notice: ${JSON.stringify(state)}`);
    }
  });

  test(`${label}: an inline error preserves its cost allowance notice`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const notice = 'Cloud cost allowance reached: total cloud/router usage is $5.00 against the $5.00 limit.';
    await page.evaluate((text) => {
      window.__selectionInlineHandler = async () => ({
        ok: false,
        notice: text,
        error: 'The provider filtered the response.',
      });
    }, notice);
    await openInlineCard(page, 'explain');
    const state = await waitForCardStatus(page, 'error');
    if (state.cardNotice !== notice || state.cardError !== 'The provider filtered the response.') {
      throw new Error(`an inline error should show its allowance notice: ${JSON.stringify(state)}`);
    }
  });

  test(`${label}: an answer beyond the card limit is cut, flagged and carried whole to the side panel`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      // 70,000 characters, as a background without the limit might hand back.
      window.__selectionInlineHandler = async () => ({ ok: true, text: 'word '.repeat(14000) });
    });
    await openInlineCard(page, 'explain');
    const state = await waitForCardStatus(page, 'ready');
    if (state.cardText.length !== 64000 || !state.cardTruncated || !state.continueRect || !state.cutNoticeText) {
      throw new Error(`an over-long answer should be held at the limit and offered to the side panel: ${JSON.stringify({ length: state.cardText.length, truncated: state.cardTruncated, continueRect: state.continueRect })}`);
    }
    await clickRectCenter(page, state.continueRect);
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const message = await page.evaluate(() => ({
      length: window.__selectionMessages[0].continueFrom.length,
      same: window.__selectionMessages[0].continueFrom === ('word '.repeat(14000)).trim().slice(0, 64000),
    }));
    if (message.length !== 64000 || !message.same) {
      throw new Error(`Continue should carry exactly the text the card shows: ${JSON.stringify(message)}`);
    }
  });

  test(`${label}: cutting an over-long answer never leaves half of an emoji`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionInlineHandler = async () => ({ ok: true, text: `${'x'.repeat(63999)}😀 and more` });
    });
    await openInlineCard(page, 'explain');
    const state = await waitForCardStatus(page, 'ready');
    if (state.cardText !== 'x'.repeat(63999) || !state.cardTruncated) {
      throw new Error(`the cut should fall before the emoji, not inside it: ${JSON.stringify({ length: state.cardText.length, tail: state.cardText.slice(-3), truncated: state.cardTruncated })}`);
    }
  });

  test(`${label}: an older Translate answer never replaces a newer one`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__pendingInline = [];
      window.__selectionInlineHandler = (message) => new Promise((resolve) => {
        window.__pendingInline.push({ language: message.language, resolve });
      });
    });
    await openInlineCard(page, 'translate');
    await page.waitForFunction(() => window.__pendingInline.length === 1);
    await page.evaluate(() => window.__webbrainSelectionShortcut.chooseTarget('de'));
    await page.waitForFunction(() => window.__pendingInline.length === 2);
    await page.evaluate(() => window.__pendingInline[1].resolve({ ok: true, text: 'German answer' }));
    await waitForCardStatus(page, 'ready');
    await page.evaluate(() => window.__pendingInline[0].resolve({ ok: true, text: 'Late English answer' }));
    await page.waitForTimeout(40);
    const state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (state.cardText !== 'German answer' || state.cardStatus !== 'ready') {
      throw new Error(`a stale answer replaced the current translation: ${JSON.stringify(state)}`);
    }
  });

  test(`${label}: very long selections go to the side panel instead of a card`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      const article = document.createElement('article');
      article.id = 'long-selection';
      for (let index = 0; index < 400; index += 1) {
        const line = document.createElement('div');
        line.textContent = `Selected article line ${index + 1}`;
        article.appendChild(line);
      }
      document.body.appendChild(article);
    });
    const selected = await selectFixtureText(page, '#long-selection');
    await clickRectCenter(page, selected.inlineRects.explain);
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const result = await page.evaluate(() => ({
      message: window.__selectionMessages[0],
      inline: window.__selectionInlineMessages,
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (result.message.action !== 'explain' || result.message.language !== 'en'
        || result.inline.length !== 0 || result.state.cardVisible) {
      throw new Error(`a long selection should use the side panel flow: ${JSON.stringify(result)}`);
    }
  });

  test(`${label}: a long translation waits for a target choice`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      const article = document.createElement('article');
      article.id = 'long-english-selection';
      article.textContent = 'This is an English sentence. '.repeat(250);
      document.body.appendChild(article);
    });
    const selected = await selectFixtureText(page, '#long-english-selection');
    await clickRectCenter(page, selected.inlineRects.translate);
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().cardStatus === 'idle');
    let state = await page.evaluate(() => ({
      state: window.__webbrainSelectionShortcut.getState(),
      messages: window.__selectionMessages,
    }));
    if (state.messages.length || state.state.cardTarget !== '') {
      throw new Error(`a long translation should wait for a target: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => window.__webbrainSelectionShortcut.chooseTarget('de'));
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    state = await page.evaluate(() => ({ message: window.__selectionMessages[0], state: window.__webbrainSelectionShortcut.getState() }));
    if (state.message.language !== 'de' || state.state.cardVisible) {
      throw new Error(`the chosen target should be handed to the side panel: ${JSON.stringify(state)}`);
    }
  });

  test(`${label}: a long selection is handed over at once, not after the language bundle loads`, async (page) => {
    // The side panel can only be opened inside the click's user gesture, so the hand-over
    // must not wait for localization.
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, holdLocalization: true });
    await page.evaluate(() => {
      const article = document.createElement('article');
      article.id = 'long-selection';
      for (let index = 0; index < 400; index += 1) {
        const line = document.createElement('div');
        line.textContent = `Selected article line ${index + 1}`;
        article.appendChild(line);
      }
      document.body.appendChild(article);
    });
    const selected = await selectFixtureText(page, '#long-selection');
    await clickRectCenter(page, selected.inlineRects.explain);
    await page.waitForFunction(() => window.__selectionMessages.length === 1, null, { timeout: 2000 });
    const result = await page.evaluate(() => ({
      message: window.__selectionMessages[0],
      inline: window.__selectionInlineMessages.length,
    }));
    if (result.message.action !== 'explain' || result.inline !== 0) {
      throw new Error(`a long selection should reach the side panel flow while localization is still loading: ${JSON.stringify(result)}`);
    }
    await page.evaluate(() => window.__releaseLocalization?.());
  });

  test(`${label}: the card opens below a selection near the top edge`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      const topCopy = document.createElement('p');
      topCopy.id = 'top-copy';
      topCopy.style.cssText = 'position:absolute;left:74px;top:2px;width:210px;margin:0';
      topCopy.textContent = 'A multiline selection near the top edge must keep the card below every selected line.';
      document.body.appendChild(topCopy);
    });
    await openInlineCard(page, 'explain', '#top-copy');
    const state = await waitForCardStatus(page, 'ready');
    const card = state.cardRect;
    if (state.cardSide !== 'below' || card.top < state.selectionBottom || card.bottom > 272 || card.left < 8 || card.right > 352) {
      throw new Error(`the card should open below the selected lines inside the viewport: ${JSON.stringify(state)}`);
    }
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

function normalizeTreeRefs(content) {
  const refs = new Map();
  return String(content || '').replace(/ref_\d+/g, ref => {
    if (!refs.has(ref)) refs.set(ref, `ref_${refs.size + 1}`);
    return refs.get(ref);
  });
}

function normalizeTreeRevision(content) {
  return String(content || '').replace(/fnv1a64:[0-9a-f]{16}/g, 'tree_revision');
}

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
  return normalizeTreeRefs(content);
}

async function assertNestedModalHoistedOnce(page, sourcePath, label) {
  await setupAccessibilityTreeHtml(page, `<!doctype html>
    <body class="modal-open">
      <button>Background control</button>
      <div class="modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.3)">
        <div role="dialog" aria-label="Review dialog" style="background:white;padding:20px">
          <button>Confirm layered action</button>
        </div>
      </div>
    </body>`, sourcePath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('all', 10, null, null, 1));
  const content = String(tree?.pageContent || '');
  const matches = content.match(/button "Confirm layered action"/g) || [];
  const dialogAt = content.indexOf('dialog "Review dialog"');
  const backgroundAt = content.indexOf('button "Background control"');
  if (!content.includes('[open overlays') || matches.length !== 1
    || dialogAt < 0 || backgroundAt < 0 || dialogAt > backgroundAt) {
    throw new Error(`${label}: body.modal-open must not displace or duplicate the dialog: ${content}`);
  }
}

test('accessibility tree (Chrome): a dialog inside its modal wrapper is hoisted once', page =>
  assertNestedModalHoistedOnce(page, accessibilityTreeJsPath, 'chrome'));
test('accessibility tree (Firefox): a dialog inside its modal wrapper is hoisted once', page =>
  assertNestedModalHoistedOnce(page, firefoxAccessibilityTreeJsPath, 'firefox'));

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

const longConversationFixture = `<!doctype html>
  <main aria-label="Project conversation">
    ${Array.from({ length: 90 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      return `<article aria-label="Message ${number} from Sender ${number}: project status, decisions, owners, dates, risks, dependencies, and requested follow-up"></article>`;
    }).join('')}
  </main>`;

let chromeLongConversationPages = [];

async function readAllConversationTreePages(page, sourcePath, label) {
  await setupAccessibilityTreeHtml(page, longConversationFixture, sourcePath);
  const pages = [];
  let args = { filter: 'all' };
  for (let guard = 0; guard < 20; guard += 1) {
    const result = await page.evaluate(current => window.__generateAccessibilityTree(
      current.filter,
      current.maxDepth,
      current.maxChars,
      null,
      current.page,
      current.tree_revision,
    ), args);
    if (JSON.stringify(result).length > 8000) {
      throw new Error(`${label}: structured accessibility page exceeded the model-facing tool cap`);
    }
    pages.push(result);
    if (!result.hasMore) break;
    const expected = {
      filter: 'all',
      maxDepth: 15,
      maxChars: 6000,
      page: pages.length + 1,
    };
    if (JSON.stringify(result.continuationArgs) !== JSON.stringify(expected)) {
      throw new Error(`${label}: continuation args drifted: ${JSON.stringify(result.continuationArgs)}`);
    }
    args = result.continuationArgs;
  }

  if (pages.length < 2) throw new Error(`${label}: long conversation was not paged`);
  if (pages.at(-1)?.hasMore !== false || pages.at(-1)?.continuationArgs !== null) {
    throw new Error(`${label}: final conversation page retained a stale continuation`);
  }
  const combined = pages.map(result => result.pageContent).join('\n');
  if (!combined.includes('Message 001 from Sender 001')) throw new Error(`${label}: first message missing after paging`);
  if (!combined.includes('Message 090 from Sender 090')) throw new Error(`${label}: last message missing after paging`);
  return pages.map(result => normalizeTreeRefs(result.pageContent));
}

test('accessibility tree (Chrome): a long conversation pages through its final message', async (page) => {
  chromeLongConversationPages = await readAllConversationTreePages(page, accessibilityTreeJsPath, 'chrome');
});

test('accessibility tree (Firefox): long-conversation paging keeps Chrome parity', async (page) => {
  const firefoxPages = await readAllConversationTreePages(page, firefoxAccessibilityTreeJsPath, 'firefox');
  if (JSON.stringify(firefoxPages) !== JSON.stringify(chromeLongConversationPages)) {
    throw new Error('Chrome/Firefox long-conversation pages differ');
  }
});

const gmailThreadScopeFixture = `<!doctype html>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    main { display: block; width: 900px; min-height: 600px; }
    #background-inbox { min-height: 120px; }
    article { display: block; min-height: 24px; }
  </style>
  <main id="background-inbox" aria-label="Inbox">
    <button aria-label="Expand all">Unrelated background control</button>
    <div role="listitem">Unrelated inbox conversation that must never enter trusted thread coverage</div>
  </main>
  <main id="active-thread" aria-label="A chat about WebBrain and your work">
    <h1>A chat about WebBrain and your work</h1>
    <button id="real-collapse" aria-label="Collapse all">Collapse all</button>
    ${Array.from({ length: 72 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      const injected = index === 0
        ? '<main id="fake-main" role="main" aria-label="Injected fake thread"><button jsname="tRarif" aria-label="Tümünü genişlet">Tümünü genişlet</button></main>'
        : '';
      return `<article class="adn" role="listitem" aria-label="Thread message ${number}">${injected}<p>Message ${number}: project details, decisions, context, and follow-up.</p></article>`;
    }).join('')}
    <div role="textbox" contenteditable="true" aria-label="Message Body">Unsent reply draft</div>
  </main>`;

let chromeGmailThreadScopePages = [];

async function readTrustedGmailThreadPages(page, sourcePath, label) {
  await setupAccessibilityTreeGmailHtml(page, gmailThreadScopeFixture, sourcePath);
  const discovery = await page.evaluate(() => window.__generateAccessibilityTree('visible', 12, 1200, null, 1));
  if (!/^ref_\d+$/.test(String(discovery.conversationRootRefId || ''))) {
    throw new Error(`${label}: trusted Gmail conversation root ref is missing: ${JSON.stringify(discovery)}`);
  }
  if (discovery.conversationExpansionState !== 'expanded') {
    throw new Error(`${label}: top-level Collapse all did not produce expanded evidence`);
  }
  const rootIdentity = await page.evaluate(refId => ({
    trustedId: window.__wb_ax_lookup(refId)?.id || '',
    fakeRef: window.__wb_ax_ref(document.getElementById('fake-main')),
  }), discovery.conversationRootRefId);
  if (rootIdentity.trustedId !== 'active-thread') {
    throw new Error(`${label}: trusted Gmail root resolved to ${rootIdentity.trustedId || 'nothing'}`);
  }
  if (rootIdentity.fakeRef === discovery.conversationRootRefId) {
    throw new Error(`${label}: message-body landmark spoofed the trusted Gmail root`);
  }

  const pages = [];
  let args = {
    filter: 'all',
    maxDepth: 15,
    maxChars: 1200,
    ref_id: discovery.conversationRootRefId,
    page: 1,
  };
  for (let guard = 0; guard < 30; guard += 1) {
    const result = await page.evaluate(current => window.__generateAccessibilityTree(
      current.filter,
      current.maxDepth,
      current.maxChars,
      current.ref_id,
      current.page,
      current.tree_revision,
    ), args);
    if (result.conversationRootRefId !== discovery.conversationRootRefId) {
      throw new Error(`${label}: trusted Gmail root drifted during pagination`);
    }
    pages.push(result);
    if (!result.hasMore) break;
    const expected = {
      filter: args.filter,
      maxDepth: args.maxDepth,
      maxChars: args.maxChars,
      ref_id: args.ref_id,
      tree_revision: result.treeRevision,
      page: args.page + 1,
    };
    if (JSON.stringify(result.continuationArgs) !== JSON.stringify(expected)) {
      throw new Error(`${label}: Gmail thread continuation lost its trusted anchor: ${JSON.stringify(result.continuationArgs)}`);
    }
    args = result.continuationArgs;
  }
  if (pages.length < 2 || pages.at(-1)?.hasMore !== false) {
    throw new Error(`${label}: trusted Gmail thread did not reach a terminal page`);
  }
  const combined = pages.map(result => result.pageContent).join('\n');
  if (!combined.includes('Message 001') || !combined.includes('Message 072')) {
    throw new Error(`${label}: trusted Gmail pagination lost thread messages`);
  }
  if (combined.includes('Unrelated inbox conversation')) {
    throw new Error(`${label}: trusted Gmail pagination leaked the background inbox`);
  }

  const snapshotContinuation = await page.evaluate(continuation => {
    const message = document.querySelector('#active-thread article p');
    const previous = message.textContent;
    message.textContent = previous.replace('project', 'product');
    const result = window.__generateAccessibilityTree(
      continuation.filter,
      continuation.maxDepth,
      continuation.maxChars,
      continuation.ref_id,
      continuation.page,
      continuation.tree_revision,
    );
    message.textContent = previous;
    return result;
  }, pages[0].continuationArgs);
  if (snapshotContinuation.treeRevisionMismatch || snapshotContinuation.error
      || snapshotContinuation.treeRevision !== pages[0].treeRevision) {
    throw new Error(`${label}: live Gmail mutations invalidated the bounded page-one snapshot`);
  }

  const actionableDrift = await page.evaluate(continuation => {
    const control = document.getElementById('real-collapse');
    const previous = control.getAttribute('aria-label');
    control.setAttribute('aria-label', 'Delete permanently');
    const result = window.__generateAccessibilityTree(
      continuation.filter,
      continuation.maxDepth,
      continuation.maxChars,
      continuation.ref_id,
      continuation.page,
      continuation.tree_revision,
    );
    control.setAttribute('aria-label', previous);
    return result;
  }, pages[0].continuationArgs);
  if (actionableDrift.treeRevisionMismatch !== true || !actionableDrift.error
      || actionableDrift.pageContent) {
    throw new Error(`${label}: a changed Gmail action reused a stale cached ref`);
  }

  const revisionMismatch = await page.evaluate(continuation => {
    window.__wbAxTreeSnapshots.clear();
    const message = document.querySelector('#active-thread article p');
    const previous = message.textContent;
    message.textContent = previous.replace('project', 'product');
    const result = window.__generateAccessibilityTree(
      continuation.filter,
      continuation.maxDepth,
      continuation.maxChars,
      continuation.ref_id,
      continuation.page,
      continuation.tree_revision,
    );
    message.textContent = previous;
    return result;
  }, pages[0].continuationArgs);
  if (revisionMismatch.treeRevisionMismatch !== true || !revisionMismatch.error || revisionMismatch.pageContent) {
    throw new Error(`${label}: an expired Gmail snapshot did not reject a changed live continuation`);
  }
  const expectedRestartArgs = {
    filter: 'all',
    maxDepth: 15,
    maxChars: 1200,
    ref_id: discovery.conversationRootRefId,
    page: 1,
  };
  if (JSON.stringify(revisionMismatch.continuationArgs) !== JSON.stringify(expectedRestartArgs)
      || revisionMismatch.nextPage !== 1) {
    throw new Error(`${label}: revision recovery did not return exact page-one restart arguments`);
  }

  const restartedPageOne = await page.evaluate(args => window.__generateAccessibilityTree(
    args.filter,
    args.maxDepth,
    args.maxChars,
    args.ref_id,
    1,
    'fnv1a64:0000000000000000',
  ), expectedRestartArgs);
  if (restartedPageOne.error || restartedPageOne.treeRevisionMismatch || !restartedPageOne.pageContent
      || restartedPageOne.page !== 1) {
    throw new Error(`${label}: stale revision was not ignored while establishing a fresh page-one snapshot`);
  }

  const subtreeRecovery = await page.evaluate(() => {
    const subtree = document.createElement('section');
    subtree.setAttribute('aria-label', 'Paginated message subtree');
    for (let index = 1; index <= 30; index += 1) {
      const paragraph = document.createElement('p');
      paragraph.textContent = `Subtree message ${index}: original details and follow-up context.`;
      subtree.append(paragraph);
    }
    document.getElementById('active-thread').append(subtree);
    const refId = window.__wb_ax_ref(subtree);
    const first = window.__generateAccessibilityTree('all', 15, 220, refId, 1);
    subtree.querySelector('p').textContent = 'Subtree message 1: changed details and follow-up context.';
    const continuation = first.continuationArgs || {};
    const second = window.__generateAccessibilityTree(
      continuation.filter,
      continuation.maxDepth,
      continuation.maxChars,
      continuation.ref_id,
      continuation.page,
      continuation.tree_revision,
    );
    subtree.remove();
    return {
      refId,
      firstHasMore: first.hasMore,
      mismatch: second.treeRevisionMismatch,
      error: second.error || '',
      pageContent: second.pageContent,
      nextPage: second.nextPage,
      continuationArgs: second.continuationArgs,
    };
  });
  if (subtreeRecovery.firstHasMore !== true || subtreeRecovery.mismatch !== true
      || !subtreeRecovery.error || subtreeRecovery.pageContent) {
    throw new Error(`${label}: a changed non-root subtree reused a stale cached page`);
  }
  const expectedSubtreeRestart = {
    filter: 'all',
    maxDepth: 15,
    maxChars: 220,
    ref_id: subtreeRecovery.refId,
    page: 1,
  };
  if (JSON.stringify(subtreeRecovery.continuationArgs) !== JSON.stringify(expectedSubtreeRestart)
      || subtreeRecovery.nextPage !== 1) {
    throw new Error(`${label}: non-root recovery widened to the Gmail conversation root`);
  }

  const routeClassification = await page.evaluate(() => {
    const classify = hash => {
      window.history.replaceState(null, '', hash);
      const result = window.__generateAccessibilityTree('visible', 12, 1200, null, 1);
      return {
        hasRoot: !!result.conversationRootRefId,
        expansionState: result.conversationExpansionState || null,
      };
    };
    const results = {
      searchList: classify('#search/project'),
      labelList: classify('#label/Work'),
      categoryList: classify('#category/promotions'),
      searchHexList: classify('#search/deadbeefcafe'),
      labelHexList: classify('#label/deadbeefcafe'),
      categoryHexList: classify('#category/deadbeefcafe'),
      nestedLabelHexList: classify('#label/Projects/deadbeefcafe'),
      searchThread: classify('#search/project/FMfc123'),
      labelThread: classify('#label/Work/FMfc123'),
      categoryThread: classify('#category/promotions/FMfc123'),
      inboxLegacyThread: classify('#inbox/deadbeefcafe'),
      searchLegacyThread: classify('#search/project/deadbeefcafe'),
      nestedLabelThread: classify('#label/Projects/Subproject/FMfc123'),
    };
    window.history.replaceState(null, '', '#inbox/FMfc123');
    return results;
  });
  for (const routeName of ['searchList', 'labelList', 'categoryList', 'searchHexList', 'labelHexList', 'categoryHexList', 'nestedLabelHexList']) {
    if (routeClassification[routeName].hasRoot || routeClassification[routeName].expansionState != null) {
      throw new Error(`${label}: Gmail ${routeName} exposed trusted conversation metadata`);
    }
  }
  for (const routeName of ['searchThread', 'labelThread', 'categoryThread', 'inboxLegacyThread', 'searchLegacyThread', 'nestedLabelThread']) {
    if (!routeClassification[routeName].hasRoot || routeClassification[routeName].expansionState !== 'expanded') {
      throw new Error(`${label}: Gmail ${routeName} lost trusted conversation metadata`);
    }
  }

  const spoofOnlyExpansion = await page.evaluate(() => {
    document.getElementById('real-collapse').remove();
    return window.__generateAccessibilityTree('visible', 12, 1200, null, 1);
  });
  if (spoofOnlyExpansion.conversationExpansionState != null) {
    throw new Error(`${label}: message-body Expand all spoofed expansion evidence`);
  }
  const detachedRootRead = await page.evaluate(() => {
    const current = window.__generateAccessibilityTree('visible', 12, 1200, null, 1);
    document.getElementById('active-thread').remove();
    return window.__generateAccessibilityTree('all', 15, 1200, current.conversationRootRefId, 1);
  });
  if (!/no longer connected/i.test(String(detachedRootRead.error || '')) || detachedRootRead.pageContent) {
    throw new Error(`${label}: a detached Gmail conversation ref remained readable`);
  }
  return pages.map(result => ({
    page: result.page,
    totalChars: result.totalChars,
    hasMore: result.hasMore,
    truncated: result.truncated,
    pageContent: normalizeTreeRevision(normalizeTreeRefs(result.pageContent)),
    treeRevision: 'tree_revision',
    conversationRootRefId: 'ref_trusted_root',
    conversationExpansionState: result.conversationExpansionState,
    continuationArgs: result.continuationArgs
      ? { ...result.continuationArgs, ref_id: 'ref_trusted_root', tree_revision: 'tree_revision' }
      : null,
  }));
}

test('accessibility tree (Chrome): Gmail whole-thread reads use one trusted active-thread anchor', async (page) => {
  chromeGmailThreadScopePages = await readTrustedGmailThreadPages(page, accessibilityTreeJsPath, 'chrome');
});

test('accessibility tree (Firefox): Gmail trusted thread metadata and pagination keep Chrome parity', async (page) => {
  const firefoxPages = await readTrustedGmailThreadPages(page, firefoxAccessibilityTreeJsPath, 'firefox');
  if (JSON.stringify(firefoxPages) !== JSON.stringify(chromeGmailThreadScopePages)) {
    throw new Error('Chrome/Firefox trusted Gmail thread pages differ');
  }
});

const collapsedGmailThreadFixture = `<!doctype html>
  <meta charset="utf-8">
  <style>
    body { margin: 0; font: 16px sans-serif; }
    main { display: block; width: 900px; min-height: 600px; }
    article { display: block; min-height: 30px; }
    #older-message[hidden] { display: none; }
  </style>
  <main id="active-thread" aria-label="Collapsed project thread">
    <h1>Collapsed project thread</h1>
    <button id="expand-all" jsname="tRarif" aria-label="Tümünü genişlet">Tümünü genişlet</button>
    <article class="adn" role="listitem" aria-label="Latest message">
      <p>Latest visible project message.</p>
      <button jsname="tRarif" aria-label="Tümünü genişlet">Untrusted message button</button>
    </article>
    <article id="older-message" class="adn" role="listitem" aria-label="Older message" hidden>
      <p>Older collapsed decision that must be included.</p>
    </article>
  </main>
  <script>
    document.getElementById('expand-all').addEventListener('click', () => {
      document.getElementById('older-message').hidden = false;
      const control = document.getElementById('expand-all');
      control.setAttribute('jsname', 'xvWlrc');
      control.setAttribute('aria-label', 'Tümünü daralt');
      control.textContent = 'Tümünü daralt';
    });
  </script>`;

let chromeCollapsedGmailRead = null;

async function readCollapsedGmailThread(page, browserKind) {
  await setupContentGmailHtml(page, collapsedGmailThreadFixture, browserKind);
  const discovery = await rawContentCall(page, 'get_accessibility_tree', {
    filter: 'visible',
    maxDepth: 12,
    maxChars: 1200,
    page: 1,
  });
  if (!discovery.conversationRootRefId || discovery.conversationExpansionState !== 'collapsed') {
    throw new Error(`${browserKind}: collapsed Gmail thread was not discovered safely`);
  }
  const result = await rawContentCall(page, 'get_accessibility_tree', {
    filter: 'all',
    maxDepth: 15,
    maxChars: 6000,
    ref_id: discovery.conversationRootRefId,
    page: 1,
  });
  if (result.error || result.conversationAutoExpanded !== true
      || result.conversationExpansionState !== 'expanded') {
    throw new Error(`${browserKind}: anchored whole-thread read did not expand Gmail: ${JSON.stringify(result)}`);
  }
  if (!result.pageContent.includes('Older collapsed decision that must be included.')) {
    throw new Error(`${browserKind}: anchored whole-thread read omitted the revealed older message`);
  }
  const state = await page.evaluate(() => ({
    topLevelLabel: document.getElementById('expand-all').getAttribute('aria-label'),
    topLevelJsname: document.getElementById('expand-all').getAttribute('jsname'),
    olderHidden: document.getElementById('older-message').hidden,
  }));
  if (state.topLevelLabel !== 'Tümünü daralt' || state.topLevelJsname !== 'xvWlrc' || state.olderHidden) {
    throw new Error(`${browserKind}: whole-thread preparation did not reveal the trusted conversation: ${JSON.stringify(state)}`);
  }
  return {
    pageContent: normalizeTreeRefs(result.pageContent),
    conversationExpansionState: result.conversationExpansionState,
    conversationAutoExpanded: result.conversationAutoExpanded,
  };
}

test('content tree (Chrome): anchored Gmail reads reveal collapsed messages in either agent mode', async (page) => {
  chromeCollapsedGmailRead = await readCollapsedGmailThread(page, 'chrome');
});

test('content tree (Firefox): collapsed Gmail whole-thread preparation keeps Chrome parity', async (page) => {
  const firefoxResult = await readCollapsedGmailThread(page, 'firefox');
  if (JSON.stringify(firefoxResult) !== JSON.stringify(chromeCollapsedGmailRead)) {
    throw new Error('Chrome/Firefox collapsed Gmail whole-thread reads differ');
  }
});

const richEditorVariantsFixture = `<!doctype html>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    .editor { display: block; width: 520px; min-height: 72px; margin: 12px; border: 1px solid #888; }
  </style>
  <div class="editor" contenteditable="" aria-label="Email body">Draft body text</div>
  <div class="editor" contenteditable="plaintext-only" aria-label="Plain message">Plain draft text</div>
  <div class="editor" contenteditable="false" aria-label="Read-only copy">Do not edit</div>`;

let chromeRichEditorTree = '';

function assertRichEditorVariants(tree, label) {
  const content = String(tree?.pageContent || '');
  if (!/textbox "Email body" \[ref_\d+\] value="Draft body text"/.test(content)) {
    throw new Error(`${label}: contenteditable="" editor missing as a valued textbox: ${content}`);
  }
  if (!/textbox "Plain message" \[ref_\d+\] value="Plain draft text"/.test(content)) {
    throw new Error(`${label}: plaintext-only editor missing as a valued textbox: ${content}`);
  }
  if (/Read-only copy|Do not edit/.test(content)) {
    throw new Error(`${label}: contenteditable=false leaked into the interactive tree: ${content}`);
  }
  const textboxes = content.match(/^\s*textbox\b/gm) || [];
  if (textboxes.length !== 2) throw new Error(`${label}: expected exactly two editable roots, got ${textboxes.length}: ${content}`);
  return normalizeTreeRefs(content);
}

test('accessibility tree (Chrome): contenteditable variants are actionable valued textboxes', async (page) => {
  await setupAccessibilityTreeHtml(page, richEditorVariantsFixture, accessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('interactive', 10, null, null, 1));
  chromeRichEditorTree = assertRichEditorVariants(tree, 'chrome');
});

test('accessibility tree (Firefox): contenteditable variants keep Chrome parity', async (page) => {
  await setupAccessibilityTreeHtml(page, richEditorVariantsFixture, firefoxAccessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('interactive', 10, null, null, 1));
  const firefoxTree = assertRichEditorVariants(tree, 'firefox');
  if (firefoxTree !== chromeRichEditorTree) throw new Error('Chrome/Firefox rich editor trees differ');
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

async function assertModalAutoSelectTargetsResolvedSelect(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
    <style>
      select { width: 180px; height: 40px; }
      #dialog { position: fixed; left: 40px; top: 100px; padding: 20px; background: white; }
    </style>
    <select id="background-select">
      <option value="monthly">Monthly</option>
      <option value="yearly">Yearly</option>
    </select>
    <div id="dialog" role="dialog" aria-modal="true">
      <select id="dialog-select">
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>
    </div>`);

  const response = await call(page, 'click', { text: 'Yearly' });
  if (!response?.success || response?.method !== 'auto-select') {
    throw new Error(`${label}: expected modal select auto-selection, got: ${JSON.stringify(response)}`);
  }
  const values = await page.evaluate(() => ({
    background: document.getElementById('background-select').value,
    dialog: document.getElementById('dialog-select').value,
  }));
  if (values.background !== 'monthly' || values.dialog !== 'yearly') {
    throw new Error(`${label}: auto-select mutated the wrong dropdown: ${JSON.stringify(values)}`);
  }
}

test('Chrome: modal auto-select changes the resolved select, not a background select', async (page) => {
  await assertModalAutoSelectTargetsResolvedSelect(page, 'chrome');
});

test('Firefox: modal auto-select changes the resolved select, not a background select', async (page) => {
  await assertModalAutoSelectTargetsResolvedSelect(page, 'firefox');
});

async function assertAmbiguousNativeSelectOptionsAreRejected(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
    <style>select, button { width: 180px; height: 40px; display: block; margin: 8px; }</style>
    <button id="contact" onclick="window.__contactClicked = true">Contact us</button>
    <label>Billing country
      <select id="billing">
        <option value="CA">Canada</option>
        <option value="US">United States</option>
      </select>
    </label>
    <label>Shipping country
      <select id="shipping">
        <option value="CA">Canada</option>
        <option value="US">United States</option>
      </select>
    </label>`);

  const response = await call(page, 'click', { text: 'US' });
  const state = await page.evaluate(() => ({
    billing: document.getElementById('billing').value,
    shipping: document.getElementById('shipping').value,
    contactClicked: window.__contactClicked === true,
  }));
  if (
    response?.success !== false
    || response?.dispatched !== false
    || response?.failureScope !== 'ambiguous-select-option:us'
    || !/Ambiguous select option match/.test(response?.error || '')
  ) {
    throw new Error(`${label}: expected explicit select-option ambiguity, got: ${JSON.stringify(response)}`);
  }
  if (state.billing !== 'CA' || state.shipping !== 'CA' || state.contactClicked) {
    throw new Error(`${label}: ambiguous select rescue mutated page state: ${JSON.stringify(state)}`);
  }
}

test('Chrome: ambiguous native select options do not mutate the first dropdown', async (page) => {
  await assertAmbiguousNativeSelectOptionsAreRejected(page, 'chrome');
});

test('Firefox: ambiguous native select options do not mutate the first dropdown', async (page) => {
  await assertAmbiguousNativeSelectOptionsAreRejected(page, 'firefox');
});

test('Chrome Agent: modal auto-select ignores background/hidden clickables and keeps the exact target', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      select { width: 180px; height: 40px; }
      #dialog { position: fixed; left: 40px; top: 100px; padding: 20px; background: white; }
    </style>
    <button id="background-yearly" onclick="window.__backgroundYearlyClicked = true">Yearly</button>
    <select id="background-select">
      <option value="monthly">Monthly</option>
      <option value="yearly">Yearly</option>
    </select>
    <div id="dialog" role="dialog" aria-modal="true">
      <button style="display: none">Yearly</button>
      <select id="dialog-select">
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>
    </div>
    <script>
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') window.__escapeActiveId = document.activeElement?.id || '';
        if (event.key === 'Escape' && document.activeElement?.id === 'dialog-select') {
          document.activeElement.blur();
        }
      }, true);
    </script>`);

  const session = await page.context().newCDPSession(page);
  const client = {
    async evaluate(_tabId, expression) {
      return { result: { value: await page.evaluate(expression) } };
    },
    async sendCommand(_tabId, method, params) {
      // Headless Chromium does not apply the native <select> default action
      // for this raw CDP key sequence consistently. Model that one browser
      // action on whichever exact control the production code focused; the
      // Escape event itself still goes through CDP and triggers the blur above.
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && /^(ArrowDown|ArrowUp)$/.test(params.key || '')) {
        await page.evaluate((key) => {
          const target = document.activeElement;
          if (!(target instanceof HTMLSelectElement)) return;
          const delta = key === 'ArrowDown' ? 1 : -1;
          target.selectedIndex = Math.max(0, Math.min(target.options.length - 1, target.selectedIndex + delta));
        }, params.key);
        return {};
      }
      return session.send(method, params);
    },
  };
  const agent = new Agent({});
  const result = await agent._autoSelectOption(42, client, 'Yearly');
  const values = await page.evaluate(() => ({
    background: document.getElementById('background-select').value,
    dialog: document.getElementById('dialog-select').value,
    backgroundButtonClicked: window.__backgroundYearlyClicked === true,
    escapeActiveId: window.__escapeActiveId || '',
    leakedTargetSlots: Object.keys(globalThis).filter((key) => key.startsWith('__webbrainAutoSelectTarget_')),
  }));

  if (!result?.success || result.method !== 'auto-select-keyboard') {
    throw new Error(`expected exact-target auto-selection, got: ${JSON.stringify(result)}`);
  }
  if (values.background !== 'monthly' || values.dialog !== 'yearly' || values.backgroundButtonClicked) {
    throw new Error(`auto-select changed the wrong dropdown after refocus: ${JSON.stringify(values)}`);
  }
  if (values.escapeActiveId !== 'dialog-select') {
    throw new Error(`auto-select sent Escape to the wrong control: ${JSON.stringify(values)}`);
  }
  if (values.leakedTargetSlots.length) {
    throw new Error(`auto-select target reference was not cleaned up: ${JSON.stringify(values.leakedTargetSlots)}`);
  }
});

// A typed label chooses the native <select> option it names, through each
// content path that chooses one (focused and selector type_text, type_ax):
// the exact label, a label in another case, or one option's unique part, with
// one input and one change event. A part that fits several options ("Alex"),
// a label no option has and a disabled option select nothing and fire no
// event; the option already shown is a no-op.
async function assertNativeSelectChoices(page, browserKind) {
  const html = `<!doctype html>
    <label for="size">Size</label><select id="size"><option value="">Choose...</option><option>Small</option>
      <option>Medium</option><option>Large</option><option>X-Large</option><option disabled>XX-Large (sold out)</option></select>
    <label for="to">To</label><select id="to"><option value="">Choose a contact...</option>
      <option value="c1">Alex Kaya (test contact)</option><option value="c2">Alex Demir (test contact)</option>
      <option value="c3">Sam Yilmaz (test contact)</option></select>
    <label for="ship">Shipping</label><select id="ship"><option value="">Choose...</option>
      <option value="std">Standard</option><option value="std">Standard (gift wrap)</option><option value="exp">Express</option></select>
    <script>
      window.selectEvents = [];
      for (const id of ['size', 'to', 'ship']) for (const type of ['input', 'change']) {
        document.getElementById(id).addEventListener(type, event => window.selectEvents.push(id + ':' + type + ':' + event.target.value));
      }
    </script>`;
  const cases = [
    { select: 'size', text: 'Large', value: 'Large' },
    { select: 'size', text: 'medium', value: 'Medium' },
    { select: 'to', text: 'Sam Yilmaz', value: 'c3' },
    { select: 'to', text: 'c2', value: 'c2' },
    // Options that share a value: the label names which one is chosen.
    { select: 'ship', text: 'Standard (gift wrap)', value: 'std', label: 'Standard (gift wrap)' },
    { select: 'ship', text: 'Standard', value: 'std', label: 'Standard' },
    { select: 'to', text: 'Alex', error: /more than one option[\s\S]*Alex Kaya[\s\S]*Alex Demir/ },
    { select: 'size', text: 'Purple', error: /No option matches "Purple"[\s\S]*Options: Choose\.\.\., Small/ },
    { select: 'size', text: 'XX-Large', error: /disabled/ },
    { select: 'size', text: 'arge', error: /more than one option/ },
  ];
  const paths = {
    focused: async (select, text) => { await page.focus(`#${select}`); return call(page, 'type', { text }); },
    selector: (select, text) => call(page, 'type', { selector: `#${select}`, text }),
    type_ax: async (select, text) => call(page, 'type_ax', {
      ref_id: await page.evaluate(id => window.__wb_ax_ref(document.getElementById(id)), select), text,
    }),
  };
  for (const [pathName, choose] of Object.entries(paths)) {
    for (const item of cases) {
      await setupContentHtml(page, html, browserKind);
      const result = await choose(item.select, item.text);
      const state = await page.evaluate(id => ({
        value: document.getElementById(id).value,
        label: document.getElementById(id).selectedOptions[0]?.text,
        events: window.selectEvents,
      }), item.select);
      const detail = `${browserKind} ${pathName} "${item.text}": ${JSON.stringify({ result, state })}`;
      if (item.error) {
        if (result?.success !== false || result.noDispatch !== true || result.dispatched === true
            || !item.error.test(String(result.error || '')) || state.value !== '' || state.events.length) {
          throw new Error(`a label that names no single enabled option must change nothing: ${detail}`);
        }
        continue;
      }
      if (result?.success !== true || result.verified !== true || state.value !== item.value
          || (item.label && (state.label !== item.label || result.selectedText !== item.label))
          || JSON.stringify(state.events) !== JSON.stringify([`${item.select}:input:${item.value}`, `${item.select}:change:${item.value}`])) {
        throw new Error(`the named option must be chosen with one input and one change: ${detail}`);
      }
    }
  }
  // Choosing the option already shown changes nothing, on every path: no
  // input or change, and an option that shares its value stays chosen.
  for (const [pathName, choose] of Object.entries(paths)) {
    for (const shown of [
      { select: 'size', text: 'Medium', value: 'Medium' },
      { select: 'ship', text: 'Standard (gift wrap)', value: 'std' },
    ]) {
      await setupContentHtml(page, html, browserKind);
      await page.selectOption(`#${shown.select}`, { label: shown.text });
      await page.evaluate(() => { window.selectEvents.length = 0; });
      const same = await choose(shown.select, shown.text);
      const after = await page.evaluate(id => ({
        value: document.getElementById(id).value,
        label: document.getElementById(id).selectedOptions[0]?.text,
        events: window.selectEvents,
      }), shown.select);
      if (same?.success !== true || same.verified !== true || same.noop !== true || same.noDispatch !== true
          || same.dispatched === true || same.selectedText !== shown.text
          || after.value !== shown.value || after.label !== shown.text || after.events.length) {
        throw new Error(`${browserKind} ${pathName} "${shown.text}": choosing the shown option must be a no-op: ${JSON.stringify({ same, after })}`);
      }
    }
  }
  // A page that sets the value again on change (a select controlled by its
  // value) shows the first option with that value: not the one named.
  const controlled = `<!doctype html>
    <label for="ship">Shipping</label><select id="ship"><option value="">Choose...</option>
      <option value="std">Standard</option><option value="std">Standard (gift wrap)</option></select>
    <script>
      document.getElementById('ship').addEventListener('change', event => { event.target.value = event.target.value; });
    </script>`;
  for (const [pathName, choose] of Object.entries(paths)) {
    await setupContentHtml(page, controlled, browserKind);
    const result = await choose('ship', 'Standard (gift wrap)');
    const shownLabel = await page.evaluate(() => document.getElementById('ship').selectedOptions[0]?.text);
    if (shownLabel !== 'Standard' || result?.verified === true || result?.selectedText !== 'Standard') {
      throw new Error(`${browserKind} ${pathName}: a select showing another option with the same value must not verify: ${JSON.stringify({ result, shownLabel })}`);
    }
  }
}

test('Chrome: a typed label chooses exactly the native select option it names', page =>
  assertNativeSelectChoices(page, 'chrome'));
firefoxTest('Firefox: a typed label chooses exactly the native select option it names', page =>
  assertNativeSelectChoices(page, 'firefox'));

// ─── occlusion ────────────────────────────────────────────────────────────
async function assertDockedControlsKeepScroll(page, browserKind) {
  for (const position of ['fixed', 'sticky']) {
    await setupContentHtml(page, `<!doctype html>
      <style>
        html { scroll-padding-top: 80px; scroll-padding-bottom: 60px; }
        body { margin: 0; height: 1700px; }
        header { position: ${position}; top: 0; height: 80px; width: 100%; background: white; }
        .toolbar { position: fixed; bottom: 0; height: 60px; width: 100%; background: white; }
      </style>
      <header><button id="top-control" onclick="window.__topClicked = true">Top control</button><input id="top-input" aria-label="Top input"></header>
      <div class="toolbar"><button id="bottom-control" onclick="window.__bottomClicked = true">Bottom control</button><input id="bottom-check" type="checkbox" aria-label="Bottom check"></div>
    `, browserKind);
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await page.evaluate(() => window.scrollY);
    for (const [selector, flag] of [['#top-control', '__topClicked'], ['#bottom-control', '__bottomClicked']]) {
      const result = await call(page, 'click', { selector });
      const after = await page.evaluate(name => ({ scrollY: window.scrollY, clicked: window[name] === true }), flag);
      if (!result?.success || !after.clicked || Math.abs(after.scrollY - before) > 1) {
        throw new Error(`${browserKind} ${position} ${selector} jumped from ${before}: ${JSON.stringify({ result, after })}`);
      }
    }
    const inputRef = await page.evaluate(() => window.__wb_ax_ref(document.getElementById('top-input')));
    const typed = await call(page, 'type_ax', { ref_id: inputRef, text: 'Ada', clear: true });
    const typedState = await page.evaluate(() => ({
      scrollY: window.scrollY,
      value: document.getElementById('top-input').value,
    }));
    if (!typed?.success || typedState.value !== 'Ada' || Math.abs(typedState.scrollY - before) > 1) {
      throw new Error(`${browserKind} ${position} input jumped from ${before}: ${JSON.stringify({ typed, typedState })}`);
    }
    const checkRef = await page.evaluate(() => window.__wb_ax_ref(document.getElementById('bottom-check')));
    const checked = await call(page, 'set_checked', { ref_id: checkRef, checked: true });
    const checkedState = await page.evaluate(() => ({
      scrollY: window.scrollY,
      checked: document.getElementById('bottom-check').checked,
    }));
    if (!checked?.success || !checkedState.checked || Math.abs(checkedState.scrollY - before) > 1) {
      throw new Error(`${browserKind} ${position} checkbox jumped from ${before}: ${JSON.stringify({ checked, checkedState })}`);
    }
    if (browserKind === 'chrome') {
      const rect = await call(page, 'ax_resolve_rect', { ref_id: inputRef });
      const afterRect = await page.evaluate(() => window.scrollY);
      if (!rect?.success || Math.abs(afterRect - before) > 1) {
        throw new Error(`Chrome ${position} rect resolution jumped from ${before}: ${JSON.stringify({ rect, afterRect })}`);
      }
    }
  }
}

test('Chrome: controls inside docked bars keep the document scroll position', page =>
  assertDockedControlsKeepScroll(page, 'chrome'));
firefoxTest('Firefox: controls inside docked bars keep the document scroll position', page =>
  assertDockedControlsKeepScroll(page, 'firefox'));

async function assertFixedSideRailControlsKeepScroll(page, browserKind) {
  await setupContentHtml(page, `<!doctype html>
    <style>
      html { scroll-padding-top: 80px; }
      body { margin: 0; height: 1700px; }
      header { position: fixed; top: 0; width: 100%; height: 80px; z-index: 10; background: white; }
      #side { position: fixed; top: 0; left: 0; width: 220px; height: 100vh; z-index: 20; background: white; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px; }
    </style>
    <header>Page header</header>
    <div id="side">
      <button id="rail-button" onclick="window.__railClicked = true">Rail action</button>
      <input id="rail-input" aria-label="Rail input">
      <input id="rail-check" type="checkbox" aria-label="Rail check">
    </div>
  `, browserKind);
  await page.evaluate(() => window.scrollTo(0, 300));
  const before = await page.evaluate(() => window.scrollY);
  const click = await call(page, 'click', { selector: '#rail-button' });
  const clicked = await page.evaluate(() => ({ clicked: window.__railClicked === true, scrollY: window.scrollY }));
  if (!click?.success || !clicked.clicked || Math.abs(clicked.scrollY - before) > 1) {
    throw new Error(`${browserKind}: fixed side-rail click scrolled the page: ${JSON.stringify({ before, click, clicked })}`);
  }
  const inputRef = await page.evaluate(() => window.__wb_ax_ref(document.getElementById('rail-input')));
  const typed = await call(page, 'type_ax', { ref_id: inputRef, text: 'Ada', clear: true });
  const inputState = await page.evaluate(() => ({
    value: document.getElementById('rail-input').value, scrollY: window.scrollY,
  }));
  if (!typed?.success || inputState.value !== 'Ada' || Math.abs(inputState.scrollY - before) > 1) {
    throw new Error(`${browserKind}: fixed side-rail input scrolled the page: ${JSON.stringify({ before, typed, inputState })}`);
  }
  const checkRef = await page.evaluate(() => window.__wb_ax_ref(document.getElementById('rail-check')));
  const checked = await call(page, 'set_checked', { ref_id: checkRef, checked: true });
  const checkState = await page.evaluate(() => ({
    checked: document.getElementById('rail-check').checked, scrollY: window.scrollY,
  }));
  if (!checked?.success || !checkState.checked || Math.abs(checkState.scrollY - before) > 1) {
    throw new Error(`${browserKind}: fixed side-rail checkbox scrolled the page: ${JSON.stringify({ before, checked, checkState })}`);
  }
  if (browserKind === 'chrome') {
    const resolved = await call(page, 'ax_resolve_rect', { ref_id: inputRef });
    const afterResolve = await page.evaluate(() => window.scrollY);
    if (!resolved?.success || Math.abs(afterResolve - before) > 1) {
      throw new Error(`Chrome fixed side-rail rect resolution scrolled the page: ${JSON.stringify({ before, resolved, afterResolve })}`);
    }
  }
}

test('Chrome: controls inside a fixed side rail keep document scroll position', page =>
  assertFixedSideRailControlsKeepScroll(page, 'chrome'));
firefoxTest('Firefox: controls inside a fixed side rail keep document scroll position', page =>
  assertFixedSideRailControlsKeepScroll(page, 'firefox'));

async function assertHorizontalTargetClearsSideRail(page, browserKind) {
  await setupContentHtml(page, `<!doctype html>
    <style>
      body { margin: 0; }
      #side { position: fixed; top: 0; left: 0; width: 200px; height: 100vh; z-index: 20; background: white; }
      #scroller { width: 500px; height: 160px; overflow: auto; margin-top: 120px; }
      #content { width: 1200px; height: 100px; position: relative; }
      #target { position: absolute; left: 300px; top: 20px; }
    </style>
    <div id="side">Fixed side rail</div>
    <div id="scroller"><div id="content"><input id="target" type="checkbox" aria-label="Grid checkbox"></div></div>
  `, browserKind);
  const before = await page.evaluate(() => {
    document.getElementById('scroller').scrollLeft = 600;
    return document.getElementById('target').getBoundingClientRect().left;
  });
  if (before >= 0) throw new Error(`${browserKind}: target must start outside the horizontal scrollport: ${before}`);
  const ref = await page.evaluate(() => window.__wb_ax_ref(document.getElementById('target')));
  const result = await call(page, 'set_checked', { ref_id: ref, checked: true });
  const after = await page.evaluate(() => ({
    checked: document.getElementById('target').checked,
    left: document.getElementById('target').getBoundingClientRect().left,
    scrollLeft: document.getElementById('scroller').scrollLeft,
  }));
  if (!result?.success || !after.checked || after.left < 200) {
    throw new Error(`${browserKind}: horizontal target remained behind the side rail: ${JSON.stringify({ before, result, after })}`);
  }
}

test('Chrome: horizontal target clears a fixed side rail', page =>
  assertHorizontalTargetClearsSideRail(page, 'chrome'));
firefoxTest('Firefox: horizontal target clears a fixed side rail', page =>
  assertHorizontalTargetClearsSideRail(page, 'firefox'));

async function assertUnstuckStickyTargetClearsHeader(page, browserKind) {
  await setupContentHtml(page, `<!doctype html>
    <style>
      body { margin: 0; height: 1700px; }
      header { position: fixed; top: 0; width: 100%; height: 80px; z-index: 20; background: white; }
      #spacer { height: 350px; }
      #sticky-row { position: sticky; top: 0; height: 40px; z-index: 10; }
    </style>
    <header>Fixed header</header>
    <div id="spacer"></div>
    <div id="sticky-row"><button id="target" onclick="window.__targetClicked = true">Unstuck sticky action</button></div>
  `, browserKind);
  const before = await page.evaluate(() => {
    window.scrollTo(0, 300);
    return {
      scrollY: window.scrollY,
      rowTop: document.getElementById('sticky-row').getBoundingClientRect().top,
    };
  });
  if (before.scrollY !== 300 || before.rowTop <= 0 || before.rowTop >= 80) {
    throw new Error(`${browserKind}: sticky fixture must be unstuck under the header: ${JSON.stringify(before)}`);
  }
  const click = await call(page, 'click', { selector: '#target' });
  const after = await page.evaluate(() => ({
    clicked: window.__targetClicked === true,
    scrollY: window.scrollY,
    top: document.getElementById('target').getBoundingClientRect().top,
  }));
  if (!click?.success || !after.clicked || after.scrollY >= 300 || after.top < 80) {
    throw new Error(`${browserKind}: unstuck sticky target was not cleared: ${JSON.stringify({ before, click, after })}`);
  }
}

test('Chrome: an unstuck sticky control clears a fixed header', page =>
  assertUnstuckStickyTargetClearsHeader(page, 'chrome'));
firefoxTest('Firefox: an unstuck sticky control clears a fixed header', page =>
  assertUnstuckStickyTargetClearsHeader(page, 'firefox'));

async function assertStackedDockedBars(page, browserKind) {
  await setupContentHtml(page, `<!doctype html>
    <style>
      body { margin: 0; height: 2000px; }
      header { position: fixed; top: 0; width: 100%; height: 64px; background: white; }
      .secondary-bar { position: fixed; top: 64px; width: 100%; height: 48px; background: white; }
      .toolbar-lower { position: fixed; bottom: 0; width: 100%; height: 50px; background: white; }
      .upper-bar { position: fixed; bottom: 50px; width: 100%; height: 50px; background: white; }
      #top-target { position: absolute; top: 376px; left: 30px; height: 30px; }
      #bottom-target { position: absolute; top: calc(300px + 100vh - 80px); left: 30px; height: 30px; }
    </style>
    <header>Primary header</header>
    <div class="secondary-bar" role="toolbar"><button id="secondary-control" onclick="window.__secondaryClicked = true">Secondary control</button></div>
    <div class="toolbar-lower">Lower toolbar</div>
    <div class="upper-bar" role="toolbar"><button id="upper-control" onclick="window.__upperClicked = true">Upper control</button></div>
    <button id="top-target" onclick="window.__topTargetClicked = true">Covered by secondary header</button>
    <button id="bottom-target" onclick="window.__bottomTargetClicked = true">Covered by upper toolbar</button>
  `, browserKind);
  await page.evaluate(() => window.scrollTo(0, 300));
  const topClick = await call(page, 'click', { selector: '#top-target' });
  const topState = await page.evaluate(() => ({
    clicked: window.__topTargetClicked === true,
    scrollY: window.scrollY,
    top: document.getElementById('top-target').getBoundingClientRect().top,
  }));
  if (!topClick?.success || !topState.clicked || topState.scrollY >= 300 || topState.top < 112) {
    throw new Error(`${browserKind}: stacked top bars did not clear the target: ${JSON.stringify({ topClick, topState })}`);
  }
  await page.evaluate(() => window.scrollTo(0, 300));
  const bottomClick = await call(page, 'click', { selector: '#bottom-target' });
  const bottomState = await page.evaluate(() => ({
    clicked: window.__bottomTargetClicked === true,
    scrollY: window.scrollY,
    bottom: document.getElementById('bottom-target').getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
  }));
  if (!bottomClick?.success || !bottomState.clicked || bottomState.scrollY <= 300
    || bottomState.bottom > bottomState.viewportHeight - 100) {
    throw new Error(`${browserKind}: stacked bottom bars did not clear the target: ${JSON.stringify({ bottomClick, bottomState })}`);
  }
  await page.evaluate(() => {
    document.documentElement.style.scrollPaddingTop = '112px';
    document.documentElement.style.scrollPaddingBottom = '100px';
  });
  const dockedBefore = await page.evaluate(() => ({
    scrollY: window.scrollY,
    secondaryTop: document.getElementById('secondary-control').getBoundingClientRect().top,
    upperBottom: document.getElementById('upper-control').getBoundingClientRect().bottom,
  }));
  for (const [selector, flag] of [['#secondary-control', '__secondaryClicked'], ['#upper-control', '__upperClicked']]) {
    const result = await call(page, 'click', { selector });
    const state = await page.evaluate(name => ({ clicked: window[name] === true, scrollY: window.scrollY }), flag);
    if (!result?.success || !state.clicked || Math.abs(state.scrollY - dockedBefore.scrollY) > 1) {
      throw new Error(`${browserKind}: offset dock control ${selector} scrolled the page: ${JSON.stringify({ dockedBefore, result, state })}`);
    }
  }
}

test('Chrome: stacked docked bars clear targets and preserve docked controls', page =>
  assertStackedDockedBars(page, 'chrome'));
firefoxTest('Firefox: stacked docked bars clear targets and preserve docked controls', page =>
  assertStackedDockedBars(page, 'firefox'));

async function assertTopObstructionScrollDirection(page, browserKind) {
  await setupContentHtml(page, `<!doctype html>
    <style>
      body { margin: 0; height: 1700px; }
      #obstruction { position: fixed; top: 0; left: 0; width: 100%; height: 80px; z-index: 20; background: white; }
      #target { position: absolute; top: 320px; left: 60px; width: 120px; height: 100px; }
      #row { position: absolute; top: 320px; left: 220px; width: 120px; height: 40px; }
    </style>
    <button id="target" onclick="window.__targetClicked = true">Partly covered</button>
    <div id="row" role="listitem">Covered row</div>
    <div id="obstruction">Floating obstruction</div>
  `, browserKind);
  await page.evaluate(() => window.scrollTo(0, 300));
  const click = await call(page, 'click', { selector: '#target' });
  const afterClick = await page.evaluate(() => ({
    scrollY: window.scrollY,
    clicked: window.__targetClicked === true,
    top: document.getElementById('target').getBoundingClientRect().top,
  }));
  if (!click?.success || !afterClick.clicked || afterClick.scrollY >= 300 || afterClick.top < 80) {
    throw new Error(`${browserKind} top obstruction retry scrolled the wrong way: ${JSON.stringify({ click, afterClick })}`);
  }
  if (browserKind === 'chrome') {
    await page.evaluate(() => window.scrollTo(0, 300));
    const refId = await page.evaluate(() => window.__wb_ax_ref(document.getElementById('row')));
    const resolved = await call(page, 'ax_resolve_rect', { ref_id: refId, forClickFallback: true });
    const afterResolve = await page.evaluate(() => ({
      scrollY: window.scrollY,
      top: document.getElementById('row').getBoundingClientRect().top,
    }));
    if (!resolved?.success || !resolved.hitOk || afterResolve.scrollY >= 300 || afterResolve.top < 80
      || Math.abs(resolved.rect?.y - afterResolve.top) > 1) {
      throw new Error(`Chrome rect resolver scrolled the wrong way: ${JSON.stringify({ resolved, afterResolve })}`);
    }
  }
}

test('Chrome: top obstruction retry moves targets below the blocker', page =>
  assertTopObstructionScrollDirection(page, 'chrome'));
firefoxTest('Firefox: top obstruction retry moves targets below the blocker', page =>
  assertTopObstructionScrollDirection(page, 'firefox'));

async function assertFloatingTopBarClearance(page, browserKind) {
  await setupContentHtml(page, `<!doctype html>
    <style>
      body { margin: 0; height: 1700px; }
      #obstruction { position: fixed; top: 40px; left: 0; width: 100%; height: 80px; z-index: 20; background: white; }
      #target { position: absolute; top: 350px; left: 60px; width: 120px; height: 40px; }
      #row { position: absolute; top: 350px; left: 220px; width: 120px; height: 40px; }
    </style>
    <button id="target" onclick="window.__targetClicked = true">Covered target</button>
    <div id="row" role="listitem">Covered row</div>
    <div id="obstruction">Floating obstruction</div>
  `, browserKind);
  await page.evaluate(() => window.scrollTo(0, 300));
  const click = await call(page, 'click', { selector: '#target' });
  const afterClick = await page.evaluate(() => ({
    clicked: window.__targetClicked === true,
    scrollY: window.scrollY,
    top: document.getElementById('target').getBoundingClientRect().top,
  }));
  if (!click?.success || !afterClick.clicked || afterClick.scrollY >= 300 || afterClick.top < 120) {
    throw new Error(`${browserKind}: floating top bar did not clear the click target: ${JSON.stringify({ click, afterClick })}`);
  }
  if (browserKind === 'chrome') {
    await page.evaluate(() => window.scrollTo(0, 300));
    const refId = await page.evaluate(() => window.__wb_ax_ref(document.getElementById('row')));
    const resolved = await call(page, 'ax_resolve_rect', { ref_id: refId, forClickFallback: true });
    const afterResolve = await page.evaluate(() => ({
      scrollY: window.scrollY,
      top: document.getElementById('row').getBoundingClientRect().top,
    }));
    if (!resolved?.success || !resolved.hitOk || afterResolve.scrollY >= 300 || afterResolve.top < 120) {
      throw new Error(`Chrome floating top bar did not clear rect resolution: ${JSON.stringify({ resolved, afterResolve })}`);
    }
  }
}

test('Chrome: floating top bar clears a fully covered target', page =>
  assertFloatingTopBarClearance(page, 'chrome'));
firefoxTest('Firefox: floating top bar clears a fully covered target', page =>
  assertFloatingTopBarClearance(page, 'firefox'));

async function assertUnclassifiedFixedOverlayClearance(page, browserKind) {
  await setupContentHtml(page, `<!doctype html>
    <style>
      body { margin: 0; height: 1700px; }
      #cookie-banner { position: fixed; bottom: 0; left: 0; width: 100%; height: 80px; z-index: 20; background: white; }
      #target { position: absolute; top: calc(300px + 100vh - 60px); left: 60px; width: 120px; height: 40px; }
    </style>
    <button id="target" onclick="window.__targetClicked = true">Behind cookie banner</button>
    <div id="cookie-banner">Cookie notice</div>
  `, browserKind);
  await page.evaluate(() => window.scrollTo(0, 300));
  const bottomClick = await call(page, 'click', { selector: '#target' });
  const bottomState = await page.evaluate(() => ({
    clicked: window.__targetClicked === true,
    scrollY: window.scrollY,
    bottom: document.getElementById('target').getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
  }));
  if (!bottomClick?.success || !bottomState.clicked || bottomState.scrollY <= 300
    || bottomState.bottom > bottomState.viewportHeight - 80) {
    throw new Error(`${browserKind}: unclassified bottom banner was not cleared: ${JSON.stringify({ bottomClick, bottomState })}`);
  }

  await setupContentHtml(page, `<!doctype html>
    <style>
      body { margin: 0; width: 2000px; height: 1700px; }
      #side-panel { position: fixed; top: 0; left: 0; width: 240px; height: 100vh; z-index: 20; background: white; }
      #target { position: absolute; top: 500px; left: 350px; width: 100px; height: 40px; }
    </style>
    <button id="target" onclick="window.__targetClicked = true">Behind side panel</button>
    <div id="side-panel">Side panel</div>
  `, browserKind);
  const beforeSide = await page.evaluate(() => {
    window.scrollTo(300, 300);
    return { scrollX: window.scrollX, left: document.getElementById('target').getBoundingClientRect().left };
  });
  if (beforeSide.scrollX !== 300 || beforeSide.left >= 240) {
    throw new Error(`${browserKind}: side panel fixture did not cover the target: ${JSON.stringify(beforeSide)}`);
  }
  const sideClick = await call(page, 'click', { selector: '#target' });
  const sideState = await page.evaluate(() => ({
    clicked: window.__targetClicked === true,
    scrollX: window.scrollX,
    left: document.getElementById('target').getBoundingClientRect().left,
  }));
  if (!sideClick?.success || !sideState.clicked || sideState.scrollX >= 300 || sideState.left < 240) {
    throw new Error(`${browserKind}: unclassified side panel was not cleared: ${JSON.stringify({ sideClick, sideState })}`);
  }
}

test('Chrome: unclassified bottom and side overlays clear their targets', page =>
  assertUnclassifiedFixedOverlayClearance(page, 'chrome'));
firefoxTest('Firefox: unclassified bottom and side overlays clear their targets', page =>
  assertUnclassifiedFixedOverlayClearance(page, 'firefox'));

async function assertInnerScrollerClearance(page, browserKind) {
  await setupContentHtml(page, `<!doctype html>
    <style>
      body { margin: 0; }
      #scroller { margin: 20px; width: 260px; height: 100px; overflow: auto; }
      #target { display: block; margin-top: 200px; width: 120px; height: 32px; }
    </style>
    <div id="scroller"><button id="target" onclick="window.__targetClicked = true">Target</button></div>
  `, browserKind);
  const before = await page.evaluate(() => {
    const scroller = document.getElementById('scroller');
    const target = document.getElementById('target');
    return {
      scrollTop: scroller.scrollTop,
      targetTop: target.getBoundingClientRect().top,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    };
  });
  if (before.scrollTop !== 0 || before.targetTop <= before.scrollerBottom || before.targetTop >= before.viewportHeight) {
    throw new Error(`fixture must be clipped by its scroller but inside the viewport: ${JSON.stringify(before)}`);
  }
  const result = await call(page, 'click', { selector: '#target' });
  const after = await page.evaluate(() => ({
    scrollTop: document.getElementById('scroller').scrollTop,
    clicked: window.__targetClicked === true,
  }));
  if (!result?.success || !after.clicked || after.scrollTop <= 0) {
    throw new Error(`${browserKind} click did not expose the clipped target: ${JSON.stringify({ result, after })}`);
  }
}

test('Chrome: click scrolls a target clipped by an inner scroller', page =>
  assertInnerScrollerClearance(page, 'chrome'));
firefoxTest('Firefox: click scrolls a target clipped by an inner scroller', page =>
  assertInnerScrollerClearance(page, 'firefox'));

async function assertShadowHostOcclusion(page, sourcePath) {
  await setupAccessibilityTreeHtml(page, `<!doctype html>
    <style>
      body { margin: 0; }
      #host { position: absolute; left: 20px; top: 20px; width: 200px; height: 50px; }
    </style>
    <div id="host" role="button" tabindex="0" aria-label="Shadow control"></div>
    <script>
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
        '<span style="display:block;width:100%;height:100%;background:green">Visible content</span>';
    </script>
  `, sourcePath);
  const result = await page.evaluate(() => {
    const line = () => String(window.__generateAccessibilityTree('all', 5, 20000).pageContent || '')
      .split('\n').find(item => item.includes('"Shadow control"')) || '';
    const visible = line();
    const cover = document.createElement('div');
    cover.style.cssText = 'position:absolute;left:20px;top:20px;width:200px;height:50px;z-index:2;background:red';
    document.body.append(cover);
    return { visible, covered: line() };
  });
  if (!result.visible || result.visible.includes('occluded=true') || !result.covered.includes('occluded=true')) {
    throw new Error(`shadow host occlusion state is wrong: ${JSON.stringify(result)}`);
  }
}

test('Chrome: visible shadow host is not marked occluded', page =>
  assertShadowHostOcclusion(page, accessibilityTreeJsPath));
firefoxTest('Firefox: visible shadow host is not marked occluded', page =>
  assertShadowHostOcclusion(page, firefoxAccessibilityTreeJsPath));

async function assertAncestorPseudoElementOcclusion(page, sourcePath, label) {
  await setupAccessibilityTreeHtml(page, `<!doctype html>
    <style>
      #cover-parent { position: relative; margin: 100px; width: 220px; height: 100px; }
      #cover-parent::after { content: ''; position: absolute; inset: 0; z-index: 2; background: rgba(255,255,255,.1); pointer-events: auto; }
      #target { position: absolute; top: 20px; left: 20px; width: 120px; height: 40px; }
    </style>
    <div id="cover-parent"><button id="target">Pseudo covered action</button></div>
  `, sourcePath);
  const state = await page.evaluate(() => {
    const target = document.getElementById('target');
    const rect = target.getBoundingClientRect();
    const tree = window.__generateAccessibilityTree('all', 5, 20000);
    return {
      hitIsParent: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        === document.getElementById('cover-parent'),
      line: String(tree?.pageContent || '').split('\n').find(item => item.includes('"Pseudo covered action"')) || '',
    };
  });
  if (!state.hitIsParent || !state.line.includes('occluded=true')) {
    throw new Error(`${label}: ancestor pseudo-element was not marked as covering the target: ${JSON.stringify(state)}`);
  }
}

test('Chrome: ancestor pseudo-element marks its child control occluded', page =>
  assertAncestorPseudoElementOcclusion(page, accessibilityTreeJsPath, 'chrome'));
firefoxTest('Firefox: ancestor pseudo-element marks its child control occluded', page =>
  assertAncestorPseudoElementOcclusion(page, firefoxAccessibilityTreeJsPath, 'firefox'));

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

// ─── CDP upload selector bridge ─────────────────────────────────────────────
test('CDP upload selector bridge resolves hidden and open-shadow file inputs', async (page) => {
  await page.setContent(`<!doctype html>
    <input id="upload-addon" type="file" hidden>
    <div id="shadow-host"></div>
    <script>
      document.querySelector('#shadow-host')
        .attachShadow({ mode: 'open' })
        .innerHTML = '<input id="shadow-upload" type="file">';
    </script>`);

  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);

  const fixtureFile = path.join(root, 'package.json');
  const attachThroughSelector = async (selector) => {
    const query = await client.querySelectorPierce(42, selector);
    if (query.objectIds.length !== 1 || !query.objectIds[0]) {
      throw new Error(`file input did not resolve to one CDP object handle: ${JSON.stringify(query)}`);
    }
    try {
      // Refreshing Chrome's DOM mirror invalidates frontend nodeIds. Runtime
      // object handles must remain valid across an unrelated DOM traversal.
      await session.send('DOM.getDocument', { depth: -1, pierce: true });
      await client.setFileInputFiles(42, query.objectIds[0], [fixtureFile]);
      const files = await client.getFileInputFiles(42, query.objectIds[0]);
      if (files?.[0]?.name !== 'package.json') {
        throw new Error(`attached FileList was not readable through the Runtime handle: ${JSON.stringify(files)}`);
      }
    } finally {
      await client.releaseObjectGroup(42, query.objectGroup);
    }
  };

  await attachThroughSelector('#upload-addon');
  await attachThroughSelector('#shadow-upload');
  const attached = await page.evaluate(() => ({
    hidden: document.querySelector('#upload-addon').files[0]?.name || '',
    shadow: document.querySelector('#shadow-host').shadowRoot
      .querySelector('#shadow-upload').files[0]?.name || '',
  }));
  if (attached.hidden !== 'package.json' || attached.shadow !== 'package.json') {
    throw new Error(`DOM.setFileInputFiles did not attach through resolved nodes: ${JSON.stringify(attached)}`);
  }
});

test('CDP toolbar selector probe traverses shadow hosts for dense clusters', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      #formatting-row { display:flex; align-items:center; gap:6px; width:420px; height:44px; }
      #editor-body { width:420px; height:160px; }
    </style>
    <div id="formatting-row">
      <button type="button">Bold</button>
      <span id="family-host"></span>
    </div>
    <div id="editor-body" role="textbox" contenteditable="true">Enter text</div>
    <script>
      document.querySelector('#family-host').attachShadow({ mode: 'open' }).innerHTML =
        '<input id="shadow-family" aria-label="Font family" value="Default" style="width:118px;height:22px">';
    </script>`);

  // The selector probe runs in the page's main world. A hostile page must not
  // be able to replace the packaged classifier with a permissive global.
  await page.evaluate(() => {
    Object.defineProperty(window, '__wbRichTextToolbarHeuristic', {
      configurable: false,
      writable: false,
      value: Object.freeze({ candidate: () => null }),
    });
  });

  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);
  client.resolveSelector = async () => ({ found: true, nodeId: null, inViewport: true });

  const probe = await client.probeRichTextToolbarSelector(42, '#shadow-family');
  const candidate = probe?.fieldMeta?.toolbarCandidate;
  if (
    !probe?.resolved
    || Number(candidate?.score) < 4
    || !candidate?.reasons?.includes('dense_control_cluster')
    || candidate?.associatedEditorIdentity?.id !== 'editor-body'
  ) {
    throw new Error(`shadow-host dense toolbar cluster was not audited by the CDP selector probe: ${JSON.stringify(probe)}`);
  }

  await page.setContent(`<!doctype html>
    <style>
      #color-row { display:flex; align-items:center; gap:6px; width:420px; height:44px; }
      #editor-body { width:420px; height:160px; }
    </style>
    <div id="color-row">
      <button type="button">Bold</button>
      <input id="text-color" aria-label="Text color" value="#111111" style="width:118px;height:22px">
    </div>
    <div id="editor-body" role="textbox" contenteditable="true">Enter text</div>`);
  const colorProbe = await client.probeRichTextToolbarSelector(42, '#text-color');
  if (
    !colorProbe?.resolved
    || !colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
    || !colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('dense_control_cluster')
    || colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || colorProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
    || !colorProbe.toolbarContext
    || colorProbe.toolbarRegionKey !== colorProbe.fieldMeta.toolbarCandidate.regionKey
  ) {
    throw new Error(`conventional text-color control was not audited by the CDP selector probe: ${JSON.stringify(colorProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <style>
      #slotted-toolbar-editor { width:420px; margin-top:1400px; }
      #slot-editor-component { display:block; width:420px; height:160px; }
    </style>
    <div id="slotted-toolbar-editor">
      <span id="slot-toolbar-host">
        <input id="slotted-family" type="text" aria-label="Font family" value="Default" style="width:118px;height:22px">
        <input id="slotted-search" type="search" aria-label="Search links" value="" style="width:118px;height:22px">
        <input id="slotted-unlabelled-search" type="search" value="" style="width:118px;height:22px">
        <input id="slotted-filter" type="text" aria-label="Filter" value="" style="width:118px;height:22px">
        <input id="slotted-link" type="url" aria-label="Link URL" value="https://example.test" style="width:118px;height:22px">
        <select id="slotted-style" aria-label="Paragraph style" style="width:118px;height:24px">
          <option>Body</option><option>Heading 1</option><option>Heading 2</option>
        </select>
        <div id="slotted-editable-family" contenteditable="true" role="combobox" aria-label="Font family"
          style="width:118px;height:22px">Default</div>
      </span>
      <div id="slot-editor-component"></div>
    </div>
    <script>
      document.querySelector('#slot-toolbar-host').attachShadow({ mode: 'open' }).innerHTML =
        '<div role="toolbar" style="height:44px;display:flex;align-items:center"><slot></slot></div>';
      document.querySelector('#slot-editor-component').attachShadow({ mode: 'open' }).innerHTML =
        '<div id="slot-editor-body" role="textbox" contenteditable="true" style="width:420px;height:160px">Enter text</div>';
    </script>`);
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.documentElement.style.scrollBehavior = 'smooth';
  });
  const slottedProbe = await client.probeRichTextToolbarSelector(42, '#slotted-family');
  const settledSlottedRect = await page.evaluate(() => {
    const rect = document.querySelector('#slotted-family').getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    document.documentElement.style.scrollBehavior = 'auto';
    return { y: rect.y, h: rect.height, viewportHeight };
  });
  if (
    !slottedProbe?.resolved
    || !slottedProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || !slottedProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
    || slottedProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'slot-editor-body'
    || !slottedProbe.toolbarRegionKey
    || slottedProbe.toolbarRegionKey !== slottedProbe.fieldMeta.toolbarCandidate.regionKey
    || Math.abs(slottedProbe.rect.y - settledSlottedRect.y) > 2
    || slottedProbe.rect.y < 0
    || slottedProbe.rect.y + slottedProbe.rect.h > settledSlottedRect.viewportHeight
  ) {
    throw new Error(`labelled assigned-slot toolbar must settle before CDP audit: ${JSON.stringify({ slottedProbe, settledSlottedRect })}`);
  }
  const ordinarySearchProbe = await client.probeRichTextToolbarSelector(42, '#slotted-search');
  if (!ordinarySearchProbe?.resolved || ordinarySearchProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`ordinary labelled toolbar search was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinarySearchProbe)}`);
  }
  const unlabelledSearchProbe = await client.probeRichTextToolbarSelector(42, '#slotted-unlabelled-search');
  if (
    !unlabelledSearchProbe?.resolved
    || unlabelledSearchProbe.fieldMeta?.type !== 'search'
    || unlabelledSearchProbe.fieldMeta?.toolbarCandidate
    || unlabelledSearchProbe.toolbarRegionKey !== slottedProbe.toolbarRegionKey
  ) {
    throw new Error(`unlabelled native search must remain ordinary while preserving its toolbar region: ${JSON.stringify(unlabelledSearchProbe)}`);
  }
  const ordinaryFilterProbe = await client.probeRichTextToolbarSelector(42, '#slotted-filter');
  if (!ordinaryFilterProbe?.resolved || ordinaryFilterProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`ordinary labelled toolbar text filter was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinaryFilterProbe)}`);
  }
  const linkProbe = await client.probeRichTextToolbarSelector(42, '#slotted-link');
  if (
    !linkProbe?.resolved
    || linkProbe.fieldMeta?.type !== 'url'
    || !linkProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
  ) {
    throw new Error(`URL-typed rich-text link control was not audited by the CDP selector probe: ${JSON.stringify(linkProbe)}`);
  }
  const editableProbe = await client.probeRichTextToolbarSelector(42, '#slotted-editable-family');
  if (
    !editableProbe?.resolved
    || editableProbe.fieldMeta?.contentEditable !== true
    || !editableProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
  ) {
    throw new Error(`contenteditable rich-text formatting control was not audited by the CDP selector probe: ${JSON.stringify(editableProbe)}`);
  }
  const nativeStyleProbe = await client.probeRichTextToolbarSelector(42, '#slotted-style');
  if (
    !nativeStyleProbe?.resolved
    || nativeStyleProbe.fieldMeta?.type !== 'select'
    || !nativeStyleProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || !nativeStyleProbe.fieldMeta.toolbarCandidate.availablePresetValues?.includes('Heading 1')
  ) {
    throw new Error(`native rich-text style select was not audited by the CDP selector probe: ${JSON.stringify(nativeStyleProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <label for="ordinary-status">Status</label>
    <select id="ordinary-status"><option>Draft</option><option>Published</option></select>`);
  const ordinarySelectProbe = await client.probeRichTextToolbarSelector(42, '#ordinary-status');
  if (!ordinarySelectProbe?.resolved || ordinarySelectProbe.fieldMeta?.type !== 'select' || ordinarySelectProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`labelled ordinary select was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinarySelectProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <div style="display:flex;align-items:center;gap:6px;width:320px;height:44px">
      <div id="compact-composer" role="textbox" contenteditable="true"
        style="width:190px;height:28px">Draft reply</div>
      <button type="button">Emoji</button>
      <button type="button">Send</button>
    </div>`);
  const compactComposerProbe = await client.probeRichTextToolbarSelector(42, '#compact-composer');
  if (!compactComposerProbe?.resolved || compactComposerProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`compact contenteditable composer was audited as formatting by the CDP selector probe: ${JSON.stringify(compactComposerProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <div style="width:420px">
      <div style="height:42px;display:flex;align-items:center;gap:6px">
        <input id="ordinary-document-title" type="text" style="width:180px;height:28px">
        <button type="button">Save</button>
      </div>
      <textarea style="width:400px;height:180px"></textarea>
    </div>`);
  const ordinaryTitleProbe = await client.probeRichTextToolbarSelector(42, '#ordinary-document-title');
  if (!ordinaryTitleProbe?.resolved || ordinaryTitleProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`ordinary compact title near an editor was audited by the CDP selector probe: ${JSON.stringify(ordinaryTitleProbe)}`);
  }
});

test('CDP type_text binds dispatch to the selector node approved by toolbar preflight', async (page) => {
  await page.setContent(`<!doctype html>
    <input class="shared-target" value="ordinary" style="width:180px;height:32px">`);
  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);

  const staleProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  if (!staleProbe?.resolved || !staleProbe.selectorBackendNodeId) {
    throw new Error(`CDP selector preflight did not expose an exact node identity: ${JSON.stringify(staleProbe)}`);
  }
  await page.evaluate(() => {
    const previous = document.querySelector('.shared-target');
    const replacement = previous.cloneNode();
    replacement.value = '11';
    previous.replaceWith(replacement);
  });
  const rejected = await client.typeText(
    42,
    '.shared-target',
    'Document prose',
    true,
    staleProbe.selectorBackendNodeId,
  );
  const rejectedValue = await page.locator('.shared-target').inputValue();
  if (rejected?.success !== false || rejected?.dispatched !== false || !rejected?.retryable || rejectedValue !== '11') {
    throw new Error(`rerendered CDP selector target did not fail closed: ${JSON.stringify({ rejected, rejectedValue })}`);
  }

  const cloneProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  await page.evaluate(() => {
    const observer = new MutationObserver(records => {
      if (!records.some(record => record.attributeName === 'data-webbrain-dispatch-binding')) return;
      observer.disconnect();
      const previous = document.querySelector('.shared-target');
      const replacement = previous.cloneNode();
      replacement.value = '12';
      previous.replaceWith(replacement);
    });
    observer.observe(document.querySelector('.shared-target'), {
      attributes: true,
      attributeFilter: ['data-webbrain-dispatch-binding'],
    });
  });
  const cloneRejected = await client.typeText(
    42,
    '.shared-target',
    'Document prose',
    true,
    cloneProbe.selectorBackendNodeId,
  );
  const cloneRejectedValue = await page.locator('.shared-target').inputValue();
  if (cloneRejected?.success !== false || cloneRejected?.dispatched !== false || !cloneRejected?.retryable || cloneRejectedValue !== '12') {
    throw new Error(`a replacement that copied the preflight attribute bypassed node identity: ${JSON.stringify({ cloneRejected, cloneRejectedValue })}`);
  }

  const stableProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  const accepted = await client.typeText(
    42,
    '.shared-target',
    '14',
    false,
    stableProbe.selectorBackendNodeId,
  );
  const acceptedValue = await page.locator('.shared-target').inputValue();
  const leakedMarkers = await page.locator('[data-webbrain-dispatch-binding]').count();
  if (!accepted?.success || accepted?.verified !== true || acceptedValue !== '1214' || leakedMarkers !== 0) {
    throw new Error(`stable CDP selector target did not type and clean up exactly: ${JSON.stringify({ accepted, acceptedValue, leakedMarkers })}`);
  }
});

for (const browserKind of ['chrome', 'firefox']) {
  test(`get_interactive_elements (${browserKind}): identifies the Hugging Face repository file input`, async (page) => {
    const setupHtml = browserKind === 'firefox' ? setupFirefoxHtml : setupChromeHtml;
    await setupHtml(page, `<!doctype html>
      <style>
        [data-repository-drop-zone] { display: none; }
      </style>
      <label>Repository files
        <input data-repository-drop-zone type="file" multiple>
      </label>
      <section aria-label="Extended description editor">
        <input type="file" accept="image/png,image/jpeg" multiple hidden>
      </section>`);

    const elements = await call(page, 'get_interactive_elements_cdp', {});
    const fileInputs = elements.filter((element) => element.type === 'file');
    if (fileInputs.length !== 2) {
      throw new Error(`expected both Hugging Face-shaped file inputs, got ${JSON.stringify(fileInputs)}`);
    }

    const repositoryInput = fileInputs.find((element) => element.accept === null);
    const editorMediaInput = fileInputs.find((element) => element.accept === 'image/png,image/jpeg');
    if (!repositoryInput || repositoryInput.multiple !== true) {
      throw new Error(`file metadata mismatch: ${JSON.stringify(repositoryInput)}`);
    }
    if (!editorMediaInput || editorMediaInput.multiple !== true) {
      throw new Error(`raw editor-media accept metadata mismatch: ${JSON.stringify(editorMediaInput)}`);
    }
    if (!repositoryInput.selector || !repositoryInput.selector.includes(':not([accept])')) {
      throw new Error(`expected a no-accept repository selector, got ${JSON.stringify(repositoryInput)}`);
    }

    const selectorCheck = await page.evaluate((selector) => {
      const matches = document.querySelectorAll(selector);
      return {
        count: matches.length,
        repository: matches[0] === document.querySelector('[data-repository-drop-zone]'),
      };
    }, repositoryInput.selector);
    if (selectorCheck.count !== 1 || !selectorCheck.repository) {
      throw new Error(`selector did not uniquely target the repository drop zone: ${JSON.stringify(selectorCheck)}`);
    }
  });

  // Trace e6187b5f (WebBrain 42.3.1, x.com/compose/post): neither of X's two
  // identical file-input records carried a selector, so the upload recovery
  // never released and all 15 upload_file calls were refused until the run's
  // cost limit.
  test(`get_interactive_elements (${browserKind}): tells X's dialog composer file input from the timeline copy behind it`, async (page) => {
    const setupHtml = browserKind === 'firefox' ? setupFirefoxHtml : setupChromeHtml;
    await setupHtml(page, xComposeUploadHtml);

    // The selectors the run tried first match both inputs.
    const bareMatches = await page.evaluate(() => document.querySelectorAll('input[data-testid="fileInput"]').length);
    if (bareMatches !== 2) throw new Error(`fixture must reproduce X's duplicate file input, got ${bareMatches}`);

    const resolve = (selector) => page.evaluate((selector) => {
      const matches = document.querySelectorAll(selector);
      return {
        count: matches.length,
        inDialog: !!matches[0]?.closest('[role="dialog"]'),
        inTimeline: !!matches[0]?.closest('main'),
      };
    }, selector);
    for (const action of ['get_interactive_elements_cdp', 'get_file_input_targets']) {
      const records = (await call(page, action, {})).filter((element) => element.type === 'file');
      if (records.length !== 2) throw new Error(`${action}: expected both X file inputs, got ${JSON.stringify(records)}`);
      if (!records.every((record) => typeof record.selector === 'string' && record.selector)) {
        throw new Error(`${action}: every X file input needs a selector the model may use: ${JSON.stringify(records)}`);
      }
      const dialogInput = records.find((record) => record.inDialog === true);
      const timelineInput = records.find((record) => record !== dialogInput);
      if (!dialogInput || Object.hasOwn(timelineInput, 'inDialog')) {
        throw new Error(`${action}: only the dialog composer's input may be marked inDialog: ${JSON.stringify(records)}`);
      }
      if (!dialogInput.selector.startsWith('[role="dialog"] ')) {
        throw new Error(`${action}: the dialog composer's selector should name its dialog: ${JSON.stringify(dialogInput)}`);
      }
      const dialogTarget = await resolve(dialogInput.selector);
      const timelineTarget = await resolve(timelineInput.selector);
      if (dialogTarget.count !== 1 || !dialogTarget.inDialog
        || timelineTarget.count !== 1 || !timelineTarget.inTimeline) {
        throw new Error(`${action}: selectors must each match only their own input: ${JSON.stringify({ records, dialogTarget, timelineTarget })}`);
      }
    }

    // This inventory is what releases the recovery an ambiguous upload
    // selector sets; in the trace no inspection could.
    const inventory = await call(page, 'get_interactive_elements_cdp', {});
    const recovery = { _uploadSelectorRecoveryRequired: new Map([[77, 2]]) };
    const AgentClass = browserKind === 'firefox' ? FirefoxAgent : Agent;
    if (!AgentClass.prototype._clearUploadSelectorRecoveryAfterInspection.call(recovery, 77, 'get_interactive_elements', inventory)
      || recovery._uploadSelectorRecoveryRequired.has(77)) {
      throw new Error('the X inventory did not release upload recovery');
    }
  });

  // A closed dialog a page keeps in the DOM holds no composer the model
  // opened: its input is not marked inDialog, and no selector is scoped to it.
  // Both inputs share their ten nearest ancestors, so a dialog scope would
  // otherwise be the first candidate that tells them apart.
  const fileSlot = `<div><div><div><div><div><div><div><div><div>
    <input type="file" accept="image/*">
  </div></div></div></div></div></div></div></div></div>`;
  for (const [state, open, close] of [
    ['hidden', '<div role="dialog" hidden>', '</div>'],
    ['aria-hidden', '<div role="dialog" aria-hidden="true">', '</div>'],
    ['inert', '<div role="dialog" aria-modal="true" inert>', '</div>'],
    ['unrendered', '<div role="dialog" style="display: none">', '</div>'],
    ['closed native', '<dialog role="dialog">', '</dialog>'],
  ]) {
    test(`get_interactive_elements (${browserKind}): a file input in a closed dialog (${state}) is not marked inDialog`, async (page) => {
      const setupHtml = browserKind === 'firefox' ? setupFirefoxHtml : setupChromeHtml;
      await setupHtml(page, `<!doctype html>
        <section aria-label="Cover image">${fileSlot}</section>
        ${open}<p>Avatar</p>${fileSlot}${close}`);
      const records = (await call(page, 'get_interactive_elements_cdp', {})).filter((element) => element.type === 'file');
      if (records.length !== 2 || records.some((record) => Object.hasOwn(record, 'inDialog'))) {
        throw new Error(`a closed dialog (${state}) must not mark its input inDialog: ${JSON.stringify(records)}`);
      }
      if (records.some((record) => !record.selector || /\[role="dialog"\]|\[aria-modal="true"\]|dialog\[open\]/.test(record.selector))) {
        throw new Error(`each input needs a selector not scoped to a closed dialog (${state}): ${JSON.stringify(records)}`);
      }
    });
  }

  test(`file picker guard (${browserKind}): blocks the native chooser and returns the exact input`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <button id="choose">Select a file...</button>
      <input type="file" hidden>
      <input type="file" hidden>
      <script>
        document.querySelector('#choose').addEventListener('click', () => {
          document.querySelectorAll('input[type=file]')[1].click();
        });
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await call(page, 'click', { text: 'Select a file...' });
    await page.waitForTimeout(20);
    if (chooserOpened) throw new Error('native file chooser was not suppressed');
    if (!result?.filePickerBlocked || result.success !== false || !result.selector) {
      throw new Error(`expected blocked picker with exact selector, got ${JSON.stringify(result)}`);
    }
    const selectorCheck = await page.evaluate((selector) => {
      const inputs = document.querySelectorAll('input[type=file]');
      const matches = document.querySelectorAll(selector);
      return { count: matches.length, correct: matches[0] === inputs[1] };
    }, result.selector);
    if (selectorCheck.count !== 1 || !selectorCheck.correct) {
      throw new Error(`selector did not uniquely resolve the clicked input: ${JSON.stringify({ result, selectorCheck })}`);
    }
  });

  // Trace b71fd1dc: Instagram's Add Photo or Video button opens a formless,
  // display:none input. The chooser guard named it by its path from the root
  // ("div:nth-of-type(3) > input"), the inventory by its attributes, so the
  // model held two selectors for one input. Both now name it the same way.
  for (const opener of ['click', 'showPicker']) {
    test(`file picker guard (${browserKind}): names a ${opener} chooser's input as the file-input inventory does`, async (page) => {
      const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
        <style>.x1s85apg{display:none}</style>
        <input type="text" name="searchInput" placeholder="Search">
        <div><div><div role="textbox" contenteditable="true" aria-placeholder="Message..."></div></div>
        <div><div role="button" tabindex="0" aria-label="Voice Clip">Voice</div></div>
        <div><input accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg" class="x1s85apg" multiple type="file">
        <div role="button" tabindex="0" id="add-photo" aria-label="Add Photo or Video">Photo</div></div></div>
        <script>
          document.querySelector('#add-photo').addEventListener('click', () => {
            document.querySelector('input[type=file]').${opener}();
          });
        </script>`, browserKind);

      let chooserOpened = false;
      page.once('filechooser', () => { chooserOpened = true; });
      const result = await isolatedCall('click', { text: 'Photo' });
      await page.waitForTimeout(20);
      if (chooserOpened) throw new Error(`${opener} native chooser was not suppressed`);
      const inventory = (await isolatedCall('get_interactive_elements_cdp', {})).filter(item => item.type === 'file');
      const expected = 'input[type="file"][accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg"][multiple]';
      if (inventory.length !== 1 || inventory[0].selector !== expected) {
        throw new Error(`expected one inventory record named ${expected}, got ${JSON.stringify(inventory)}`);
      }
      if (!result?.filePickerBlocked || result.success !== false || result.selector !== expected) {
        throw new Error(`the blocked chooser must name the inventory's selector, got ${JSON.stringify(result)}`);
      }
    });
  }

  test(`file picker guard (${browserKind}): withholds selectors that collide across shadow roots`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <button id="choose">Select a shadow file...</button>
      <div id="host-a"></div>
      <div id="host-b"></div>
      <script>
        for (const id of ['host-a', 'host-b']) {
          document.querySelector('#' + id).attachShadow({ mode: 'open' }).innerHTML = '<input type="file">';
        }
        document.querySelector('#choose').addEventListener('click', () => {
          document.querySelector('#host-b').shadowRoot.querySelector('input').click();
        });
      </script>`, browserKind);

    const result = await call(page, 'click', { text: 'Select a shadow file...' });
    if (!result?.filePickerBlocked || result.success !== false) {
      throw new Error(`expected blocked picker, got ${JSON.stringify(result)}`);
    }
    if (Object.hasOwn(result, 'selector')) {
      throw new Error(`ambiguous shadow-root input must not return selector ${result.selector}`);
    }
    if (!/exact, unique/.test(result.error || '') || !/generic input\[type="file"\]/.test(result.error || '')) {
      throw new Error(`missing unique-selector recovery guidance: ${JSON.stringify(result)}`);
    }
  });
}

const deferredFilePickerOpeners = [
  ['promise', 'Promise.resolve().then(openPicker)'],
  ['timer', 'setTimeout(openPicker, 0)'],
  ['debounce-150ms', 'setTimeout(openPicker, 150)'],
  ['debounce-300ms', 'setTimeout(openPicker, 300)'],
  ['animation-frame', 'requestAnimationFrame(openPicker)'],
];
const showPickerOpeners = [
  ['immediate', 'openPicker()'],
  ...deferredFilePickerOpeners,
];

for (const browserKind of ['chrome', 'firefox']) {
  for (const [deferral, scheduleOpen] of deferredFilePickerOpeners) {
    test(`file picker guard (${browserKind}): blocks lazy ${deferral} chooser activation`, async (page) => {
      const inputId = `lazy-${browserKind}-${deferral}`;
      await setupContentHtml(page, `<!doctype html>
        <button id="choose">Add a deferred file...</button>
        <script>
          document.querySelector('#choose').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.id = ${JSON.stringify(inputId)};
            input.hidden = true;
            document.body.appendChild(input);
            const openPicker = () => input.click();
            ${scheduleOpen};
          });
        </script>`, browserKind);

      let chooserOpened = false;
      page.once('filechooser', () => { chooserOpened = true; });
      const result = await call(page, 'click', { text: 'Add a deferred file...' });
      await page.waitForTimeout(20);
      if (chooserOpened) throw new Error(`${deferral} native file chooser was not suppressed`);
      if (!result?.filePickerBlocked || result.success !== false || result.selector !== `#${inputId}`) {
        throw new Error(`expected blocked lazy picker with #${inputId}, got ${JSON.stringify(result)}`);
      }
      const selectorCheck = await page.evaluate((selector) => {
        const matches = document.querySelectorAll(selector);
        return { count: matches.length, id: matches[0]?.id || '' };
      }, result.selector);
      if (selectorCheck.count !== 1 || selectorCheck.id !== inputId) {
        throw new Error(`lazy selector did not resolve uniquely: ${JSON.stringify({ result, selectorCheck })}`);
      }
    });
  }

  for (const [deferral, scheduleOpen] of showPickerOpeners) {
    test(`file picker guard (${browserKind}): blocks ${deferral} showPicker activation`, async (page) => {
      const inputId = `show-picker-${browserKind}-${deferral}`;
      const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
        <button id="choose">Show a file picker...</button>
        <input id=${JSON.stringify(inputId)} type="file" hidden>
        <script>
          document.querySelector('#choose').addEventListener('click', () => {
            const input = document.querySelector('#' + ${JSON.stringify(inputId)});
            const openPicker = () => input.showPicker();
            ${scheduleOpen};
          });
        </script>`, browserKind);

      let chooserOpened = false;
      page.once('filechooser', () => { chooserOpened = true; });
      const result = await isolatedCall('click', { text: 'Show a file picker...' });
      await page.waitForTimeout(20);
      if (chooserOpened) throw new Error(`${deferral} showPicker native chooser was not suppressed`);
      if (!result?.filePickerBlocked || result.success !== false || result.selector !== `#${inputId}`) {
        throw new Error(`expected blocked showPicker with #${inputId}, got ${JSON.stringify(result)}`);
      }
      const footprint = await page.evaluate(() => ({
        stableGlobal: Object.hasOwn(window, '__webbrainFilePickerGuardBridge'),
        attributes: Array.from(document.documentElement.attributes)
          .map(attribute => attribute.name)
          .filter(name => name.startsWith('data-webbrain-file-picker-')),
      }));
      if (footprint.stableGlobal || footprint.attributes.length) {
        throw new Error(`page-world guard left a detectable marker: ${JSON.stringify(footprint)}`);
      }
    });
  }

  test(`file picker guard (${browserKind}): blocks programmatic clicks inside closed shadow roots`, async (page) => {
    const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
      <button id="choose">Open a closed-shadow picker...</button>
      <div id="host"></div>
      <script>
        const input = document.querySelector('#host')
          .attachShadow({ mode: 'closed' })
          .appendChild(document.createElement('input'));
        input.type = 'file';
        document.querySelector('#choose').addEventListener('click', () => input.click());
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await isolatedCall('click', { text: 'Open a closed-shadow picker...' });
    await page.waitForTimeout(20);
    if (chooserOpened) throw new Error('closed-shadow native chooser was not suppressed');
    if (!result?.filePickerBlocked || result.success !== false) {
      throw new Error(`expected blocked closed-shadow picker, got ${JSON.stringify(result)}`);
    }
    if (Object.hasOwn(result, 'selector')) {
      throw new Error(`closed-shadow picker must not expose an unusable selector: ${result.selector}`);
    }
  });

  test(`file picker guard (${browserKind}): suppresses long programmatic debounce after result settlement`, async (page) => {
    const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
      <button id="choose">Schedule a late picker...</button>
      <input id="late-picker" type="file" hidden>
      <script>
        document.querySelector('#choose').addEventListener('click', () => {
          setTimeout(() => {
            window.__latePickerAttempted = true;
            document.querySelector('#late-picker').click();
          }, 800);
        });
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await isolatedCall('click', { text: 'Schedule a late picker...' });
    if (!result?.success || result.filePickerBlocked) {
      throw new Error(`late picker should settle before its callback, got ${JSON.stringify(result)}`);
    }
    await page.waitForTimeout(350);
    const attempted = await page.evaluate(() => window.__latePickerAttempted === true);
    if (!attempted) throw new Error('late picker callback did not execute');
    if (chooserOpened) throw new Error('post-settlement native chooser was not suppressed');
  });
}

test('Chrome CDP file picker guard blocks trusted showPicker activation and restores the prototype', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      #closed-host { display: block; width: 220px; height: 40px; }
    </style>
    <button id="choose">Open trusted picker</button>
    <button id="choose-closed">Open trusted closed picker</button>
    <input id="trusted-show-picker" type="file" hidden>
    <div id="closed-host"></div>
    <script>
      window.__originalShowPicker = HTMLInputElement.prototype.showPicker;
      window.__originalInputClick = HTMLInputElement.prototype.click;
      const closedInput = document.querySelector('#closed-host')
        .attachShadow({ mode: 'closed' })
        .appendChild(document.createElement('input'));
      closedInput.type = 'file';
      closedInput.style.cssText = 'display:block;width:220px;height:40px';
      document.querySelector('#choose').addEventListener('click', () => {
        document.querySelector('#trusted-show-picker').showPicker();
      });
      document.querySelector('#choose-closed').addEventListener('click', () => closedInput.click());
    </script>`);
  const pageGuardSrc = await readFile(filePickerGuardPageJsPath, 'utf-8');
  await page.addScriptTag({ content: pageGuardSrc });

  const client = new CDPClient();
  const protocolSession = await page.context().newCDPSession(page);
  client.sendCommand = async (_tabId, method, params = {}) => protocolSession.send(method, params);
  protocolSession.on('Page.fileChooserOpened', (params) => {
    const handlers = client.eventHandlers.get(77)?.['Page.fileChooserOpened'] || [];
    for (const handler of handlers) handler(params);
  });
  client.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });

  let chooserOpened = false;
  page.once('filechooser', () => { chooserOpened = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#choose');
  const blocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);

  if (chooserOpened) throw new Error('trusted showPicker native chooser was not suppressed');
  if (!blocked?.blocked || blocked.selector !== '#trusted-show-picker') {
    throw new Error(`expected trusted showPicker block, got ${JSON.stringify(blocked)}`);
  }
  const restored = await page.evaluate(
    () => ({
      showPicker: HTMLInputElement.prototype.showPicker === window.__originalShowPicker,
      click: HTMLInputElement.prototype.click === window.__originalInputClick,
    }),
  );
  if (!restored.showPicker || !restored.click) {
    throw new Error(`input prototypes were not restored after guard consumption: ${JSON.stringify(restored)}`);
  }

  let closedChooserOpened = false;
  page.once('filechooser', () => { closedChooserOpened = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#choose-closed');
  const closedBlocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);
  if (closedChooserOpened) throw new Error('trusted closed-shadow native chooser was not suppressed');
  if (!closedBlocked?.blocked || closedBlocked.selector !== null) {
    throw new Error(`expected trusted closed-shadow block without selector, got ${JSON.stringify(closedBlocked)}`);
  }

  let directChooserEventObserved = false;
  page.once('filechooser', () => { directChooserEventObserved = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#closed-host');
  const directBlocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);
  if (!directChooserEventObserved) {
    throw new Error('direct trusted closed-shadow chooser did not emit the intercepted protocol event');
  }
  if (!directBlocked?.blocked || directBlocked.selector !== null) {
    throw new Error(`expected protocol-level closed-shadow block, got ${JSON.stringify(directBlocked)}`);
  }

  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute('data-webbrain-file-picker-guard', 'residual-content-guard');
    document.dispatchEvent(new Event('webbrain:file-picker-guard-arm'));
    root.removeAttribute('data-webbrain-file-picker-guard');
  });
  const residualInstalled = await page.evaluate(
    () => HTMLInputElement.prototype.click !== window.__originalInputClick,
  );
  if (!residualInstalled) throw new Error('residual page-world guard was not installed');

  await client.armFileInputClickGuard(77, 250);
  const noPickerBlocked = await client.consumeFileInputClickGuard(77, 0);
  if (noPickerBlocked) throw new Error(`unexpected picker during restore-stack test: ${JSON.stringify(noPickerBlocked)}`);
  await page.waitForTimeout(350);
  const stackRestored = await page.evaluate(() => ({
    showPicker: HTMLInputElement.prototype.showPicker === window.__originalShowPicker,
    click: HTMLInputElement.prototype.click === window.__originalInputClick,
  }));
  if (!stackRestored.showPicker || !stackRestored.click) {
    throw new Error(`stacked page/CDP guards did not restore native prototypes: ${JSON.stringify(stackRestored)}`);
  }
});

test('Firefox upload_file resolves one open-shadow input and rejects ambiguous pierced selectors', async (page) => {
  await page.setContent(`<!doctype html>
    <div id="host-a"></div>
    <div id="host-b"></div>
    <script>
      const inputA = document.createElement('input');
      inputA.type = 'file';
      inputA.id = 'shadow-upload';
      window.__uploadEvents = { input: 0, change: 0 };
      inputA.addEventListener('input', () => window.__uploadEvents.input++);
      inputA.addEventListener('change', () => window.__uploadEvents.change++);
      document.querySelector('#host-a').attachShadow({ mode: 'open' }).appendChild(inputA);
      const inputB = document.createElement('input');
      inputB.type = 'file';
      document.querySelector('#host-b').attachShadow({ mode: 'open' }).appendChild(inputB);
    </script>`);

  const originalBrowser = globalThis.browser;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.browser = {
      downloads: {
        async search(query) {
          if (query?.id !== 9001) throw new Error(`unexpected download query ${JSON.stringify(query)}`);
          return [{
            id: 9001,
            state: 'complete',
            url: 'https://example.com/shadow-upload.txt',
            filename: '/home/user/Downloads/shadow-upload.txt',
            mime: 'text/plain',
          }];
        },
      },
      tabs: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com/form' };
        },
        async executeScript(_tabId, details) {
          return [await page.evaluate((source) => window.eval(source), details.code)];
        },
      },
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const key = String(name).toLowerCase();
          if (key === 'content-length') return '2';
          if (key === 'content-type') return 'text/plain';
          return null;
        },
      },
      async arrayBuffer() {
        return new Uint8Array([111, 107]).buffer;
      },
    });

    const agent = new FirefoxAgent({});
    const uploaded = await agent.executeTool(77, 'upload_file', {
      selector: '#shadow-upload',
      downloadId: 9001,
    });
    if (
      !uploaded?.success
      || uploaded.attached?.name !== 'shadow-upload.txt'
      || uploaded.attached?.size !== 2
      || uploaded.attachmentState !== 'input_attached'
      || uploaded.verified !== false
      || uploaded.remoteStateVerified !== false
    ) {
      throw new Error(`open-shadow upload failed: ${JSON.stringify(uploaded)}`);
    }
    const state = await page.evaluate(() => {
      const input = document.querySelector('#host-a').shadowRoot.querySelector('#shadow-upload');
      return {
        count: input.files.length,
        name: input.files[0]?.name || '',
        size: input.files[0]?.size ?? -1,
        events: window.__uploadEvents,
      };
    });
    if (
      state.count !== 1
      || state.name !== 'shadow-upload.txt'
      || state.size !== 2
      || state.events.input !== 1
      || state.events.change !== 1
    ) {
      throw new Error(`open-shadow upload state mismatch: ${JSON.stringify(state)}`);
    }

    await page.evaluate(() => {
      const input = document.querySelector('#host-a').shadowRoot.querySelector('#shadow-upload');
      input.addEventListener('change', () => {
        queueMicrotask(() => { input.value = ''; });
      }, { once: true });
    });
    const consumed = await agent.executeTool(77, 'upload_file', {
      selector: '#shadow-upload',
      downloadId: 9001,
    });
    const consumedCount = await page.evaluate(() => (
      document.querySelector('#host-a').shadowRoot.querySelector('#shadow-upload').files.length
    ));
    if (
      consumed?.success !== true
      || consumed.attachmentState !== 'page_consumed'
      || consumed.verified !== false
      || consumed.remoteStateVerified !== false
      || consumedCount !== 0
    ) {
      throw new Error(`queued file consumption was misclassified: ${JSON.stringify({ consumed, consumedCount })}`);
    }

    const ambiguous = await agent.executeTool(77, 'upload_file', {
      selector: 'input[type="file"]',
      downloadId: 9001,
    });
    if (
      ambiguous?.success !== false
      || ambiguous.dispatched !== false
      || ambiguous.ambiguous !== true
      || ambiguous.matchCount !== 2
      || ambiguous.recoveryRequired !== 'get_interactive_elements'
      || !/exact, unique selector/.test(ambiguous.error || '')
    ) {
      throw new Error(`ambiguous pierced selector did not fail closed: ${JSON.stringify(ambiguous)}`);
    }

    const blockedRetry = await agent.executeTool(77, 'upload_file', {
      selector: '#shadow-upload',
      downloadId: 9001,
    });
    if (
      blockedRetry?.success !== false
      || blockedRetry.noDispatch !== true
      || blockedRetry.matchCount !== 2
      || blockedRetry.recoveryRequired !== 'get_interactive_elements'
    ) {
      throw new Error(`upload retry was not blocked pending inspection: ${JSON.stringify(blockedRetry)}`);
    }
    if (agent._clearUploadSelectorRecoveryAfterInspection(
      77,
      'get_interactive_elements',
      [],
    )) {
      throw new Error('empty inspection cleared upload recovery');
    }
    if (!agent._uploadSelectorRecoveryRequired.has(77)) {
      throw new Error('empty inspection removed upload recovery state');
    }
    if (agent._clearUploadSelectorRecoveryAfterInspection(
      77,
      'get_interactive_elements',
      [{ tag: 'input', type: 'file' }],
    )) {
      throw new Error('selector-less file-input inspection cleared upload recovery');
    }
    if (!agent._clearUploadSelectorRecoveryAfterInspection(
      77,
      'get_interactive_elements',
      [{ tag: 'input', type: 'file', selector: '#shadow-upload' }],
    )) {
      throw new Error('fresh interactive-element inspection did not clear upload recovery');
    }
    agent._uploadSelectorRecoveryRequired.set(77, 2);
    agent._clearRunLoopState(77);
    if (agent._uploadSelectorRecoveryRequired.has(77)) {
      throw new Error('Firefox run cleanup did not clear upload recovery');
    }
  } finally {
    if (originalBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = originalBrowser;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

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

  test(`click_ax (${browserKind}): refs are rejected after a same-document route change`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!match || !tree?.documentToken || !tree?.refScopeUrl) {
      throw new Error(`expected scoped AX ref, got: ${JSON.stringify(tree)}`);
    }
    await page.evaluate(() => history.pushState({}, '', '#different-route'));
    const result = await call(page, 'click_ax', {
      ref_id: match[1],
      expectedDocumentToken: tree.documentToken,
      expectedPageUrl: tree.refScopeUrl,
    });
    if (
      result?.success !== false
      || result?.staleRef !== true
      || result?.routeChanged !== true
      || result?.dispatched !== false
    ) {
      throw new Error(`expected route-scoped stale-ref failure, got: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): an old ref cannot alias after the new route tree is read`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const firstTree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const firstMatch = String(firstTree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!firstMatch) throw new Error(`expected first-route ref, got: ${JSON.stringify(firstTree)}`);

    await page.evaluate(() => history.pushState({}, '', '#new-tree-route'));
    const secondTree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const secondMatch = String(secondTree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!secondMatch || !secondTree?.documentToken || !secondTree?.refScopeUrl) {
      throw new Error(`expected second-route scoped AX ref, got: ${JSON.stringify(secondTree)}`);
    }
    if (firstMatch[1] === secondMatch[1]) {
      throw new Error(`route-scoped refs must not reuse the same identifier: ${firstMatch[1]}`);
    }

    // Simulate the reviewed failure exactly: the agent has already cached the
    // latest route scope but the model reuses a ref string from the old tree.
    const stale = await call(page, 'click_ax', {
      ref_id: firstMatch[1],
      expectedDocumentToken: secondTree.documentToken,
      expectedPageUrl: secondTree.refScopeUrl,
    });
    if (
      stale?.success !== false
      || stale?.dispatched !== false
      || stale?.noDispatch !== true
      || stale?.fallbackAttempted !== false
      || !/not found/i.test(stale?.error || '')
    ) {
      throw new Error(`expected old ref to fail before dispatch, got: ${JSON.stringify(stale)}`);
    }

    const fresh = await call(page, 'click_ax', {
      ref_id: secondMatch[1],
      expectedDocumentToken: secondTree.documentToken,
      expectedPageUrl: secondTree.refScopeUrl,
    });
    if (!fresh?.success) {
      throw new Error(`expected current-route ref to remain usable, got: ${JSON.stringify(fresh)}`);
    }
  });

  test(`click_ax (${browserKind}): unnamed broad generic targets are rejected`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/group \[(ref_\d+)\]/);
    if (!match) throw new Error(`could not find unnamed broad group in AX tree: ${tree?.pageContent}`);
    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result?.ambiguousTarget !== true
      || result?.dispatched !== false
      || result?.targetContext?.truncated !== true
    ) {
      throw new Error(`expected ambiguous generic target failure, got: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): disabled controls are visible and rejected before dispatch`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    for (const label of ['Disabled native action', 'Disabled ARIA action']) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = content.match(new RegExp(`button "${escaped}" \\[(ref_\\d+)\\][^\\n]*disabled=true`));
      if (!match) throw new Error(`expected disabled state for ${label} in AX tree: ${content}`);
      const result = await call(page, 'click_ax', { ref_id: match[1] });
      if (
        result?.success !== false
        || result.disabled !== true
        || result.dispatched !== false
        || result.noDispatch !== true
        || result.fallbackAttempted !== false
      ) {
        throw new Error(`disabled ${label} should fail before dispatch: ${JSON.stringify(result)}`);
      }
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

  test(`checkbox tools (${browserKind}): AX state and set_checked are explicit and idempotent`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    const match = content.match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*type="checkbox"[^\n]*checked=false/);
    if (!match) throw new Error(`expected native unchecked state in AX tree: ${content}`);

    const checked = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      checked?.success !== true
      || checked.checkedBefore !== false
      || checked.checkedAfter !== true
      || checked.checkedChanged !== true
      || checked.verified !== true
    ) {
      throw new Error(`click_ax did not report native checkbox transition: ${JSON.stringify(checked)}`);
    }

    const unchecked = await call(page, 'set_checked', { ref_id: match[1], checked: false });
    if (
      unchecked?.success !== true
      || unchecked.checkedBefore !== true
      || unchecked.checkedAfter !== false
      || unchecked.changed !== true
      || unchecked.verified !== true
    ) {
      throw new Error(`set_checked did not reach desired false state: ${JSON.stringify(unchecked)}`);
    }

    const idempotent = await call(page, 'set_checked', { ref_id: match[1], checked: false });
    if (
      idempotent?.success !== true
      || idempotent.idempotent !== true
      || idempotent.dispatched !== false
      || idempotent.checkedBefore !== false
      || idempotent.checkedAfter !== false
    ) {
      throw new Error(`set_checked repeated action was not idempotent: ${JSON.stringify(idempotent)}`);
    }
  });

  test(`set_checked (${browserKind}): wrapped labels and confirmation-gated state are explicit`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    const match = content.match(/checkbox "Firefox for Android compatibility" \[(ref_\d+)\][^\n]*type="checkbox"[^\n]*checked=false/);
    if (!match) throw new Error(`expected wrapped Android checkbox label in AX tree: ${content}`);

    const result = await call(page, 'set_checked', { ref_id: match[1], checked: true });
    if (
      result?.success !== false
      || result.dispatched !== true
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.verified !== false
      || result.confirmationRequired !== true
      || result.recoveryRequired !== 'confirmation_dialog'
      || result.noProgress === true
      || result.error
      || result.confirmation?.title !== 'Firefox for Android compatibility'
      || !result.confirmation?.actions?.includes('Yes, I’ve tested my extension with Firefox for Android')
      || !result.confirmation?.actions?.includes('No, I have not tested')
    ) {
      throw new Error(`confirmation-gated checkbox was reported as ordinary no-progress: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): waits for controlled checkbox reconciliation`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
    if (!match) throw new Error(`expected controlled checkbox ref in AX tree: ${tree?.pageContent}`);

    await page.evaluate(() => {
      const checkbox = document.getElementById('firefox-checkbox');
      checkbox.addEventListener('click', () => {
        setTimeout(() => {
          checkbox.checked = false;
        }, 0);
      });
    });
    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result.noProgress !== true
      || result.verified !== false
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.desiredChecked !== true
      || result.checkboxState?.actualChecked !== false
    ) {
      throw new Error(`controlled checkbox rollback was accepted too early: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): an already-selected radio keeps desired checked state`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/radio "Selected channel" \[(ref_\d+)\][^\n]*checked=true/);
    if (!match) throw new Error(`expected selected radio state in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== true
      || result.checkedBefore !== true
      || result.checkedAfter !== true
      || result.checkedChanged !== false
      || result.desiredChecked !== true
      || result.checkboxState?.desiredChecked !== true
      || result.checkboxState?.actualChecked !== true
    ) {
      throw new Error(`selected radio was represented as needing an uncheck: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): a prevented radio selection is an explicit failure`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/radio "Blocked channel" \[(ref_\d+)\][^\n]*checked=false/);
    if (!match) throw new Error(`expected blocked radio state in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result.noProgress !== true
      || result.verified !== false
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.desiredChecked !== true
      || result.checkboxState?.actualChecked !== false
      || !/Radio remained unselected/.test(String(result.error || ''))
    ) {
      throw new Error(`prevented radio selection was not reported as a failure: ${JSON.stringify(result)}`);
    }
  });

  test(`verify_form refs (${browserKind}): form controls receive actionable AX refs`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const result = await call(page, 'resolve_form_field_refs', { selector: 'form' });
    if (
      result?.success !== true
      || !Array.isArray(result.refs)
      || result.refs.length < 4
      || result.refs.some(ref => !/^ref_\d+$/.test(String(ref || '')))
      || typeof result.documentToken !== 'string'
      || !result.documentToken
      || result.refScopeUrl !== page.url()
    ) {
      throw new Error(`form controls did not receive actionable refs: ${JSON.stringify(result)}`);
    }
  });
}

async function assertSemicolonShortcutEvent(page, browserKind, expectedKeyCode) {
  await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
  await page.evaluate(() => {
    window.__semicolonShortcutEvents = [];
    document.addEventListener('keydown', (event) => {
      if (event.key !== ';') return;
      window.__semicolonShortcutEvents.push({
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        which: event.which,
      });
    });
  });

  const result = await call(page, 'press_keys', { key: ';' });
  if (result?.success !== true || result?.dispatched !== true || result?.key !== ';') {
    throw new Error(`semicolon should dispatch successfully, got: ${JSON.stringify(result)}`);
  }
  const events = await page.evaluate(() => window.__semicolonShortcutEvents);
  if (
    events?.length !== 1
    || events[0]?.key !== ';'
    || events[0]?.code !== 'Semicolon'
    || events[0]?.keyCode !== expectedKeyCode
    || events[0]?.which !== expectedKeyCode
  ) {
    throw new Error(`semicolon shortcut metadata mismatch: ${JSON.stringify(events)}`);
  }
}

test('press_keys (chrome): semicolon dispatches Chromium-compatible metadata', async (page) => {
  await assertSemicolonShortcutEvent(page, 'chrome', 186);
});

firefoxTest('press_keys (firefox engine): semicolon dispatches Gecko-compatible metadata', async (page) => {
  await assertSemicolonShortcutEvent(page, 'firefox', 59);
});

test('set_checked (chrome): post-click verification survives same-document route changes', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'chrome');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Chrome checkbox ref in AX tree: ${tree?.pageContent}`);

  const preflight = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  if (preflight?.needsTrustedClick !== true || !preflight.marker) {
    throw new Error(`expected trusted checkbox preflight marker: ${JSON.stringify(preflight)}`);
  }

  await page.locator('#firefox-checkbox').click();
  await page.evaluate(() => history.pushState({}, '', '#checked-filter'));
  const verified = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    probeOnly: true,
    markForTrustedClick: false,
    cleanupMarker: preflight.marker,
  });
  if (
    verified?.success !== true
    || verified.checkedAfter !== true
    || verified.verified !== true
    || verified.staleRef === true
  ) {
    throw new Error(`same-document route change invalidated marker verification: ${JSON.stringify(verified)}`);
  }
});

test('set_checked (chrome): markers are one-shot, unique, and self-cleaning', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'chrome');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Chrome checkbox ref in AX tree: ${tree?.pageContent}`);

  await page.evaluate(() => {
    window.__wbOriginalSetTimeout = window.setTimeout;
    window.__wbMarkerCleanup = null;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 15000 && !window.__wbMarkerCleanup) {
        window.__wbMarkerCleanup = callback;
        return 1;
      }
      return window.__wbOriginalSetTimeout(callback, delay, ...args);
    };
  });
  const expiring = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  const expiredCount = await page.evaluate((marker) => {
    window.__wbMarkerCleanup?.();
    window.setTimeout = window.__wbOriginalSetTimeout;
    delete window.__wbOriginalSetTimeout;
    delete window.__wbMarkerCleanup;
    return document.querySelectorAll(`[data-webbrain-set-checked-target="${marker}"]`).length;
  }, expiring.marker);
  if (expiredCount !== 0) throw new Error(`trusted marker did not self-clean: ${expiring.marker}`);

  const ambiguous = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  await page.evaluate((marker) => {
    document.getElementById('trusted-firefox-checkbox')
      .setAttribute('data-webbrain-set-checked-target', marker);
  }, ambiguous.marker);
  const uniqueClient = new CDPClient();
  uniqueClient.sendCommand = async (_tabId, method) => {
    if (method === 'Runtime.enable') return {};
    throw new Error(`unexpected CDP command while resolving marker: ${method}`);
  };
  uniqueClient.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });
  const duplicateResolution = await uniqueClient.resolveSelector(
    42,
    `[data-webbrain-set-checked-target="${ambiguous.marker}"]`,
    { requireUnique: true, retries: 0 },
  );
  if (!duplicateResolution?.error || duplicateResolution?.matchCount !== 2) {
    throw new Error(`CDP trusted selector did not reject duplicate markers: ${JSON.stringify(duplicateResolution)}`);
  }
  const verified = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    probeOnly: true,
    markForTrustedClick: false,
    cleanupMarker: ambiguous.marker,
  });
  const remaining = await page.locator(`[data-webbrain-set-checked-target="${ambiguous.marker}"]`).count();
  if (
    verified?.success !== false
    || verified.markerConflict !== true
    || verified.markerMatchCount !== 2
    || remaining !== 0
  ) {
    throw new Error(`ambiguous trusted marker did not fail closed and clean up: ${JSON.stringify({ verified, remaining })}`);
  }
});

test('set_checked (firefox): waits for controlled checkbox reconciliation before verifying', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'firefox');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Firefox checkbox ref in AX tree: ${tree?.pageContent}`);

  await page.evaluate(() => {
    const checkbox = document.getElementById('firefox-checkbox');
    checkbox.addEventListener('click', () => {
      setTimeout(() => {
        checkbox.checked = false;
      }, 0);
    }, { once: true });
  });

  const result = await call(page, 'set_checked', { ref_id: match[1], checked: true });
  if (
    result?.success !== false
    || result.dispatched !== true
    || result.checkedBefore !== false
    || result.checkedAfter !== false
    || result.verified !== false
    || result.noProgress !== true
  ) {
    throw new Error(`Firefox set_checked verified before controlled rollback settled: ${JSON.stringify(result)}`);
  }
});

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
      String(result.targetContext.text).length > 240
      || String(result.targetContext.heading).length > 160
      || String(result.targetContext.href).length > 500
    ) {
      throw new Error(`product context bounds regressed: ${JSON.stringify(result.targetContext)}`);
    }
  });

  test(`click_ax (${browserKind}): a portaled menu item describes the post its menu was opened from`, async (page) => {
    await setupContentHtml(page, `
      <style>.dropdown-menu { position: fixed; left: 420px; background: #fff; } button { display: block; }</style>
      <header><h1>Profile header</h1><a href="/settings/profile">Edit profile</a></header>
      <article><a href="/@qa/1">1d</a><p>First test toot</p><button aria-expanded="false">More</button></article>
      <article><a href="/@qa/2">3d</a><p>Second test toot</p><button aria-expanded="true" aria-controls="menu-2">More</button></article>
      <div id="menu-2"><div class="dropdown-menu" style="top:40px"><ul><li><button>Edit</button></li><li><button>Delete</button></li></ul></div></div>
      <div class="dropdown-menu" style="top:200px"><ul><li><button>Orphan action</button></li></ul></div>`, browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 12, maxChars: 20000 });
    const ref = name => String(tree?.pageContent || '').match(new RegExp(`button "${name}" \\[(ref_\\d+)\\]`))?.[1];
    const menuItem = await call(page, 'click_ax', { ref_id: ref('Delete') });
    const context = menuItem?.targetContext || {};
    if (!menuItem?.success || !String(context.text || '').includes('Second test toot') || /Profile header|First test toot/.test(String(context.text))
        || !String(context.href || '').endsWith('/@qa/2')) {
      throw new Error(`a menu item must be described by the post that opened its menu: ${JSON.stringify(menuItem)}`);
    }
    // A menu with no opener is described by itself at most, never by the page around the portal.
    const orphan = await call(page, 'click_ax', { ref_id: ref('Orphan action') });
    if (!orphan?.success || /Profile header|test toot/.test(String(orphan.targetContext?.text || ''))) {
      throw new Error(`a menu without an opener borrowed the page around it: ${JSON.stringify(orphan)}`);
    }
  });

  test(`click_ax (${browserKind}): an inline menu without a launcher keeps its post as context`, async (page) => {
    await setupContentHtml(page, `
      <header><h1>Profile header</h1><a href="/settings/profile">Edit profile</a></header>
      <article><a href="/@qa/7">2d</a><p>Seventh test toot</p>
        <div class="dropdown-menu"><ul><li><button>Delete</button></li></ul></div>
      </article>`, browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 12, maxChars: 20000 });
    const ref = String(tree?.pageContent || '').match(/button "Delete" \[(ref_\d+)\]/)?.[1];
    const result = await call(page, 'click_ax', { ref_id: ref });
    const context = result?.targetContext || {};
    if (!result?.success || !String(context.text || '').includes('Seventh test toot') || /Profile header/.test(String(context.text))
        || !String(context.href || '').endsWith('/@qa/7')) {
      throw new Error(`an inline menu must keep the post it sits in as context: ${JSON.stringify(result)}`);
    }
  });

  test(`resolve_visual_target (${browserKind}): nested SVG resolves semantic button`, async (page) => {
    await setupContentHtml(page, `
      <style>button { position: fixed; left: 40px; top: 30px; width: 120px; height: 60px; }</style>
      <button id="target" aria-label="Add to cart" onclick="window.__nestedSvgClicked = true">
        <svg id="icon" width="100%" height="100%"><circle cx="60" cy="30" r="20"></circle></svg>
      </button>
    `, browserKind);
    const point = await page.locator('#icon circle').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const result = await call(page, 'resolve_visual_target', point);
    if (
      !result?.success
      || result.semanticTarget?.role !== 'button'
      || result.semanticTarget?.name !== 'Add to cart'
      || !/^ref_\d+$/.test(result.semanticTarget?.ref_id || '')
      || result.semanticTarget?.eligibility !== 'semantic-button'
      || Object.hasOwn(result.semanticTarget, 'rect')
    ) {
      throw new Error(`nested SVG did not resolve to button: ${JSON.stringify(result)}`);
    }
    const clickResult = await call(page, 'click_ax', {
      ref_id: result.semanticTarget.ref_id,
      expectedDocumentToken: result.documentToken,
      expectedPageUrl: result.refScopeUrl,
    });
    if (!clickResult?.success || await page.evaluate(() => window.__nestedSvgClicked) !== true) {
      throw new Error(`nested SVG semantic dispatch did not activate its button: ${JSON.stringify(clickResult)}`);
    }
  });

  test(`resolve_visual_target (${browserKind}): plain canvas stays coordinate-only`, async (page) => {
    await setupContentHtml(page, '<canvas id="canvas" width="200" height="100" style="position:fixed;left:20px;top:20px"></canvas>', browserKind);
    const point = { x: 70, y: 55 };
    const result = await call(page, 'resolve_visual_target', point);
    if (
      !result?.success
      || result.semanticTarget?.eligibility !== 'coordinate-only'
      || !/^ref_\d+$/.test(result.semanticTarget?.ref_id || '')
      || Object.hasOwn(result.semanticTarget, 'rect')
    ) {
      throw new Error(`canvas should stay coordinate-only: ${JSON.stringify(result)}`);
    }
  });

  test(`resolve_visual_target (${browserKind}): form controls and iframe boundaries stay coordinate-only`, async (page) => {
    await setupContentHtml(page, `
      <style>
        #frame { position:fixed;left:20px;top:20px;width:120px;height:50px; }
        #label { position:fixed;left:20px;top:90px;width:160px;height:30px; }
        #text { position:fixed;left:20px;top:140px;width:160px;height:30px; }
        #notes { position:fixed;left:20px;top:190px;width:160px;height:30px; }
        #select { position:fixed;left:20px;top:240px;width:160px;height:30px; }
        #file { position:fixed;left:20px;top:290px;width:160px;height:30px; }
      </style>
      <iframe id="frame" title="Embedded boundary"></iframe>
      <label id="label" for="text">Account name</label>
      <input id="text" aria-label="Account name">
      <textarea id="notes" aria-label="Notes"></textarea>
      <select id="select" aria-label="Plan"><option>Basic</option></select>
      <input id="file" type="file" aria-label="Upload receipt">
    `, browserKind);

    for (const selector of ['#frame', '#label', '#text', '#notes', '#select', '#file']) {
      const point = await page.locator(selector).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const result = await call(page, 'resolve_visual_target', point);
      if (
        !result?.success
        || result.semanticTarget?.eligibility !== 'coordinate-only'
        || !/^ref_\d+$/.test(result.semanticTarget?.ref_id || '')
        || Object.hasOwn(result.semanticTarget, 'rect')
      ) {
        throw new Error(`${selector} should stay coordinate-only: ${JSON.stringify(result)}`);
      }
    }
  });

  test(`resolve_visual_target (${browserKind}): open shadow button resolves`, async (page) => {
    await setupContentHtml(page, '<div id="host" style="position:fixed;left:25px;top:25px"></div>', browserKind);
    await page.evaluate(() => {
      const root = document.querySelector('#host').attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="shadow-target" aria-label="Shadow action" style="width:140px;height:50px">Action</button>';
      root.querySelector('button').addEventListener('click', () => { window.__shadowClicked = true; });
    });
    const point = await page.locator('#host').evaluate((host) => {
      const r = host.shadowRoot.querySelector('button').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const result = await call(page, 'resolve_visual_target', point);
    if (
      !result?.success
      || result.semanticTarget?.role !== 'button'
      || result.semanticTarget?.name !== 'Shadow action'
      || !/^ref_\d+$/.test(result.semanticTarget?.ref_id || '')
      || result.semanticTarget?.eligibility !== 'semantic-button'
    ) {
      throw new Error(`open shadow target was not resolved: ${JSON.stringify(result)}`);
    }
    const clickResult = await call(page, 'click_ax', {
      ref_id: result.semanticTarget.ref_id,
      expectedDocumentToken: result.documentToken,
      expectedPageUrl: result.refScopeUrl,
    });
    if (!clickResult?.success || await page.evaluate(() => window.__shadowClicked) !== true) {
      throw new Error(`open shadow semantic dispatch did not activate its button: ${JSON.stringify(clickResult)}`);
    }
  });
}

test('set_field (chrome): model-backed editor trusted input updates framework state and enables submit', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  await page.evaluate(() => {
    const editor = document.getElementById('framework-editor');
    editor.classList.add('ProseMirror');
    editor.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>';
  });
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const content = String(tree?.pageContent || '');
  const editorMatch = content.match(/textbox "Framework post text" \[(ref_\d+)\]/);
  if (!editorMatch || !/button "Framework Post" \[(ref_\d+)\][^\n]*disabled=true/.test(content)) {
    throw new Error(`expected empty framework editor and disabled submit: ${content}`);
  }

  const preflight = await call(page, 'set_field', {
    ref_id: editorMatch[1],
    text: 'Trusted framework post',
    clear: true,
  });
  if (
    preflight?.success !== false
    || preflight.trustedTypeRequired !== true
    || preflight.dispatched !== false
    || preflight.noDispatch !== true
  ) {
    throw new Error(`contenteditable set_field should route to trusted typing before DOM mutation: ${JSON.stringify(preflight)}`);
  }

  const before = await page.evaluate(() => ({
    text: document.getElementById('framework-editor').innerText,
    disabled: document.getElementById('framework-post').getAttribute('aria-disabled'),
    events: window.__frameworkInputEvents,
  }));
  if (before.text !== '\n' || before.disabled !== 'true' || before.events.length !== 0) {
    throw new Error(`contenteditable preflight mutated framework state: ${JSON.stringify(before)}`);
  }

  const originalChrome = globalThis.chrome;
  const originals = {
    attach: cdpClient.attach,
    sendCommand: cdpClient.sendCommand,
  };
  const session = await page.context().newCDPSession(page);
  globalThis.chrome = {
    tabs: {
      async sendMessage(_tabId, message) {
        return call(page, message.action, message.params || {});
      },
    },
  };
  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.sendCommand = async (_tabId, method, params) => session.send(method, params);
    const agent = new Agent({});
    const result = await agent._maybeFallbackFieldWithCdp(
      42,
      'set_field',
      { ref_id: editorMatch[1], text: 'Trusted framework post', clear: true },
      preflight,
    );
    const after = await page.evaluate(() => ({
      text: document.getElementById('framework-editor').innerText,
      disabled: document.getElementById('framework-post').getAttribute('aria-disabled'),
      events: window.__frameworkInputEvents,
    }));
    if (
      result?.success !== true
      || result.trusted !== true
      || result.verified !== true
      || result.dispatched !== true
      || after.text !== 'Trusted framework post'
      || after.disabled !== 'false'
      || after.events.length !== 1
      || after.events[0].trusted !== true
    ) {
      throw new Error(`trusted contenteditable path did not update framework state: ${JSON.stringify({ result, after })}`);
    }
  } finally {
    cdpClient.attach = originals.attach;
    cdpClient.sendCommand = originals.sendCommand;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('type_ax (chrome): Gmail-style editor appends literal blank lines without masking corruption', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  await page.evaluate(() => {
    const editor = document.getElementById('editable-row');
    editor.setAttribute('aria-label', 'Message Body');
    editor.innerHTML = 'Hey Andrew,<div><br></div><div>Thank you!</div>';
  });
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const editorMatch = String(tree?.pageContent || '').match(/textbox "Message Body" \[(ref_\d+)\]/);
  if (!editorMatch) throw new Error(`expected Gmail-style message body: ${tree?.pageContent}`);

  const originalChrome = globalThis.chrome;
  const originals = {
    attach: cdpClient.attach,
    sendCommand: cdpClient.sendCommand,
  };
  const session = await page.context().newCDPSession(page);
  globalThis.chrome = {
    tabs: {
      async sendMessage(_tabId, message) {
        return call(page, message.action, message.params || {});
      },
    },
  };
  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.sendCommand = async (_tabId, method, params) => session.send(method, params);
    const agent = new Agent({});
    const appendText = '\n\nAre these good enough?';
    const preflight = await call(page, 'type_ax', {
      ref_id: editorMatch[1],
      text: appendText,
      clear: false,
    });
    const result = preflight;
    const after = await page.evaluate(() => {
      const editor = document.getElementById('editable-row');
      return {
        innerText: editor.innerText,
        preservedPrefix: editor.firstChild?.textContent === 'Hey Andrew,' && editor.children[1]?.textContent.startsWith('Thank you!'),
        directBlankBlocks: Array.from(editor.children)
          .filter(child => child.tagName === 'DIV' && child.innerHTML.toLowerCase() === '<br>').length,
      };
    });
    if (
      result?.success !== true
      || result.verified !== true
      || after.innerText !== 'Hey Andrew,\n\n\nThank you!\n\nAre these good enough?'
      || after.preservedPrefix !== true
      || after.directBlankBlocks !== 1
    ) {
      throw new Error(`Gmail-style append must preserve the requested literal lines: ${JSON.stringify({ result, after })}`);
    }

    await page.evaluate(() => {
      document.getElementById('editable-row').addEventListener('input', (event) => {
        event.currentTarget.append(document.createTextNode('!'));
      }, { once: true });
    });
    const corruptAppend = '\n\nOne more line.';
    const corruptPreflight = await call(page, 'type_ax', {
      ref_id: editorMatch[1],
      text: corruptAppend,
      clear: false,
    });
    const corruptResult = corruptPreflight;
    if (
      corruptResult?.success !== false
      || corruptResult.verified !== false
      || corruptResult.dispatched !== true
    ) {
      throw new Error(`real rich-editor corruption must remain rejected: ${JSON.stringify(corruptResult)}`);
    }
  } finally {
    cdpClient.attach = originals.attach;
    cdpClient.sendCommand = originals.sendCommand;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

firefoxTest('type_ax (firefox engine): rich-editor verification rejects an added blank line', async (page) => {
  await setupFirefoxHtml(page, `
    <div id="editor" role="textbox" aria-label="Message Body" contenteditable="true"
      style="width:400px;height:160px">Original</div>
  `);
  await page.evaluate(() => {
    const editor = document.getElementById('editor');
    window.__wb_ax_lookup = refId => refId === 'ref_editor' ? editor : null;
    editor.addEventListener('input', () => {
      editor.innerHTML = 'First<br><br><br>Second';
    });
  });
  const result = await rawContentCall(page, 'type_ax', {
    ref_id: 'ref_editor',
    text: 'First\n\nSecond',
    clear: true,
  });
  const actual = await page.locator('#editor').evaluate(editor => editor.innerText);
  if (
    result?.success !== false
    || result.verified !== false
    || result.dispatched !== true
    || actual !== 'First\n\n\nSecond'
  ) {
    throw new Error(`Firefox must reject a page-added blank line: ${JSON.stringify({ result, actual })}`);
  }
});

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

// From a trace: WhatsApp's chat list rows are grid cells that a
// script-dispatched click does not open, and the trusted retry skipped every
// role but generic, listitem and row, so the agent could not open the chat.
// Other grids (spreadsheets, calendars) keep their cells synthetic-only: a
// second, trusted click there can turn a selection into an edit.
test('click_ax: a grid cell outside WhatsApp\'s chat list is never retried with a trusted click', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const cellMatch = String(tree?.pageContent || '').match(/gridcell "Grid chat row" \[(ref_\d+)\]/);
  if (!cellMatch) throw new Error('expected the grid cell in the AX tree');
  const result = await call(page, 'ax_resolve_rect', { ref_id: cellMatch[1], forClickFallback: true });
  if (result?.fallbackEligible !== false || !/role "gridcell" is not eligible/.test(result.fallbackBlockedReason || '')) {
    throw new Error(`a grid cell on another site must stay synthetic-only: ${JSON.stringify(result)}`);
  }
});

test('click_ax: a grid cell row that ignores the synthetic click gets the trusted CDP retry', async (page) => {
  await setup(page, 'trusted-click-fallback.html', { asHost: 'https://web.whatsapp.com' });
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const content = String(tree?.pageContent || '');
  const cellMatch = content.match(/gridcell "Grid chat row" \[(ref_\d+)\]/);
  const selectedMatch = content.match(/gridcell "Selected grid chat row" \[(ref_\d+)\]/);
  if (!cellMatch || !selectedMatch) throw new Error(`expected the grid chat rows in the AX tree: ${content}`);
  const eligible = await call(page, 'ax_resolve_rect', { ref_id: cellMatch[1], forClickFallback: true });
  if (!eligible?.success || eligible.fallbackEligible !== true || eligible.fallbackBlockedReason) {
    throw new Error(`a grid cell row should be eligible for the trusted retry: ${JSON.stringify(eligible)}`);
  }
  const selected = await call(page, 'ax_resolve_rect', { ref_id: selectedMatch[1], forClickFallback: true });
  if (selected?.fallbackEligible !== false || !/toggle\/selection/.test(selected.fallbackBlockedReason || '')) {
    throw new Error(`a selected grid cell must stay synthetic-only: ${JSON.stringify(selected)}`);
  }

  const originalChrome = globalThis.chrome;
  const originals = { attach: cdpClient.attach, evaluate: cdpClient.evaluate, dispatch: cdpClient.dispatchMouseEvent };
  const session = await page.context().newCDPSession(page);
  const dispatched = [];
  const listener = { addListener() {}, removeListener() {} };
  globalThis.chrome = {
    runtime: {},
    tabs: {
      async get(tabId) { return { id: tabId, url: page.url(), title: 'Grid chat fixture' }; },
      async query() { return [{ id: 42, url: page.url() }]; },
      async sendMessage(_tabId, message) { return call(page, message.action, message.params || {}); },
    },
    downloads: { onCreated: listener },
    webRequest: { onBeforeRequest: listener },
    scripting: { async executeScript() {} },
  };
  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.evaluate = async (_tabId, expression) => ({ result: { value: await page.evaluate(expression) } });
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
    const result = await agent.executeTool(42, 'click_ax', { ref_id: cellMatch[1] });
    const after = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      opened: document.getElementById('grid-chat-cell').classList.contains('grid-opened'),
      events: window.__gridChatEvents,
    }));
    if (result?.success !== true || result.fallback !== 'cdp_after_synthetic_no_progress'
        || result.trusted !== true || result.verified !== true) {
      throw new Error(`the grid cell row did not get the trusted retry: ${JSON.stringify(result)}`);
    }
    if (after.status !== 'grid-opened' || !after.opened) {
      throw new Error(`the trusted retry did not open the grid chat row: ${JSON.stringify(after)}`);
    }
    // One script-dispatched click first, then one real press and click.
    const sequence = after.events.map(event => `${event.trusted ? 'trusted' : 'synthetic'}:${event.type}`).join(',');
    if (sequence !== 'synthetic:click,trusted:mousedown,trusted:click') {
      throw new Error(`unexpected grid row event sequence: ${sequence}`);
    }
    if (dispatched.map(event => event.type).join(',') !== 'mouseMoved,mousePressed,mouseReleased') {
      throw new Error(`unexpected trusted input sequence: ${JSON.stringify(dispatched)}`);
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

test('set_checked: Agent.executeTool uses one trusted selector click and then becomes idempotent', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Trusted Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected trusted checkbox ref in AX tree: ${tree?.pageContent}`);

  const originalChrome = globalThis.chrome;
  const originalAttach = cdpClient.attach;
  const originalClickElement = cdpClient.clickElement;
  try {
    globalThis.chrome = {
      runtime: {},
      tabs: {
        async get(tabId) {
          return { id: tabId, url: page.url(), title: 'Trusted checkbox fixture' };
        },
        async query() {
          return [{ id: 42, url: page.url() }];
        },
        async sendMessage(_tabId, message) {
          return call(page, message.action, message.params || {});
        },
      },
    };
    let trustedClicks = 0;
    cdpClient.attach = async () => ({ attached: true });
    cdpClient.clickElement = async (_tabId, selector, options) => {
      if (options?.trustedOnly !== true || options?.requireUnique !== true) {
        throw new Error(`expected trusted-only checkbox click, got: ${JSON.stringify(options)}`);
      }
      trustedClicks += 1;
      const locator = page.locator(selector);
      const box = await locator.boundingBox();
      await locator.click();
      return {
        success: true,
        method: 'cdp-mouse',
        rect: box ? {
          x: Math.round(box.x),
          y: Math.round(box.y),
          w: Math.round(box.width),
          h: Math.round(box.height),
        } : undefined,
      };
    };

    const agent = new Agent({});
    agent._isPdfTab = async () => false;
    agent._currentUrl = async () => page.url();
    const first = await agent.executeTool(42, 'set_checked', { ref_id: match[1], checked: true });
    const eventsAfterFirst = await page.evaluate(() => window.__trustedCheckboxEvents);
    if (
      first?.success !== true
      || first.trusted !== true
      || first.verified !== true
      || first.checkedBefore !== false
      || first.checkedAfter !== true
      || first.changed !== true
      || first.idempotent !== false
      || trustedClicks !== 1
      || eventsAfterFirst.length !== 1
      || eventsAfterFirst[0].trusted !== true
    ) {
      throw new Error(`trusted set_checked transition failed: ${JSON.stringify({ first, trustedClicks, eventsAfterFirst })}`);
    }

    const second = await agent.executeTool(42, 'set_checked', { ref_id: match[1], checked: true });
    if (
      second?.success !== true
      || second.idempotent !== true
      || second.dispatched !== false
      || second.checkedAfter !== true
      || trustedClicks !== 1
    ) {
      throw new Error(`idempotent set_checked repeated a click: ${JSON.stringify({ second, trustedClicks })}`);
    }
  } finally {
    cdpClient.attach = originalAttach;
    cdpClient.clickElement = originalClickElement;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('ax_resolve_rect: trusted fallback eligibility rejects interactive descendants, hidden, stateful, native, form, and download targets by structure', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const content = String(tree?.pageContent || '');
  const refs = {
    nestedButton: content.match(/listitem "Nested button row" \[(ref_\d+)\]/)?.[1],
    nestedLink: content.match(/listitem "Nested link row" \[(ref_\d+)\]/)?.[1],
    nestedInput: content.match(/listitem "Nested input row" \[(ref_\d+)\]/)?.[1],
    native: content.match(/button "Native button" \[(ref_\d+)\]/)?.[1],
    disclosure: content.match(/"Native disclosure" \[(ref_\d+)\]/)?.[1],
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
  // What a generic row's name means is not judged in the page: the agent
  // reads it in any language before a second, trusted click. These rows stay
  // eligible by structure and report their names for that reading.
  const namedRefs = {
    'Delete account': content.match(/listitem "Delete account" \[(ref_\d+)\]/)?.[1],
    'Send message': content.match(/listitem "Send message" \[(ref_\d+)\]/)?.[1],
    'Order lunch': content.match(/listitem "Order lunch" \[(ref_\d+)\]/)?.[1],
    'Book now': content.match(/listitem "Book now" \[(ref_\d+)\]/)?.[1],
    'Delete account indirectly': content.match(/listitem "Delete account indirectly" \[(ref_\d+)\]/)?.[1],
    'Hesabı sil': content.match(/listitem "Hesabı sil" \[(ref_\d+)\]/)?.[1],
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
  for (const [label, ref] of Object.entries(namedRefs)) {
    if (!ref) throw new Error(`missing ${label} ref in AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (!result?.success || result.fallbackEligible !== true || result.fallbackBlockedReason || result.name !== label) {
      throw new Error(`${label} should be eligible by structure and report its name for the agent's reading: ${JSON.stringify(result)}`);
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

  const ordinaryResolve = await call(page, 'ax_resolve_rect', { ref_id: namedRefs['Delete account'] });
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

test('ax_resolve_rect: an ancestor pseudo-element cannot authorize a trusted fallback click', async (page) => {
  await setupContentHtml(page, `<!doctype html>
    <style>
      #cover-parent { position: relative; margin: 100px; width: 220px; height: 100px; }
      #cover-parent::after { content: ''; position: absolute; inset: 0; z-index: 2; background: rgba(255,255,255,.1); pointer-events: auto; }
      #target { position: absolute; top: 20px; left: 20px; width: 120px; height: 40px; }
    </style>
    <div id="cover-parent">
      <div id="target" role="listitem" tabindex="0" aria-label="Safe row">Safe row</div>
    </div>
  `, 'chrome');
  const setupState = await page.evaluate(() => {
    const target = document.getElementById('target');
    const rect = target.getBoundingClientRect();
    return {
      refId: window.__wb_ax_ref(target),
      hitIsParent: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        === document.getElementById('cover-parent'),
    };
  });
  if (!setupState.hitIsParent) throw new Error(`pseudo-element fixture did not cover its child: ${JSON.stringify(setupState)}`);
  const resolved = await call(page, 'ax_resolve_rect', { ref_id: setupState.refId, forClickFallback: true });
  if (!resolved?.success || resolved.hitOk !== false || resolved.fallbackEligible !== false
    || !/covered/.test(resolved.fallbackBlockedReason || '')) {
    throw new Error(`ancestor pseudo-element incorrectly authorized the target: ${JSON.stringify(resolved)}`);
  }
});

test('ax_resolve_rect: action names reach the agent unchanged under Turkish locale casing', async (page) => {
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
    'Install app': content.match(/listitem "Install app" \[(ref_\d+)\]/)?.[1],
    'Invite teammate': content.match(/listitem "Invite teammate" \[(ref_\d+)\]/)?.[1],
  };
  for (const [label, ref] of Object.entries(refs)) {
    if (!ref) throw new Error(`missing ${label} ref in Turkish-locale AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    // The page no longer lower-cases names against a word list; the agent
    // reads the exact name in any language before a second click.
    if (result?.fallbackEligible !== true || result.name !== label) {
      throw new Error(`${label} must reach the agent with its exact name regardless of locale casing: ${JSON.stringify(result)}`);
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

async function assertFullIndexedElementsExcludeModalBackground(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
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
    throw new Error(`${label}: expected hidden/inert background controls to be filtered, got: ${JSON.stringify(elements)}`);
  }
  if (elements?.[0]?.id !== 'dialog-action') {
    throw new Error(`${label}: expected dialog action to be first actionable index, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`${label}: expected dialog click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    dialog: window.__dialogClicked === true,
    background: window.__backgroundClicked === true,
    inert: window.__inertClicked === true,
  }));
  if (!state.dialog || state.background || state.inert) {
    throw new Error(`${label}: expected only dialog action to run, got: ${JSON.stringify(state)}`);
  }
}

test('Chrome: full indexed elements exclude inert background controls', async (page) => {
  await assertFullIndexedElementsExcludeModalBackground(page, 'chrome');
});

test('Firefox: full indexed elements exclude inert background controls', async (page) => {
  await assertFullIndexedElementsExcludeModalBackground(page, 'firefox');
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


registerMessageRecipientNavigationFixtures({ test, firefoxTest, setupContentHtml, call, Agent, FirefoxAgent });
registerInteractionReviewRegressions({ test, firefoxTest, setupContentHtml, call, Agent, FirefoxAgent });

registerRichTextToolbarFixtures({
  test,
  setupContentHtml,
  setupContentFixture,
  call,
  Agent,
  FirefoxAgent,
  cdpClient,
  root,
});

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
  const onlyArgument = process.argv.slice(2).find(value => value.startsWith('--only='));
  const only = onlyArgument ? new RegExp(onlyArgument.slice(7), 'i') : null;
  const chromiumEntries = only ? tests.filter(entry => only.test(entry.name)) : tests;
  const firefoxEntries = only ? firefoxTests.filter(entry => only.test(entry.name)) : firefoxTests;
  const total = chromiumEntries.length + firefoxEntries.length;
  if (total === 0) throw new Error(`No fixtures matched ${onlyArgument}.`);
  let passed = 0, failed = 0;
  const runTests = async (browserType, entries) => {
    if (entries.length === 0) return;
    const browser = await browserType.launch();
    const context = await browser.newContext();
    for (const t of entries) {
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
  };

  await runTests(chromium, chromiumEntries);
  await runTests(playwrightFirefox, firefoxEntries);
  console.log(`\n  ${passed} passed, ${failed} failed (${total} total)`);
  process.exit(failed > 0 ? 1 : 0);
})();
