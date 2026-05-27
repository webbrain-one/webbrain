/**
 * WebBrain Side Panel — Chat UI logic.
 * Default: human-friendly compact output. Verbose mode: full tool debug.
 */

import { t, getLocale, setLocale, LANGUAGES, applyDOMTranslations } from './i18n.js';
import { sanitizeMarkdownLinks } from './markdown-link.js';

// ─── Onboarding (first-launch wizard) ───────────────────────────────
(async function initOnboarding() {
  const stored = await chrome.storage.local.get('onboardingComplete');
  if (stored.onboardingComplete) return;

  const overlay = document.getElementById('onboarding');
  if (!overlay) return;

  applyDOMTranslations(overlay);
  overlay.classList.remove('hidden');

  const steps = overlay.querySelectorAll('.ob-step');
  const dots = overlay.querySelectorAll('.ob-step-dot');
  const nextBtn = document.getElementById('ob-next');
  const backBtn = document.getElementById('ob-back');
  const settingsBtn = document.getElementById('ob-open-settings');
  const skipBtn = document.getElementById('ob-skip');
  const totalSteps = steps.length;
  let current = 0;

  function dismissOnboarding() {
    chrome.storage.local.set({ onboardingComplete: true }).catch(() => {});
    overlay.classList.add('hidden');
  }

  function goTo(idx) {
    steps[current].classList.remove('active');
    dots[current].classList.remove('active');
    dots[current].classList.add('done');

    current = idx;

    steps[current].classList.add('active');
    dots.forEach((d, i) => {
      d.classList.toggle('active', i === current);
      d.classList.toggle('done', i < current);
    });

    const isLast = current === totalSteps - 1;
    backBtn.classList.toggle('hidden', current === 0);
    nextBtn.classList.toggle('hidden', isLast);
    settingsBtn.classList.toggle('hidden', !isLast);
    skipBtn.classList.toggle('hidden', !isLast);
    if (!isLast) nextBtn.textContent = t('ob.btn.next');
  }

  nextBtn.addEventListener('click', () => {
    if (current < totalSteps - 1) goTo(current + 1);
  });

  backBtn.addEventListener('click', () => {
    if (current > 0) goTo(current - 1);
  });

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    dismissOnboarding();
  });

  skipBtn.addEventListener('click', dismissOnboarding);
})();

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
// Tab Recorder (v7.4) — recording is started entirely via the agent's
// `record_tab` tool (prompt-driven). The live red banner that appears
// during a recording carries its own Stop button; that's the only UI
// surface. No toolbar button — keeping one was duplicate UI.
const recordingBanner = document.getElementById('recording-banner');
const recordingTimerEl = document.getElementById('recording-timer');
const recordingStopBtn = document.getElementById('btn-recording-stop');

let currentTabId = null;
let isProcessing = false;
let currentAssistantEl = null;
let verboseMode = false;
let agentMode = 'ask'; // 'ask' or 'act'
let abortRequested = false;
// Notification sound on task completion. Default on; togglable via Settings.
let notifySoundEnabled = true;
let notifyAudio = null;
chrome.storage.local.get('notifySound').then((stored) => {
  if (stored && stored.notifySound === false) notifySoundEnabled = false;
}).catch(() => {});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.notifySound) {
    notifySoundEnabled = changes.notifySound.newValue !== false;
  }
});

/**
 * Play a short chime when the agent finishes a task. Lazy-creates the Audio
 * element the first time and reuses it after that — sidepanel.html is an
 * extension page so loading /assets/notification.mp3 works without any
 * web_accessible_resources entry. Best-effort: if autoplay is blocked (very
 * occasional first-load case in Chrome) we just swallow the error.
 */
function playCompletionSound() {
  if (!notifySoundEnabled) return;
  try {
    if (!notifyAudio) {
      notifyAudio = new Audio(chrome.runtime.getURL('assets/notification.mp3'));
      notifyAudio.volume = 0.6;
    }
    notifyAudio.currentTime = 0;
    const p = notifyAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* ignore */ }
}

