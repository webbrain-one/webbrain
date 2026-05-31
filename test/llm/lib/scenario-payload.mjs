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

import {
  SYSTEM_PROMPT_ACT as CHROME_SYSTEM_PROMPT_ACT,
  SYSTEM_PROMPT_ACT_MID as CHROME_SYSTEM_PROMPT_ACT_MID,
  SYSTEM_PROMPT_ACT_COMPACT as CHROME_SYSTEM_PROMPT_ACT_COMPACT,
  SYSTEM_PROMPT_ASK as CHROME_SYSTEM_PROMPT_ASK,
  getToolsForMode as chromeGetToolsForMode,
} from '../../../src/chrome/src/agent/tools.js';
import {
  UNIVERSAL_PREAMBLE as CHROME_UNIVERSAL_PREAMBLE,
} from '../../../src/chrome/src/agent/adapters.js';
import {
  SYSTEM_PROMPT_ACT as FIREFOX_SYSTEM_PROMPT_ACT,
  SYSTEM_PROMPT_ACT_MID as FIREFOX_SYSTEM_PROMPT_ACT_MID,
  SYSTEM_PROMPT_ACT_COMPACT as FIREFOX_SYSTEM_PROMPT_ACT_COMPACT,
  SYSTEM_PROMPT_ASK as FIREFOX_SYSTEM_PROMPT_ASK,
  getToolsForMode as firefoxGetToolsForMode,
} from '../../../src/firefox/src/agent/tools.js';
import {
  UNIVERSAL_PREAMBLE as FIREFOX_UNIVERSAL_PREAMBLE,
} from '../../../src/firefox/src/agent/adapters.js';
// Freeze + tier helpers live in build-payload.mjs so both runners share
// one baseline loaded once per process.
import { normalizeTier, getFrozenSnapshot } from './build-payload.mjs';

const BROWSERS = {
  chrome: {
    SYSTEM_PROMPT_ACT: CHROME_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ACT_MID: CHROME_SYSTEM_PROMPT_ACT_MID,
    SYSTEM_PROMPT_ACT_COMPACT: CHROME_SYSTEM_PROMPT_ACT_COMPACT,
    SYSTEM_PROMPT_ASK: CHROME_SYSTEM_PROMPT_ASK,
    UNIVERSAL_PREAMBLE: CHROME_UNIVERSAL_PREAMBLE,
    getToolsForMode: chromeGetToolsForMode,
  },
  firefox: {
    SYSTEM_PROMPT_ACT: FIREFOX_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ACT_MID: FIREFOX_SYSTEM_PROMPT_ACT_MID,
    SYSTEM_PROMPT_ACT_COMPACT: FIREFOX_SYSTEM_PROMPT_ACT_COMPACT,
    SYSTEM_PROMPT_ASK: FIREFOX_SYSTEM_PROMPT_ASK,
    UNIVERSAL_PREAMBLE: FIREFOX_UNIVERSAL_PREAMBLE,
    getToolsForMode: firefoxGetToolsForMode,
  },
};

function getActPromptForTier(browser, tier) {
  if (tier === 'compact') return browser.SYSTEM_PROMPT_ACT_COMPACT;
  if (tier === 'mid')     return browser.SYSTEM_PROMPT_ACT_MID;
  return browser.SYSTEM_PROMPT_ACT;
}

function pick(browser) {
  const key = browser || 'chrome';
  const b = BROWSERS[key];
  if (!b) throw new Error(`Unknown browser: ${browser} (expected chrome|firefox)`);
  return b;
}

/**
 * @param {object} scenario - { id, mode, browser, tab, seed, expected }
 * @param {object} opts     - { useSiteAdapters?: boolean, strictSecretMode?: boolean,
 *                              tier?: 'full'|'mid'|'compact' }
 * @returns {{ messages: Array, tools: Array }}
 */
export function buildScenarioPayload(scenario, opts = {}) {
  const browser = pick(scenario.browser);
  const mode = scenario.mode === 'ask' ? 'ask' : 'act';
  const tier = normalizeTier(opts.tier);
  const useSiteAdapters = opts.useSiteAdapters !== false;
  const strictSecretMode = !!opts.strictSecretMode;

  // FREEZE MODE: snapshot wins. Site adapters / tier are ignored — whatever
  // was active at capture time is what we replay. Multi-turn seeds still
  // flow through verbatim.
  const FROZEN = getFrozenSnapshot();
  let systemContent;
  if (FROZEN) {
    systemContent = FROZEN.systemContent;
  } else {
    systemContent = mode === 'act' ? getActPromptForTier(browser, tier) : browser.SYSTEM_PROMPT_ASK;
    if (useSiteAdapters) {
      systemContent += `\n\n${browser.UNIVERSAL_PREAMBLE.trim()}`;
    }
  }

  const tools = FROZEN
    ? FROZEN.tools
    : browser.getToolsForMode(mode, { strictSecretMode, tier });

  return {
    messages: [
      { role: 'system', content: systemContent },
      ...scenario.seed,
    ],
    tools,
  };
}

export { BROWSERS };
