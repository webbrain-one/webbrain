#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { isDeepStrictEqual } from 'node:util';

export const NAME = 'webbrain-omarchy';
const OWNER = 'webbrain-omarchy/v1';
const AGENTS = ['claude', 'codex', 'opencode'];
const BRIDGE_ENV = { WEBBRAIN_BRIDGE_PORT: '17374', WEBBRAIN_BRIDGE_PATH: '/extension' };
const URLS = Object.freeze({
  extension: 'https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb',
  cloud: 'https://webbrain.cloud/',
  docs: 'https://webbrain.one/docs/omarchy/',
});
const script = fileURLToPath(import.meta.url);
const exists = file => fs.existsSync(file);
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const equal = isDeepStrictEqual;

export function context(options = {}) {
  const home = path.resolve(options.home ?? os.homedir());
  const env = options.env ?? process.env;
  const root = path.join(home, '.local/share/webbrain-omarchy');
  return {
    home, env, root,
    platform: options.platform ?? process.platform,
    sourceRoot: options.sourceRoot ?? path.resolve(path.dirname(script), '../../..'),
    cliSource: options.cliSource ?? script,
    node: options.node ?? process.execPath,
    plugin: path.join(home, '.config/omarchy/plugins/webbrain.browser'),
    wrapper: path.join(home, '.local/bin/webbrain-omarchy'),
    state: path.join(root, 'state.json'),
    portCheck: options.portCheck ?? (() => checkBridgeAvailable()),
    runner: options.runner ?? ((command, args, opts) => spawnSync(command, args, {
      ...opts, shell: false, encoding: 'utf8',
    })),
    detacher: options.detacher ?? ((command, args, opts) => new Promise((resolve, reject) => {
      const child = spawn(command, args, { ...opts, shell: false, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    })),
  };
}

function exec(c, command, args, { inherit = false, timeout = 180000, check = true, cwd = c.home } = {}) {
  const result = c.runner(command, args, {
    cwd, env: c.env, stdio: inherit ? 'inherit' : 'pipe', timeout, shell: false,
  });
  if (check && (result.error || result.status !== 0)) {
    // Never echo child output: agent configuration can contain credentials.
    throw new Error(`${command} failed${result.error?.code ? ` (${result.error.code})` : ` (exit ${result.status})`}. Existing configuration is preserved; run the command directly for diagnostics.`);
  }
  return result;
}

function safePath(file) {
  let current = path.resolve(file);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing a symlink destination: ${current}`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function atomicWrite(file, text, mode = 0o600) {
  safePath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.webbrain-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, text, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}

function removeOwned(target, parent) {
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(parent)) throw new Error('Unsafe cleanup path.');
  safePath(resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function state(c) {
  if (!exists(c.state)) return null;
  safePath(c.root);
  safePath(c.state);
  const value = json(c.state);
  if (value.owner !== OWNER || !AGENTS.includes(value.agent)) throw new Error('Unrecognized integration state; refusing to overwrite it.');
  return value;
}

function expected(c, agent) {
  const args = [path.join(c.root, 'mcp-server/dist/index.js')];
  return agent === 'opencode'
    ? { type: 'local', command: [c.node, ...args], enabled: true, environment: BRIDGE_ENV }
    : { type: 'stdio', command: c.node, args, env: BRIDGE_ENV };
}

function configFile(c, agent) {
  if (c.configPath) return c.configPath;
  if (agent === 'codex') return path.join(c.env.CODEX_HOME || path.join(c.home, '.codex'), 'config.toml');
  if (agent === 'claude') return c.env.CLAUDE_CONFIG_DIR
    ? path.join(c.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(c.home, '.claude.json');
  const directory = path.join(c.env.XDG_CONFIG_HOME || path.join(c.home, '.config'), 'opencode');
  const jsonc = path.join(directory, 'opencode.jsonc');
  const plain = path.join(directory, 'opencode.json');
  if (exists(jsonc) && exists(plain)) throw new Error('Both opencode.json and opencode.jsonc exist. Merge them before configuring this integration.');
  return exists(jsonc) ? jsonc : plain;
}

function configContext(c, agent) {
  const configPath = configFile(c, agent);
  const configEnv = agent === 'codex' ? { CODEX_HOME: c.env.CODEX_HOME || '', OMARCHY_AGENT_CODEX_HOME: c.env.OMARCHY_AGENT_CODEX_HOME || '' }
    : agent === 'claude' ? { CLAUDE_CONFIG_DIR: c.env.CLAUDE_CONFIG_DIR || '', OMARCHY_AGENT_CLAUDE_HOME: c.env.OMARCHY_AGENT_CLAUDE_HOME || '' }
      : { XDG_CONFIG_HOME: path.dirname(path.dirname(configPath)) };
  return { configPath, configEnv };
}
function selectAccount(c, agent) {
  if (agent === 'opencode') return c;
  const provider = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const pin = `OMARCHY_AGENT_${agent.toUpperCase()}_HOME`;
  let selected = c.env[provider];
  if (!selected) {
    if (Object.hasOwn(c.env, pin)) selected = c.env[pin];
    else {
      const result = exec(c, 'omarchy-agent-account-home', [agent], { check: false, timeout: 5000 });
      if (result.error?.code === 'ENOENT') selected = '';
      else if (result.error || result.status !== 0) throw new Error('Could not resolve the selected Omarchy agent account. Set the agent configuration home explicitly and retry.');
      else selected = (result.stdout || '').trim();
    }
  }
  if (selected && !path.isAbsolute(selected)) throw new Error('Agent configuration home must be an absolute path.');
  return { ...c, env: { ...c.env, [provider]: selected || '', [pin]: selected || '' } };
}
function canonicalConfig(file) {
  const tail = [];
  let current = path.resolve(file);
  while (!exists(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) fs.realpathSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Cannot resolve the agent configuration path.');
    tail.unshift(path.basename(current)); current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}
function runtimeContext(c, installed) {
  return { ...c, node: installed.node, configPath: installed.configPath,
    env: { ...c.env, ...installed.configEnv } };
}

// Preserve JSONC comments and unrelated bytes instead of reserializing user settings.
function trivia(text, pos) {
  while (pos < text.length) {
    if (/\s/.test(text[pos])) { pos++; continue; }
    if (text.slice(pos, pos + 2) === '//') { const end = text.indexOf('\n', pos); pos = end < 0 ? text.length : end; continue; }
    if (text.slice(pos, pos + 2) === '/*') { const end = text.indexOf('*/', pos + 2); if (end < 0) throw new Error('Unclosed JSONC comment.'); pos = end + 2; continue; }
    break;
  }
  return pos;
}
function stringEnd(text, start) {
  let pos = start + 1;
  while (pos < text.length) { if (text[pos] === '\\') pos += 2; else if (text[pos++] === '"') return pos; }
  throw new Error('Unclosed JSON string.');
}
function valueEnd(text, start) {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] === '{' || text[start] === '[') {
    const close = text[start] === '{' ? '}' : ']';
    let pos = start + 1;
    while ((pos = trivia(text, pos)) < text.length) {
      if (text[pos] === close) return pos + 1;
      if ('{["'.includes(text[pos])) pos = valueEnd(text, pos); else pos++;
    }
    throw new Error('Unclosed JSON container.');
  }
  let pos = start;
  while (pos < text.length && !/[\s,}\]]/.test(text[pos]) && text[pos] !== '/') pos++;
  return pos;
}
function members(text, start) {
  if (text[start] !== '{') throw new Error('Expected a JSON object.');
  const result = [];
  let pos = trivia(text, start + 1);
  while (text[pos] !== '}') {
    if (text[pos] !== '"') throw new Error('Invalid JSON object key.');
    const begin = pos, end = stringEnd(text, pos), key = JSON.parse(text.slice(pos, end));
    pos = trivia(text, end);
    if (text[pos] !== ':') throw new Error('Invalid JSON property.');
    const valueStart = trivia(text, pos + 1), finish = valueEnd(text, valueStart);
    pos = trivia(text, finish);
    const comma = text[pos] === ',' ? pos : null;
    if (comma !== null) pos = trivia(text, pos + 1); else if (text[pos] !== '}') throw new Error('Invalid JSON separator.');
    if (result.some(item => item.key === key)) throw new Error(`Duplicate JSON property: ${key}`);
    result.push({ key, begin, valueStart, finish, comma });
  }
  return result;
}
function parseJsonc(text) {
  let clean = '', pos = 0;
  while (pos < text.length) {
    if (text[pos] === '"') { const end = stringEnd(text, pos); clean += text.slice(pos, end); pos = end; }
    else if (text.slice(pos, pos + 2) === '//' || text.slice(pos, pos + 2) === '/*') { const end = trivia(text, pos); clean += ' '.repeat(end - pos); pos = end; }
    else if (text[pos] === ',' && /[}\]]/.test(text[trivia(text, pos + 1)] || 'x')) { clean += ' '; pos++; }
    else clean += text[pos++];
  }
  return JSON.parse(clean);
}
function editMember(text, start, key, value) {
  const items = members(text, start), index = items.findIndex(item => item.key === key), item = items[index];
  if (item) {
    if (value !== undefined) return text.slice(0, item.valueStart) + JSON.stringify(value) + text.slice(item.finish);
    const begin = item.comma === null && index > 0 ? items[index - 1].comma : item.begin;
    const end = item.comma === null ? item.finish : item.comma + 1;
    return text.slice(0, begin) + text.slice(end);
  }
  if (value === undefined) return text;
  return text.slice(0, start + 1) + `\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}${items.length ? ',' : ''}` + text.slice(start + 1);
}
export function editOpenCode(text, value) {
  const parsed = parseJsonc(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('OpenCode config must be an object.');
  const start = trivia(text, 0), mcp = members(text, start).find(item => item.key === 'mcp');
  const result = mcp
    ? editMember(text, mcp.valueStart, NAME, value)
    : value === undefined ? text : editMember(text, start, 'mcp', { [NAME]: value });
  parseJsonc(result);
  return result;
}

function registrations(c, agent) {
  if (agent === 'codex') {
    const result = exec(c, 'codex', ['mcp', 'list', '--json'], { timeout: 5000 });
    let list;
    try { list = JSON.parse(result.stdout); }
    catch { throw new Error('Codex returned invalid MCP configuration JSON. Inspect its configuration directly.'); }
    if (!Array.isArray(list)) throw new Error('Unexpected Codex MCP list response.');
    return Object.fromEntries(list.map(entry => [entry.name, { ...(entry.transport ?? entry), ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }) }]));
  }
  const file = configFile(c, agent);
  if (!exists(file)) return {};
  let parsed;
  try { parsed = agent === 'opencode' ? parseJsonc(read(file)) : json(file); }
  catch { throw new Error(`Cannot read valid ${agent} configuration at ${file}. Fix it before installing; its contents were not logged.`); }
  return (agent === 'opencode' ? parsed.mcp : parsed.mcpServers) ?? {};
}
function registration(c, agent) { return registrations(c, agent)[NAME] ?? null; }
function rejectConflictingServer(c, agent) {
  for (const [name, entry] of Object.entries(registrations(c, agent))) {
    if (name === NAME || entry?.enabled === false || entry?.disabled === true) continue;
    const command = JSON.stringify([entry?.command, entry?.args]);
    if (name.toLowerCase() === 'webbrain' || /@webbrain\/mcp-server|webbrain-mcp|webbrain[^\n]*mcp-server/.test(command)) {
      throw new Error(`Enabled WebBrain MCP registration "${name}" already exists. Disable or remove it in ${agent} before using this integration; two servers cannot share port 17374. The existing entry was not changed.`);
    }
  }
}
function matches(actual, wanted) {
  if (!actual) return false;
  return actual.type === wanted.type && equal(actual.command, wanted.command)
    && equal(actual.args ?? [], wanted.args ?? []) && actual.enabled !== false
    && equal(actual.env ?? {}, wanted.env ?? {})
    && equal(actual.environment ?? {}, wanted.environment ?? {});
}
function configure(c, agent, value) {
  const file = configFile(c, agent);
  // Omarchy extra accounts can deliberately share config files through symlinks.
  // Native clients preserve those links; JSONC edits replace only the target.
  const target = canonicalConfig(file);
  if (agent === 'opencode') atomicWrite(target, editOpenCode(exists(file) ? read(file) : '{}\n', value));
  else if (value) exec(c, agent, agent === 'claude'
    ? ['mcp', 'add', NAME, '--scope', 'user', '--transport', 'stdio', '--env', 'WEBBRAIN_BRIDGE_PORT=17374', '--env', 'WEBBRAIN_BRIDGE_PATH=/extension', '--', value.command, ...value.args]
    : ['mcp', 'add', NAME, '--env', 'WEBBRAIN_BRIDGE_PORT=17374', '--env', 'WEBBRAIN_BRIDGE_PATH=/extension', '--', value.command, ...value.args]);
  else exec(c, agent, agent === 'claude' ? ['mcp', 'remove', '--scope', 'user', NAME] : ['mcp', 'remove', NAME]);
}
function backupConfig(c, file) {
  if (!exists(file)) return;
  atomicWrite(path.join(c.root, 'backups', `${Date.now()}-${randomUUID()}-${path.basename(file)}`), read(canonicalConfig(file)));
}

export function install(c, agent, dryRun = false, enable = true) {
  if (c.platform !== 'linux') throw new Error('Installation is supported on Linux only.');
  if (!AGENTS.includes(agent)) throw new Error('Choose --agent claude, codex, or opencode.');
  const prior = state(c);
  if (prior && prior.agent !== agent) throw new Error('Uninstall before selecting another agent; only one agent owns this bridge.');
  c = prior ? runtimeContext(c, prior) : selectAccount(c, agent);
  if (!exists(c.node)) throw new Error('The stored Node runtime is missing. Uninstall, then install from a checkout using the current Node runtime.');
  for (const target of [c.root, c.plugin, c.wrapper]) safePath(target);
  canonicalConfig(configFile(c, agent));
  if (exists(c.root) && !prior) throw new Error('Installation directory already exists without an ownership record.');
  if (exists(c.plugin) && (!exists(path.join(c.plugin, '.webbrain-owner')) || read(path.join(c.plugin, '.webbrain-owner')) !== OWNER)) throw new Error('Plugin directory belongs to another installation.');
  if (exists(c.wrapper) && !read(c.wrapper).includes(`// ${OWNER}\n`)) throw new Error('Launcher already exists and is not owned by this integration.');
  const previousEntry = registration(c, agent), wanted = expected(c, agent);
  rejectConflictingServer(c, agent);
  if (previousEntry && (!prior || !matches(previousEntry, wanted))) throw new Error('An existing webbrain-omarchy MCP registration is not owned by this installation.');
  const mcpSource = path.join(c.sourceRoot, 'mcp-server');
  const integrationSource = path.join(c.sourceRoot, 'integrations/omarchy');
  if (!exists(path.join(mcpSource, 'package-lock.json')) || !exists(path.join(integrationSource, 'manifest.json'))) throw new Error('Run install from a complete WebBrain source checkout with the Omarchy integration.');
  const manifest = json(path.join(integrationSource, 'manifest.json'));
  const files = fs.readdirSync(integrationSource).filter(name => name === 'manifest.json' || name.endsWith('.qml'));
  if (files.length < 2) throw new Error('Plugin QML files are missing.');
  if (dryRun) return { dryRun: true, agent, registration: NAME, installDirectory: c.root, pluginDirectory: c.plugin, files, message: 'Would build this checkout’s MCP server, install the plugin and launcher, and register only the selected agent. Browser installation and pairing remain manual.' };
  exec(c, agent, ['--version']);
  const packageInfo = json(path.join(mcpSource, 'package.json'));
  if (packageInfo.name !== '@webbrain/mcp-server' || !exists(path.join(mcpSource, 'src/pairing.ts'))) throw new Error('This checkout does not contain the reviewed paired MCP server.');
  const token = randomUUID(), stage = `${c.root}.stage-${token}`, old = `${c.root}.old-${token}`;
  const pluginStage = `${c.plugin}.stage-${token}`, pluginOld = `${c.plugin}.old-${token}`;
  const wrapperBefore = exists(c.wrapper) ? read(c.wrapper) : null;
  let swapped = false, pluginSwapped = false, registered = false, committed = false;
  fs.mkdirSync(path.dirname(stage), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(pluginStage), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(stage, { mode: 0o700 });
    const mcpStage = path.join(stage, 'mcp-server');
    fs.mkdirSync(mcpStage);
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'src']) fs.cpSync(path.join(mcpSource, name), path.join(mcpStage, name), { recursive: true });
    exec(c, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: mcpStage });
    exec(c, 'npm', ['run', 'build'], { cwd: mcpStage });
    if (!exists(path.join(mcpStage, 'dist/index.js'))) throw new Error('MCP build did not produce dist/index.js.');
    fs.copyFileSync(c.cliSource, path.join(stage, 'cli.mjs'));
    if (exists(path.join(c.root, 'backups'))) {
      safePath(path.join(c.root, 'backups'));
      fs.cpSync(path.join(c.root, 'backups'), path.join(stage, 'backups'), { recursive: true });
    }
    atomicWrite(path.join(stage, 'state.json'), JSON.stringify({ owner: OWNER, agent, version: packageInfo.version, node: c.node, ...configContext(c, agent), manifestId: manifest.id ?? 'webbrain.browser' }, null, 2) + '\n');
    fs.mkdirSync(pluginStage);
    for (const name of files) fs.copyFileSync(path.join(integrationSource, name), path.join(pluginStage, name));
    fs.writeFileSync(path.join(pluginStage, '.webbrain-owner'), OWNER);
    if (prior) fs.renameSync(c.root, old);
    fs.renameSync(stage, c.root); swapped = true;
    if (exists(c.plugin)) fs.renameSync(c.plugin, pluginOld);
    fs.renameSync(pluginStage, c.plugin); pluginSwapped = true;
    atomicWrite(c.wrapper, `#!/usr/bin/env node\n// ${OWNER}\nimport(${JSON.stringify(pathToFileURL(path.join(c.root, 'cli.mjs')).href)}).then(({ main }) => main()).catch(() => { console.error('WebBrain: installed helper could not be loaded. Reinstall from the source checkout.'); process.exitCode = 1; });\n`, 0o755);
    if (!previousEntry) {
      backupConfig(c, configFile(c, agent));
      registered = true;
      configure(c, agent, wanted);
      if (!matches(registration(c, agent), wanted)) throw new Error('The agent did not retain the expected MCP registration.');
    }
    committed = true;
    let cleanupNote = '';
    for (const [retired, parent] of [[old, path.dirname(c.root)], [pluginOld, path.dirname(c.plugin)]]) {
      try { removeOwned(retired, parent); }
      catch { cleanupNote += ` Previous installation files remain at ${retired}; the new installation is active.`; }
    }
    let pluginEnabled = false;
    if (enable) {
      const rescan = exec(c, 'omarchy-shell', ['shell', 'rescanPlugins'], { check: false, timeout: 10000 });
      if (!rescan.error && rescan.status === 0) {
        const activated = exec(c, 'omarchy', ['plugin', 'enable', 'webbrain.browser'], { check: false, timeout: 10000 });
        pluginEnabled = !activated.error && activated.status === 0;
      }
    }
    return { installed: true, agent, pluginEnabled, message: `Installed.${pluginEnabled ? ' Omarchy plugin enabled.' : ' Enable the plugin in a running Omarchy session: omarchy-shell shell rescanPlugins, then omarchy plugin enable webbrain.browser.'} Install the extension, then pair it with ws://127.0.0.1:17374/extension. Only the selected agent should own this bridge.${cleanupNote}` };
  } catch (error) {
    if (committed) throw new Error(`Installation is complete, but desktop activation failed: ${error.message}`);
    if (registered) {
      try {
        const entry = registration(c, agent);
        if (entry && !matches(entry, wanted)) throw new Error('Registration changed during installation.');
        if (entry) configure(c, agent, undefined);
      }
      catch { throw new Error(`${error.message} Registration cleanup failed; retain ${c.root} and remove only ${NAME} through your agent before uninstalling.`); }
    }
    if (swapped) removeOwned(c.root, path.dirname(c.root));
    if (exists(old)) fs.renameSync(old, c.root);
    if (pluginSwapped) removeOwned(c.plugin, path.dirname(c.plugin));
    if (exists(pluginOld)) fs.renameSync(pluginOld, c.plugin);
    if (wrapperBefore !== null) atomicWrite(c.wrapper, wrapperBefore, 0o755);
    else if (exists(c.wrapper) && read(c.wrapper).includes(`// ${OWNER}\n`)) fs.unlinkSync(c.wrapper);
    throw error;
  } finally {
    removeOwned(stage, path.dirname(c.root));
    removeOwned(pluginStage, path.dirname(c.plugin));
  }
}

