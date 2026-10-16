// Build the LLM request payload for a multi-turn SCENARIO.
//
// Unlike single-turn cases (questions/NNN.json), a scenario carries a verbatim
// conversation history (seed[]) that the model must continue from. The first
// user message is already enriched with [Current page context …] and any site
// adapter notes — authors write it the way it would appear on the wire — so
// the only thing the runner adds is the system prompt for the chosen browser
// and mode.
//
// The seed messages use the OpenAI chat-completions message shape:
//   { role: "user",   content: "..." }
//   { role: "assistant", content: "..."|null, tool_calls: [{id, type:"function", function:{name, arguments}}] }
//   { role: "tool", tool_call_id, name, content: "..." }

import { readFileSync } from 'node:fs';
import * as chromeSkills from '../../../src/chrome/src/agent/skills.js';
import * as firefoxSkills from '../../../src/firefox/src/agent/skills.js';

import {
  SYSTEM_PROMPT_ACT as CHROME_SYSTEM_PROMPT_ACT,
  SYSTEM_PROMPT_ACT_MID as CHROME_SYSTEM_PROMPT_ACT_MID,
  SYSTEM_PROMPT_ACT_COMPACT as CHROME_SYSTEM_PROMPT_ACT_COMPACT,
  SYSTEM_PROMPT_DEV_APPENDIX as CHROME_SYSTEM_PROMPT_DEV_APPENDIX,
  SYSTEM_PROMPT_ASK as CHROME_SYSTEM_PROMPT_ASK,
  SYSTEM_PROMPT_BATCHING as CHROME_SYSTEM_PROMPT_BATCHING,
  getToolsForMode as chromeGetToolsForMode,
} from '../../../src/chrome/src/agent/tools.js';
import {
  UNIVERSAL_PREAMBLE as CHROME_UNIVERSAL_PREAMBLE,
} from '../../../src/chrome/src/agent/adapters.js';
import {
  SYSTEM_PROMPT_ACT as FIREFOX_SYSTEM_PROMPT_ACT,
  SYSTEM_PROMPT_ACT_MID as FIREFOX_SYSTEM_PROMPT_ACT_MID,
  SYSTEM_PROMPT_ACT_COMPACT as FIREFOX_SYSTEM_PROMPT_ACT_COMPACT,
  SYSTEM_PROMPT_DEV_APPENDIX as FIREFOX_SYSTEM_PROMPT_DEV_APPENDIX,
  SYSTEM_PROMPT_ASK as FIREFOX_SYSTEM_PROMPT_ASK,
  SYSTEM_PROMPT_BATCHING as FIREFOX_SYSTEM_PROMPT_BATCHING,
  getToolsForMode as firefoxGetToolsForMode,
} from '../../../src/firefox/src/agent/tools.js';
import {
  UNIVERSAL_PREAMBLE as FIREFOX_UNIVERSAL_PREAMBLE,
} from '../../../src/firefox/src/agent/adapters.js';
// Freeze + mode/tier helpers live in build-payload.mjs so both runners share
// one baseline loaded once per process.
import {
  assertRunnableModeTier,
  getFrozenSnapshot,
  getSystemPromptForMode,
  normalizeMode,
  normalizeTier,
} from './build-payload.mjs';

const BROWSERS = {
  chrome: {
    SYSTEM_PROMPT_ACT: CHROME_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ACT_MID: CHROME_SYSTEM_PROMPT_ACT_MID,
    SYSTEM_PROMPT_ACT_COMPACT: CHROME_SYSTEM_PROMPT_ACT_COMPACT,
    SYSTEM_PROMPT_DEV_APPENDIX: CHROME_SYSTEM_PROMPT_DEV_APPENDIX,
    SYSTEM_PROMPT_ASK: CHROME_SYSTEM_PROMPT_ASK,
    SYSTEM_PROMPT_BATCHING: CHROME_SYSTEM_PROMPT_BATCHING,
    UNIVERSAL_PREAMBLE: CHROME_UNIVERSAL_PREAMBLE,
    getToolsForMode: chromeGetToolsForMode,
  },
  firefox: {
    SYSTEM_PROMPT_ACT: FIREFOX_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ACT_MID: FIREFOX_SYSTEM_PROMPT_ACT_MID,
    SYSTEM_PROMPT_ACT_COMPACT: FIREFOX_SYSTEM_PROMPT_ACT_COMPACT,
    SYSTEM_PROMPT_DEV_APPENDIX: FIREFOX_SYSTEM_PROMPT_DEV_APPENDIX,
    SYSTEM_PROMPT_ASK: FIREFOX_SYSTEM_PROMPT_ASK,
    SYSTEM_PROMPT_BATCHING: FIREFOX_SYSTEM_PROMPT_BATCHING,
    UNIVERSAL_PREAMBLE: FIREFOX_UNIVERSAL_PREAMBLE,
    getToolsForMode: firefoxGetToolsForMode,
  },
};

