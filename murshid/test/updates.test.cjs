'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updates, FEED_URL, compareVersions, selectRelease } = require('../app/updates');

function feed(version = '0.1.4') {
  const asset = suffix => ({ url: `https://murshid.one/download/Murshid-${version}-${suffix}`, size: 123, sha256: 'a'.repeat(64) });
  const update = asset('macos-universal.zip');
  return { schema: 'murshid-updates/1', currentRelease: version,
    platforms: { 'darwin-universal': { version, installer: asset('macos-universal.dmg'), update },
      'win32-x64': { version, installer: asset('windows-x64-setup.exe') },
      'linux-x64': { version, installer: asset('linux-x86_64.AppImage') } },
    releases: [{ version, updateTo: { version, name: version, ...update } }] };
}
function fixture({ document = feed(), version = '0.1.3', platform = 'darwin', arch = 'arm64', fetchImpl, packaged = true } = {}) {
  const native = new EventEmitter();
  const calls = [];
  native.setFeedURL = options => calls.push(['feed', options]);
  native.checkForUpdates = () => calls.push(['download']);
  native.quitAndInstall = () => calls.push(['install']);
  const updater = new Updates({ version, platform, arch, packaged, nativeUpdater: native,
    openExternal: async url => calls.push(['open', url]), fetchImpl: fetchImpl || (async (url, options) => {
      calls.push(['check', url, options.redirect]); return new Response(JSON.stringify(document));
    }) });
  return { updater, native, calls };
}

test('versions compare numerically, reject invalid versions, and never offer a downgrade', async () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.3', '0.1.3'), 0);
  for (const version of ['v0.1.3', '0.1', '0.01.3', '1.0.0-beta', '999999999999999999999.0.0']) {
    assert.throws(() => compareVersions(version, '0.1.3'));
  }
  for (const version of ['0.1.3', '0.1.5']) {
    const { updater } = fixture({ version, document: feed('0.1.3') });
    assert.equal((await updater.check()).status, 'current');
  }
});

test('each platform selects its own published version and architecture', () => {
  const document = feed();
  document.platforms['win32-x64'] = feed('0.1.1').platforms['win32-x64'];
  assert.equal(selectRelease(document, 'darwin', 'x64').version, '0.1.4');
  assert.equal(selectRelease(document, 'darwin', 'arm64').version, '0.1.4');
  assert.equal(selectRelease(document, 'win32', 'x64').version, '0.1.1');
  assert.equal(selectRelease(document, 'linux', 'x64').version, '0.1.4');
  assert.equal(selectRelease(document, 'linux', 'arm64'), null);
});

test('invalid metadata cannot authorize a native download or installer URL', async () => {
  const changes = [
    f => { f.schema = 'other'; },
    f => { f.platforms['darwin-universal'].installer.url = 'https://evil.example/install.dmg'; },
    f => { f.platforms['darwin-universal'].installer.url = 'http://murshid.one/download/Murshid-0.1.4-macos-universal.dmg'; },
    f => { f.platforms['darwin-universal'].update.sha256 = ''; },
    f => { f.platforms['darwin-universal'].update.size = -1; },
    f => { f.currentRelease = '0.1.5'; },
    f => { f.releases[0].updateTo.sha256 = 'b'.repeat(64); },
    f => { f.releases[0].updateTo.name = 'unexpected'; },
    f => { f.platforms['darwin-universal'].version = '0.1.5'; },
    f => { f.platforms['darwin-universal'].installer.url += '?redirect=evil'; },
  ];
  for (const change of changes) {
    const document = feed(); change(document);
    const { updater, calls } = fixture({ document });
    assert.equal((await updater.check()).status, 'error');
    await updater.download(); updater.install();
    assert.equal(calls.some(c => ['download', 'install', 'open'].includes(c[0])), false);
  }
});

test('checking coalesces concurrent callers and does not start a download', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const { updater, calls } = fixture({ fetchImpl: async (url, options) => {
    requests++; assert.equal(url, FEED_URL); assert.equal(options.redirect, 'error');
    await wait; return new Response(JSON.stringify(feed()));
  } });
  const first = updater.check(), second = updater.check();
  assert.equal(first, second); release();
  assert.equal((await first).status, 'available');
  assert.equal(requests, 1); assert.deepEqual(calls, []);
});

