/**
 * WebBrain Side Panel — Chat UI logic.
 * Default: human-friendly compact output. Verbose mode: full tool debug.
 */

import { t, getLocale, setLocale, LANGUAGES, applyDOMTranslations } from './i18n.js';
import { sanitizeMarkdownLinks } from './markdown-link.js';

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('user-input');
const sendBtn = document.getElementById('btn-send');
const clearBtn = document.getElementById('btn-clear');
const settingsBtn = document.getElementById('btn-settings');
const verboseBtn = document.getElementById('btn-verbose');
const providerSelect = document.getElementById('provider-select');
const statusDot = document.getElementById('status-dot');
const agentActivity = document.getElementById('agent-activity');
const activityText = document.getElementById('activity-text');
const modeAskBtn = document.getElementById('btn-mode-ask');
const modeActBtn = document.getElementById('btn-mode-act');
const actWarning = document.getElementById('act-warning');
const inputArea = document.getElementById('input-area');
const stopBtn = document.getElementById('btn-stop');

let currentTabId = null;
let isProcessing = false;
let currentAssistantEl = null;
let verboseMode = false;
let agentMode = 'ask'; // 'ask' or 'act'
let abortRequested = false;

// Per-tab chat history (stores innerHTML of messages container)
const tabChats = new Map();

// Tool names → i18n key for the human-friendly label. Resolved at render
// time so language changes take effect without a reload.
const TOOL_KEYS = {
  read_page: 'tool.read_page',
  get_interactive_elements: 'tool.get_interactive_elements',
  click: 'tool.click',
  type_text: 'tool.type_text',
  scroll: 'tool.scroll',
  navigate: 'tool.navigate',
  extract_data: 'tool.extract_data',
  wait_for_element: 'tool.wait_for_element',
  get_selection: 'tool.get_selection',
  execute_js: 'tool.execute_js',
  new_tab: 'tool.new_tab',
  screenshot: 'tool.screenshot',
  done: 'tool.done',
};

function friendlyToolLabel(name, args) {
  // Add context from args where it makes sense
  if (name === 'click' && args?.selector) return t('tool.click.selector', { selector: truncate(args.selector, 30) });
  if (name === 'click' && args?.index != null) return t('tool.click.index', { index: args.index });
  if (name === 'type_text' && args?.text) return t('tool.type_text.text', { text: truncate(args.text, 25) });
  if (name === 'navigate' && args?.url) return t('tool.navigate.url', { url: truncate(args.url, 35) });
  if (name === 'new_tab' && args?.url) return t('tool.new_tab.url', { url: truncate(args.url, 35) });
  if (name === 'scroll') return t('tool.scroll.direction', { direction: args?.direction || 'down' });
  if (name === 'extract_data') return t('tool.extract_data.type', { type: args?.type || 'data' });
  if (name === 'wait_for_element' && args?.selector) return t('tool.wait_for_element.selector', { selector: truncate(args.selector, 30) });
  const key = TOOL_KEYS[name];
  return key ? t(key) : name;
}


// --- Initialization ---

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  // Load verbose setting
  const stored = await browser.storage.local.get('verboseMode');
  verboseMode = stored.verboseMode || false;

  await loadProviders();
  await testConnection();

  browser.tabs.onActivated.addListener(async (info) => {
    switchToTab(info.tabId);
  });

  // Listen for setting changes (from options page)
  if (verboseBtn) verboseBtn.classList.toggle('active', verboseMode);

  browser.storage.onChanged.addListener((changes) => {
    if (changes.verboseMode) {
      verboseMode = changes.verboseMode.newValue;
      if (verboseBtn) verboseBtn.classList.toggle('active', verboseMode);
    }
  });
}

