// Build the exact LLM request payload WebBrain would send for a given
// (user message, tab, mode) — mirrors the selected browser agent's
// _buildSystemPrompt + _enrichUserMessageWithCurrentPage + getToolsForMode,
// minus the WebExtension-only bits (vision sub-call, screenshot capture,
// adapter re-injection across turns).
//
// We import the prompt constants and tool schemas directly from browser
// source so the payload stays in lock-step with what ships.
//
// FREEZE MODE — set the env var WB_FREEZE_BASELINE to the path of a
// snapshot JSON (see freeze/baseline-2026-05-23.json) to pin the system
// prompt and tools array to a previous run's values, regardless of what
// src/ currently exports. The per-case user message is still computed
// dynamically (URL, title, user prompt). Use this to keep "vs Sonnet"
// comparisons honest as the tool list evolves.

import { readFileSync, existsSync } from 'node:fs';

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
  getActiveAdapter as chromeGetActiveAdapter,
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
  getActiveAdapter as firefoxGetActiveAdapter,
} from '../../../src/firefox/src/agent/adapters.js';

export const TIERS = ['full', 'mid', 'compact'];
export const DEFAULT_TIER = 'full';
export const MODES = ['ask', 'act', 'dev'];
export const DEFAULT_MODE = 'act';

export function normalizeTier(tier) {
  const key = (tier || DEFAULT_TIER).toLowerCase();
  if (!TIERS.includes(key)) {
    throw new Error(`Bad tier: ${tier}. Expected one of ${TIERS.join(', ')}.`);
  }
  return key;
}

export function normalizeMode(mode) {
  const key = (mode || DEFAULT_MODE).toLowerCase();
  if (!MODES.includes(key)) {
    throw new Error(`Bad mode: ${mode}. Expected one of ${MODES.join(', ')}.`);
  }
  return key;
}

export function isActionMode(mode) {
  const key = normalizeMode(mode);
  return key === 'act' || key === 'dev';
}

export function assertRunnableModeTier(mode, tier) {
  if (mode === 'dev' && tier === 'compact') {
    throw new Error('Dev mode requires a Mid or Full prompt tier; Compact-tier Dev is blocked.');
  }
}

export const DEFAULT_BROWSER = 'chrome';
export const BROWSERS = {
  chrome: {
    SYSTEM_PROMPT_ACT: CHROME_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ACT_MID: CHROME_SYSTEM_PROMPT_ACT_MID,
    SYSTEM_PROMPT_ACT_COMPACT: CHROME_SYSTEM_PROMPT_ACT_COMPACT,
    SYSTEM_PROMPT_DEV_APPENDIX: CHROME_SYSTEM_PROMPT_DEV_APPENDIX,
    SYSTEM_PROMPT_ASK: CHROME_SYSTEM_PROMPT_ASK,
    UNIVERSAL_PREAMBLE: CHROME_UNIVERSAL_PREAMBLE,
    getActiveAdapter: chromeGetActiveAdapter,
    getToolsForMode: chromeGetToolsForMode,
  },
  firefox: {
    SYSTEM_PROMPT_ACT: FIREFOX_SYSTEM_PROMPT_ACT,
    SYSTEM_PROMPT_ACT_MID: FIREFOX_SYSTEM_PROMPT_ACT_MID,
    SYSTEM_PROMPT_ACT_COMPACT: FIREFOX_SYSTEM_PROMPT_ACT_COMPACT,
    SYSTEM_PROMPT_DEV_APPENDIX: FIREFOX_SYSTEM_PROMPT_DEV_APPENDIX,
    SYSTEM_PROMPT_ASK: FIREFOX_SYSTEM_PROMPT_ASK,
    UNIVERSAL_PREAMBLE: FIREFOX_UNIVERSAL_PREAMBLE,
    getActiveAdapter: firefoxGetActiveAdapter,
    getToolsForMode: firefoxGetToolsForMode,
  },
};

// Pick the right ACT system prompt for a tier. Ask mode has no tier
// variants (only one ASK prompt exists), so tier is ignored there.
function getActPromptForTier(browser, tier) {
  if (tier === 'compact') return browser.SYSTEM_PROMPT_ACT_COMPACT;
  if (tier === 'mid')     return browser.SYSTEM_PROMPT_ACT_MID;
  return browser.SYSTEM_PROMPT_ACT;
}

export function getSystemPromptForMode(browser, mode, tier) {
  if (mode === 'ask') return browser.SYSTEM_PROMPT_ASK;
  let prompt = getActPromptForTier(browser, tier);
  if (mode === 'dev') {
    prompt += `\n\n${browser.SYSTEM_PROMPT_DEV_APPENDIX.trim()}`;
  }
  return prompt;
}