export function status(c) {
  const installed = state(c);
  if (!installed) return { installed: false, agent: null, mcpReady: false, configured: false, bridgeConfigured: null, message: 'Not installed. Choose an agent during installation.' };
  const runtime = runtimeContext(c, installed);
  let configured = false, note = '';
  try { configured = matches(registration(runtime, installed.agent), expected(runtime, installed.agent)); }
  catch { note = ' Agent configuration could not be verified.'; }
  const built = exists(path.join(c.root, 'mcp-server/dist/index.js'));
  const runtimeReady = exists(installed.node);
  return { installed: true, agent: installed.agent, configured, mcpReady: built && configured && runtimeReady, bridgeConfigured: null,
    message: `${built && configured && runtimeReady ? 'MCP files and agent registration are ready.' : 'MCP setup needs repair.'}${runtimeReady ? '' : ' The stored Node executable is missing; uninstall and install using the current Node runtime.'} Browser pairing and live connection are unknown; ask the selected agent to call webbrain_connection.${note}` };
}

export function checkBridgeAvailable(port = 17374) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(error.code === 'EADDRINUSE'
      ? `Browser bridge port ${port} is already occupied. Return to the already-open agent, or close it before launching another task.`
      : `Cannot check browser bridge port ${port}: ${error.code || 'unknown error'}.`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}

