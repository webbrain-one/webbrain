'use strict';

// Run under Electron with an isolated profile and a fixture server supplied by the runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { ctx } = require('../app/main');

(async () => {
  try {
    for (let i = 0; i < 200 && !ctx.windows.length; i++) await new Promise(r => setTimeout(r, 100));
    assert(ctx.windows.length, 'browser should start');
    const temporary = process.env.MURSHID_TEST_TEMPORARY === '1';
    assert.equal(ctx.ses.isPersistent(), !temporary);
    // WebBrain can create a window while its own startup is still in progress.
    await new Promise(r => setTimeout(r, 3000));
    const tab = ctx.windows[0].addTab({ url: process.env.MURSHID_TEST_URL });
    while (tab.wc.isLoading()) await new Promise(r => setTimeout(r, 100));
    await tab.wc.loadURL(process.env.MURSHID_TEST_URL);
    const before = await tab.wc.executeJavaScript("({ cookie: document.cookie, storage: localStorage.getItem('fixture') })");
    assert.equal(before.cookie.includes('fixture=value'), !temporary && process.env.MURSHID_TEST_SECOND === '1');
    assert.equal(before.storage, !temporary && process.env.MURSHID_TEST_SECOND === '1' ? 'value' : null);
    await tab.wc.executeJavaScript("document.cookie = 'fixture=value; max-age=3600; path=/'; localStorage.setItem('fixture', 'value')");
    await ctx.ses.cookies.flushStore();
    await tab.wc.loadURL('murshid://settings/');
    const checked = await tab.wc.executeJavaScript("new Promise(resolve => setTimeout(() => resolve(document.getElementById('persist-session').checked), 300))");
    assert.equal(checked, !temporary);
    if (temporary && process.env.MURSHID_TEST_SECOND === '1') {
      await tab.wc.executeJavaScript("document.getElementById('persist-session').click()");
      for (let i = 0; i < 50 && ctx.settings.get('persistBrowserSession') !== true; i++) await new Promise(r => setTimeout(r, 100));
      assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.MURSHID_PROFILE, 'murshid-settings.json'))).persistBrowserSession, true);
    }
    console.log(`Session smoke passed: ${temporary ? 'temporary' : 'persistent'} ${process.env.MURSHID_TEST_SECOND === '1' ? 'restart' : 'first launch'}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { app.exit(process.exitCode || 0); }
})();
