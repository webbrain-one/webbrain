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
  await w.ui.executeJavaScript('document.getElementById("quota").click(); true');
  await new Promise((r) => setTimeout(r, 1500));
  const alive = ctx.windows.some((x) => !x.win.isDestroyed());
  console.log('menu opened, window alive:', alive);
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(out.hidden === false && /%|—/.test(out.value) && alive ? 0 : 1);
});