if (verboseBtn) {
  verboseBtn.addEventListener('click', async (e) => {
    // Shift+click → dump deep debug log to DevTools console (hidden feature)
    if (e.shiftKey) {
      try {
        const response = await sendToBackground('get_debug_log');
        if (response?.log?.length) {
          console.group('%c[WebBrain Deep Verbose] %d entries', 'color:#7c3aed;font-weight:bold', response.log.length);
          for (const entry of response.log) {
            const label = entry.type || 'unknown';
            const ts = entry.timestamp || '';
            if (label.includes('request')) {
              console.groupCollapsed(`%c→ ${label} %c[step ${entry.step}] ${ts}`, 'color:#2563eb;font-weight:bold', 'color:#6b7280');
              console.log('Provider:', entry.provider);
              console.log('Messages:', entry.messages);
              console.log('Options:', entry.options);
              console.groupEnd();
            } else if (label.includes('response')) {
              console.groupCollapsed(`%c← ${label} %c[step ${entry.step}] ${ts}`, 'color:#059669;font-weight:bold', 'color:#6b7280');
              console.log('Content:', entry.content);
              console.log('Tool calls:', entry.toolCalls);
              console.groupEnd();
            } else if (label.includes('error')) {
              console.log(`%c✗ ${label} [step ${entry.step}] ${ts}: %c${entry.error}`, 'color:#dc2626;font-weight:bold', 'color:#dc2626');
            } else {
              console.log(`${label} [step ${entry.step}] ${ts}`, entry);
            }
          }
          console.groupEnd();
        } else {
          console.log('%c[WebBrain Deep Verbose] No entries yet — run a query first.', 'color:#7c3aed');
        }
      } catch (err) {
        console.error('[WebBrain Deep Verbose] Failed to fetch debug log:', err);
      }
      return; // don't toggle verbose mode
    }

    // Normal click → toggle verbose mode
    verboseMode = !verboseMode;
    verboseBtn.classList.toggle('active', verboseMode);
    browser.storage.local.set({ verboseMode }).catch(() => {});
  });
}

function switchToTab(newTabId) {
  if (newTabId === currentTabId) return;
  if (isProcessing) return; // don't switch while agent is running

  // Save current tab's chat
  if (currentTabId != null) {
    tabChats.set(currentTabId, messagesEl.innerHTML);
  }

  currentTabId = newTabId;

  // Restore new tab's chat or start fresh
  if (tabChats.has(newTabId)) {
    messagesEl.innerHTML = tabChats.get(newTabId);
  } else {
    messagesEl.innerHTML = '';
    addMessage('system', t('sp.help_message'));
  }
  scrollToBottom();
}

async function loadProviders() {
  try {
    const res = await sendToBackground('get_providers');
    providerSelect.innerHTML = '';
    for (const [id, config] of Object.entries(res.providers)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = config.label || id;
      if (id === res.active) opt.selected = true;
      providerSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load providers:', e);
  }
}

async function testConnection() {
  statusDot.className = 'status-dot connecting';
  try {
    const res = await sendToBackground('test_provider', {
      providerId: providerSelect.value,
    });
    statusDot.className = `status-dot ${res.ok ? 'online' : 'offline'}`;
    statusDot.title = res.ok
      ? t('sp.status.connected', { model: res.model || providerSelect.value })
      : t('sp.status.error', { msg: res.error });
  } catch {
    statusDot.className = 'status-dot offline';
    statusDot.title = t('sp.status.failed');
  }
}

// --- Message Sending ---

// Per-conversation API mutation override (set via /allow-api).
let apiMutationsAllowed = false;

function parseSlashCommands(text) {
  const m = text.match(/^\/allow-api\b\s*/i);
  if (m) {
    const wasAlreadyAllowed = apiMutationsAllowed;
    apiMutationsAllowed = true;
    updateApiBadge();
    if (!wasAlreadyAllowed) {
      addMessage('system', t('sp.api.enabled_html'));
    }
    return text.slice(m[0].length).trim();
  }
  return text;
}

function updateApiBadge() {
  let badge = document.getElementById('api-badge');
  if (apiMutationsAllowed) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'api-badge';
      badge.className = 'api-badge';
      badge.innerHTML = t('sp.api.badge_html');
      const inputArea = document.getElementById('input-area');
      inputArea?.parentNode?.insertBefore(badge, inputArea);
    }
  } else if (badge) {
    badge.remove();
  }
}