// Per-tab chat history (stores innerHTML of messages container).
// Also mirrored to chrome.storage.session keyed `tabChat:<tabId>` so the
// conversation survives the side panel being closed and reopened.
const tabChats = new Map();
const TAB_CHAT_PREFIX = 'tabChat:';

async function loadTabChat(tabId) {
  if (tabChats.has(tabId)) return tabChats.get(tabId);
  try {
    const key = TAB_CHAT_PREFIX + tabId;
    const stored = await chrome.storage.session.get(key);
    const html = stored?.[key];
    if (typeof html === 'string') {
      tabChats.set(tabId, html);
      return html;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function persistTabChat(tabId, html) {
  if (tabId == null) return;
  tabChats.set(tabId, html);
  try {
    chrome.storage.session.set({ [TAB_CHAT_PREFIX + tabId]: html }).catch(() => {});
  } catch (e) { /* ignore */ }
}

// Save current tab's chat to storage on a debounced cadence — we don't want
// to thrash storage on every keystroke / streamed token.
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (currentTabId != null) persistTabChat(currentTabId, messagesEl.innerHTML);
  }, 400);
}

// Observe the messages container so any DOM mutation (new message, streamed
// delta, tool step update) eventually gets persisted.
const persistObserver = new MutationObserver(schedulePersist);

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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  // Load verbose setting
  const stored = await chrome.storage.local.get('verboseMode');
  verboseMode = stored.verboseMode || false;

  // Restore prior conversation for this tab (if any) — survives close/reopen.
  if (currentTabId != null) {
    const html = await loadTabChat(currentTabId);
    if (html) {
      messagesEl.innerHTML = html;
      messagesEl.querySelectorAll('[data-bound]').forEach(el => delete el.dataset.bound);
      rebindCopyButtons();
      scrollToBottom();
    }
  }

  // Start observing the messages container for changes to persist.
  persistObserver.observe(messagesEl, { childList: true, subtree: true, characterData: true });

  await loadProviders();
  await testConnection();

  chrome.tabs.onActivated.addListener(async (info) => {
    switchToTab(info.tabId);
  });

  // Also handle window focus changes
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && tab.id !== currentTabId) {
      switchToTab(tab.id);
    }
  });

  // Reflect initial verbose state in the button.
  if (verboseBtn) verboseBtn.classList.toggle('active', verboseMode);

  // Listen for setting changes (from options page)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.verboseMode) {
      verboseMode = changes.verboseMode.newValue;
      if (verboseBtn) verboseBtn.classList.toggle('active', verboseMode);
    }
  });
}

// Verbose toggle button: persists the choice via the same storage key the
// settings page uses, so the two stay in sync.
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
    chrome.storage.local.set({ verboseMode }).catch(() => {});
  });
}

async function switchToTab(newTabId) {
  if (newTabId === currentTabId) return;
  if (isProcessing) return; // don't switch while agent is running

  // Save current tab's chat (in-memory + storage).
  if (currentTabId != null) {
    persistTabChat(currentTabId, messagesEl.innerHTML);
  }

  currentTabId = newTabId;

  // Restore new tab's chat from memory or storage.
  const html = await loadTabChat(newTabId);
  if (html) {
    messagesEl.innerHTML = html;
    messagesEl.querySelectorAll('[data-bound]').forEach(el => delete el.dataset.bound);
    rebindCopyButtons();
  } else {
    messagesEl.innerHTML = '';
    addMessage('system', t('sp.help_message'));
  }
  scrollToBottom();
}

// After restoring innerHTML the copy buttons need their click handlers re-bound,
// since serialized HTML loses listeners.
function rebindCopyButtons() {
  document.querySelectorAll('.msg-copy-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', () => {
      const content = btn.closest('.message-content');
      const textEl = content?.querySelector('.message-text');
      if (textEl) {
        navigator.clipboard.writeText(textEl.innerText).then(() => {
          btn.textContent = t('sp.copied');
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = t('sp.copy'); btn.classList.remove('copied'); }, 1500);
        });
      }
    });
  });
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