export function normalizeBrowser(browser) {
  const key = browser || DEFAULT_BROWSER;
  if (!BROWSERS[key]) {
    throw new Error(`Bad browser: ${browser}. Expected chrome or firefox.`);
  }
  return key;
}

// ── frozen-baseline loader ───────────────────────────────────────────
// Loaded either at module init (via env var) OR lazily before buildPayload
// is called (via loadFrozenBaseline). The lazy path matters because runners
// parse CLI args AFTER they import this module, and ES module imports are
// hoisted — so a --freeze flag set on argv would otherwise be too late.
let FROZEN_BASELINE = null;

export function loadFrozenBaseline(path) {
  if (!path) { FROZEN_BASELINE = null; return null; }
  if (!existsSync(path)) {
    throw new Error(`Frozen baseline path missing: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed?.systemContent || !Array.isArray(parsed?.tools)) {
    throw new Error(`Frozen baseline lacks systemContent or tools[]: ${path}`);
  }
  FROZEN_BASELINE = parsed;
  console.error(
    `▸ FROZEN baseline loaded: ${path}\n` +
    `  source: ${parsed.meta?.sourceRun || '(unknown)'} @ ${parsed.meta?.runTag || '(no tag)'}\n` +
    `  tools=${parsed.tools.length}, systemBytes=${parsed.systemContent.length}, systemHash=${(parsed.meta?.systemHash || '').slice(0,16)}…`
  );
  return parsed;
}

// Env-var path: works for plain `WB_FREEZE_BASELINE=... node ...` invocations
// without any CLI flag.
const FREEZE_PATH_FROM_ENV = process.env.WB_FREEZE_BASELINE || '';
if (FREEZE_PATH_FROM_ENV) loadFrozenBaseline(FREEZE_PATH_FROM_ENV);

export function isFrozen() { return !!FROZEN_BASELINE; }
export function getFrozenMeta() { return FROZEN_BASELINE?.meta || null; }
// Full snapshot accessor — used by scenario-payload.mjs so both runners
// share the same singleton baseline, loaded once per process.
export function getFrozenSnapshot() { return FROZEN_BASELINE; }

/**
 * @param {object} caseRec - { id?, mode: 'act'|'ask'|'dev', tab: {url, title}, user }
 * @param {object} opts    - { useSiteAdapters?: boolean, strictSecretMode?: boolean,
 *                             profile?: {enabled, text}, captchaSolver?: boolean,
 *                             browser?: 'chrome'|'firefox',
 *                             tier?: 'full'|'mid'|'compact'   // ACT-mode prompt+tools tier
 *                           }
 * @returns {{ messages: Array, tools: Array }}
 */
export function buildPayload(caseRec, opts = {}) {
  const browser = BROWSERS[normalizeBrowser(opts.browser)];
  const mode = normalizeMode(caseRec.mode);
  const tier = normalizeTier(opts.tier);
  const url = caseRec.tab?.url || '';
  const title = caseRec.tab?.title || '';
  const useSiteAdapters = opts.useSiteAdapters !== false;
  const strictSecretMode = !!opts.strictSecretMode;

  // ── system message ───────────────────────────────────────────────────
  // FREEZE MODE: skip ALL system-prompt assembly (incl. adapters, profile,
  // captcha) and use the snapshot verbatim. Whatever site-adapter/profile
  // text was baked into the baseline at capture time is what runs.
  // NOTE: freeze takes precedence over tier — the snapshot's tier is whatever
  // tier was active when the baseline was captured.
  let systemContent;
  if (FROZEN_BASELINE) {
    systemContent = FROZEN_BASELINE.systemContent;
  } else {
    assertRunnableModeTier(mode, tier);
    // ACT and DEV modes honor tier (full / mid / compact). ASK mode has one prompt.
    systemContent = getSystemPromptForMode(browser, mode, tier);
    if (useSiteAdapters) {
      systemContent += `\n\n${browser.UNIVERSAL_PREAMBLE.trim()}`;
    }
    if (opts.profile?.enabled && opts.profile?.text?.trim()) {
      systemContent +=
        `\n\n[User profile — use these details when a form or signup needs them, INSTEAD of asking the user. The user has opted in to sharing this with you. Do NOT volunteer these details on pages that don't need them, and NEVER reveal the password in chat output or screenshots. Treat it as sensitive.]\n` +
        opts.profile.text.trim();
    }
  }
  if (opts.captchaSolver && !FROZEN_BASELINE) {
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
  // FREEZE MODE: use the snapshot's tools verbatim. The strictSecretMode,
  // tier, and mode options have no effect on a frozen baseline by design.
  const tools = FROZEN_BASELINE
    ? FROZEN_BASELINE.tools
    : browser.getToolsForMode(mode, { strictSecretMode, tier });

  return {
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
    tools,
  };
}