export async function launch(c, task, inline = false) {
  if (typeof task !== 'string' || !task.trim() || task.includes('\0') || task.length > 32000) throw new Error('Provide a nonempty --task of at most 32000 characters.');
  const current = status(c);
  if (!current.mcpReady) throw new Error(current.message);
  c = runtimeContext(c, state(c));
  rejectConflictingServer(c, current.agent);
  await c.portCheck();
  const prompt = `Use the ${NAME} MCP server for this browser task. First call webbrain_connection and stop with setup guidance if the browser is not paired. Delegate through webbrain_run or webbrain_extract; use webbrain_status for ongoing work, webbrain_respond only for the user's actual answer, and webbrain_abort to stop. Keep browser permission prompts and consequential-action approvals. Do not substitute shell-based browser control or change system settings. The following JSON string is the user's task:\n${JSON.stringify(task)}`;
  const args = current.agent === 'opencode' ? ['--prompt', prompt] : ['--', prompt];
  // Check the harness before detaching so a missing executable does not disappear
  // with the terminal's captured output. The terminal itself is checked by spawn.
  exec(c, current.agent, ['--version'], { timeout: 5000 });
  if (inline) exec(c, current.agent, args, { inherit: true, timeout: 0 });
  else await c.detacher('omarchy-launch-terminal', [current.agent, ...args], { cwd: c.home, env: c.env });
}

