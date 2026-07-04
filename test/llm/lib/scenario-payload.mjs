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
  SYSTEM_PROMPT_DEV_APPENDIX as CHROME_SYSTEM_PROMPT_DEV_APPENDIX,
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
  SYSTEM_PROMPT_DEV_APPENDIX as FIREFOX_SYSTEM_PROMPT_DEV_APPENDIX,
  SYSTEM_PROMPT_ASK as FIREFOX_SYSTEM_PROMPT_ASK,
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
    UNIVERSAL_PREAMBLE: CHROME_UNIVERSAL_PREAMBLE,
    getToolsForMode: chromeGetToolsForMode,
  },
  firefox: {
    SYSTEM_PROMPT_ACT: FIREFOX_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ACT_MID: FIREFOX_SYSTEM_PROMPT_ACT_MID,
    SYSTEM_PROMPT_ACT_COMPACT: FIREFOX_SYSTEM_PROMPT_ACT_COMPACT,
    SYSTEM_PROMPT_DEV_APPENDIX: FIREFOX_SYSTEM_PROMPT_DEV_APPENDIX,
    SYSTEM_PROMPT_ASK: FIREFOX_SYSTEM_PROMPT_ASK,
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
 *                              tier?: 'full'|'mid'|'compact', unprotected?: boolean }
 *   unprotected: ABLATION — strip BOTH the untrusted-content wrapper from the
 *   seed AND the untrusted-content instructions from the system prompt.
 * @returns {{ messages: Array, tools: Array }}
 */
export function buildScenarioPayload(scenario, opts = {}) {
  const browser = pick(scenario.browser);
  const mode = normalizeMode(scenario.mode);
  const tier = normalizeTier(opts.tier);
  const useSiteAdapters = opts.useSiteAdapters !== false;
  const strictSecretMode = !!opts.strictSecretMode;
  const unprotected = !!opts.unprotected;

  // FREEZE MODE: snapshot wins. Site adapters / tier are ignored — whatever
  // was active at capture time is what we replay. Multi-turn seeds still
  // flow through verbatim.
  const FROZEN = getFrozenSnapshot();
  let systemContent;
  if (FROZEN) {
    systemContent = FROZEN.systemContent;
  } else {
    assertRunnableModeTier(mode, tier);
    systemContent = getSystemPromptForMode(browser, mode, tier);
    if (useSiteAdapters) {
      systemContent += `\n\n${browser.UNIVERSAL_PREAMBLE.trim()}`;
    }
  }

  const tools = FROZEN
    ? FROZEN.tools
    : browser.getToolsForMode(mode, { strictSecretMode, tier });

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
