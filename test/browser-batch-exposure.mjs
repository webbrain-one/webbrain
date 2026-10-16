import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { buildPayload, BROWSERS as PAYLOAD_BROWSERS, loadFrozenBaseline, getFrozenSnapshot } from './llm/lib/build-payload.mjs';
import { buildScenarioPayload } from './llm/lib/scenario-payload.mjs';

for (const build of ['chrome', 'firefox']) {
  const { getToolsForMode, SYSTEM_PROMPT_ACT, SYSTEM_PROMPT_ACT_MID, SYSTEM_PROMPT_ACT_COMPACT, SYSTEM_PROMPT_BATCHING } = await import(`../src/${build}/src/agent/tools.js`);
  const { validateToolArguments } = await import(`../src/${build}/src/agent/tool-arguments.js`);
  const { capabilityFor, UNTRUSTED_CONTENT_TOOLS } = await import(`../src/${build}/src/agent/permission-gate.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  test(`${build}: batching is exposed only in enabled Mid/Full action modes`, () => {
    for (const mode of ['ask', 'act', 'dev']) {
      for (const tier of ['compact', 'mid', 'full']) {
        const tools = getToolsForMode(mode, { tier });
        const batch = tools.find(tool => tool.function.name === 'browser_batch');
        assert.equal(!!batch, mode !== 'ask' && tier !== 'compact', `${mode}/${tier}`);
        assert.equal(getToolsForMode(mode, { tier, browserBatchEnabled: false }).some(tool => tool.function.name === 'browser_batch'), false);
        if (!batch) continue;
        const schema = batch.function.parameters;
        assert.equal(schema.properties.actions.maxItems, tier === 'mid' ? 6 : 10);
        assert.equal(schema.properties.actions.minItems, 1);
        const names = new Set(tools.map(tool => tool.function.name));
        const actionNames = schema.properties.actions.items.properties.name.enum;
        assert.ok(actionNames.every(name => names.has(name)), 'Only advertised sub-tools can be selected.');
        assert.ok(!actionNames.includes('browser_batch'));
        assert.ok(!actionNames.includes('execute_js'));
        assert.ok(!actionNames.includes('chat_send'));
        assert.equal(actionNames.includes('hover'), tier === 'full');
        // The parent schema must not close the child tool's arguments to {}.
        assert.equal(validateToolArguments('browser_batch', {
          actions: [{ name: 'set_field', input: { ref_id: 'ref_1', text: 'hello', submit: false } }],
        }, schema).ok, true);
        assert.equal(validateToolArguments('browser_batch', {
          actions: [{ name: 'browser_batch', input: {} }],
        }, schema).ok, false);
      }
    }
  });

  test(`${build}: batch guidance follows the feature switch and leaves Compact small`, () => {
    const provider = { promptTier: 'mid', config: { promptTier: 'mid' } };
    const agent = new Agent({ getActive: () => provider });
    assert.equal(agent.browserBatchEnabled, true);
    assert.ok(agent._buildSystemPrompt('act').includes(SYSTEM_PROMPT_BATCHING));
    assert.ok(agent._buildSystemPrompt('dev').includes(SYSTEM_PROMPT_BATCHING));
    assert.ok(!agent._buildSystemPrompt('ask').includes(SYSTEM_PROMPT_BATCHING));
    agent.setBrowserBatchEnabled(false);
    assert.ok(!agent._buildSystemPrompt('act').includes(SYSTEM_PROMPT_BATCHING));
    agent.setBrowserBatchEnabled(true);
    provider.promptTier = provider.config.promptTier = 'compact';
    assert.ok(!agent._buildSystemPrompt('act').includes(SYSTEM_PROMPT_BATCHING));
    assert.ok(!SYSTEM_PROMPT_ACT_COMPACT.includes('browser_batch'));
  });

  test(`${build}: batch results are classified as untrusted while children own permissions`, () => {
    assert.equal(UNTRUSTED_CONTENT_TOOLS.has('browser_batch'), true);
    assert.equal(capabilityFor('browser_batch', {}), null);
    assert.notEqual(capabilityFor('set_field', { ref_id: 'ref_1', text: 'value' }), null);
  });

  test(`${build}: run provider controls base prompt and batching guidance across refreshes`, () => {
    const prompts = { full: SYSTEM_PROMPT_ACT, mid: SYSTEM_PROMPT_ACT_MID, compact: SYSTEM_PROMPT_ACT_COMPACT };
    for (const activeTier of Object.keys(prompts)) for (const runTier of Object.keys(prompts)) {
      const active = { promptTier: activeTier };
      const run = { promptTier: runTier };
      const agent = new Agent({ getActive: () => active, getProvider: id => id === 'override' ? run : active });
      agent._persist = () => {};
      let override = true;
      if (agent._runProviderOverrides) agent._runProviderOverrides.set(1, 'override');
      // Firefox currently has a global provider; exercise the shared tab hook
      // without adding Chrome's per-run provider API to that platform.
      else agent._activeProvider = tabId => tabId === 1 && override ? run : active;
      const messages = agent.getConversation(1, 'act');
      assert.ok(messages[0].content.startsWith(prompts[runTier]), `${activeTier}/${runTier}: base prompt`);
      assert.equal(messages[0].content.includes(SYSTEM_PROMPT_BATCHING), runTier !== 'compact');
      assert.ok(agent._buildSystemPrompt('act', 2).startsWith(prompts[activeTier]), 'unrelated tabs use the global provider');
      agent.setBrowserBatchEnabled(false);
      agent._refreshSystemPromptForTab(1, 'act');
      assert.ok(messages[0].content.startsWith(prompts[runTier]));
      assert.equal(messages[0].content.includes(SYSTEM_PROMPT_BATCHING), false);
      agent.setBrowserBatchEnabled(true);
      agent._refreshSystemPromptForTab(1, 'act');
      assert.equal(messages[0].content.includes(SYSTEM_PROMPT_BATCHING), runTier !== 'compact');
      assert.equal(agent._buildSystemPrompt('ask', 1).includes(SYSTEM_PROMPT_BATCHING), false);
      if (runTier !== 'compact') assert.ok(agent._buildSystemPrompt('dev', 1).includes(SYSTEM_PROMPT_BATCHING));
      if (agent._runProviderOverrides) agent._runProviderOverrides.delete(1);
      override = false;
      assert.ok(agent.getConversation(1, 'act')[0].content.startsWith(prompts[activeTier]), 'run cleanup restores the global tier');
    }
  });

  test(`${build}: every locale labels the batch tool`, async () => {
    const directory = new URL(`../src/${build}/src/ui/locales/`, import.meta.url);
    const locales = fs.readdirSync(directory).filter(file => file.endsWith('.js'));
    assert.equal(locales.length, 23);
    for (const file of locales) {
      const text = fs.readFileSync(new URL(file, directory), 'utf8');
      assert.match(text, /'tool\.browser_batch':\s*["'][^"']+["']/u, file);
    }
  });

  test(`${build}: both evaluation builders place batch guidance immediately after the base prompt`, () => {
    const browser = PAYLOAD_BROWSERS[build];
    const prompts = { full: SYSTEM_PROMPT_ACT, mid: SYSTEM_PROMPT_ACT_MID, compact: SYSTEM_PROMPT_ACT_COMPACT };
    for (const mode of ['act', 'dev', 'ask']) for (const tier of Object.keys(prompts)) {
      if (mode === 'dev' && tier === 'compact') continue;
      const options = { tier, browser: build, profile: { enabled: true, text: 'Fixture profile.' } };
      const payloads = [
        buildPayload({ mode, user: 'Fill the known fields.' }, options),
        buildScenarioPayload({ mode, browser: build, seed: [], packagedSkillIds: ['cms-wix'], activeSkillIds: ['cms-wix'] }, options),
      ];
      const agent = new Agent({ getActive: () => ({ promptTier: tier }) });
      const production = agent._buildSystemPrompt(mode);
      for (const payload of payloads) {
        const prompt = payload.messages[0].content;
        const hasBatch = payload.tools.some(tool => tool.function.name === 'browser_batch');
        assert.equal(prompt.includes(SYSTEM_PROMPT_BATCHING), hasBatch);
        if (!hasBatch) continue;
        assert.ok(prompt.startsWith(`${prompts[tier]}\n\n${SYSTEM_PROMPT_BATCHING}`));
        assert.ok(prompt.indexOf(SYSTEM_PROMPT_BATCHING) < prompt.indexOf(browser.UNIVERSAL_PREAMBLE.trim()));
        assert.ok(production.indexOf(SYSTEM_PROMPT_BATCHING) < production.indexOf(browser.UNIVERSAL_PREAMBLE.trim()));
        if (mode === 'dev') {
          const appendix = browser.SYSTEM_PROMPT_DEV_APPENDIX.trim();
          assert.ok(prompt.indexOf(SYSTEM_PROMPT_BATCHING) < prompt.indexOf(appendix));
          assert.ok(production.indexOf(SYSTEM_PROMPT_BATCHING) < production.indexOf(appendix));
        }
        assert.equal(prompt.split(SYSTEM_PROMPT_BATCHING).length - 1, 1);
      }
    }
  });

  test(`${build}: prompt-order changes leave frozen prompts and tools untouched`, () => {
    loadFrozenBaseline(new URL('./llm/freeze/baseline-2026-05-23.json', import.meta.url));
    try {
      const frozen = getFrozenSnapshot();
      const options = { tier: 'compact', browser: build, profile: { enabled: true, text: 'Must not be appended.' } };
      for (const payload of [
        buildPayload({ mode: 'act', user: 'Fixture.' }, options),
        buildScenarioPayload({ mode: 'act', browser: build, seed: [], packagedSkillIds: ['missing-skill-must-not-load'] }, options),
      ]) {
        assert.equal(payload.messages[0].content, frozen.systemContent);
        assert.equal(payload.tools, frozen.tools);
      }
    } finally { loadFrozenBaseline(null); }
  });
}
