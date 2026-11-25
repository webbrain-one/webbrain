import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { context, editOpenCode, install, launch, status, uninstall, checkBridgeAvailable, NAME } from '../bin/webbrain-omarchy.mjs';

const sourceCLI = fileURLToPath(new URL('../bin/webbrain-omarchy.mjs', import.meta.url));
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'webbrain-omarchy-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, "home with spaces ' $()"), sourceRoot = path.join(temp, 'checkout');
  fs.mkdirSync(home);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: '@webbrain/mcp-server', version: '0.1.2' }),
    'package-lock.json': '{}', 'tsconfig.json': '{}', 'README.md': 'test', LICENSE: 'MIT', 'src/pairing.ts': 'paired',
  })) write(path.join(sourceRoot, 'mcp-server', name), content);
  write(path.join(sourceRoot, 'integrations/omarchy/manifest.json'), '{"id":"webbrain.browser"}');
  write(path.join(sourceRoot, 'integrations/omarchy/BarWidget.qml'), 'Item {}');
  write(path.join(sourceRoot, 'integrations/omarchy/WebBrainPanel.qml'), 'Item {}');
  const fake = path.join(temp, 'fake-executable.mjs');
  write(fake, `
import fs from 'node:fs';
import path from 'node:path';
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({command,args,cwd:process.cwd()})+'\\n');
const file = command === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME,'.claude.json') : path.join(process.env.CODEX_HOME || path.join(process.env.HOME,'.codex'),'servers.json');
function load() { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {}; }
function save(obj) { fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(obj)); }
if(command === 'omarchy-agent-account-home') { process.stdout.write(process.env.FAKE_ACCOUNT_HOME || ''); }
else if (args[0] === '--version') { console.log('test-agent 1.0'); }
else if (command === 'npm') {
 if (args[0] === 'run' && process.env.FAKE_FAIL === 'build') { console.error('PRIVATE_KEY_DO_NOT_LOG');process.exit(12); }
 if (args[0] === 'run') { fs.mkdirSync('dist');fs.writeFileSync('dist/index.js','// built from source'); }
} else if (args[0] === 'mcp' && args[1] === 'list') {
 const obj=load();console.log(JSON.stringify(Object.entries(obj).map(([name,entry])=>{const {enabled,...transport}=entry;return {name,transport,enabled}})));
} else if (args[0] === 'mcp' && args[1] === 'add') {
 const sep=args.indexOf('--'),name=args[2],obj=load();
 const entry={type:'stdio',command:args[sep+1],args:args.slice(sep+2),env:{}};
 for(let i=0;i<sep;i++) if(args[i]==='--env') {const value=args[++i],eq=value.indexOf('=');entry.env[value.slice(0,eq)]=value.slice(eq+1);}
 entry.env=Object.fromEntries(Object.entries(entry.env).sort(([a],[b])=>a.localeCompare(b)));
 if(command==='claude') { obj.mcpServers??={};obj.mcpServers[name]=entry; } else obj[name]=entry;
 save(obj);
 if(process.env.FAKE_FAIL==='registration') { console.error('PRIVATE_KEY_DO_NOT_LOG');process.exit(13); }
} else if (args[0] === 'mcp' && args[1] === 'remove') {
 const name=args.at(-1),obj=load(); if(command==='claude') delete obj.mcpServers?.[name]; else delete obj[name];save(obj);
}
`);
  const log = path.join(temp, 'calls.jsonl');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: '', XDG_CONFIG_HOME: path.join(home, '.config'), FAKE_LOG: log, FAKE_FAIL: '', FAKE_ACCOUNT_HOME: '' };
  delete env.OMARCHY_AGENT_CLAUDE_HOME;
  delete env.OMARCHY_AGENT_CODEX_HOME;
  const detached = [];
  const c = context({ home, sourceRoot, cliSource: sourceCLI, platform: 'linux', env, portCheck: async () => {},
    runner(command, args, options) {
      assert.equal(options.shell, false);
      return spawnSync(process.execPath, [fake, command, ...args], { ...options, encoding: 'utf8', stdio: 'pipe' });
    },
    async detacher(command, args, options) { detached.push({ command, args, options }); },
  });
  return { c, temp, home, sourceRoot, env, detached, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

test('JSONC edit preserves comments, unrelated values, escapes, and trailing commas', () => {
  const input = '{\n // keep all of this\n "model": "a\\\"b",\n "mcp": { /* local */ "other": {"command":["x", "}"]}, },\n "other": true,\n}\n';
  const added = editOpenCode(input, { type: 'local', command: ['node', 'with "quotes"'], enabled: true });
  assert.ok(added.includes('// keep all of this'));
  assert.ok(added.includes('/* local */ "other": {"command":["x", "}"]}'));
  assert.equal(editOpenCode(added, undefined).replace(/\s+/g, ''), input.replace(/\s+/g, ''));
  assert.throws(() => editOpenCode('{"mcp":false}', {}), /object/);
  assert.throws(() => editOpenCode('{"mcp":{},"mcp":{}}', {}), /Duplicate/);
});

for (const agent of ['claude', 'codex', 'opencode']) {
  test(`${agent}: install, update, and uninstall preserve other registrations and browser state`, t => {
    const f = fixture(t), { c, home } = f;
    const config = agent === 'claude' ? path.join(home, '.claude.json') : agent === 'codex' ? path.join(home, '.codex/servers.json') : path.join(home, '.config/opencode/opencode.jsonc');
    const other = { type: 'stdio', command: 'other', args: ['untouched'] };
    write(config, JSON.stringify(agent === 'claude' ? { preference: 'keep', mcpServers: { other } } : agent === 'opencode' ? { model: 'keep', mcp: { other } } : { other }));
    write(path.join(home, '.webbrain/bridge-key'), 'DO_NOT_PRINT_OR_DELETE');
    write(path.join(home, '.config/omarchy/plugins/other.plugin/user.txt'), 'keep');
    assert.equal(install(c, agent).installed, true);
    assert.deepEqual(status(c), {
      installed: true, agent, configured: true, mcpReady: true, bridgeConfigured: null,
      message: 'MCP files and agent registration are ready. Browser pairing and live connection are unknown; ask the selected agent to call webbrain_connection.',
    });
    assert.equal(install(c, agent).installed, true);
    assert.equal(f.calls().filter(call => call.command === 'npm' && call.args[0] === 'ci').length, 2);
    assert.ok(f.calls().filter(call => call.command === 'npm').every(call => call.cwd.startsWith(c.root + '.stage-')));
    const configured = readJson(config);
    assert.deepEqual(agent === 'claude' ? configured.mcpServers.other : agent === 'opencode' ? configured.mcp.other : configured.other, other);
    assert.equal(uninstall(c).installed, false);
    const final = readJson(config);
    assert.deepEqual(agent === 'claude' ? final.mcpServers.other : agent === 'opencode' ? final.mcp.other : final.other, other);
    assert.equal((agent === 'claude' ? final.mcpServers : agent === 'opencode' ? final.mcp : final)[NAME], undefined);
    assert.equal(fs.readFileSync(path.join(home, '.webbrain/bridge-key'), 'utf8'), 'DO_NOT_PRINT_OR_DELETE');
    assert.equal(fs.readFileSync(path.join(home, '.config/omarchy/plugins/other.plugin/user.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(c.root), false);
    assert.equal(fs.existsSync(c.wrapper), false);
  });
}

test('installed helper works after source checkout is removed', t => {
  const { c, sourceRoot, env } = fixture(t);
  install(c, 'opencode');
  fs.rmSync(sourceRoot, { recursive: true });
  const result = spawnSync(process.execPath, [c.wrapper, 'status', '--json'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mcpReady, true);
});

test('dry-run creates no installation or config and never invokes npm', t => {
  const { c, calls } = fixture(t);
  assert.equal(install(c, 'opencode', true).dryRun, true);
  assert.equal(fs.existsSync(c.root), false);
  assert.equal(fs.existsSync(c.plugin), false);
  assert.equal(fs.existsSync(path.join(c.home, '.config/opencode/opencode.json')), false);
  assert.equal(calls().length, 0);
});

test('task text is one literal argv value; default launches a detached terminal', async t => {
  const { c, detached, calls } = fixture(t);
  install(c, 'opencode');
  const task = "-x; $(touch /tmp/oops) `whoami` 'quoted' \"double\"\nnew line";
  await launch(c, task);
  assert.equal(detached.length, 1);
  assert.equal(detached[0].command, 'omarchy-launch-terminal');
  assert.deepEqual(detached[0].args.slice(0, 2), ['opencode', '--prompt']);
  assert.equal(JSON.parse(detached[0].args[2].split('\n').at(-1)), task);
  assert.ok(detached[0].args[2].includes('webbrain_connection'));
  await launch(c, task, true);
  const invocation = calls().at(-1);
  assert.equal(invocation.command, 'opencode');
  assert.equal(invocation.args.length, 2);
  await assert.rejects(launch(c, ''), /nonempty/);
  await assert.rejects(launch(c, 'a\0b'), /nonempty/);
});

test('failed source build leaves prior install and config byte-for-byte intact', t => {
  const { c, env } = fixture(t);
  install(c, 'opencode');
  const config = path.join(c.home, '.config/opencode/opencode.json');
  const before = fs.readFileSync(config, 'utf8'), stateBefore = fs.readFileSync(c.state, 'utf8');
  env.FAKE_FAIL = 'build';
  assert.throws(() => install(c, 'opencode'), error => !error.message.includes('PRIVATE_KEY') && /npm failed/.test(error.message));
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  assert.equal(fs.readFileSync(c.state, 'utf8'), stateBefore);
  assert.equal(fs.readdirSync(path.dirname(c.root)).some(name => name.includes('.stage-')), false);
});

test('native registration failure rolls back a partially written registration and owned files', t => {
  const { c, env } = fixture(t);
  write(path.join(c.home, '.claude.json'), '{"setting":"untouched","mcpServers":{"other":{"command":"keep"}}}');
  env.FAKE_FAIL = 'registration';
  assert.throws(() => install(c, 'claude'), /claude failed/);
  assert.deepEqual(readJson(path.join(c.home, '.claude.json')), { setting: 'untouched', mcpServers: { other: { command: 'keep' } } });
  assert.equal(fs.existsSync(c.root), false);
  assert.equal(fs.existsSync(c.plugin), false);
});

test('unowned files, existing registrations and agent switches are refused', t => {
  const { c } = fixture(t);
  write(c.wrapper, '#!/bin/sh\necho user-owned\n');
  assert.throws(() => install(c, 'opencode'), /not owned/);
  fs.unlinkSync(c.wrapper);
  const config = path.join(c.home, '.config/opencode/opencode.json');
  write(config, JSON.stringify({ mcp: { [NAME]: { type: 'local', command: ['other'] } } }));
  assert.throws(() => install(c, 'opencode'), /not owned/);
  write(config, '{}');
  install(c, 'opencode');
  assert.throws(() => install(c, 'claude'), /Uninstall before/);
});

test('modified registrations survive uninstall and are reported as unconfigured', t => {
  const { c } = fixture(t);
  install(c, 'opencode');
  const config = path.join(c.home, '.config/opencode/opencode.json');
  const changed = { type: 'local', command: ['my-new-command'], enabled: true };
  write(config, JSON.stringify({ mcp: { [NAME]: changed } }));
  assert.equal(status(c).mcpReady, false);
  assert.match(uninstall(c).message, /modified MCP registration was preserved/);
  assert.deepEqual(readJson(config).mcp[NAME], changed);
});

test('malformed JSONC and ambiguous OpenCode configs are never overwritten', t => {
  const { c } = fixture(t);
  const plain = path.join(c.home, '.config/opencode/opencode.json'), commented = plain + 'c';
  write(commented, '{"mcp": ');
  assert.throws(() => install(c, 'opencode'));
  assert.equal(fs.readFileSync(commented, 'utf8'), '{"mcp": ');
  write(plain, '{}');
  assert.throws(() => install(c, 'opencode'), /Both opencode/);
});

test('pairing-key refuses captured output and status never prints the key', t => {
  const { c, env } = fixture(t);
  install(c, 'opencode');
  write(path.join(c.home, '.webbrain/bridge-key'), 'TOP_SECRET_PAIRING_KEY');
  for (const args of [['status', '--json'], ['pairing-key']]) {
    const result = spawnSync(process.execPath, [c.wrapper, ...args], { env, encoding: 'utf8' });
    assert.ok(!(result.stdout + result.stderr).includes('TOP_SECRET_PAIRING_KEY'));
    if (args[0] === 'pairing-key') { assert.equal(result.status, 1); assert.match(result.stderr, /terminal/); }
  }
});

test('disabled Codex registration never reports MCP ready', t => {
  const { c } = fixture(t);
  install(c, 'codex');
  const file = path.join(c.home, '.codex/servers.json'), config = readJson(file);
  config[NAME].enabled = false;
  write(file, JSON.stringify(config));
  assert.equal(status(c).mcpReady, false);
  assert.equal(status(c).configured, false);
});

for (const agent of ['claude', 'codex', 'opencode']) {
  test(`${agent}: desktop launch and uninstall reuse installed configuration context`, async t => {
    const { c, env, home, detached } = fixture(t);
    const variable = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : agent === 'codex' ? 'CODEX_HOME' : 'XDG_CONFIG_HOME';
    env[variable] = path.join(home, 'selected-account');
    install(c, agent);
    const selected = env[variable];
    env[variable] = path.join(home, 'different-account');
    assert.equal(status(c).mcpReady, true);
    await launch(c, 'Read the current page');
    assert.equal(detached[0].options.env[variable], selected);
    assert.equal(fs.existsSync(env[variable]), false);
    uninstall(c);
    assert.equal(fs.existsSync(env[variable]), false);
  });
}

test('missing running Omarchy shell retains working installation and reports manual enable', t => {
  const { c } = fixture(t);
  const original = c.runner;
  c.runner = (command, args, options) => command === 'omarchy-shell'
    ? { status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }
    : original(command, args, options);
  const result = install(c, 'opencode');
  assert.equal(result.installed, true);
  assert.equal(result.pluginEnabled, false);
  assert.match(result.message, /Enable the plugin in a running Omarchy session/);
  assert.equal(status(c).mcpReady, true);
});

test('no-enable skips shell calls', t => {
  const { c, calls } = fixture(t);
  install(c, 'opencode', false, false);
  assert.ok(!calls().some(call => call.command.startsWith('omarchy')));
});

test('symlinked backup directory is rejected before deregistration or chmod', t => {
  const { c, temp } = fixture(t);
  install(c, 'opencode');
  const target = path.join(temp, 'unrelated');
  fs.mkdirSync(target, { mode: 0o755 });
  write(path.join(target, 'keep.txt'), 'preserve');
  const before = fs.statSync(target).mode;
  try { fs.symlinkSync(target, path.join(c.root, 'backups'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Platform does not allow test symlinks'); return; } throw error; }
  assert.throws(() => uninstall(c), /symlink/);
  assert.equal(status(c).mcpReady, true);
  assert.equal(fs.statSync(target).mode, before);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'preserve');
});

test('symlinked ownership state is rejected', t => {
  const { c, temp } = fixture(t);
  install(c, 'opencode');
  const target = path.join(temp, 'state-copy.json');
  fs.renameSync(c.state, target);
  try { fs.symlinkSync(target, c.state, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Platform does not allow test symlinks'); return; } throw error; }
  assert.throws(() => status(c), /symlink/);
  assert.throws(() => uninstall(c), /symlink/);
  assert.ok(fs.existsSync(target));
});

test('enabled existing WebBrain server is preserved and blocks install', t => {
  const { c, home } = fixture(t);
  const config = path.join(home, '.config/opencode/opencode.json');
  const original = JSON.stringify({ mcp: { existingBrowser: { type: 'local', command: ['npx', '@webbrain/mcp-server'], enabled: true } } });
  write(config, original);
  assert.throws(() => install(c, 'opencode'), /two servers cannot share port/);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(fs.existsSync(c.root), false);
});

test('a disabled prior WebBrain registration can coexist without being changed', t => {
  const { c, home } = fixture(t);
  const config = path.join(home, '.config/opencode/opencode.json');
  const disabled = { type: 'local', command: ['npx', '@webbrain/mcp-server'], enabled: false };
  write(config, JSON.stringify({ mcp: { webbrain: disabled } }));
  install(c, 'opencode');
  assert.deepEqual(readJson(config).mcp.webbrain, disabled);
});

test('busy browser bridge prevents launching another agent', async t => {
  const { c, detached } = fixture(t);
  install(c, 'opencode');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  c.portCheck = () => checkBridgeAvailable(server.address().port);
  await assert.rejects(launch(c, 'Read a page'), /already occupied/);
  assert.equal(detached.length, 0);
});

test('missing stored Node runtime is reported and blocks launch', async t => {
  const { c } = fixture(t);
  install(c, 'opencode');
  const recorded = readJson(c.state);
  recorded.node = path.join(c.home, 'removed-node');
  write(c.state, JSON.stringify(recorded));
  assert.equal(status(c).mcpReady, false);
  assert.match(status(c).message, /Node executable is missing/);
  await assert.rejects(launch(c, 'Read a page'), /Node executable is missing/);
});

for (const agent of ['claude', 'codex']) {
  for (const extra of [false, true]) {
    test(`${agent}: Omarchy ${extra ? 'extra' : 'Main'} account stays pinned after desktop account changes`, async t => {
      const { c, env, home, detached } = fixture(t);
      const provider = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
      env[provider] = '';
      env.FAKE_ACCOUNT_HOME = extra ? path.join(home, 'omarchy-extra-account') : '';
      const selected = env.FAKE_ACCOUNT_HOME;
      install(c, agent);
      env.FAKE_ACCOUNT_HOME = path.join(home, 'newly-selected-account');
      assert.equal(status(c).mcpReady, true);
      await launch(c, 'Read a page');
      assert.equal(detached[0].options.env[`OMARCHY_AGENT_${agent.toUpperCase()}_HOME`], selected);
      assert.equal(detached[0].options.env[provider], selected);
      uninstall(c);
      assert.equal(fs.existsSync(env.FAKE_ACCOUNT_HOME), false);
    });
  }
}

test('JSONC configuration symlinks are preserved while their target is updated', t => {
  const { c, temp } = fixture(t);
  const target = path.join(temp, 'shared-config.json'), linked = path.join(c.home, '.config/opencode/opencode.json');
  write(target, '{"model":"keep"}');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  try { fs.symlinkSync(target, linked, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Platform does not allow test symlinks'); return; } throw error; }
  install(c, 'opencode');
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.equal(readJson(target).model, 'keep');
  assert.ok(readJson(target).mcp[NAME]);
  uninstall(c);
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.equal(readJson(target).mcp[NAME], undefined);
});
