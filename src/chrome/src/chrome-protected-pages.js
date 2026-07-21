const CHROME_WEB_STORE_DASHBOARD_RE = /^https:\/\/chrome\.google\.com\/webstore\/devconsole(?:[/?#]|$)/i;
const PROTECTED_DOM_TOOLS = new Set([
  'list_webmcp_tools', 'execute_webmcp_tool',
  'inject_css', 'remove_injected_css', 'execute_js', 'read_console',
  'inspect_network_requests', 'inspect_event_listeners',
  'verify_form', 'get_shadow_dom', 'shadow_dom_query', 'get_frames',
  'iframe_read', 'iframe_click', 'iframe_type', 'upload_file',
  'download_resource_from_page',
  'read_page', 'get_interactive_elements', 'get_accessibility_tree',
  'click_ax', 'set_checked', 'type_ax', 'set_field', 'click', 'type_text',
  'press_keys', 'scroll', 'extract_data', 'inspect_element_styles',
  'patch_element', 'revert_patch', 'highlight_element', 'hover', 'drag_drop',
  'wait_for_element', 'wait_for_stable', 'get_selection',
]);

export function isChromeProtectedPageDomTool(toolName) {
  return PROTECTED_DOM_TOOLS.has(String(toolName || ''));
}

export function chromeProtectedPageForUrl(url) {
  const value = String(url || '').trim();
  if (CHROME_WEB_STORE_DASHBOARD_RE.test(value)) return 'chrome-web-store-developer';
  return '';
}

export function chromeProtectedPageFailure(url, toolName = '') {
  const protectedPage = chromeProtectedPageForUrl(url);
  if (!protectedPage) return null;
  const name = String(toolName || 'DOM tool');
  return {
    success: false,
    dispatched: false,
    noDispatch: true,
    errorCode: 'chrome_protected_page',
    nonRetryable: true,
    nonRetryableScope: `chrome-protected-page:${protectedPage}`,
    protectedPage,
    url: String(url || ''),
    recoverySkill: 'chrome-web-store-release',
    recoveryTools: [
      'chrome_web_store_status',
      'chrome_web_store_upload',
      'chrome_web_store_publish',
    ],
    error: `${name} cannot access the Chrome Web Store Developer Dashboard because Chrome blocks extension content scripts and debugger attachment on this protected page. Do not retry this or another DOM tool. If the Chrome Web Store release skill is enabled, load it and use its trusted tools; otherwise ask the user to enable it in Settings → Skills. A screenshot may be used once for read-only visual context, but cannot make dashboard controls interactive.`,
    stopMessage: 'Stopped: Chrome protects the Chrome Web Store Developer Dashboard from extension DOM access. Repeating DOM reads, waits, clicks, typing, script injection, or debugger-based fallbacks cannot work. Use the enabled Chrome Web Store release skill or continue manually.',
  };
}
