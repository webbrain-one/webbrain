import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getToolsForMode,
  ASK_ONLY_TOOLS,
  COMPACT_TOOL_NAMES,
  SYSTEM_PROMPT_ASK,
  SYSTEM_PROMPT_ACT_COMPACT,
} from '../../src/chrome/src/agent/tools.js';
import { calculateExpression } from '../../src/chrome/src/agent/calculator.js';
import { parseToolCallsFromText } from '../../src/chrome/src/agent/tool-call-parser.js';
import {
  sanitizeText,
  repairAssistantDisplayText,
  repairDoubleEscapedAssistantText,
} from '../../src/chrome/src/agent/text-sanitize.js';
import {
  getActiveAdapter,
  UNIVERSAL_PREAMBLE,
} from '../../src/chrome/src/agent/adapters.js';
import {
  highlightCode,
  escapeCodeHtml,
  renderMarkdownBlockquotes,
  renderMarkdownHeadings,
  renderMarkdownTables,
  createMarkdownPlaceholders,
} from '../../src/chrome/src/ui/markdown-render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The embed/ package. */
export const PROJECT_ROOT = path.resolve(__dirname, '..');
/** The WebBrain repository root: the widget reuses the extension's own code. */
export const REPO_ROOT = path.resolve(PROJECT_ROOT, '..');
export const EXTENSION_ROOT = path.resolve(REPO_ROOT, 'src/chrome');

export const EXTENSION_PATHS = Object.freeze({
  accessibilityTree: path.resolve(EXTENSION_ROOT, 'src/content/accessibility-tree.js'),
  contentScript: path.resolve(EXTENSION_ROOT, 'src/content/content.js'),
  visualIndicator: path.resolve(EXTENSION_ROOT, 'src/content/agent-visual-indicator.js'),
  activityBrain: path.resolve(EXTENSION_ROOT, 'src/ui/activity-brain.js'),
  markdownRender: path.resolve(EXTENSION_ROOT, 'src/ui/markdown-render.js'),
  calculator: path.resolve(EXTENSION_ROOT, 'src/agent/calculator.js'),
  readPageWindow: path.resolve(EXTENSION_ROOT, 'src/agent/read-page-window.js'),
  credentialFields: path.resolve(EXTENSION_ROOT, 'src/agent/credential-fields.js'),
  icon128: path.resolve(EXTENSION_ROOT, 'icons/icon128.png'),
  icon48: path.resolve(EXTENSION_ROOT, 'icons/icon48.png'),
});

/**
 * Tools supported inside the embedded in-page website runtime.
 * Strips extension-only capabilities (downloads, file picker uploads, CDP screenshots,
 * MemCode cloud recall) while keeping all DOM reading, AX tree, calculation, and
 * in-page interaction tools from the WebBrain extension.
 */
export const EMBED_ASK_ALLOWED_TOOLS = new Set([
  'calculate',
  'get_accessibility_tree',
  'read_page',
  'get_window_info',
  'get_interactive_elements',
  'scroll',
  'extract_data',
  'wait_for_stable',
  'get_selection',
  'done',
]);

export const EMBED_ACT_ALLOWED_TOOLS = new Set([
  ...EMBED_ASK_ALLOWED_TOOLS,
  'click_ax',
  'set_checked',
  'type_ax',
  'set_field',
  'click',
  'type_text',
  'press_keys',
  'navigate',
  'wait_for_element',
  'find_text',
  'scratchpad_write',
]);

/**
 * Returns the filtered OpenAI function-calling tool definitions directly from
 * the WebBrain extension's `getToolsForMode`.
 */
export function getEmbedToolsForMode(mode = 'ask') {
  const normalizedMode = mode === 'act' ? 'act' : 'ask';
  const upstreamTools = getToolsForMode(normalizedMode, {
    tier: 'compact',
    browserBatchEnabled: false,
    researchEscalationEnabled: false,
    imageGenConfigured: false,
    webMcpAvailable: false,
    carouselNavigation: false,
    gmailResultCounting: false,
  });
  const allowSet = normalizedMode === 'act' ? EMBED_ACT_ALLOWED_TOOLS : EMBED_ASK_ALLOWED_TOOLS;
  return upstreamTools.filter((tool) => allowSet.has(tool?.function?.name));
}

/**
 * Builds the system prompt for an embedded website session using the WebBrain extension's
 * system prompts, universal preamble, site adapters, and dashboard site settings.
 */
export function buildEmbedSystemPrompt(mode = 'ask', siteConfig = {}, pageUrl = '') {
  const normalizedMode = mode === 'act' ? 'act' : 'ask';
  const basePrompt = normalizedMode === 'act' ? SYSTEM_PROMPT_ACT_COMPACT : SYSTEM_PROMPT_ASK;

  const parts = [
    basePrompt,
    UNIVERSAL_PREAMBLE,
    `EMBEDDED WEBSITE CONTEXT (WebBrain for Websites):
- You are embedded directly on "${ sanitizeText(siteConfig.name || siteConfig.domain || 'this website', 120, { collapseWhitespace: true }) }" (${ sanitizeText(siteConfig.domain || pageUrl || '', 200, { collapseWhitespace: true }) }).
- Mode policy for this site: ${ siteConfig.modePolicy === 'ask_and_act' ? 'Ask + Act enabled' : 'Ask mode only (read-only)' }. Active turn mode: ${ normalizedMode.toUpperCase() }.
- Do not mention browser extension settings, slash commands (/record, /screenshot, /schedule), or switching providers. You are the built-in AI assistant for this website.
- IMPORTANT: When INITIAL VISIBLE PAGE ACCESSIBILITY TREE SNAPSHOT is provided below, you ALREADY have the current page's content and [ref_N] elements. In Ask mode, answer directly from that snapshot (calling \`calculate\` if exact math is needed) instead of redundantly calling \`get_accessibility_tree\` or \`read_page\` first.
- Be concise, accurate, and directly helpful to the website visitor. Ground every claim in the observed accessibility tree or page text.`,
  ];

  if (pageUrl) {
    try {
      const adapter = getActiveAdapter(pageUrl);
      const notes = String(adapter?.notes || '').trim();
      if (notes) {
        parts.push(`SITE ADAPTER NOTES (${adapter.name || adapter.id || 'matched'}):\n${notes}`);
      }
    } catch {
      // Ignore adapter lookup errors on synthetic URLs
    }
  }

  if (siteConfig.customInstructions && String(siteConfig.customInstructions).trim()) {
    parts.push(`WEBSITE OWNER INSTRUCTIONS:\n${sanitizeText(siteConfig.customInstructions, 2000)}`);
  }

  return parts.filter(Boolean).join('\n\n');
}

export {
  getToolsForMode,
  ASK_ONLY_TOOLS,
  COMPACT_TOOL_NAMES,
  SYSTEM_PROMPT_ASK,
  SYSTEM_PROMPT_ACT_COMPACT,
  calculateExpression,
  parseToolCallsFromText,
  sanitizeText,
  repairAssistantDisplayText,
  repairDoubleEscapedAssistantText,
  getActiveAdapter,
  UNIVERSAL_PREAMBLE,
  highlightCode,
  escapeCodeHtml,
  renderMarkdownBlockquotes,
  renderMarkdownHeadings,
  renderMarkdownTables,
  createMarkdownPlaceholders,
};
