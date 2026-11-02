// Numbered answers on WebBrain's clarify cards: the real renderClarifyCard,
// submitClarify and the keydown handler run in Chromium and Firefox with the
// real stylesheet and locale strings. Each answer shows its number in a small
// square at its right edge, drawn from a data attribute so the button's own
// text stays the answer the card sends back, and typing that digit answers the
// card. A field the user is writing in keeps the digit as text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

async function panel(build, engine) {
  const source = read(build, 'src/ui/sidepanel.js');
  const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 700 } });
  await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style>
    <div class="message assistant" data-run-request-id="request-1"><div class="message-content"></div></div>
    <textarea id="composer"></textarea>`);
  await page.addScriptTag({ content: `(() => {
    const STRINGS = ${JSON.stringify(english)};
    const t = (key, params) => String(STRINGS[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => params?.[name] ?? '{' + name + '}');
    let currentTabId = 9;
    let currentAssistantEl = document.querySelector('.message.assistant');
    const inputEl = document.querySelector('#composer');
    const submittedClarificationIds = new Set();
    const sent = [];
    function clarificationSubmissionKey(tabId, requestId, clarifyId) { return JSON.stringify([Number(tabId), String(requestId || ''), String(clarifyId || '')]); }
    function hideActivity() {} function playClarifySound() {} function scrollToBottom() {} function hideRecommendedActions() {}
    function resetChatNavigation() {} function addMessage() { return currentAssistantEl; } function applyClarifyTimeoutExtension() {}
    function clearClarifyCountdown() {} function placeAnsweredClarifyCardInTimeline() {} function startClarifyCountdown() {}
    function maybeShowPermissionEducationHint() {} function workflowHealingTargetLabel(value) { return String(value || ''); }
    function sameTabId(a, b) { return Number(a) === Number(b); } function restoreActiveRunState() {}
    function bindPermissionSkipButton() {} function uploadApprovalCard() { return null; }
    function keepClarifyAliveWhileTyping() {}
    const CAPABILITY_LABEL = {};
    async function sendToBackground(action, payload) { sent.push([action, payload]); return { matched: true }; }
    ${extract(source, 'renderClarifyCard')}
    ${extract(source, 'submitClarify')}
    ${extract(source, 'clarifyShortcutOption')}
    ${extract(source, 'handleClarifyShortcutKeydown')}
    document.addEventListener('keydown', handleClarifyShortcutKeydown, true);
    window.panel = { render: renderClarifyCard, sent, composer: inputEl };
  })();` });
  return { browser, page };
}

// What the user sees on each answer: its number, its unchanged label, and the
// square the stylesheet draws from the attribute. Chromium resolves attr() in
// the computed content, Firefox keeps the function — so the digit is also
// measured: a wider value widens the square only if the attribute is drawn.
const view = () => ({
  answers: [...document.querySelectorAll('.clarify-option')]
    .map(button => [button.dataset.shortcut, button.textContent, button.getAttribute('aria-keyshortcuts')]),
  badges: [...document.querySelectorAll('.clarify-option')].map(button => {
    const after = getComputedStyle(button, '::after');
    return [after.content, Math.round(parseFloat(after.width)), Math.round(parseFloat(after.height))];
  }),
  widened: (() => {
    const button = document.querySelector('.clarify-option');
    const width = () => parseFloat(getComputedStyle(button, '::after').width);
    const square = width();
    button.dataset.shortcut = '88888';
    const wide = width();
    button.dataset.shortcut = '1';
    return wide > square + 10 && Math.round(width()) === Math.round(square);
  })(),
  skipNumbered: !!document.querySelector('.clarify-skip-permissions')?.dataset?.shortcut,
});

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: a permission card numbers its answers and a digit answers it`, async () => {
    const { browser, page } = await panel(build, engine);
    try {
      await page.evaluate(data => window.panel.render(data), {
        clarifyId: 'perm_1', tabId: 9, question: 'q',
        permission: { capability: 'downloads', host: 'example.com' },
      });
      const shown = await page.evaluate(view);
      assert.deepEqual(shown.answers.map(answer => answer[0]), ['1', '2', '3'], 'numbered in the order shown');
      assert.deepEqual(shown.answers.map(answer => answer[2]), ['1', '2', '3'], 'aria-keyshortcuts names the digit');
      assert.deepEqual(shown.answers.map(answer => answer[1]),
        ['Allow once', 'Always allow on example.com', 'Don\'t allow'], 'the number is not in the label');
      // The slash and empty string are the alt text: the digit is drawn but
      // stays out of the button's accessible name.
      for (const [content, width, height] of shown.badges) {
        assert.match(content, /^(attr\(data-shortcut\)|"[1-9]") \/ ""$/, 'the square takes the digit from the attribute');
        assert.deepEqual([width, height], [16, 16], 'a 16px square per answer');
      }
      assert.equal(shown.widened, true, 'the attribute is what the square draws');
      assert.equal(shown.skipNumbered, false, 'the skip-all-prompts button is not an answer and gets no number');

      await page.keyboard.press('2');
      assert.deepEqual(await page.evaluate(() => window.panel.sent),
        [['clarify_response', { tabId: 9, clarifyId: 'perm_1', answer: 'always', source: 'option', memorySource: 'permission' }]],
        'pressing 2 sent the second answer');
    } finally { await browser.close(); }
  });

  test(`${build}: a question's options answer to digits, a typed answer does not`, async () => {
    const { browser, page } = await panel(build, engine);
    try {
      await page.evaluate(data => window.panel.render(data), {
        clarifyId: 'ask_1', tabId: 9, question: 'Which one?', options: ['Blue', 'Red', 'Green'],
      });
      assert.deepEqual((await page.evaluate(view)).answers,
        [['1', 'Blue', '1'], ['2', 'Red', '2'], ['3', 'Green', '3']]);

      // The card's own field has the caret. A digit after other text is text.
      assert.equal(await page.evaluate(() => document.activeElement.className), 'clarify-input');
      await page.keyboard.type('abc');
      await page.keyboard.press('3');
      assert.deepEqual(await page.evaluate(() => window.panel.sent), [], 'the field was not empty');
      assert.equal(await page.evaluate(() => document.querySelector('.clarify-input').value), 'abc3');

      await page.evaluate(() => { document.querySelector('.clarify-input').value = ''; });
      await page.keyboard.press('3');
      assert.deepEqual(await page.evaluate(() => window.panel.sent),
        [['clarify_response', { tabId: 9, clarifyId: 'ask_1', answer: 'Green', source: 'option',
          memorySource: 'clarification_response', question: 'Which one?' }]],
        'an empty field gives the digit up to the third option');
      assert.equal(await page.evaluate(() => document.querySelector('.clarify-input').value), '',
        'the digit was not typed as well');
      assert.equal(await page.evaluate(() => document.querySelector('.clarify-your-answer').textContent),
        'Your answer: Green');
    } finally { await browser.close(); }
  });

  test(`${build}: a draft in the composer and an answered card keep their digits`, async () => {
    const { browser, page } = await panel(build, engine);
    try {
      await page.evaluate(data => window.panel.render(data), {
        clarifyId: 'ask_2', tabId: 9, question: 'Which one?', options: ['Blue', 'Red'],
      });
      await page.evaluate(() => { window.panel.composer.value = '2 pages please'; window.panel.composer.focus(); });
      await page.keyboard.press('1');
      assert.deepEqual(await page.evaluate(() => window.panel.sent), [], 'a draft in the composer keeps the digit');

      await page.evaluate(() => { window.panel.composer.value = ''; });
      await page.keyboard.press('1');
      assert.deepEqual(await page.evaluate(() => window.panel.sent),
        [['clarify_response', { tabId: 9, clarifyId: 'ask_2', answer: 'Blue', source: 'option',
          memorySource: 'clarification_response', question: 'Which one?' }]],
        'an empty composer answers the card without the mouse');
      await page.keyboard.press('2');
      assert.equal(await page.evaluate(() => window.panel.sent.length), 1, 'an answered card takes no more digits');
    } finally { await browser.close(); }
  });
}

test('both builds number and bind the answers the same way', async () => {
  const [chrome, fox] = ['chrome', 'firefox'].map(build => read(build, 'src/ui/sidepanel.js'));
  for (const name of ['clarifyShortcutOption', 'handleClarifyShortcutKeydown']) {
    assert.equal(extract(chrome, name), extract(fox, name), `${name} is identical in both builds`);
  }
  for (const build of [chrome, fox]) {
    // Every answer list is numbered: a branch that forgets it shows no numbers
    // and answers to no digit.
    assert.equal((build.match(/^ {4}card\.appendChild\(optionsEl\);$/gm) || []).length,
      (build.match(/^ {4}numberClarifyOptions\(optionsEl\);$/gm) || []).length,
      'each clarify-options list is numbered before it is added to the card');
  }
  for (const build of ['chrome', 'firefox']) {
    const css = read(build, 'styles/sidepanel.css');
    assert.match(css, /\.clarify-option\[data-shortcut\]::after \{\n {2}content: attr\(data-shortcut\) \/ "";/,
      'the square is drawn from the attribute, with empty alt text');
  }
});