async function sendMessage() {
  let text = inputEl.value.trim();
  if (!text || isProcessing) return;

  text = parseSlashCommands(text);
  if (!text) {
    inputEl.value = '';
    autoResizeInput();
    return;
  }

  isProcessing = true;
  abortRequested = false;
  sendBtn.disabled = true;
  inputEl.value = '';
  autoResizeInput();

  addMessage('user', text);
  showActivity(t('sp.activity.thinking'));

  currentAssistantEl = addMessage('assistant', '');

  try {
    const res = await sendToBackground('chat', {
      tabId: currentTabId,
      text,
      mode: agentMode,
      apiMutationsAllowed,
    });

    if (abortRequested) {
      // Agent was stopped — show what we got so far
      const textEl = currentAssistantEl?.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        textEl.innerHTML = formatMarkdown(res?.content || t('sp.stopped_by_user'));
        addMessageCopyButton(currentAssistantEl);
      }
    } else if (res.content && currentAssistantEl) {
      const textEl = currentAssistantEl.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        textEl.innerHTML = formatMarkdown(res.content);
        addMessageCopyButton(currentAssistantEl);
      }
    }
  } catch (e) {
    if (!abortRequested) {
      addMessage('error', t('sp.error_prefix', { msg: e.message }));
    }
  } finally {
    finalizeSteps();
    isProcessing = false;
    abortRequested = false;
    sendBtn.disabled = false;
    hideActivity();
    currentAssistantEl = null;
    scrollToBottom();
  }
}

// --- Listen for Agent Updates ---

browser.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'sidepanel' || msg.action !== 'agent_update') return;

  const { type, data } = msg;

  switch (type) {
    case 'thinking':
      showActivity(t('sp.activity.thinking_step', { step: data.step }));
      break;

    case 'text':
      // Empty content means "the model returned nothing new at this step".
      // Don't wipe any previously-rendered assistant text — earlier steps
      // may already have put useful intermediate prose in the bubble.
      if (currentAssistantEl && data.content) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl) {
          if (verboseMode) {
            // Verbose mode: append each turn's reasoning as its own
            // paragraph so intermediate prose ("I'll click X", "the modal
            // is still open", "page changed, retrying") is preserved
            // alongside the steps log instead of being overwritten by the
            // next turn's blurb.
            const para = document.createElement('div');
            para.className = 'reasoning-step';
            para.innerHTML = formatMarkdown(data.content);
            textEl.appendChild(para);
          } else {
            // Compact mode keeps only the latest blurb. Toggle Verbose
            // (V button) to retain the full reasoning trail.
            textEl.innerHTML = formatMarkdown(data.content);
          }
          // Add copy button if not already present
          if (!currentAssistantEl.querySelector('.msg-copy-btn')) {
            addMessageCopyButton(currentAssistantEl);
          }
        }
      }
      break;

    case 'text_delta':
      if (currentAssistantEl) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl) textEl.textContent += data.content;
      }
      scrollToBottom();
      break;

    case 'tool_call':
      showActivity(friendlyToolLabel(data.name, data.args));
      showInspectionBanner(data.name);
      if (currentAssistantEl) {
        if (verboseMode) {
          appendVerboseToolCall(data.name, data.args);
        } else {
          appendCompactStep(data.name, data.args);
        }
      }
      scrollToBottom();
      break;

    case 'tool_result':
      if (currentAssistantEl) {
        if (verboseMode) {
          appendVerboseToolResult(data.name, data.result);
        } else {
          markLastStepDone(data.name, data.result);
        }
      }
      scrollToBottom();
      break;

    case 'error':
      hideActivity();
      if (currentAssistantEl) markLastStepFailed();
      addMessage('error', t('sp.error_prefix', { msg: data.message }));
      break;

    case 'max_steps_reached':
      hideActivity();
      // Don't gate on currentAssistantEl — race with sendResponse means it
      // may already be null by the time this fires.
      showContinueButton();
      break;

    case 'warning':
      hideActivity();
      break;
  }
});


