'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-session-test-'));
const server = http.createServer((_req, res) => res.end('<!doctype html><title>Session test</title>'));
server.listen(0, '127.0.0.1', async () => {
  try {
    for (const temporary of [false, true]) {
      fs.writeFileSync(path.join(profile, 'murshid-settings.json'), JSON.stringify({ startCompanion: false, persistBrowserSession: !temporary }));
      for (const second of [false, true]) {
        const env = { ...process.env, MURSHID_PROFILE: profile, MURSHID_TEST_URL: `http://127.0.0.1:${server.address().port}/`, MURSHID_TEST_TEMPORARY: temporary ? '1' : '0', MURSHID_TEST_SECOND: second ? '1' : '0' };
        delete env.MURSHID_COMPANION;
        await new Promise((resolve, reject) => {
          const child = spawn(require('electron'), [path.join(__dirname, 'session-smoke.cjs')], { env, stdio: 'inherit' });
          child.on('error', reject);
          child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Electron exited with ${code}`)));
        });
      }
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
