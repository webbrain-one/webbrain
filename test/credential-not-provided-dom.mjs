// The page side of credential-not-provided: content.js reports how many
// visible password fields share a field's form (`passwordFields`), so the
// agent tells a sign-in form's password from a sign-up form's new password
// and its confirmation. Both builds' real content scripts, in Chromium (the
// only installed engine), on owned fixture pages; no external page is
// contacted.
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
    <input id="hidden-pass" name="hidden_pass" type="password" style="display:none"><button>Sign in</button></form>
  <form id="signup"><label for="email">Email</label><input id="email" name="email">
    <label for="password">Password</label><input id="password" name="password" type="password">
    <label for="password2">Password (again)</label><input id="password2" name="password2" type="password"><button>Create account</button></form>
  <div id="loose"><label for="loose-pass">Password</label><input id="loose-pass" name="loose_pass" type="password"></div>`;

for (const build of ['chrome', 'firefox']) {
  const { isSignInPasswordField } = await import(`../src/${build}/src/agent/credential-fields.js`);

  test(`${build}: content.js counts the visible password fields of a field's form`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://owned-credential-fields.invalid/login');
      await page.setContent(PAGE);
      await page.evaluate(() => {
        window.fixtureHandlers = [];
        const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
        window.chrome = { runtime }; window.browser = { runtime };
      });
      for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
        await page.addScriptTag({ content: await readFile(path.join(ROOT, 'src', build, 'src/content', file), 'utf8') });
      }
      const meta = selector => page.evaluate(params => new Promise(resolve => {
        for (const handler of window.fixtureHandlers) handler({ target: 'content', action: 'field_value_digest', params }, {}, resolve);
      }), { selector }).then(result => result.fieldMeta);
      const signin = await meta('#pass');
      assert.equal(signin.passwordFields, 1, 'a hidden password input in the form is not counted');
      assert.equal(isSignInPasswordField(signin).guarded, true);
      const signup = await meta('#password');
      assert.equal(signup.passwordFields, 2);
      assert.equal(isSignInPasswordField(signup).guarded, false);
      assert.equal(isSignInPasswordField(await meta('#password2')).guarded, false);
      // Outside a form, the document's visible password fields are counted.
      assert.equal((await meta('#loose-pass')).passwordFields, 4);
      // Only password inputs carry the count.
      assert.equal('passwordFields' in await meta('#user'), false);
      // The focused field, as typing after a click reads it.
      await page.focus('#pass');
      const focused = await page.evaluate(() => new Promise(resolve => {
        for (const handler of window.fixtureHandlers) handler({ target: 'content', action: 'field_value_digest', params: { focused: true } }, {}, resolve);
      }));
      assert.equal(focused.fieldMeta.id, 'pass');
      assert.equal(focused.fieldMeta.passwordFields, 1);
    } finally {
      await browser.close();
    }
  });
}