// ==========================================================================
// COMPACT MODE (default) — shows tool steps as a tidy activity log
// ==========================================================================

function getOrCreateStepsContainer() {
  if (!currentAssistantEl) return null;
  const content = currentAssistantEl.querySelector('.message-content');
  let container = content.querySelector('.steps-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'steps-container';
    // Insert before the text element
    const textEl = content.querySelector('.message-text');
    content.insertBefore(container, textEl);
  }
  return container;
}

function appendCompactStep(toolName, args) {
  const container = getOrCreateStepsContainer();
  if (!container) return;

  // Mark previous active step as done if still spinning
  const prev = container.querySelector('.step-item.active');
  if (prev) {
    prev.classList.remove('active');
    prev.classList.add('done');
    const icon = prev.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon check'; icon.textContent = '\u2713'; }
  }

  const step = document.createElement('div');
  step.className = 'step-item active';
  step.dataset.tool = toolName;

  const icon = document.createElement('span');
  icon.className = 'step-icon spinning';
  icon.textContent = '';

  const label = document.createElement('span');
  label.className = 'step-label';
  label.textContent = friendlyToolLabel(toolName, args);

  // Small toggle to peek at details
  const toggle = document.createElement('button');
  toggle.className = 'step-details-toggle';
  toggle.textContent = t('sp.step.details');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const details = step.nextElementSibling;
    if (details && details.classList.contains('step-details')) {
      details.classList.toggle('open');
    }
  });

  step.appendChild(icon);
  step.appendChild(label);
  step.appendChild(toggle);
  container.appendChild(step);

  // Hidden details panel (populated when result arrives)
  const details = document.createElement('div');
  details.className = 'step-details';
  details.innerHTML = `<div class="detail-label">${escapeHtml(t('sp.step.input_label'))}</div><div class="detail-args">${escapeHtml(JSON.stringify(args, null, 2))}</div>`;
  container.appendChild(details);
}

function markLastStepDone(toolName, result) {
  const container = getOrCreateStepsContainer();
  if (!container) return;

  const active = container.querySelector('.step-item.active');
  if (active) {
    active.classList.remove('active');
    active.classList.add('done');
    const icon = active.querySelector('.step-icon');
    if (icon) {
      const success = !result?.error;
      icon.className = success ? 'step-icon check' : 'step-icon fail';
      icon.textContent = success ? '\u2713' : '\u2717';
    }

    // Append result to the details panel
    const details = active.nextElementSibling;
    if (details && details.classList.contains('step-details')) {
      const resultDiv = document.createElement('div');
      resultDiv.className = 'detail-result';
      resultDiv.innerHTML = `<div class="detail-label">${escapeHtml(t('sp.step.result_label'))}</div>${escapeHtml(truncate(JSON.stringify(result), 300))}`;
      details.appendChild(resultDiv);
    }
  }
}

function markLastStepFailed() {
  const container = getOrCreateStepsContainer();
  if (!container) return;
  const active = container.querySelector('.step-item.active');
  if (active) {
    active.classList.remove('active');
    active.classList.add('done');
    const icon = active.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon fail'; icon.textContent = '\u2717'; }
  }
}

function finalizeSteps() {
  if (!currentAssistantEl) return;
  const actives = currentAssistantEl.querySelectorAll('.step-item.active');
  actives.forEach(step => {
    step.classList.remove('active');
    step.classList.add('done');
    const icon = step.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon check'; icon.textContent = '\u2713'; }
  });
}


// ==========================================================================
// VERBOSE MODE (opt-in) — full tool call + result blocks
// ==========================================================================

function appendVerboseToolCall(name, args) {
  if (!currentAssistantEl) return;
  const content = currentAssistantEl.querySelector('.message-content');

  const el = document.createElement('div');
  el.className = 'tool-call';

  const header = document.createElement('div');
  header.className = 'tool-call-header';
  header.innerHTML = `<span class="icon">\u26A1</span> ${name}`;

  const body = document.createElement('div');
  body.className = 'tool-call-body';
  body.textContent = JSON.stringify(args, null, 2);

  el.appendChild(header);
  el.appendChild(body);

  const textEl = content.querySelector('.message-text');
  content.insertBefore(el, textEl);
}

