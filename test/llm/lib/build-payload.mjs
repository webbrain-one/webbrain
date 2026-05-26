// Build the exact LLM request payload WebBrain would send for a given
// (user message, tab, mode) — mirrors the selected browser agent's
// _buildSystemPrompt + _enrichUserMessageWithCurrentPage + getToolsForMode,
// minus the WebExtension-only bits (vision sub-call, screenshot capture,
// adapter re-injection across turns).
//
// We import the prompt constants and tool schemas directly from browser
// source so the payload stays in lock-step with what ships.

import {
  SYSTEM_PROMPT_ACT as CHROME_SYSTEM_PROMPT_ACT,
  SYSTEM_PROMPT_ASK as CHROME_SYSTEM_PROMPT_ASK,
  getToolsForMode as chromeGetToolsForMode,
} from '../../../src/chrome/src/agent/tools.js';
import {
  UNIVERSAL_PREAMBLE as CHROME_UNIVERSAL_PREAMBLE,
  getActiveAdapter as chromeGetActiveAdapter,
} from '../../../src/chrome/src/agent/adapters.js';
import {
  SYSTEM_PROMPT_ACT as FIREFOX_SYSTEM_PROMPT_ACT,
  SYSTEM_PROMPT_ASK as FIREFOX_SYSTEM_PROMPT_ASK,
  getToolsForMode as firefoxGetToolsForMode,
} from '../../../src/firefox/src/agent/tools.js';
import {
  UNIVERSAL_PREAMBLE as FIREFOX_UNIVERSAL_PREAMBLE,
  getActiveAdapter as firefoxGetActiveAdapter,
} from '../../../src/firefox/src/agent/adapters.js';

export const DEFAULT_BROWSER = 'chrome';
export const BROWSERS = {
  chrome: {
    SYSTEM_PROMPT_ACT: CHROME_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ASK: CHROME_SYSTEM_PROMPT_ASK,
    UNIVERSAL_PREAMBLE: CHROME_UNIVERSAL_PREAMBLE,
    getActiveAdapter: chromeGetActiveAdapter,
    getToolsForMode: chromeGetToolsForMode,
  },
  firefox: {
    SYSTEM_PROMPT_ACT: FIREFOX_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ASK: FIREFOX_SYSTEM_PROMPT_ASK,
    UNIVERSAL_PREAMBLE: FIREFOX_UNIVERSAL_PREAMBLE,
    getActiveAdapter: firefoxGetActiveAdapter,
    getToolsForMode: firefoxGetToolsForMode,
  },
};

export function normalizeBrowser(browser) {
  const key = browser || DEFAULT_BROWSER;
  if (!BROWSERS[key]) {
    throw new Error(`Bad browser: ${browser}. Expected chrome or firefox.`);
  }
  return key;
}

/**
 * @param {object} caseRec - { id?, mode: 'act'|'ask', tab: {url, title}, user }
 * @param {object} opts    - { useSiteAdapters?: boolean, strictSecretMode?: boolean,
 *                             profile?: {enabled, text}, captchaSolver?: boolean,
 *                             browser?: 'chrome'|'firefox' }
 * @returns {{ messages: Array, tools: Array }}
 */
export function buildPayload(caseRec, opts = {}) {
  const browser = BROWSERS[normalizeBrowser(opts.browser)];
  const mode = caseRec.mode === 'ask' ? 'ask' : 'act';
  const url = caseRec.tab?.url || '';
  const title = caseRec.tab?.title || '';
  const useSiteAdapters = opts.useSiteAdapters !== false;
  const strictSecretMode = !!opts.strictSecretMode;

  // ── system message ───────────────────────────────────────────────────
  let systemContent = mode === 'act' ? browser.SYSTEM_PROMPT_ACT : browser.SYSTEM_PROMPT_ASK;
  if (useSiteAdapters) {
    systemContent += `\n\n${browser.UNIVERSAL_PREAMBLE.trim()}`;
  }
  if (opts.profile?.enabled && opts.profile?.text?.trim()) {
    systemContent +=
      `\n\n[User profile — use these details when a form or signup needs them, INSTEAD of asking the user. The user has opted in to sharing this with you. Do NOT volunteer these details on pages that don't need them, and NEVER reveal the password in chat output or screenshots. Treat it as sensitive.]\n` +
      opts.profile.text.trim();
  }
  if (opts.captchaSolver) {
    systemContent += `\n\n[CAPTCHA SOLVER — the user has configured CapSolver. When a CAPTCHA blocks a step, call \`solve_captcha\` once (with no arguments — it auto-detects reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile). On success, click the form's submit button and continue. On failure, ask the user to solve it manually — do not retry solve_captcha repeatedly.]`;
  }

  // ── user message (enriched with per-turn context) ────────────────────
  let contextLine = url
    ? `[Current page context — applies to this user message and supersedes older page context for phrases like "this page". URL: ${url}${title ? ` — Title: ${title}` : ''}]\n\n`
    : '';

  if (useSiteAdapters && url) {
    const adapter = browser.getActiveAdapter(url);
    if (adapter) {
      const heading = adapter.category === 'finance'
        ? `[Site guidance for ${adapter.name} — FINANCE / HIGH-STAKES]`
        : `[Site guidance for ${adapter.name}]`;
      contextLine += `${heading}\n${adapter.notes.trim()}\n\n`;
    }
  }

  const userContent = contextLine + caseRec.user;

  // ── tools ────────────────────────────────────────────────────────────
  const tools = browser.getToolsForMode(mode, { strictSecretMode });

  return {
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
    tools,
  };
}