// Per-conversation flag for API mutation override (set via /allow-api).
// Reset on clearConversation. Visible to the user in the chat as a system
// message and as a sticky badge near the input area.
let apiMutationsAllowed = false;

/**
 * Parse leading slash commands out of the user's message. Currently:
 *   /allow-api  → enable API mutation override for this conversation.
 * Returns the cleaned text. May trigger UI side effects (toast, badge).
 */
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

  // Parse any leading slash command. parseSlashCommands may strip the
  // command from `text` and toggle apiMutationsAllowed as a side effect.
  text = parseSlashCommands(text);
  // If the entire message was just the slash command, there's nothing
  // left to send to the agent — bail out after the side effect.
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
    // Chime the user when the agent finishes. We play on both success and
    // error completion — anything that wasn't an explicit user abort. The
    // sound is what takes them from "glance back at the tab" to "know it's
    // done" without having to sit and watch the sidebar.
    const wasAborted = abortRequested;
    isProcessing = false;
    abortRequested = false;
    sendBtn.disabled = false;
    hideActivity();
    currentAssistantEl = null;
    scrollToBottom();
    if (!wasAborted) playCompletionSound();
  }
}

// ─── Tab Recorder (v7.4) ────────────────────────────────────────────
// State: idle ↔ recording. The agent's `record_tab` tool is what flips
// the panel into recording mode (background broadcasts a started event);
// the toolbar Stop button + the banner Stop button are the two ways to
// flip back. The banner timer is driven off recordingState.startedAt
// (received from background), so it survives panel re-mount.

let recordingTimerInterval = null;
let recordingStartedAt = null;

function formatRecordTimer(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function setRecordingUI(active) {
  if (recordingBanner) recordingBanner.classList.toggle('hidden', !active);
  if (active) {
    if (!recordingTimerInterval) {
      recordingTimerInterval = setInterval(() => {
        if (recordingStartedAt && recordingTimerEl) {
          recordingTimerEl.textContent = formatRecordTimer(Date.now() - recordingStartedAt);
        }
      }, 1000);
    }
    if (recordingTimerEl && recordingStartedAt) {
      recordingTimerEl.textContent = formatRecordTimer(Date.now() - recordingStartedAt);
    }
  } else {
    if (recordingTimerInterval) {
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
    if (recordingTimerEl) recordingTimerEl.textContent = '00:00';
    recordingStartedAt = null;
  }
}

async function hydrateRecordingFromBackground() {
  try {
    const res = await sendToBackground('get_recording_state');
    if (res?.state?.active) {
      recordingStartedAt = res.state.startedAt;
      setRecordingUI(true);
    } else {
      setRecordingUI(false);
    }
  } catch { /* background not ready yet, ignore */ }
}

async function stopRecording() {
  if (recordingStopBtn) recordingStopBtn.disabled = true;
  try {
    const res = await sendToBackground('stop_tab_recording');
    if (!res?.ok) {
      alert(t('sp.record.error', { error: res?.error || 'unknown' }));
      return;
    }
    setRecordingUI(false);
  } finally {
    if (recordingStopBtn) recordingStopBtn.disabled = false;
  }
}

if (recordingStopBtn) recordingStopBtn.addEventListener('click', stopRecording);

// Hydrate on panel boot — the agent may have started a recording before
// this panel even mounted (Cmd+T to a new tab, then switch back).
hydrateRecordingFromBackground();

// --- Listen for Agent Updates ---

// Recorder broadcasts — independent of the per-tab agent_update flow.
// These are intentionally NOT scoped by tabId because the recording banner
// is global (a panel on any tab in the window should reflect that a record
// is in progress on tab X).
// Holds the latest finished recording result (filename + optional
// transcript) so Phase 3's "Summarize" CTA can read it.
let lastRecordingResult = null;
let lastTranscript = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'sidepanel' || msg.action !== 'recording_update') return;
  if (msg.event === 'started') {
    recordingStartedAt = msg.state?.startedAt || Date.now();
    setRecordingUI(true);
  } else if (msg.event === 'stopped') {
    setRecordingUI(false);
    lastRecordingResult = msg.result || null;
    if (lastRecordingResult?.transcribeAfter) {
      showRecordingStatus(t('sp.record.transcribing'));
    } else if (lastRecordingResult?.filename) {
      showRecordingStatus(t('sp.record.saved', { filename: lastRecordingResult.filename }), { autoHide: 6000 });
    }
  } else if (msg.event === 'transcribing') {
    showRecordingStatus(t('sp.record.transcribing'));
  } else if (msg.event === 'transcribed') {
    if (msg.result?.ok) {
      lastTranscript = msg.result.text || null;
      showRecordingStatus(
        t('sp.record.transcribed', { filename: msg.result.transcriptFilename || 'transcript.txt' }),
        { autoHide: 8000, summarizable: true }
      );
    } else {
      showRecordingStatus(t('sp.record.transcribe_failed', { error: msg.result?.error || 'unknown' }), { autoHide: 8000 });
    }
  }
});