function appendVerboseToolResult(name, result) {
  if (!currentAssistantEl) return;
  const content = currentAssistantEl.querySelector('.message-content');
  const lastTool = content.querySelector('.tool-call:last-of-type');
  if (lastTool) {
    const resultEl = document.createElement('div');
    resultEl.className = 'tool-result';
    resultEl.textContent = truncate(JSON.stringify(result), 200);
    lastTool.appendChild(resultEl);
  }
}


// ==========================================================================
// UI Helpers
// ==========================================================================

function addMessage(role, content) {
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}`;

  const contentEl = document.createElement('div');
  contentEl.className = 'message-content';

  const textEl = document.createElement('div');
  textEl.className = 'message-text';
  if (role === 'user') {
    textEl.textContent = content;
  } else {
    textEl.innerHTML = content ? formatMarkdown(content) : '';
  }

  contentEl.appendChild(textEl);
  msgEl.appendChild(contentEl);
  messagesEl.appendChild(msgEl);

  // Add copy button to assistant messages
  if (role === 'assistant' && content) {
    addMessageCopyButton(msgEl);
  }

  scrollToBottom();

  return msgEl;
}

function showContinueButton() {
  document.querySelectorAll('.continue-bar').forEach(el => el.remove());

  const bar = document.createElement('div');
  bar.className = 'continue-bar';
  bar.innerHTML = `
    <span class="continue-text">${escapeHtml(t('sp.continue_bar', { steps: agent_maxSteps || 60 }))}</span>
    <button class="continue-btn" id="btn-continue">${escapeHtml(t('sp.continue_btn'))}</button>
  `;
  messagesEl.appendChild(bar);
  scrollToBottom();

  document.getElementById('btn-continue').addEventListener('click', continueAgent);
}

async function continueAgent() {
  document.querySelectorAll('.continue-bar').forEach(el => el.remove());

  isProcessing = true;
  abortRequested = false;
  sendBtn.disabled = true;

  currentAssistantEl = addMessage('assistant', '');
  showActivity(t('sp.activity.continuing'));

  try {
    const res = await sendToBackground('continue', {
      tabId: currentTabId,
      mode: agentMode,
    });

    if (res.content && currentAssistantEl) {
      const textEl = currentAssistantEl.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        textEl.innerHTML = formatMarkdown(res.content);
        addMessageCopyButton(currentAssistantEl);
      }
    }
  } catch (e) {
    if (!abortRequested) {
      addMessage('error', t('sp.error_prefix', { msg: e.message }));
    }
  } finally {
    finalizeSteps();
    isProcessing = false;
    abortRequested = false;
    sendBtn.disabled = false;
    hideActivity();
    currentAssistantEl = null;
    scrollToBottom();
  }
}

let agent_maxSteps = 60;
browser.storage.local.get('maxAgentSteps').then(s => { agent_maxSteps = s.maxAgentSteps || 60; });
browser.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) agent_maxSteps = changes.maxAgentSteps.newValue;
});

// Page inspection banner
const PAGE_TOOLS = new Set(['read_page', 'get_interactive_elements', 'click', 'type_text', 'scroll', 'extract_data', 'wait_for_element', 'get_selection', 'execute_js', 'screenshot']);
let inspectionBannerShown = false;

function showInspectionBanner(toolName) {
  if (inspectionBannerShown || !PAGE_TOOLS.has(toolName)) return;
  inspectionBannerShown = true;

  const banner = document.getElementById('inspection-banner');
  if (banner) banner.classList.remove('hidden');

  browser.browserAction?.setBadgeText?.({ text: '🔍' }).catch(() => {});
  browser.browserAction?.setBadgeBackgroundColor?.({ color: '#6c63ff' }).catch(() => {});
}

function hideInspectionBanner() {
  inspectionBannerShown = false;
  const banner = document.getElementById('inspection-banner');
  if (banner) banner.classList.add('hidden');
  browser.browserAction?.setBadgeText?.({ text: '' }).catch(() => {});
}

function showActivity(text) {
  agentActivity.classList.remove('hidden');
  activityText.textContent = text;
}

function hideActivity() {
  agentActivity.classList.add('hidden');
  hideInspectionBanner();
}

function scrollToBottom() {
  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}

// Debounce math rendering so streaming updates don't re-walk the DOM
// on every token.
let _mathRenderTimer = null;
function scheduleMathRender() {
  if (_mathRenderTimer) return;
  _mathRenderTimer = setTimeout(() => {
    _mathRenderTimer = null;
    try {
      if (typeof window.renderMathInElement !== 'function') return;
      const target = document.getElementById('messages');
      if (!target) return;
      window.renderMathInElement(target, {
        // Delimiters in order of precedence. We deliberately do NOT enable
        // single-`$...$` as an inline-math delimiter: LLM responses very
        // often contain dollar amounts ("$1,263 ... $2,526") and KaTeX
        // would pair them up and italicize the prose between them. Users
        // who genuinely want inline math can use \\( ... \\) or $$...$$.
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        errorColor: '#f44336',
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        ignoredClasses: ['katex', 'code-block-wrapper'],
      });
    } catch (e) {
      console.warn('[webbrain] math render failed:', e);
    }
  }, 50);
}

function formatMarkdown(text) {
  if (!text) return '';

  // 1. Extract fenced code blocks BEFORE escaping HTML
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const id = `__CODEBLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: lang || '', code });
    return id;
  });

  // 2. Extract inline code before escaping
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const id = `__INLINE_${inlineCodes.length}__`;
    inlineCodes.push(code);
    return id;
  });

  // 3. Escape HTML in the remaining text
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 4. Inline formatting (bold + italic), then markdown link sanitization,
  // then newline → <br>. Links are handled by the dedicated markdown-link
  // module (unit-tested in test/run.js) — see that file for the rationale
  // and threat model.
  text = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = sanitizeMarkdownLinks(text);
  text = text.replace(/\n/g, '<br>');

  // 5. Restore inline code
  inlineCodes.forEach((code, i) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    text = text.replace(`__INLINE_${i}__`, `<code>${escaped}</code>`);
  });

  // 6. Restore fenced code blocks with copy button
  codeBlocks.forEach((block, i) => {
    const escaped = block.code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langLabel = block.lang ? `<span class="code-lang">${escapeHtml(block.lang)}</span>` : '';
    const copyBtn = `<button class="code-copy-btn" data-code-index="${i}" title="${escapeHtml(t('sp.copy.code.title'))}">${escapeHtml(t('sp.copy'))}</button>`;
    const header = `<div class="code-block-header">${langLabel}${copyBtn}</div>`;
    text = text.replace(
      `__CODEBLOCK_${i}__`,
      `<div class="code-block-wrapper">${header}<pre><code>${escaped}</code></pre></div>`
    );
  });

  // Schedule KaTeX rendering of any math expressions in the messages area.
  scheduleMathRender();

  // Store raw code for copy buttons to use
  if (codeBlocks.length > 0) {
    setTimeout(() => {
      document.querySelectorAll('.code-copy-btn').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = 'true';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const wrapper = btn.closest('.code-block-wrapper');
          const codeEl = wrapper?.querySelector('pre code');
          if (codeEl) {
            navigator.clipboard.writeText(codeEl.textContent).then(() => {
              btn.textContent = t('sp.copied');
              btn.classList.add('copied');
              setTimeout(() => { btn.textContent = t('sp.copy'); btn.classList.remove('copied'); }, 1500);
            });
          }
        });
      });
    }, 0);
  }

  return text;
}

