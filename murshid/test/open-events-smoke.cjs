'use strict';
// Run under Electron with MURSHID_PROFILE pointing to a disposable directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const file = path.join(process.env.MURSHID_PROFILE, 'test file.html');
fs.writeFileSync(file, '<!doctype html><title>isolated fixture</title>');
const server = http.createServer((_req, res) => res.end('<!doctype html><title>isolated fixture</title>'));
server.listen(0, '127.0.0.1', () => {
const base = `http://127.0.0.1:${server.address().port}`;
const { ctx } = require('../app/main');
const event = () => ({ preventDefault() { this.prevented = true; } });
const earlyUrl = event(); const earlyFile = event();
app.emit('open-url', earlyUrl, `${base}/early`);
app.emit('open-file', earlyFile, file);
assert(earlyUrl.prevented && earlyFile.prevented);
const waitFor = async (condition) => {
  for (let i = 0; i < 150; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out waiting for browser state');
};
(async () => {
  try {
    const urls = () => ctx.windows.flatMap(w => w.tabs.map(t => t.url));
    await waitFor(() => urls().includes(`${base}/early`) && urls().includes(pathToFileURL(file).href));
    const late = event(); app.emit('open-url', late, `${base}/late`);
    await waitFor(() => urls().includes(`${base}/late`));
    assert(late.prevented);
    console.log('Early and late macOS open events reached isolated tabs');
    const w = ctx.windows[0];
    await waitFor(() => w.uiReady);
    const readAddress = () => w.ui.executeJavaScript("document.getElementById('address').value");
    await waitFor(async () => (await readAddress()).includes('/late'));
    w.focusOmnibox();
    const newTab = w.addTab({});
    await waitFor(async () => await readAddress() === '');
    assert.equal(await w.ui.executeJavaScript("document.activeElement.id"), 'address');
    console.log('New tab focuses an empty address bar after a previous page');
    const guarded = w.addTab({ url: `${base}/guarded` });
    await waitFor(() => guarded.wc.getURL() === `${base}/guarded` && !guarded.wc.isLoading());
    await guarded.wc.executeJavaScript("window.onbeforeunload = e => { e.preventDefault(); e.returnValue = ''; }; document.body.click();", true);
    const { dialog } = require('electron');
    const originalDialog = dialog.showMessageBoxSync;
    let prompts = 0;
    try {
      dialog.showMessageBoxSync = () => { prompts++; return 1; };
      w.closeTab(guarded);
      await new Promise(r => setTimeout(r, 500));
      assert.equal(prompts, 1, 'beforeunload should prompt');
      assert(w.tabs.includes(guarded) && !guarded.wc.isDestroyed(), 'Stay should retain the tab');
      dialog.showMessageBoxSync = () => { prompts++; return 0; };
      w.closeTab(guarded);
      await waitFor(() => !w.tabs.includes(guarded));
      assert.equal(prompts, 2, 'retry should prompt again');
      assert(w.closedTabs.some(entry => entry.url === `${base}/guarded`));
      console.log('Beforeunload Stay retains the tab; Leave closes it');
      const other = ctx.createWindow({ url: `${base}/window-guarded` });
      const windowTab = other.activeTab;
      await waitFor(() => windowTab.wc.getURL() === `${base}/window-guarded` && !windowTab.wc.isLoading());
      await windowTab.wc.executeJavaScript("window.onbeforeunload = e => { e.preventDefault(); e.returnValue = ''; }; document.body.click();", true);
      dialog.showMessageBoxSync = () => 1;
      other.win.close();
      await new Promise(r => setTimeout(r, 500));
      assert(!other.win.isDestroyed() && other.tabs.includes(windowTab), 'Stay should retain the window and tab');
      dialog.showMessageBoxSync = () => 0;
      other.win.close();
      await waitFor(() => other.win.isDestroyed());
      console.log('Window close honors beforeunload');
    } finally { dialog.showMessageBoxSync = originalDialog; }
    // Exercise the last-window decision with an offscreen window still alive.
    const { BrowserWindow } = require('electron');
    const offscreen = new BrowserWindow({ show: false });
    const realWindows = ctx.windows, realFocus = ctx.focusOrder, realQuit = app.quit;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    let quitCalls = 0;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      app.quit = () => { quitCalls++; };
      const first = {}, last = {};
      ctx.windows = [first, last]; ctx.focusOrder = [first, last];
      ctx.onWindowClosed(first); assert.equal(quitCalls, 0);
      ctx.onWindowClosed(last); assert.equal(quitCalls, 1);
      assert.equal(offscreen.isDestroyed(), false);
      console.log('Last Linux browser window requests quit despite an offscreen window');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      app.quit = realQuit; ctx.windows = realWindows; ctx.focusOrder = realFocus;
      offscreen.destroy();
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); app.exit(process.exitCode || 0); }
})();
});
