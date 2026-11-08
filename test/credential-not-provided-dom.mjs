// The page side of credential-not-provided: content.js, and the Chrome CDP
// selector probe that type_text({selector}) resolves its target through,
// report how many visible password fields share a field's form
// (`passwordFields`), how many of its fields name an account
// (`usernameFields`) and what the form's submit control says
// (`formSubmitText`), so the agent tells a sign-in form's password from a
// sign-up form's new password and its confirmation, and from a lone password
// field that is no account's (a Wi-Fi key). Both builds' real content
// scripts, and the Chrome build's CDP client over a real CDP session, in
// Chromium (the only installed engine), on owned fixture pages; no external
// page is contacted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const PAGE = `<!doctype html>
  <form id="signin"><label for="user">Username</label><input id="user" name="user" autocomplete="username">
    <label for="pass">Password</label><input id="pass" name="pass" type="password">
    <input id="hidden-pass" name="hidden_pass" type="password" style="display:none">
    <button type="button" id="show">Show</button><button>Sign in</button></form>
  <form id="signup"><label for="email">Email</label><input id="email" name="email">
    <label for="password">Password</label><input id="password" name="password" type="password">
    <label for="password2">Password (again)</label><input id="password2" name="password2" type="password"><button>Create account</button></form>
  <form id="signup-confirm"><label for="sc-password">Password</label><input id="sc-password" name="sc_password" type="password">
    <label for="sc-confirm">Confirm password</label><input id="sc-confirm" name="sc_confirm" type="password"><input type="submit" value="Continue"></form>
  <form id="signup-single"><label for="ss-email">Email</label><input id="ss-email" name="ss_email">
    <label for="ss-password">Password</label><input id="ss-password" name="ss_password" type="password">
    <button type="submit">  Create
      account </button></form>
  <div id="loose"><label for="loose-pass">Password</label><input id="loose-pass" name="loose_pass" type="password"></div>`;

// Lone password fields, with and without what makes them a sign-in's: a
// username, email or login field of the same form (`usernameFields`), a
// submit control that signs in or goes on to the next step, or a label that
// says so. A hidden input, and a field of another form, name no account.
const EVIDENCE_PAGE = `<!doctype html>
  <form id="login-submit"><label for="ls-user">Username</label><input id="ls-user" name="username">
    <label for="ls-pass">Password</label><input id="ls-pass" name="password" type="password"><button>Submit</button></form>
  <form id="email-submit"><input id="es-email" type="email" placeholder="you@example.test">
    <input id="es-pass" name="password" type="password" aria-label="Password"><input type="submit" value="Submit"></form>
  <form id="lone"><label for="lone-pass">Password</label><input id="lone-pass" name="password" type="password">
    <button type="submit">Submit</button></form>
  <form id="wifi"><label for="wifi-ssid">Network name</label><input id="wifi-ssid" name="ssid">
    <label for="wifi-key">Wi-Fi password</label><input id="wifi-key" name="wifi_key" type="password"><button>Apply</button></form>
  <form id="step"><input type="hidden" name="username" value="test-account-a"><input type="hidden" name="flow" value="password">
    <label>Enter password <input id="step-pass" name="password" type="password"></label><button>Next</button></form>
  <form id="hidden-user"><input type="hidden" name="username" value="test-account-a">
    <label for="hu-pass">Password</label><input id="hu-pass" name="password" type="password"><button>Submit</button></form>
  <form id="account-label"><label for="al-pass">Account password</label><input id="al-pass" name="pw" type="password">
    <button>Save</button></form>
  <form id="newsletter"><input name="email" type="email"><button>Subscribe</button></form>`;
// Outside a form, only form-less fields of the root name the account: the
// newsletter form's email field is not the Wi-Fi key's, the login panel's
// own field is its password's.
const LOOSE_PAGE = `<!doctype html>
  <form id="newsletter"><input name="email" type="email" autocomplete="email"><button>Subscribe</button></form>
  <div id="router"><label for="router-key">Wi-Fi password</label><input id="router-key" name="key" type="password">
    <button type="button">Save</button></div>`;
const LOGIN_PANEL_PAGE = `<!doctype html>
  <form id="newsletter"><input name="email" type="email" autocomplete="email"><button>Subscribe</button></form>
  <div id="loose-login"><label for="ll-user">Email</label><input id="ll-user" name="login">
    <label for="ll-pass">Password</label><input id="ll-pass" name="password" type="password"><button type="button">Log in</button></div>`;
// What each password field of those pages reports, and whether it is a
// sign-in's.
const EVIDENCE = [
  ['#ls-pass', { passwordFields: 1, usernameFields: 1, formSubmitText: 'Submit' }, true],
  ['#es-pass', { passwordFields: 1, usernameFields: 1, formSubmitText: 'Submit' }, true],
  ['#lone-pass', { passwordFields: 1, usernameFields: 0, formSubmitText: 'Submit' }, false],
  ['#wifi-key', { passwordFields: 1, usernameFields: 0, formSubmitText: 'Apply' }, false],
  ['#step-pass', { passwordFields: 1, usernameFields: 0, formSubmitText: 'Next' }, true],
  ['#hu-pass', { passwordFields: 1, usernameFields: 0, formSubmitText: 'Submit' }, false],
  ['#al-pass', { passwordFields: 1, usernameFields: 0, formSubmitText: 'Save' }, true],
];
const PAGES = [
  [EVIDENCE_PAGE, EVIDENCE],
  [LOOSE_PAGE, [['#router-key', { passwordFields: 1, usernameFields: 0 }, false]]],
  [LOGIN_PANEL_PAGE, [['#ll-pass', { passwordFields: 1, usernameFields: 1 }, true]]],
];
const facts = meta => Object.fromEntries(['passwordFields', 'usernameFields', 'formSubmitText']
  .filter(key => key in meta).map(key => [key, meta[key]]));

const fixturePage = async (browser, html = PAGE) => {
  const page = await (await browser.newContext()).newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('https://owned-credential-fields.invalid/login');
  await page.setContent(html);
  return page;
};

// The content script of a build on a fixture page, and a field_value_digest
// call to it.
const withContentScript = async (page, build) => {
  await page.evaluate(() => {
    window.fixtureHandlers = [];
    const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
    window.chrome = { runtime }; window.browser = { runtime };
  });
  for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
    await page.addScriptTag({ content: await readFile(path.join(ROOT, 'src', build, 'src/content', file), 'utf8') });
  }
  return selector => page.evaluate(params => new Promise(resolve => {
    for (const handler of window.fixtureHandlers) handler({ target: 'content', action: 'field_value_digest', params }, {}, resolve);
  }), { selector }).then(result => result.fieldMeta);
};

for (const build of ['chrome', 'firefox']) {
  const { isSignInPasswordField } = await import(`../src/${build}/src/agent/credential-fields.js`);

  test(`${build}: content.js reports the password fields and submit text of a field's form`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await fixturePage(browser);
      const meta = await withContentScript(page, build);
      const signin = await meta('#pass');
      assert.equal(signin.passwordFields, 1, 'a hidden password input in the form is not counted');
      assert.equal(signin.formSubmitText, 'Sign in', 'a type=button control is not the submit control');
      assert.equal(signin.usernameFields, 1);
      assert.equal(isSignInPasswordField(signin).guarded, true);
      const signup = await meta('#password');
      assert.equal(signup.passwordFields, 2);
      assert.equal(isSignInPasswordField(signup).guarded, false);
      assert.equal(isSignInPasswordField(await meta('#password2')).guarded, false);
      assert.equal((await meta('#sc-password')).formSubmitText, 'Continue', 'an input type=submit reports its value');
      // One password field, but the form's submit control creates an account.
      const single = await meta('#ss-password');
      assert.equal(single.passwordFields, 1);
      assert.equal(single.formSubmitText, 'Create account');
      assert.equal(isSignInPasswordField(single).guarded, false);
      // Outside a form, the document's visible password fields are counted
      // and there is no submit control.
      const loose = await meta('#loose-pass');
      assert.equal(loose.passwordFields, 7);
      assert.equal('formSubmitText' in loose, false);
      // Only password inputs carry the facts.
      const user = await meta('#user');
      assert.equal('passwordFields' in user, false);
      assert.equal('formSubmitText' in user, false);
      assert.equal('usernameFields' in user, false);
      // The focused field, as typing after a click reads it.
      await page.focus('#pass');
      const focused = await page.evaluate(() => new Promise(resolve => {
        for (const handler of window.fixtureHandlers) handler({ target: 'content', action: 'field_value_digest', params: { focused: true } }, {}, resolve);
      }));
      assert.equal(focused.fieldMeta.id, 'pass');
      assert.equal(focused.fieldMeta.passwordFields, 1);
      assert.equal(focused.fieldMeta.formSubmitText, 'Sign in');
    } finally {
      await browser.close();
    }
  });

  // #593 follow-up: a lone password field is a sign-in's only when the page
  // shows one, so "fill this form with random info" and a generated Wi-Fi
  // key are typed, and a real sign-in (a username field with a "Submit"
  // button, a password step with "Next") stays guarded.
  test(`${build}: content.js reports what makes a lone password field a sign-in's`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [html, expected] of PAGES) {
        const page = await fixturePage(browser, html);
        const meta = await withContentScript(page, build);
        for (const [selector, reported, guarded] of expected) {
          const field = await meta(selector);
          assert.deepEqual(facts(field), reported, selector);
          assert.equal(isSignInPasswordField(field).guarded, guarded, selector);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
}

// In Chrome, type_text({selector}) gets its typing target from the CDP
// selector probe (rich-text-toolbar-probe.js -> cdp-client.js
// probeRichTextToolbarSelector), not from content.js, and the agent's
// credential check reads the field metadata that probe returns
// (typingTargetFieldMeta). It must report the same facts.
test('chrome: the CDP selector probe reports the same password-field facts as content.js', async () => {
  const { CDPClient } = await import('../src/chrome/src/cdp/cdp-client.js');
  const { isSignInPasswordField } = await import('../src/chrome/src/agent/credential-fields.js');
  CDPClient._heuristicSourceOverride = await readFile(path.join(ROOT, 'src/chrome/src/content/rich-text-toolbar-heuristic.js'), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await fixturePage(browser);
    const session = await page.context().newCDPSession(page);
    const client = new CDPClient();
    client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);
    client.resolveSelector = async () => ({ found: true, nodeId: null, inViewport: true });
    const probe = async selector => {
      const result = await client.probeRichTextToolbarSelector(42, selector);
      assert.equal(result?.resolved, true, `${selector} resolved`);
      return result.fieldMeta;
    };
    const signin = await probe('#pass');
    assert.equal(signin.passwordFields, 1);
    assert.equal(signin.formSubmitText, 'Sign in');
    assert.equal(isSignInPasswordField(signin).guarded, true);
    // A sign-up's password and its confirmation, neither with autocomplete.
    for (const selector of ['#password', '#sc-password', '#sc-confirm']) {
      const meta = await probe(selector);
      assert.equal(meta.passwordFields, 2, selector);
      assert.equal(isSignInPasswordField(meta).guarded, false, selector);
    }
    const single = await probe('#ss-password');
    assert.equal(single.formSubmitText, 'Create account');
    assert.equal(isSignInPasswordField(single).guarded, false);
    assert.equal((await probe('#loose-pass')).passwordFields, 7);
    assert.equal('passwordFields' in await probe('#user'), false);
    assert.equal('usernameFields' in await probe('#user'), false);
  } finally {
    await browser.close();
  }
});

