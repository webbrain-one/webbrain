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
  for (let i = 0; i < 150; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 100)); }
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
  finally { server.close(); app.quit(); }
})();
});
