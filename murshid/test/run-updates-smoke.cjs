'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-updates-test-'));
  fs.writeFileSync(path.join(profile, 'murshid-settings.json'), JSON.stringify({ startCompanion: false }));
  let application;
  try {
    application = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env: { ...process.env, MURSHID_PROFILE: profile } });
    await application.evaluate(async ({ app }) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const ctx = require(require('node:path').join(app.getAppPath(), 'app/main.js')).ctx;
      for (let i = 0; i < 200 && !ctx.windows.length; i++) await new Promise(r => setTimeout(r, 100));
      const native = new (require('node:events').EventEmitter)();
      ctx.testUpdateCalls = [];
      native.setFeedURL = args => ctx.testUpdateCalls.push(['feed', args]);
      native.checkForUpdates = () => ctx.testUpdateCalls.push(['download']);
      native.quitAndInstall = () => ctx.testUpdateCalls.push(['install']);
      ctx.testNativeUpdater = native;
      const version = '0.1.4';
      const asset = suffix => ({ url: `https://murshid.one/download/Murshid-${version}-${suffix}`, size: 123, sha256: 'a'.repeat(64) });
      const update = asset('macos-universal.zip');
      const feed = { schema: 'murshid-updates/1', currentRelease: version,
        platforms: { 'darwin-universal': { version, installer: asset('macos-universal.dmg'), update } },
        releases: [{ version, updateTo: { version, name: version, ...update } }] };
      ctx.updates.stop();
      const { Updates } = require(require('node:path').join(app.getAppPath(), 'app/updates.js'));
      ctx.updates = new Updates({ version: app.getVersion(), platform: 'darwin', arch: 'arm64', packaged: true,
        nativeUpdater: native, fetchImpl: async () => new Response(JSON.stringify(feed)) });
      ctx.updates.on('change', () => ctx.refreshAllWindows());
      ctx.updateTestTab = ctx.windows[0].addTab({ url: 'murshid://updates/' });
      await ctx.updateTestTab.wc.loadURL('murshid://updates/');
    });
    const evaluate = expression => application.evaluate(({ app }, expression) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const ctx = require(require('node:path').join(app.getAppPath(), 'app/main.js')).ctx;
      return ctx.updateTestTab.wc.executeJavaScript(expression);
    }, expression);
    const wait = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); }
      throw new Error('Timed out: ' + expression);
    };
    await wait("document.getElementById('download-update').hidden === false");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('install-update')).display"), 'none');
    assert.match(await evaluate("document.getElementById('update-status').textContent"), /0\.1\.4/);
    await evaluate("document.getElementById('download-update').click()");
    await wait("document.getElementById('check-update').disabled && document.getElementById('download-update').hidden");
    await application.evaluate(({ app }) => {
      const require = process.mainModule.require.bind(process.mainModule);
      require(require('node:path').join(app.getAppPath(), 'app/main.js')).ctx.testNativeUpdater.emit('update-downloaded', {}, '', '0.1.4');
    });
    await wait("document.getElementById('install-update').hidden === false");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('download-update')).display"), 'none');
    const screenshot = await application.evaluate(async ({ app }) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const ctx = require(require('node:path').join(app.getAppPath(), 'app/main.js')).ctx;
      return (await ctx.updateTestTab.wc.capturePage()).toPNG().toString('base64');
    });
    const artifacts = path.resolve(__dirname, '../dist/updates-check');
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, 'updates-ready.png'), Buffer.from(screenshot, 'base64'));
    await evaluate("document.getElementById('install-update').click()");
    const calls = await application.evaluate(({ app }) => {
      const require = process.mainModule.require.bind(process.mainModule);
      return require(require('node:path').join(app.getAppPath(), 'app/main.js')).ctx.testUpdateCalls;
    });
    assert.equal(calls.filter(c => c[0] === 'download').length, 1);
    assert.equal(calls.filter(c => c[0] === 'install').length, 1);
    const opened = await application.evaluate(async ({ app }) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const ctx = require(require('node:path').join(app.getAppPath(), 'app/main.js')).ctx;
      const w = ctx.windows[0], count = w.tabs.length;
      const result = await w.ui.executeJavaScript("window.murshidUI.invoke('updates')");
      return { result, added: w.tabs.length - count };
    });
    assert.deepEqual(opened, { result: null, added: 1 });
    console.log('Updates UI passed: available version, explicit native download, ready state, and explicit restart/install.');
  } finally {
    if (application) await application.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