// Minimal status strip just below the (now-hidden) recording banner.
// Carries post-recording notifications: "saved to Downloads", "transcribing…",
// "transcript ready" + optional Summarize CTA (Phase 3).
function showRecordingStatus(text, opts = {}) {
  let el = document.getElementById('recording-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'recording-status';
    el.className = 'recording-status';
    const banner = document.getElementById('recording-banner');
    if (banner && banner.parentNode) {
      banner.parentNode.insertBefore(el, banner.nextSibling);
    } else {
      document.body.appendChild(el);
    }
  }
  el.innerHTML = ''; // reset
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (opts.summarizable && lastTranscript) {
    const btn = document.createElement('button');
    btn.textContent = t('sp.record.summarize');
    btn.className = 'btn-summarize-recording';
    btn.addEventListener('click', () => summarizeLastTranscript());
    el.appendChild(btn);
  }
  el.classList.remove('hidden');
  if (opts.autoHide) {
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.add('hidden'), opts.autoHide);
  }
}

// Phase 3 placeholder — wired below when we add the summarize message
// handoff. Defined here so showRecordingStatus can reference it.
function summarizeLastTranscript() {
  if (!lastTranscript) return;
  // The sidepanel's send-message path expects a user-typed string. Drop the
  // transcript in as if the user pasted it with a summary instruction.
  const prompt =
    `I just recorded a tab. Here is the Whisper transcript — please summarize it ` +
    `in 5-8 bullet points and extract any action items, decisions, and open ` +
    `questions. Be concise.\n\n----- TRANSCRIPT -----\n${lastTranscript}\n----- END TRANSCRIPT -----`;
  if (inputEl) {
    inputEl.value = prompt;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (sendBtn) sendBtn.click();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'sidepanel' || msg.action !== 'agent_update') return;

  // Drop updates that belong to a different tab's run. agent_update is a
  // window-wide broadcast (chrome.runtime.sendMessage has no per-tab
  // targeting from the service worker), and the side panel mounts a
  // fresh instance on every tab — so without this guard, an agent run
  // still in flight on tab A would render its "thinking…" / tool steps
  // / final text into a brand-new Cmd+T tab B's panel the moment B's
  // panel finished mounting. `msg.tabId == null` keeps backward compat
  // for any in-flight events from a pre-tabId background build.
  if (msg.tabId != null && msg.tabId !== currentTabId) return;

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
            // Compact mode keeps only the latest blurb. Replacing is
            // intentional here — most pre-tool reasoning is "I'll click X"
            // boilerplate that becomes obsolete once X is clicked, and the
            // steps log already captures what was done. Toggle Verbose
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
      // Don't gate on currentAssistantEl — this event sometimes arrives
      // after the chat sendResponse has resolved and the finally block has
      // already nulled out currentAssistantEl. The continue bar attaches to
      // the messages container, not to a specific message, so it's fine to
      // show unconditionally.
      showContinueButton();
      break;

    case 'warning':
      hideActivity();
      break;

    case 'clarify':
      // Agent paused to ask the user a question. Render an inline card in
      // the current assistant bubble; the user picks an option or types a
      // custom answer, and we post `clarify_response` back to the bg.
      renderClarifyCard(data);
      break;
  }
});