test('automatic checks run after startup and daily, and stop when disabled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { updater, calls } = fixture();
  updater.start();
  t.mock.timers.tick(9999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1); await updater.check();
  assert.equal(calls.filter(c => c[0] === 'check').length, 1);
  t.mock.timers.tick(24 * 60 * 60 * 1000); await updater.check();
  assert.equal(calls.filter(c => c[0] === 'check').length, 2);
  updater.stop(); t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(calls.filter(c => c[0] === 'check').length, 2);
});

test('the native download is explicit and deduplicated; only a matching completed update can install', async () => {
  const { updater, native, calls } = fixture();
  updater.install(); assert.equal(calls.length, 0);
  await updater.check(); await updater.download(); await updater.download();
  assert.equal(updater.snapshot().status, 'downloading');
  assert.equal(calls.filter(c => c[0] === 'download').length, 1);
  assert.deepEqual(calls.find(c => c[0] === 'feed')[1], { url: FEED_URL, serverType: 'json' });
  updater.install(); assert.equal(calls.some(c => c[0] === 'install'), false);
  native.emit('update-downloaded', {}, '', '0.1.4');
  assert.equal(updater.snapshot().status, 'ready');
  await updater.check(); assert.equal(updater.snapshot().status, 'ready');
  updater.install(); updater.install();
  assert.equal(calls.filter(c => c[0] === 'install').length, 1);
});

test('native errors, unexpected downloaded versions and stale download events never enable installation', async () => {
  const { updater, native, calls } = fixture();
  await updater.check(); await updater.download();
  native.emit('update-downloaded', {}, '', '0.9.0');
  assert.equal(updater.snapshot().status, 'error');
  native.emit('update-downloaded', {}, '', '0.1.4'); updater.install();
  assert.equal(calls.some(c => c[0] === 'install'), false);
  await updater.check(); await updater.download(); native.emit('error', new Error('private provider details'));
  assert.equal(updater.snapshot().status, 'error');
  assert.equal(JSON.stringify(updater.snapshot()).includes('private provider'), false);
});

test('HTTP failures, oversized feeds, malformed JSON and redirected responses fail closed', async () => {
  for (const response of [new Response('error', { status: 503 }), new Response('x'.repeat(130 * 1024)), new Response('{broken'),
    { ok: true, url: 'https://evil.example/feed', body: [] }]) {
    const { updater } = fixture({ fetchImpl: async () => response });
    assert.equal((await updater.check()).status, 'error');
  }
});

test('Windows, Linux and unpackaged Mac open only their validated installer on an explicit click', async () => {
  for (const options of [{ platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'x64' }, { packaged: false }]) {
    const { updater, calls } = fixture(options);
    await updater.check(); assert.equal(calls.some(c => c[0] === 'open'), false);
    await updater.download();
    assert.equal(updater.snapshot().status, 'opened');
    assert.ok(calls.find(c => c[0] === 'open')[1].startsWith('https://murshid.one/download/Murshid-0.1.4-'));
    updater.install(); assert.equal(calls.some(c => c[0] === 'install'), false);
  }
});

test('the release builder verifies checksums and publishes each platform’s own latest version', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createHash } = require('node:crypto');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-feed-test-'));
  try {
    const version = require('../package.json').version;
    const names = [`Murshid-${version}-macos-universal.dmg`, `Murshid-${version}-macos-universal.zip`,
      'Murshid-0.1.1-windows-x64-setup.exe', 'Murshid-0.1.1-linux-x86_64.AppImage'];
    const lines = names.map(name => {
      const bytes = Buffer.from('owned release fixture ' + name);
      fs.writeFileSync(path.join(dir, name), bytes);
      return createHash('sha256').update(bytes).digest('hex') + '  ' + name;
    });
    fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
    const output = path.join(dir, 'stable.json');
    const command = [path.resolve(__dirname, '../scripts/build-update-feed.mjs'), dir, output];
    const result = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(fs.readFileSync(output));
    assert.equal(selectRelease(document, 'darwin', 'arm64').version, version);
    assert.equal(selectRelease(document, 'win32', 'x64').version, '0.1.1');
    assert.equal(selectRelease(document, 'linux', 'x64').version, '0.1.1');
    fs.writeFileSync(path.join(dir, names[1]), 'corrupted');
    assert.notEqual(spawnSync(process.execPath, command).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