/** Adds a copy button to an entire assistant message (for non-code text) */
function addMessageCopyButton(msgEl) {
  if (!msgEl) return;
  const content = msgEl.querySelector('.message-content');
  if (!content) return;
  const btn = document.createElement('button');
  btn.className = 'msg-copy-btn';
  btn.textContent = t('sp.copy');
  btn.title = t('sp.copy.code.title');
  btn.addEventListener('click', () => {
    const textEl = content.querySelector('.message-text');
    if (textEl) {
      navigator.clipboard.writeText(textEl.innerText).then(() => {
        btn.textContent = t('sp.copied');
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = t('sp.copy'); btn.classList.remove('copied'); }, 1500);
      });
    }
  });
  content.appendChild(btn);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function autoResizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

// --- Communication ---

async function sendToBackground(action, data = {}) {
  const response = await browser.runtime.sendMessage(
    { target: 'background', action, ...data }
  );
  if (response?.error) {
    throw new Error(response.error);
  }
  return response;
}

// --- Mode Toggle ---

function setMode(mode) {
  agentMode = mode;

  if (mode === 'ask') {
    modeAskBtn.classList.add('active');
    modeAskBtn.classList.remove('act');
    modeActBtn.classList.remove('active', 'act');
    actWarning.classList.add('hidden');
    inputArea.classList.remove('act-mode');
    inputEl.placeholder = t('sp.input.ask_placeholder');
    inputEl.dataset.i18nPlaceholder = 'sp.input.ask_placeholder';
  } else {
    modeActBtn.classList.add('active', 'act');
    modeAskBtn.classList.remove('active');
    actWarning.classList.remove('hidden');
    inputArea.classList.add('act-mode');
    inputEl.placeholder = t('sp.input.act_placeholder');
    inputEl.dataset.i18nPlaceholder = 'sp.input.act_placeholder';
  }
}