function pick(browser) {
  const key = browser || 'chrome';
  const b = BROWSERS[key];
  if (!b) throw new Error(`Unknown browser: ${browser} (expected chrome|firefox)`);
  return b;
}

// ── Ablation helpers (for opts.unprotected) ─────────────────────────────────
// Strip the <untrusted_page_content id="…">…</…> wrapper from a seed message,
// leaving the raw page bytes the model would see with NO quarantine.
function unwrapUntrusted(content) {
  if (typeof content !== 'string') return content;
  return content.replace(
    /<untrusted_page_content\b[^>]*>\n?([\s\S]*?)\n?<\/untrusted_page_content\b[^>]*>/g,
    '$1',
  );
}

// Remove the prompt-level defense: the dedicated "UNTRUSTED PAGE CONTENT" block
// (ACT/ASK/MID — a blank-line-delimited paragraph) and the inline COMPACT
// security bullet. With this AND the wrapper removed, the only thing that could
// protect the model is its own training — so the run isolates the defense.
function stripUntrustedInstructions(prompt) {
  const kept = prompt.split('\n\n').filter((block) => !/^\s*UNTRUSTED PAGE CONTENT/i.test(block));
  return kept.join('\n\n')
    .split('\n').filter((line) => !/^\s*\d+\.\s*SECURITY:.*untrusted/i.test(line)).join('\n');
}

/**
 * @param {object} scenario - { id, mode, browser, tab, seed, expected }
 * @param {object} opts     - { useSiteAdapters?: boolean, strictSecretMode?: boolean,
 *                              tier?: 'full'|'mid'|'compact', unprotected?: boolean,
 *                              researchEscalationEnabled?: boolean }
 *   unprotected: ABLATION — strip BOTH the untrusted-content wrapper from the
 *   seed AND the untrusted-content instructions from the system prompt.
 * @returns {{ messages: Array, tools: Array }}
 */
export function buildScenarioPayload(scenario, opts = {}) {
  const browser = pick(scenario.browser);
  const mode = normalizeMode(scenario.mode);
  const tier = normalizeTier(opts.tier);
  const useSiteAdapters = opts.useSiteAdapters !== false;
  const strictSecretMode = opts.strictSecretMode ?? (scenario.strictSecretMode === true);
  const unprotected = !!opts.unprotected;

  // Freeze preserves both the captured prompt and its tool surface verbatim.
  const FROZEN = getFrozenSnapshot();
  if (!FROZEN) assertRunnableModeTier(mode, tier);

  // Fixture-owned enabled/active IDs reproduce on-demand package loading. Never
  // infer activation from seed/tool text; Compact uses the production exclusion.
  let skillLoaderTool;
  let skillsPrompt = '';
  if (!FROZEN && scenario.packagedSkillIds?.length) {
    const skills = scenario.browser === 'firefox' ? firefoxSkills : chromeSkills;
    const enabled = scenario.packagedSkillIds.map(id => {
      const source = skills.PACKAGED_SKILL_SOURCES.find(s => s.id === id);
      if (!source) throw new Error(`Unknown packaged scenario skill: ${id}`);
      return { id, name: source.name, sourceType: 'built-in', sourceUrl: source.path,
        content: readFileSync(new URL(`../../../src/${scenario.browser || 'chrome'}/${source.path}`, import.meta.url), 'utf8') };
    });
    const context = { mode, tier, activeSkillIds: scenario.activeSkillIds || [] };
    skillLoaderTool = skills.buildSkillLoaderDefinition(enabled, context);
    const loaded = skills.buildCustomSkillsPrompt(enabled, context);
    if (loaded) skillsPrompt = loaded;
  }

  const tools = FROZEN
    ? FROZEN.tools
    : browser.getToolsForMode(mode, {
      strictSecretMode,
      tier,
      skillLoaderTool,
      researchEscalationEnabled: opts.researchEscalationEnabled === true,
    });

  let systemContent = FROZEN
    ? FROZEN.systemContent
    : getSystemPromptForMode(browser, mode, tier, tools);
  if (!FROZEN) {
    if (useSiteAdapters) systemContent += `\n\n${browser.UNIVERSAL_PREAMBLE.trim()}`;
    if (skillsPrompt) systemContent += `\n\n${skillsPrompt}`;
  }

  // ABLATION: remove both layers of injection defense.
  let seed = scenario.seed;
  if (unprotected) {
    systemContent = stripUntrustedInstructions(systemContent);
    seed = scenario.seed.map((m) =>
      m.role === 'tool' && typeof m.content === 'string'
        ? { ...m, content: unwrapUntrusted(m.content) }
        : m,
    );
  }

  return {
    messages: [
      { role: 'system', content: systemContent },
      ...seed,
    ],
    tools,
  };
}

export { BROWSERS };