/**
 * Render a clarify() prompt inside the current assistant message. Shows the
 * question, optional "reason" hint, suggested-option buttons, and a free-
 * text input. First submit (option click OR text submit) disables the card
 * and routes the answer to the background. UI stays visible after answering
 * so the user can see what they chose.
 */
function renderClarifyCard(data) {
  hideActivity();
  if (!currentAssistantEl) return;
  const tabId = currentTabId;
  if (!tabId) return;
  const clarifyId = String(data.clarifyId || '');
  if (!clarifyId) return;

  const content = currentAssistantEl.querySelector('.message-content');
  if (!content) return;

  const card = document.createElement('div');
  card.className = 'clarify-card';
  card.dataset.clarifyId = clarifyId;

  const qEl = document.createElement('div');
  qEl.className = 'clarify-question';
  qEl.textContent = String(data.question || '').slice(0, 600);
  card.appendChild(qEl);

  if (data.reason) {
    const reasonEl = document.createElement('div');
    reasonEl.className = 'clarify-reason';
    reasonEl.textContent = String(data.reason).slice(0, 400);
    card.appendChild(reasonEl);
  }

  const options = Array.isArray(data.options) ? data.options.slice(0, 4) : [];
  const optionsEl = options.length ? document.createElement('div') : null;
  if (optionsEl) {
    optionsEl.className = 'clarify-options';
    for (const opt of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'clarify-option';
      b.textContent = String(opt).slice(0, 200);
      b.addEventListener('click', () => submitClarify(card, tabId, clarifyId, b.textContent, 'option'));
      optionsEl.appendChild(b);
    }
    card.appendChild(optionsEl);
  }

  const row = document.createElement('div');
  row.className = 'clarify-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'clarify-input';
  input.placeholder = options.length
    ? (typeof t === 'function' ? t('sp.clarify.input_placeholder_with_options') : 'Or type a different answer…')
    : (typeof t === 'function' ? t('sp.clarify.input_placeholder') : 'Type your answer…');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault();
      submitClarify(card, tabId, clarifyId, input.value.trim(), 'text');
    }
  });
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'clarify-submit';
  submitBtn.textContent = typeof t === 'function' ? t('sp.clarify.submit') : 'Send';
  submitBtn.addEventListener('click', () => {
    const v = input.value.trim();
    if (v) submitClarify(card, tabId, clarifyId, v, 'text');
  });
  row.appendChild(input);
  row.appendChild(submitBtn);
  card.appendChild(row);

  content.appendChild(card);
  scrollToBottom();
  try { input.focus(); } catch {}
}

function submitClarify(card, tabId, clarifyId, answer, source) {
  // Lock the card so the user can't double-submit and so it's visually
  // clear what was chosen. The pending Promise on the agent side only
  // accepts the first response anyway, but UI feedback matters.
  if (card.classList.contains('clarify-answered')) return;
  card.classList.add('clarify-answered');
  for (const el of card.querySelectorAll('button, input')) {
    el.disabled = true;
  }
  const answered = document.createElement('div');
  answered.className = 'clarify-your-answer';
  answered.textContent = (typeof t === 'function' ? t('sp.clarify.your_answer') : 'Your answer:') + ' ' + answer;
  card.appendChild(answered);
  scrollToBottom();

  // IMPORTANT: include `target: 'background'`. Without it, background's
  // message router (chrome.runtime.onMessage in background.js) silently
  // drops the message — the very first line is
  //   if (msg.target !== 'background') return;
  // …and the agent's pending clarify Promise hangs forever, leaving the
  // run stuck in `status: "running"` even after the user answers. Use
  // sendToBackground() rather than chrome.runtime.sendMessage directly
  // so the target field is always injected.
  sendToBackground('clarify_response', { tabId, clarifyId, answer, source })
    .catch(() => { /* background may be torn down — clarify state already lives there */ });
}


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
  // Remove any existing continue button
  document.querySelectorAll('.continue-bar').forEach(el => el.remove());

  const bar = document.createElement('div');
  bar.className = 'continue-bar';
  bar.innerHTML = `
    <span class="continue-text">${escapeHtml(t('sp.continue_bar', { steps: agent_maxSteps || 130 }))}</span>
    <button class="continue-btn" id="btn-continue">${escapeHtml(t('sp.continue_btn'))}</button>
  `;
  messagesEl.appendChild(bar);
  scrollToBottom();

  document.getElementById('btn-continue').addEventListener('click', continueAgent);
}

