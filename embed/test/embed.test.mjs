import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getEmbedToolsForMode,
  buildEmbedSystemPrompt,
  calculateExpression,
} from '../src/webbrain.js';
import { buildEmbedBundle } from '../src/bundle.js';
import { buildAgentSpec } from '../src/agent-spec.js';

const EMBED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the extension modules load and the widget gets Ask and Act tools', () => {
  const askTools = getEmbedToolsForMode('ask').map((t) => t.function.name);
  assert.ok(askTools.includes('get_accessibility_tree'));
  assert.ok(askTools.includes('read_page'));
  assert.ok(askTools.includes('calculate'));
  assert.ok(!askTools.includes('click_ax'), 'Ask mode must not click');
  assert.ok(!askTools.includes('set_field'), 'Ask mode must not type');

  const actTools = getEmbedToolsForMode('act').map((t) => t.function.name);
  for (const name of ['click_ax', 'type_ax', 'set_field', 'set_checked']) {
    assert.ok(actTools.includes(name), `Act mode should include ${name}`);
  }
  assert.ok(!actTools.includes('open_tab') && !actTools.includes('close_tab'), 'No browser-extension tab tools on a website');

  assert.equal(calculateExpression('(49 - 39) * 12 * 12').result, '1440');

  const askPrompt = buildEmbedSystemPrompt('ask', {
    name: 'Acme Docs',
    domain: 'https://docs.acme.dev',
    modePolicy: 'ask_only',
    customInstructions: 'Always cite the pricing tier table.',
  });
  assert.ok(askPrompt.includes('Acme Docs'));
  assert.ok(askPrompt.includes('Always cite the pricing tier table.'));
  assert.ok(askPrompt.includes('Ask mode only (read-only)'));

  const githubPrompt = buildEmbedSystemPrompt('ask', { name: 'Docs' }, 'https://github.com/webbrain-one/webbrain/issues');
  assert.match(githubPrompt, /SITE ADAPTER NOTES \(.+\):\n\S/, 'Site adapter notes reach the prompt');
});

test('the bundle carries the extension content scripts and leaves extension-only parts out', () => {
  const bundle = buildEmbedBundle();
  assert.ok(bundle.length > 50000);
  // Sites load embed.js with a classic <script>, not as a module.
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'embed.js' }));
  const toolNames = {
    ask: getEmbedToolsForMode('ask').map((t) => t.function.name),
    act: getEmbedToolsForMode('act').map((t) => t.function.name),
  };
  assert.ok(bundle.includes(`toolNames: ${JSON.stringify(toolNames)}`), 'The widget enforces the tools.json tool lists');
  assert.ok(bundle.includes('License: GPL-3.0-or-later'), 'The bundle states its license');
  assert.ok(bundle.includes('https://github.com/webbrain-one/webbrain/tree/main/embed'), 'The bundle links its source');
  assert.ok(bundle.includes('__generateAccessibilityTree'), 'accessibility-tree.js');
  assert.ok(bundle.includes('WB_AGENT_INDICATOR'), 'agent-visual-indicator.js');
  assert.ok(bundle.includes('mountActivityBrain'), 'activity-brain.js');
  assert.ok(bundle.includes('[data-webbrain-question]'), 'Older data-webbrain-question buttons keep working');
  assert.ok(!bundle.includes('apocalypse-overlay'), 'No Apocalypse Mode overlay');
});

test('tools.json gives a server the same prompts and tools as the widget', () => {
  const spec = buildAgentSpec();
  assert.equal(spec.version, 1);
  assert.ok(spec.prompts.ask.length > 200 && spec.prompts.act.length > 200);
  assert.deepEqual(spec.askToolNames, spec.tools.ask.map((t) => t.function.name));
  assert.ok(spec.actToolNames.includes('click_ax') && !spec.askToolNames.includes('click_ax'));
});

test('the build writes the release files with matching checksums', () => {
  execFileSync(process.execPath, [path.join(EMBED_ROOT, 'scripts/build.mjs')], { stdio: 'pipe' });
  const dist = path.join(EMBED_ROOT, 'dist');
  const sums = fs.readFileSync(path.join(dist, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.deepEqual(sums.map((line) => line.split(/\s+/)[1]), ['embed.js', 'tools.json', 'icon48.png', 'icon128.png', 'VERSION.json']);
  for (const line of sums) {
    const [hash, name] = line.split(/\s+/);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex');
    assert.equal(actual, hash, `${name} checksum`);
  }
  const version = JSON.parse(fs.readFileSync(path.join(dist, 'VERSION.json'), 'utf8'));
  assert.equal(version.name, '@webbrain/embed');
  assert.equal(version.license, 'GPL-3.0-or-later');
  assert.match(version.source, /^https:\/\/github\.com\/webbrain-one\/webbrain\/tree\/.+\/embed$/);
});