modeAskBtn.addEventListener('click', () => setMode('ask'));

modeActBtn.addEventListener('click', async () => {
  if (agentMode === 'act') return; // already active
  try {
    const stored = await browser.storage.local.get('actConfirmed');
    if (!stored.actConfirmed) {
      const ok = confirm(t('sp.mode.act.confirm'));
      if (!ok) return;
      browser.storage.local.set({ actConfirmed: true }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
  setMode('act');
});


// --- Stop / Abort ---

stopBtn.addEventListener('click', async () => {
  if (!isProcessing) return;
  abortRequested = true;
  showActivity(t('sp.activity.stopping'));

  try {
    await sendToBackground('abort', { tabId: currentTabId });
  } catch {
    // Best effort
  }

  // Force UI to settle even if background doesn't respond cleanly
  setTimeout(() => {
    if (abortRequested) {
      finalizeSteps();
      if (currentAssistantEl) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl && !textEl.textContent.trim()) {
          textEl.innerHTML = t('sp.stopped_by_user_html');
        }
      }
      isProcessing = false;
      sendBtn.disabled = false;
      hideActivity();
      currentAssistantEl = null;
      abortRequested = false;
    }
  }, 3000); // safety timeout if background takes too long
});


// --- Event Listeners ---

sendBtn.addEventListener('click', sendMessage);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener('input', autoResizeInput);

clearBtn.addEventListener('click', async () => {
  await sendToBackground('clear_conversation', { tabId: currentTabId });
  messagesEl.innerHTML = '';
  addMessage('system', t('sp.cleared_message'));
  apiMutationsAllowed = false;
  updateApiBadge();
});

providerSelect.addEventListener('change', async () => {
  await sendToBackground('set_active_provider', { providerId: providerSelect.value });
  await testConnection();
});

settingsBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});

// --- Language selector (globe icon in header) ---
const languageSelect = document.getElementById('language-select');
if (languageSelect) {
  languageSelect.innerHTML = LANGUAGES
    .map((l) => `<option value="${l.code}">${l.label}</option>`)
    .join('');
  languageSelect.value = getLocale();
  languageSelect.addEventListener('change', () => {
    setLocale(languageSelect.value);
    applyDOMTranslations(document);
  });
  document.addEventListener('wb-locale-changed', () => {
    languageSelect.value = getLocale();
  });
}

// --- Start ---
init();
