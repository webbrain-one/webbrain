'use strict';
// Temporary GUI smoke: the toolbar's quota pill renders with the companion up.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-quota-'));
fs.writeFileSync(path.join(profile, 'murshid-settings.json'), JSON.stringify({ startCompanion: false }));
app.setPath('userData', profile);
const { ctx } = require('../app/main');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const w = ctx.windows[0];
  if (!w) { console.error('no window'); app.exit(1); return; }
  for (let i = 0; i < 100; i += 1) {
    const st = ctx.companion.uiState();
    if (st.running && st.quota) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const out = await w.ui.executeJavaScript(`(() => {
    const q = document.getElementById('quota');
    return { hidden: q.hidden, value: document.getElementById('quota-value').textContent, title: q.title };
  })()`);
  console.log('quota pill:', JSON.stringify(out));
  console.log('companion state:', JSON.stringify(ctx.companion.uiState().quota && { tightest: ctx.companion.uiState().quota.tightest }));
  // The extension reports its Compass id through the bridge; give it a
  // moment. If the side panel never opened in this throwaway profile the id
  // may not exist yet, so fall back to seeding one to prove the fetch path.
  for (let i = 0; i < 30 && !ctx.companion.deviceGuid; i += 1) await new Promise((r) => setTimeout(r, 500));
  console.log('device guid from extension:', ctx.companion.deviceGuid ? 'reported' : 'absent (will seed)');
  if (!ctx.companion.deviceGuid) ctx.companion.setDeviceGuid('dfae9111-b752-50af-ab25-ef346262e2a5');
  for (let i = 0; i < 20 && !ctx.companion.compass; i += 1) await new Promise((r) => setTimeout(r, 500));
  const uist = ctx.companion.uiState();
  console.log('compass state:', JSON.stringify({ guid: ctx.companion.deviceGuid ? 'set' : 'unset', compass: ctx.companion.compass, urls: uist.compassUrls ? 'set' : 'unset', pillTightest: uist.quota?.tightest?.account }));
  await w.ui.executeJavaScript('document.getElementById("quota").click(); true');
  await new Promise((r) => setTimeout(r, 1500));
  const alive = ctx.windows.some((x) => !x.win.isDestroyed());
  console.log('menu opened, window alive:', alive);
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(out.hidden === false && /%|—/.test(out.value) && alive ? 0 : 1);
});