async function continueAgent() {
  // Remove the continue bar
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

// Track max steps for display in continue bar
let agent_maxSteps = 130;
chrome.storage.local.get('maxAgentSteps').then(s => { agent_maxSteps = s.maxAgentSteps || 130; });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) agent_maxSteps = changes.maxAgentSteps.newValue;
});

// Page inspection banner — shown when agent starts interacting with the page
const PAGE_TOOLS = new Set(['read_page', 'get_interactive_elements', 'click', 'type_text', 'scroll', 'extract_data', 'wait_for_element', 'get_selection', 'screenshot']);
let inspectionBannerShown = false;

function showInspectionBanner(toolName) {
  if (inspectionBannerShown || !PAGE_TOOLS.has(toolName)) return;
  inspectionBannerShown = true;

  const banner = document.getElementById('inspection-banner');
  if (banner) {
    banner.classList.remove('hidden');
  }

  // Set extension badge
  chrome.action?.setBadgeText?.({ text: '🔍' }).catch(() => {});
  chrome.action?.setBadgeBackgroundColor?.({ color: '#6c63ff' }).catch(() => {});
}

function hideInspectionBanner() {
  inspectionBannerShown = false;
  const banner = document.getElementById('inspection-banner');
  if (banner) {
    banner.classList.add('hidden');
  }
  chrome.action?.setBadgeText?.({ text: '' }).catch(() => {});
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
        // Don't crash the whole message on a bad expression — show the raw
        // source in red instead.
        throwOnError: false,
        errorColor: '#f44336',
        // Skip rendering inside code blocks and already-rendered math.
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
  // auto-render walks text nodes and replaces $...$, $$...$$, \(...\), \[...\]
  // with rendered spans. It's idempotent (rendered spans are skipped on
  // subsequent passes) so we can safely call it after every innerHTML write.
  scheduleMathRender();

  // Store raw code for copy buttons to use
  if (codeBlocks.length > 0) {
    setTimeout(() => {
      document.querySelectorAll('.code-copy-btn').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = 'true';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Get the code from the adjacent pre>code element
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

function sendToBackground(action, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: 'background', action, ...data },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      }
    );
  });
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
    // Keep the data- attribute in sync so locale changes auto-apply.
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
  // Show a confirmation dialog the very first time the user enables Act
  // mode on this install — tracked via chrome.storage.local so it only
  // happens once, not on every click.
  try {
    const stored = await chrome.storage.local.get('actConfirmed');
    if (!stored.actConfirmed) {
      const ok = confirm(t('sp.mode.act.confirm'));
      if (!ok) return;
      chrome.storage.local.set({ actConfirmed: true }).catch(() => {});
    }
  } catch (e) { /* storage unavailable, fall through */ }
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
  if (currentTabId != null) {
    tabChats.delete(currentTabId);
    chrome.storage.session?.remove(TAB_CHAT_PREFIX + currentTabId).catch(() => {});
  }
  // Per-conversation flags reset on clear.
  apiMutationsAllowed = false;
  updateApiBadge();
});

providerSelect.addEventListener('change', async () => {
  await sendToBackground('set_active_provider', { providerId: providerSelect.value });
  await testConnection();
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
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
    // Re-apply placeholder since it flips with ask/act mode
    applyDOMTranslations(document);
  });
  document.addEventListener('wb-locale-changed', () => {
    languageSelect.value = getLocale();
  });
}

// --- Start ---
init();
