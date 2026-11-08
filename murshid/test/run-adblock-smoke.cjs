'use strict';

// Runs the ad blocking check (adblock-smoke.cjs) in Electron with a fresh
// profile. MURSHID_TEST_ADBLOCK_REFRESH=1 also downloads the lists for real.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  server.close(() => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-adblock-test-'));
    try {
      fs.writeFileSync(path.join(profile, 'murshid-settings.json'), JSON.stringify({ startCompanion: false }));
      const env = { ...process.env, MURSHID_PROFILE: profile, MURSHID_TEST_CDP_PORT: String(port) };
      delete env.MURSHID_COMPANION;
      const result = spawnSync(require('electron'), [`--remote-debugging-port=${port}`, path.join(__dirname, 'adblock-smoke.cjs')], {
        env, stdio: 'inherit', timeout: 120000,
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
});
server.on('error', (error) => { console.error(error); process.exitCode = 1; });