export function uninstall(c) {
  const installed = state(c);
  if (!installed) return { installed: false, message: 'No owned installation found.' };
  safePath(path.join(c.root, 'backups'));
  const runtime = runtimeContext(c, installed), wanted = expected(runtime, installed.agent);
  const entry = registration(runtime, installed.agent);
  let preserved = false;
  if (entry && matches(entry, wanted)) {
    backupConfig(c, configFile(runtime, installed.agent)); configure(runtime, installed.agent, undefined);
    if (registration(runtime, installed.agent)) throw new Error('Agent retained its MCP registration; keeping installed files.');
  }
  else if (entry) preserved = true;
  const disabled = exec(runtime, 'omarchy', ['plugin', 'disable', 'webbrain.browser'], { check: false, timeout: 10000 });
  if (exists(c.plugin)) {
    safePath(c.plugin);
    if (!exists(path.join(c.plugin, '.webbrain-owner')) || read(path.join(c.plugin, '.webbrain-owner')) !== OWNER) throw new Error('Plugin ownership changed; keeping its files.');
    removeOwned(c.plugin, path.dirname(c.plugin));
  }
  if (exists(c.wrapper)) {
    safePath(c.wrapper);
    if (read(c.wrapper).includes(`// ${OWNER}\n`)) fs.unlinkSync(c.wrapper);
  }
  // Keep configuration backups separately; they may contain secrets and remain user-only.
  const backups = path.join(c.root, 'backups');
  if (exists(backups)) {
    const retained = `${c.root}-backups-${randomUUID()}`;
    fs.renameSync(backups, retained);
    fs.chmodSync(retained, 0o700);
  }
  removeOwned(c.root, path.dirname(c.root));
  const rescanned = exec(runtime, 'omarchy-shell', ['shell', 'rescanPlugins'], { check: false, timeout: 10000 });
  const shellNote = disabled.error || disabled.status !== 0 || rescanned.error || rescanned.status !== 0
    ? ' Omarchy shell cleanup could not be confirmed; run omarchy plugin disable webbrain.browser and omarchy-shell shell rescanPlugins in the desktop session.' : '';
  return { installed: false, message: `Integration removed. Browser state, ~/.webbrain/bridge-key and unrelated agent settings remain.${preserved ? ' A modified MCP registration was preserved.' : ''}${shellNote}` };
}