// The sign-in evidence of a lone password field, through the CDP selector
// probe and through the Chrome content script on the same page: the same
// facts, and the same answer.
test('chrome: the CDP selector probe reports the same sign-in evidence as content.js', async () => {
  const { CDPClient } = await import('../src/chrome/src/cdp/cdp-client.js');
  const { isSignInPasswordField } = await import('../src/chrome/src/agent/credential-fields.js');
  CDPClient._heuristicSourceOverride = await readFile(path.join(ROOT, 'src/chrome/src/content/rich-text-toolbar-heuristic.js'), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [html, expected] of PAGES) {
      const probePage = await fixturePage(browser, html);
      const session = await probePage.context().newCDPSession(probePage);
      const client = new CDPClient();
      client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);
      client.resolveSelector = async () => ({ found: true, nodeId: null, inViewport: true });
      const contentMeta = await withContentScript(await fixturePage(browser, html), 'chrome');
      for (const [selector, reported, guarded] of expected) {
        const probed = await client.probeRichTextToolbarSelector(42, selector);
        assert.equal(probed?.resolved, true, `${selector} resolved`);
        assert.deepEqual(facts(probed.fieldMeta), reported, selector);
        assert.deepEqual(facts(probed.fieldMeta), facts(await contentMeta(selector)), selector);
        assert.equal(isSignInPasswordField(probed.fieldMeta).guarded, guarded, selector);
      }
    }
  } finally {
    await browser.close();
  }
});
