/**
 * The Firefox build's mutating-tool surface, in a browser-free module so the
 * Agent and the unit suite classify tools from one list instead of two.
 *
 * This file is deliberately NOT mirrored byte-for-byte with the Chrome copy:
 * the two builds ship different tool sets, and that difference is exactly what
 * the loop detector must see. Keep the shared, browser-neutral detection logic
 * in loop-detector.js, which IS byte-identical across builds.
 */

/** Tools that change page or browser state, gating auto-screenshots and
 *  unknown-outcome normalization as well as loop detection. */
export const STATE_CHANGE_TOOLS = new Set(['navigate', 'gmail_count_results', 'carousel_navigate', 'promote_iframe', 'delegate_research', 'go_back', 'go_forward', 'click', 'click_ax', 'set_checked', 'iframe_click', 'type_text', 'type_ax', 'set_field', 'iframe_type', 'press_keys', 'scroll', 'hover', 'drag_drop', 'execute_js', 'chat_send']);

/**
 * Everything the failed-action loop counters treat as a browser mutation.
 * Adds the remaining upload- and challenge-scoped tools that act on the page but are not
 * part of the auto-screenshot state-change set.
 */
export const BROWSER_MUTATION_TOOLS = new Set([
  ...STATE_CHANGE_TOOLS,
  'upload_file',
  'solve_captcha',
]);