function flags(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!Object.hasOwn(allowed, key) || Object.hasOwn(result, key)) throw new Error(`Unknown or repeated option: ${key}`);
    if (allowed[key]) { if (args[i + 1] === undefined) throw new Error(`Missing value for ${key}`); result[key] = args[++i]; }
    else result[key] = true;
  }
  return result;
}

export async function main(argv = process.argv.slice(2), c = context()) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
    const [command, ...args] = argv;
    let result;
    if (command === 'install') { const f = flags(args, { '--agent': true, '--dry-run': false, '--no-enable': false }); result = install(c, f['--agent'], f['--dry-run'], !f['--no-enable']); }
    else if (command === 'status') { const f = flags(args, { '--json': false }); result = status(c); if (f['--json']) { console.log(JSON.stringify(result)); return; } }
    else if (command === 'launch') { const f = flags(args, { '--task': true, '--inline': false }); await launch(c, f['--task'], f['--inline']); return; }
    else if (command === 'uninstall') { flags(args, {}); result = uninstall(c); }
    else if (command === 'open') { if (args.length !== 1 || !Object.hasOwn(URLS, args[0])) throw new Error('Use open extension, cloud, or docs.'); exec(c, 'xdg-open', [URLS[args[0]]]); return; }
    else if (command === 'pairing-key') {
      flags(args, {});
      const current = state(c);
      if (!current) throw new Error('Install the integration first.');
      if (!process.stdout.isTTY) throw new Error('Run pairing-key in a terminal; keys are never emitted through captured output.');
      exec(c, current.node, [path.join(c.root, 'mcp-server/dist/index.js'), 'pairing-key'], { inherit: true }); return;
    } else if (!command || command === '--help' || command === 'help') {
      console.log('webbrain-omarchy install --agent claude|codex|opencode [--dry-run] [--no-enable]\nwebbrain-omarchy status [--json]\nwebbrain-omarchy launch --task TEXT [--inline]\nwebbrain-omarchy open extension|cloud|docs\nwebbrain-omarchy pairing-key\nwebbrain-omarchy uninstall'); return;
    } else throw new Error(`Unknown command: ${command}`);
    console.log(result.dryRun ? JSON.stringify(result, null, 2) : result.message);
  } catch (error) { console.error(`WebBrain: ${error.message}`); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) await main();
