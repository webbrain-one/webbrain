import {
  getEmbedToolsForMode,
  SYSTEM_PROMPT_ASK,
  SYSTEM_PROMPT_ACT_COMPACT,
  UNIVERSAL_PREAMBLE,
} from './webbrain.js';

/**
 * The agent specification a server needs to drive the widget: the system
 * prompts and the tool definitions for Ask and Act mode, taken from the
 * extension so both always agree. Published as `tools.json` with each release.
 */
export function buildAgentSpec() {
  const ask = getEmbedToolsForMode('ask');
  const act = getEmbedToolsForMode('act');
  return {
    version: 1,
    prompts: {
      ask: SYSTEM_PROMPT_ASK,
      act: SYSTEM_PROMPT_ACT_COMPACT,
      universalPreamble: UNIVERSAL_PREAMBLE,
    },
    tools: { ask, act },
    askToolNames: ask.map((tool) => tool.function.name),
    actToolNames: act.map((tool) => tool.function.name),
  };
}
