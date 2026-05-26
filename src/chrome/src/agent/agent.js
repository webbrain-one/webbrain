import { AGENT_TOOLS, AGENT_TOOL_NAMES, COMPACT_TOOL_NAMES, getToolsForMode, SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT, SYSTEM_PROMPT_ACT_COMPACT } from './tools.js';
import { URL_FAMILY_TOOLS, resourceBucket, bucketArgsKey } from './loop-bucket.js';
import { isCredentialField, CREDENTIAL_NOTE_STRICT } from './credential-fields.js';
import { cdpClient } from '../cdp/cdp-client.js';
import { getActiveAdapter, UNIVERSAL_PREAMBLE } from './adapters.js';
import {
  fetchUrl,
  researchUrl,
  listDownloads,
  readDownloadedFile,
  downloadResourceFromPage,
  downloadFiles,
} from '../network/network-tools.js';
import {
  isPdfUrl,
  extractPdfText,
  providerSupportsPdfPassthrough,
  buildClaudeDocumentBlock,
  PDF_PASSTHROUGH_MAX_BYTES,
} from './pdf-tools.js';
import * as trace from '../trace/recorder.js';
import { solveCaptcha, detectCaptcha, injectToken } from './captcha-solver.js';
import {
  startTabRecording as recorderStart,
  stopTabRecording as recorderStop,
  getRecordingState as recorderGetState,
} from '../recorder/host.js';

/**
 * The WebBrain Agent — orchestrates multi-step LLM + tool-use loops.
 */
export class Agent {
  constructor(providerManager) {
    this.providerManager = providerManager;
    this.conversations = new Map(); // tabId -> messages[]
    this.conversationModes = new Map(); // tabId -> 'ask' | 'act'
    this.conversationIds = new Map(); // tabId -> stable conversationId (regenerated on clearConversation)
    this.hydratedTabs = new Set(); // tabIds we've already pulled from storage
    this.persistTimers = new Map(); // tabId -> debounce handle
    this.abortFlags = new Map(); // tabId -> boolean
    this.currentRunId = new Map(); // tabId -> active trace runId (for recorder hooks)
    this.maxSteps = 130; // safety limit for autonomous loops (configurable via settings)
    this.maxContextMessages = 50; // trim beyond this
    this._debugLog = []; // ring buffer for deep verbose (LLM requests/responses)
    this._debugLogMax = 200; // max entries before oldest are dropped
    this.maxContextChars = 80000; // rough char budget (~20k tokens)
    // Auto-screenshot mode. 'off' | 'navigation' | 'state_change' | 'every_step'.
    // Loaded from chrome.storage.local in background.js.
    this.autoScreenshot = 'state_change';
    // Whether to inject site adapter notes + universal cookie/paywall
    // guidance into the system prompt. Loaded from chrome.storage.local.
    // Default true. The adapter notes themselves still live in
    // _enrichUserMessageWithCurrentPage because they're URL-specific; the
    // universal preamble rides along with the base system prompt.
    this.useSiteAdapters = true;

    // Strict secret-handling mode. When true, the `done` tool description
    // adds a hard prohibition on quoting credentials in summaries and the
    // post-set_field credential note tells the model to never echo the
    // value. When false (the default — this is a personal-computer tool,
    // not a third-party deployment), the model gets soft hygiene guidance
    // ("prefer generic phrasing unless the user asks for the value") but
    // can quote credentials when the user explicitly asks for them ("show
    // me my recovery codes", "what's my API key on this page"). Toggle
    // lives in Settings → "Strict secret handling". Loaded in background.js.
    this.strictSecretMode = false;

    // Profile auto-fill: when enabled, the user's profile text (name,
    // email, throwaway password, etc.) is appended to the system prompt
    // so the agent can fill signup forms without asking every time.
    // Plaintext in chrome.storage.local — warned about in the settings
    // UI. Loaded in background.js alongside other settings.
    this.profileEnabled = false;
    this.profileText = '';

    // CapSolver integration. Off by default. When enabled AND an API key
    // is set, the system prompt grows a "[CAPTCHA SOLVER]" note that
    // tells the model to try `solve_captcha` once before falling back to
    // asking the user. The agent reads the key from chrome.storage.local
    // at call time so rotating the key doesn't require a restart.
    this.captchaSolverEnabled = false;
    // Stale click detection: per-tab last clicked element identity.
    this._lastCdpClickIdent = new Map(); // tabId -> string
    // Loop detection: per-tab ring buffer of recent tool calls + nudge count.
    this.recentCalls = new Map(); // tabId -> [{ key, name, ts }]
    this.loopNudges = new Map();  // tabId -> consecutive-nudge counter
    this.healthyCallsSinceLoop = new Map(); // tabId -> count of clean calls since last nudge
    this.lastAutoScreenshotTs = new Map(); // tabId -> ms — defensive debounce
    this.lastSeenAdapter = new Map(); // tabId -> adapter name from last enrichment
    // Separate buffer for coordinate-based click attempts. The general loop
    // detector keys on JSON.stringify(args), so when the model interleaves
    // execute_js with different code strings between clicks, the same
    // (x,y) click never accumulates to the threshold inside its window.
    // This buffer tracks ONLY coord clicks and survives any amount of
    // unrelated noise between them, catching the "click missing its target,
    // model retries forever" failure mode in 2-3 attempts instead of never.
    this.recentCoordClicks = new Map(); // tabId -> [{ key, ts }]
    // Per-tab opt-in: when true, the agent is allowed to use API mutations
    // (POST/PUT/PATCH/DELETE via fetch_url, mutation fetch() via execute_js)
    // for steps where it judges API to be more reliable than UI. Set via
    // the /allow-api slash command in the sidebar; cleared on
    // clearConversation. Persisted with the conversation so a service
    // worker restart preserves it.
    this.apiAllowedTabs = new Set();
    // Track which tabs have already had the [API ALLOWED] preamble
    // injected for the current run, so we don't push it on every turn.
    this.apiAllowedInjected = new Set();
    // Last interacted region per tab (CSS-pixel rect from click_ax / type_ax).
    // Used to draw an outline onto verification screenshots in `done` so the
    // model can see which element it last touched. Lives for the tab's
    // lifetime; overwritten on each ax interaction, cleared on tab close.
    this._lastInteractionRect = new Map(); // tabId -> { x, y, w, h, ts }
    // Pending clarify() tool calls awaiting user input. Keyed by tabId →
    // (clarifyId → {resolve, reject}). The clarify tool returns a Promise
    // that resolves when the user submits a response via the side panel
    // (background.js routes `clarify_response` to submitClarifyResponse).
    // abort() and clearConversation() cancel all pending clarifications so
    // the agent loop doesn't deadlock.
    this._pendingClarifications = new Map();
    // Cache for `_isPdfTab` — the URL-pattern check is sync and free,
    // but the HEAD fallback for "Content-Type: application/pdf at a
    // URL that doesn't end in .pdf" costs a round-trip. We cache the
    // resolved is-PDF flag per (tabId,url) so the agent doesn't probe
    // on every executeTool call within a turn.
    this._isPdfTabCache = new Map(); // tabId -> { url, isPdf }
  }

  /**
   * Toggle the per-tab API-mutation allowlist. Called by background.js
   * when the sidebar reports the user typed /allow-api.
   */
  setApiMutationsAllowed(tabId, allowed) {
    if (allowed) {
      this.apiAllowedTabs.add(tabId);
    } else {
      this.apiAllowedTabs.delete(tabId);
      this.apiAllowedInjected.delete(tabId);
    }
  }

  // ---- Loop detection ----
  // Catches the agent stuck repeating an ineffective action or oscillating
  // between two calls. Cheap, runs after every tool execution. On first
  // detection we soft-nudge by injecting a [LOOP DETECTED] note into the
  // tool result the model sees. On second detection within the same loop,
  // we hard-stop the run with a clear final message.

  _recordCall(tabId, name, args, result) {
    // URL-family tools (fetch_url, research_url, …) bucket by resource
    // identity so the agent can't escape loop detection by fetching the
    // same logical file via 8 different API endpoints. See loop-bucket.js.
    const errored = !!(result && (result.error || result.success === false));
    const argsHash = bucketArgsKey(name, args);
    const key = `${name}|${argsHash}|${errored ? 'err' : 'ok'}`;
    const buf = this.recentCalls.get(tabId) || [];
    buf.push({ key, name, ts: Date.now() });
    if (buf.length > 6) buf.shift();
    this.recentCalls.set(tabId, buf);
    return buf;
  }

  _detectLoop(buf) {
    if (!buf || buf.length < 3) return null;
    // 1. Same key 3+ times in the window.
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3) {
        return { type: 'repeat', key, name: key.split('|')[0], count: n };
      }
    }
    // 2. ABAB oscillation in the last 4.
    if (buf.length >= 4) {
      const last4 = buf.slice(-4);
      if (
        last4[0].key === last4[2].key &&
        last4[1].key === last4[3].key &&
        last4[0].key !== last4[1].key
      ) {
        return { type: 'oscillation', a: last4[0].name, b: last4[1].name };
      }
    }
    return null;
  }

  _clearLoopState(tabId) {
    this.recentCalls.delete(tabId);
    this.loopNudges.delete(tabId);
    this.healthyCallsSinceLoop.delete(tabId);
    this.recentCoordClicks.delete(tabId);
  }

  /**
   * Synthesize a transparent summary when the agent hits the step limit
   * without producing a final answer. Walks the conversation to count
   * tool usage and surface the last non-empty assistant message and the
   * last tool call, so the user sees WHY the run ended instead of an
   * empty `done` event. Pure deterministic — no extra LLM call.
   */
  _buildStepLimitSummary(messages, steps) {
    const toolCounts = new Map();
    let lastAssistantText = '';
    let lastToolCall = null;
    for (const m of messages) {
      if (m.role === 'assistant') {
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            const name = tc?.function?.name || tc?.name;
            if (name) {
              toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
              lastToolCall = { name, args: tc?.function?.arguments || tc?.arguments || '' };
            }
          }
        }
        if (typeof m.content === 'string' && m.content.trim()) {
          lastAssistantText = m.content;
        }
      }
    }
    const sortedTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([n, c]) => `${n} ×${c}`)
      .join(', ');
    const lastActionLine = lastToolCall
      ? `Last tool attempted: ${lastToolCall.name}${lastToolCall.args ? ' (' + String(lastToolCall.args).slice(0, 120) + ')' : ''}`
      : '';
    const lastTextSnippet = lastAssistantText
      ? `Last thing I said: "${lastAssistantText.slice(0, 280).replace(/\s+/g, ' ').trim()}${lastAssistantText.length > 280 ? '…' : ''}"`
      : '';
    return [
      `[Step limit reached after ${steps} steps without completing the task.`,
      sortedTools ? `Tools attempted: ${sortedTools}.` : '',
      lastActionLine,
      lastTextSnippet,
      'This usually means: (a) the task is too complex for the current model — try a stronger one, (b) the step limit is too low — raise it in Settings, or (c) the strategy was wrong — try breaking it into smaller parts.]',
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Coordinate-click loop detector. Buckets to nearest 5px so a click that
   * drifts by a pixel or two between attempts still hashes the same. Window
   * of 8 — generous, since the goal is to survive interleaved noise like
   * execute_js / type_text / read_page calls between coord retries.
   *
   * Returns 'nudge' on the 3rd repeat and 'stop' on the 5th. Gives the
   * agent more room to retry on pages with loading states or animations.
   */
  _checkCoordClickLoop(tabId, x, y) {
    const bx = Math.round(x / 5) * 5;
    const by = Math.round(y / 5) * 5;
    const key = `${bx},${by}`;
    const buf = this.recentCoordClicks.get(tabId) || [];
    buf.push({ key, ts: Date.now() });
    if (buf.length > 12) buf.shift();
    this.recentCoordClicks.set(tabId, buf);

    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    const n = counts.get(key) || 0;
    if (n >= 8) return { kind: 'stop', x: bx, y: by };
    if (n >= 5) return { kind: 'nudge', x: bx, y: by };
    return { kind: 'none' };
  }

  /**
   * Add a tab to the "WebBrain" tab group — reused by both the explicit
   * `new_tab` tool and the click handler's target=_blank redirect fallback.
   *
   * We look up the WebBrain group by title within the source tab's
   * window rather than by source-tab-membership: if the source is in a
   * user-owned group (e.g. "Dev", "Research"), we don't drag agent-
   * spawned tabs into that group. The user's own grouping stays intact;
   * agent outputs live in their own WebBrain group.
   *
   * If no WebBrain group exists yet for the window, we create a fresh one
   * containing only the new tab (NOT the source tab) — leaving the
   * source where the user put it. Background.js's action.onClicked
   * handler is the canonical place that opts the source tab into the
   * group, via `ensureWebBrainGroup`.
   *
   * Returns the group id (or -1 if grouping isn't supported / failed).
   */
  /**
   * Decide whether `pageUrl` is a PDF tab the content-script path
   * cannot reach. Two paths:
   *   - Fast path: URL pattern (`isPdfUrl`). Catches `*.pdf` paths and
   *     `?file=*.pdf` viewer URLs — the bulk of cases.
   *   - Slow path: HEAD probe with credentials. Catches PDFs served
   *     from endpoints whose URL doesn't reveal the type, e.g.
   *     `/download?id=42` returning `Content-Type: application/pdf`.
   *
   * Result is cached per `(tabId, pageUrl)` so we probe at most once
   * per tab+URL combination. The cache is invalidated implicitly when
   * the URL changes (next `_isPdfTab` call sees a different URL and
   * re-probes).
   *
   * Failure modes:
   *   - HEAD blocked / 405 / network error → assume non-PDF, fall
   *     through to existing content-script path. Worst case we don't
   *     redirect; same outcome as before this fix.
   *   - chrome:// / about:// / non-http(s) URLs → fast path returns
   *     false, no probe attempted.
   */
  async _isPdfTab(tabId, pageUrl) {
    if (!pageUrl) return false;
    if (isPdfUrl(pageUrl)) return true;

    // Cache hit?
    const cached = this._isPdfTabCache.get(tabId);
    if (cached && cached.url === pageUrl) return cached.isPdf;

    // Only probe http(s). Other schemes can't be PDF tabs we'd want to
    // route to read_pdf, and a fetch against chrome:// or about:// just
    // throws.
    let isPdf = false;
    if (/^https?:/i.test(pageUrl)) {
      try {
        const res = await fetch(pageUrl, {
          method: 'HEAD',
          credentials: 'include',
        });
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('application/pdf')) isPdf = true;
      } catch { /* fall through with isPdf = false */ }
    }

    this._isPdfTabCache.set(tabId, { url: pageUrl, isPdf });
    return isPdf;
  }

  async _addToWebBrainGroup(sourceTab, tabId) {
    if (!chrome.tabGroups || !sourceTab?.id || tabId == null) return -1;
    try {
      // Find an existing WebBrain group in this window, if any.
      let existing = null;
      try {
        const groups = await chrome.tabGroups.query({
          title: 'WebBrain',
          windowId: sourceTab.windowId,
        });
        if (Array.isArray(groups) && groups.length > 0) existing = groups[0];
      } catch { /* tabGroups.query unsupported on very old Chromes */ }

      if (existing) {
        await chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] });
        return existing.id;
      }

      // No WebBrain group yet — create one with just the new tab. We
      // deliberately do NOT include sourceTab here, because if the user
      // put it in their own "Dev" group, pulling it out is hostile.
      // The first action.onClicked elsewhere will opt the source tab in.
      const gid = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(gid, {
        title: 'WebBrain', color: 'blue', collapsed: false,
      });
      return gid;
    } catch (_) { return -1; }
  }

  /**
   * target="_blank" redirect. After a click that looks like it may have
   * opened a new tab (most news sites, Reddit, Google results all force
   * `target="_blank"`), we detect the spawned tab, close it, and reroute
   * the URL into the source tab so the agent's next screenshot actually
   * reflects the content it tried to open. Without this the model gets
   * stuck clicking the same headline forever while tabs pile up off-screen
   * (see qwen3.6 Strait-of-Hormuz trace).
   *
   * `beforeTabIds` is a Set of tab ids captured right before the click
   * dispatch. Any tab created after, with openerTabId matching our source
   * tab, is treated as the click's target. We poll briefly because
   * `tabs.onCreated` fires before the URL has resolved in some flows.
   *
   * Returns { redirected: true, url, closedTabId } on redirect, else null.
   */
  async _redirectTargetBlankClick(tabId, beforeTabIds) {
    try {
      let newTab = null;
      // Poll for up to ~900ms — the new tab needs a few ticks to appear
      // and for Chrome to populate its URL past about:blank.
      for (let i = 0; i < 9; i++) {
        await new Promise(r => setTimeout(r, 100));
        const all = await chrome.tabs.query({});
        const candidate = all.find(t =>
          t.id !== tabId &&
          t.openerTabId === tabId &&
          !beforeTabIds.has(t.id)
        );
        if (candidate) {
          const url = candidate.pendingUrl || candidate.url || '';
          // Wait a tick more if the URL hasn't resolved past about:blank.
          if (url && url !== 'about:blank' && !url.startsWith('chrome://newtab')) {
            newTab = candidate;
            break;
          }
          // Keep polling so we can capture the real URL once the tab commits.
          newTab = candidate;
        }
      }
      if (!newTab) return null;
      const targetUrl = newTab.pendingUrl || newTab.url || '';
      if (!targetUrl || targetUrl === 'about:blank' || targetUrl.startsWith('chrome://newtab')) {
        // We saw a new tab but never got a real URL out of it. Close it
        // and move on — redirecting to about:blank would make things worse.
        try { await chrome.tabs.remove(newTab.id); } catch {}
        return null;
      }
      const closedTabId = newTab.id;
      try { await chrome.tabs.remove(newTab.id); } catch {}
      try { await chrome.tabs.update(tabId, { url: targetUrl }); } catch {}
      // Give the source tab a beat to commit the navigation so follow-up
      // screenshots/reads don't race the load.
      await new Promise(r => setTimeout(r, 600));
      return { redirected: true, url: targetUrl, closedTabId };
    } catch (_) {
      return null;
    }
  }

  /**
   * Run loop detection on a freshly recorded call. Returns one of:
   *   { kind: 'none' }
   *   { kind: 'nudge', warning: string }   // soft warning to inject into tool result
   *   { kind: 'stop',  message: string }   // hard stop, abort the run
   */
  _checkLoop(tabId, toolName, toolArgs, toolResult) {
    const buf = this._recordCall(tabId, toolName, toolArgs, toolResult);
    const loop = this._detectLoop(buf);
    if (!loop) {
      // Healthy, non-looping call. We don't reset the nudge counter
      // immediately — that would let the agent escape detection by
      // doing one read_page between two stuck clicks. Only reset after
      // a sustained run of healthy calls (a full window's worth).
      const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
      this.healthyCallsSinceLoop.set(tabId, healthy);
      if (healthy >= 2) {
        this.loopNudges.delete(tabId);
        this.healthyCallsSinceLoop.delete(tabId);
      }
      return { kind: 'none' };
    }

    // Any new loop detection resets the healthy-streak counter.
    this.healthyCallsSinceLoop.delete(tabId);
    const nudges = (this.loopNudges.get(tabId) || 0) + 1;
    this.loopNudges.set(tabId, nudges);

    if (nudges >= 8) {
      this._clearLoopState(tabId);
      const desc = loop.type === 'repeat'
        ? `the same call to ${loop.name}`
        : `between ${loop.a} and ${loop.b}`;
      return {
        kind: 'stop',
        message: `Stopped: I detected I was looping on ${desc} without making progress after multiple warnings. Please tell me what's blocking, give me a different instruction, or take a look at the page yourself.`,
      };
    }

    const warning = loop.type === 'repeat'
      ? `[LOOP DETECTED: You've just called ${loop.name} ${loop.count} times with the same arguments and the same outcome. The current approach is NOT working. Try something fundamentally different: a different selector, a different tool, scroll to find a different element, or take a screenshot to see what's actually on screen. DO NOT repeat this exact call again — try a creative alternative.]`
      : `[LOOP DETECTED: You're oscillating between ${loop.a} and ${loop.b} without making progress. Stop. Take a screenshot to see what's actually happening, then try a completely different approach.]`;
    return { kind: 'nudge', warning };
  }

  // Tools whose successful completion should trigger an auto-screenshot when
  // the corresponding mode is active.
  static NAV_TOOLS = new Set(['navigate', 'new_tab']);
  static STATE_CHANGE_TOOLS = new Set(['navigate', 'new_tab', 'click', 'type_text', 'press_keys', 'scroll', 'hover', 'drag_drop']);

  // System prompt for the dedicated "vision model" sub-call. Kept terse and
  // format-oriented so the description is actually useful to the planning
  // model — free-form captioning ("a modern-looking login page") is worse
  // than useless. Update with care; this is the main quality lever for the
  // split-provider mode.
  static VISION_SYSTEM_PROMPT = `You are the vision subsystem of a web-automation agent. A screenshot of the current browser viewport is attached. Describe what is on screen so the planning agent can decide its next action.

Format — keep it terse, structured, no flowery prose:

1) Page purpose: one line (e.g. "GitHub repo issue list", "Gmail compose", "Stripe checkout form").
2) Visible text: list the EXACT strings on buttons, links, headings, tabs, and menu items. Quote them verbatim. Do not paraphrase.
3) Inputs: list each visible form field with its label, placeholder, current value, and whether it is focused/disabled.
4) State signals: loading spinners, toasts, modals, error banners, success messages, CAPTCHAs, cookie/consent banners, overlays.
5) Blockers: anything that would prevent the next likely action (overlay, disabled submit, missing data, auth prompt).
6) Unknowns: if you cannot read something clearly, say so. Do not guess numbers, names, or identifiers.

Rules: no prose intro, no conclusion, no "this screenshot shows...", no layout description unless it matters (e.g. "left nav is collapsed"). If the page is blank or still loading, say that in one line and stop.`;

  /**
   * Strip chain-of-thought preambles from a vision model's response.
   *
   * Reasoning models (Qwen3/3.5, DeepSeek-R1, etc.) often emit planning text
   * before the real answer — either wrapped in <think>...</think> tags or as
   * plain prose restating the task ("The user wants..."). Our vision prompt
   * asks for a numbered list starting with "1)", so everything before the
   * first list marker is preamble and can be discarded.
   */
  static _cleanVisionDescription(raw) {
    if (!raw) return '';
    let s = String(raw);
    // Drop any <think>...</think> blocks (some servers surface them verbatim).
    s = s.replace(/<think[\s\S]*?<\/think>/gi, '');
    // Trim to the first numbered list marker ("1)" or "1." or "**1"), which
    // matches the format our system prompt asks for.
    const markerRe = /(^|\n)\s*(?:\*\*)?1[.)][\s\S]/;
    const m = s.match(markerRe);
    if (m && m.index != null) {
      const cut = m.index + (m[1] ? m[1].length : 0);
      s = s.slice(cut);
    }
    return s.trim();
  }

  /**
   * Decide whether to capture an auto-screenshot after a tool call, based on
   * the current setting and which tool ran.
   */
  _shouldAutoScreenshot(toolName) {
    const mode = this.autoScreenshot;
    if (mode === 'off' || !mode) return false;
    if (mode === 'every_step') return true;
    if (mode === 'state_change') return Agent.STATE_CHANGE_TOOLS.has(toolName);
    if (mode === 'navigation') return Agent.NAV_TOOLS.has(toolName);
    return false;
  }

  /**
   * Capture a viewport JPEG screenshot via CDP and return a data URL, or null
   * if capture fails. JPEG @ q60 keeps tokens reasonable (~1k–2k per image).
   */
  /**
   * Attach the current page's URL/title to every user message so deictic
   * phrases like "this page" resolve to the active tab, not an older page
   * mentioned earlier in the thread. The heavier screenshot context is still
   * limited to the first real user turn.
   */
  async _enrichUserMessageWithCurrentPage(tabId, messages, userMessage) {
    const hasPriorUserTurn = messages.some(m => m.role === 'user');

    // Collect URL + title via chrome.tabs (cheap, no debugger needed).
    let url = '';
    let title = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab?.url || '';
      title = tab?.title || '';
    } catch (e) { /* ignore */ }

    let contextLine = url
      ? `[Current page context — applies to this user message and supersedes older page context for phrases like "this page". URL: ${url}${title ? ` — Title: ${title}` : ''}]\n\n`
      : '';

    // API mutation override: prepend a strong note when the user has set
    // /allow-api for this tab. Inject only once per "allowed run" to avoid
    // bloating every subsequent turn.
    if (this.apiAllowedTabs.has(tabId) && !this.apiAllowedInjected.has(tabId)) {
      contextLine += `[USER OVERRIDE — /allow-api: For this conversation the user has explicitly authorized you to use API mutations (POST/PUT/PATCH/DELETE via fetch_url) when you judge API to be more reliable than UI for a specific step. The default UI-first rule still applies — only reach for the API when UI has actually failed or is genuinely unworkable. Before any destructive API call (anything that creates, deletes, transfers, or charges), state the URL, method, and payload in plain text in your response so the user can see what you're about to do.]\n\n`;
      this.apiAllowedInjected.add(tabId);
    }

    // Site adapter notes: if the URL matches a known site, inject the
    // non-obvious quirks the model would otherwise have to discover by trial.
    if (this.useSiteAdapters && url) {
      const adapter = getActiveAdapter(url);
      const currentName = adapter ? adapter.name : null;
      const lastName = this.lastSeenAdapter.get(tabId) || null;
      const shouldInjectAdapter = !hasPriorUserTurn || currentName !== lastName;
      // Always remember the current adapter (or null) so mid-conversation
      // re-injection can detect a real change.
      this.lastSeenAdapter.set(tabId, currentName);
      if (adapter && shouldInjectAdapter) {
        const heading = adapter.category === 'finance'
          ? `[Site guidance for ${adapter.name} — FINANCE / HIGH-STAKES]`
          : `[Site guidance for ${adapter.name}]`;
        contextLine += `${heading}\n${adapter.notes.trim()}\n\n`;
      }
    }

    if (hasPriorUserTurn) {
      return { role: 'user', content: contextLine + userMessage };
    }

    // Determine vision capability: either a dedicated vision model is
    // configured (routes screenshots there, text to main), or the main
    // provider itself supports images. Without either, plain text context.
    const provider = this.providerManager.getActive();
    const visionProvider = await this.providerManager.getVisionProvider();
    if (!provider.supportsVision && !visionProvider) {
      return { role: 'user', content: contextLine + userMessage };
    }

    const shot = await this._captureAutoScreenshot(tabId);
    if (!shot) {
      return { role: 'user', content: contextLine + userMessage };
    }

    // Vision-model path: sub-call the dedicated vision model, drop a text
    // description into the first user message so the main provider never
    // sees the raw pixels.
    if (visionProvider) {
      const desc = await this._describeScreenshot(tabId, shot.dataUrl, 'initial_user_message');
      if (desc) {
        const visionBlock = `[Initial viewport description (from vision model ${desc.model}):\n${desc.text}\n]\n\n`;
        return { role: 'user', content: contextLine + visionBlock + userMessage };
      }
      // Sub-call failed. Fall back to raw image iff the main provider can
      // read images; otherwise drop the screenshot entirely.
      if (!provider.supportsVision) {
        return { role: 'user', content: contextLine + userMessage };
      }
    }

    // Raw-image path (main provider supports vision and no vision sub-call).
    const screenshotNote = `[Initial viewport screenshot follows (native device resolution for visual fidelity — pixel coordinates on the image are NOT CSS pixels). Prefer click_ax({ref_id}) after get_accessibility_tree. If you must use click({x,y}), first call screenshot({coord_aligned: true}) to get a CSS-pixel-aligned capture whose image pixels match click coordinates.]\n\n`;

    return {
      role: 'user',
      content: [
        { type: 'text', text: contextLine + screenshotNote + userMessage },
        { type: 'image_url', image_url: { url: shot.dataUrl } },
      ],
    };
  }

  /**
   * After the first turn, the user may navigate or open a new site that has
   * a different adapter than the one used at conversation start. Detect that
   * and inject a fresh "Site context changed" message so the new adapter's
   * notes show up in the model's context for the next LLM call.
   *
   * Returns true if a re-injection happened (so callers can persist).
   */
  async _maybeReinjectAdapter(tabId, messages) {
    if (!this.useSiteAdapters) return false;
    let url = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab?.url || '';
    } catch (e) { return false; }
    if (!url) return false;

    const adapter = getActiveAdapter(url);
    const lastName = this.lastSeenAdapter.get(tabId) || null;
    const currentName = adapter ? adapter.name : null;

    if (currentName === lastName) return false;
    this.lastSeenAdapter.set(tabId, currentName);

    if (!adapter) return false; // moved off an adapted site → no inject needed

    const heading = adapter.category === 'finance'
      ? `[Site context changed → now on ${adapter.name} — FINANCE / HIGH-STAKES. Apply these rules from now on:]`
      : `[Site context changed → now on ${adapter.name}. Apply these notes from now on:]`;
    messages.push({
      role: 'user',
      content: `${heading}\n${adapter.notes.trim()}`,
    });
    return true;
  }

  /**
   * Cheap helper to read the current URL of a tab without throwing.
   */
  async _currentUrl(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab?.url || '';
    } catch (e) { return ''; }
  }

  /**
   * Strip query params + hash for "did the URL meaningfully change" comparison.
   * Lets things like ?utm_source=... or hash anchors slide without triggering
   * the navigation notice, while still catching real route changes.
   */
  _normalizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) { return url; }
  }

  /**
   * Execute one assistant turn's worth of tool calls. Both the non-streaming
   * and streaming paths call this so they share identical loop-detection,
   * persistence, and auto-screenshot behavior.
   *
   * Returns one of:
   *   { action: 'continue' }                  → caller should `continue` the LLM loop
   *   { action: 'return',   value: string }   → caller should return immediately
   *   { action: 'abort' }                     → user requested abort mid-batch
   */
  async _executeToolBatch(tabId, toolCalls, messages, onUpdate, provider, partialAssistantText = null) {
    let didStateChange = false;
    // Set of tools whose side effect can navigate the page. We snapshot the
    // URL before these and re-check after, so we can warn the model when an
    // unintended navigation happens (the most common cause of "model keeps
    // executing the original plan on a totally different page").
    const NAV_PRONE_TOOLS = new Set(['click', 'navigate', 'iframe_click']);
    const navNotices = []; // accumulated for injection after the loop

    for (const tc of toolCalls) {
      // Abort check before each tool call.
      if (this._checkAbort(tabId)) {
        const value = partialAssistantText || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        return { action: 'return', value };
      }

      const fnName = tc.function.name;
      let fnArgs;
      try {
        fnArgs = typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch {
        fnArgs = {};
      }

      // Snapshot URL before nav-prone tools.
      let beforeUrl = '';
      if (NAV_PRONE_TOOLS.has(fnName)) {
        beforeUrl = await this._currentUrl(tabId);
      }

      onUpdate('tool_call', { name: fnName, args: fnArgs });
      const _toolStart = Date.now();
      const toolResult = await this.executeTool(tabId, fnName, fnArgs, onUpdate);
      const _toolLatency = Date.now() - _toolStart;
      onUpdate('tool_result', { name: fnName, result: toolResult });
      const _runIdForTool = this.currentRunId.get(tabId);
      if (_runIdForTool) {
        trace.recordToolCall(_runIdForTool, null, {
          name: fnName, args: fnArgs, result: toolResult, latencyMs: _toolLatency,
        });
      }

      // Detect unintended navigation. Give the page a beat to fire SPA
      // history events / commit a real nav before re-reading the URL.
      if (NAV_PRONE_TOOLS.has(fnName) && beforeUrl && !toolResult?.error) {
        await new Promise(r => setTimeout(r, 200));
        const afterUrl = await this._currentUrl(tabId);
        const beforeNorm = this._normalizeUrl(beforeUrl);
        const afterNorm = this._normalizeUrl(afterUrl);
        if (beforeNorm && afterNorm && beforeNorm !== afterNorm) {
          // The `navigate` tool intentionally goes somewhere — don't warn.
          // For everything else (click, execute_js, iframe_click) the nav
          // is a side effect the model may not have anticipated.
          if (fnName !== 'navigate') {
            navNotices.push({ before: beforeUrl, after: afterUrl, viaTool: fnName });
          }
        }
      }

      // done() short-circuit — push result, persist, and bail out.
      if (toolResult && toolResult.done) {
        const finalResponse = toolResult.summary || partialAssistantText || 'Task completed.';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: this._limitToolResult(toolResult),
        });
        this._persist(tabId);
        return { action: 'return', value: finalResponse };
      }

      // Loop detection — two parallel checks, strongest action wins.
      const loopCheck = this._checkLoop(tabId, fnName, fnArgs, toolResult);
      let coordCheck = { kind: 'none' };
      if (fnName === 'click' && fnArgs?.x != null && fnArgs?.y != null) {
        coordCheck = this._checkCoordClickLoop(tabId, fnArgs.x, fnArgs.y);
      }

      // Combine: stop > nudge > none.
      let effectiveKind = 'none';
      let nudgeWarning = '';
      let stopMessage = '';
      if (loopCheck.kind === 'stop' || coordCheck.kind === 'stop') {
        effectiveKind = 'stop';
        if (coordCheck.kind === 'stop') {
          // Show the model's actual args, not _checkCoordClickLoop's 5px
          // bucket — for fractional inputs like (0.911, 0.331) the bucket
          // rounds to (0, 0) and the message reads as if we'd clicked the
          // top-left corner, hiding what really happened.
          stopMessage = `Stopped: I clicked at (or near) coordinates (${fnArgs.x}, ${fnArgs.y}) multiple times and the page never responded. That position is hitting empty space, an overlay, or the wrong element. Please give a different instruction or check the page yourself.`;
        } else {
          stopMessage = loopCheck.message;
        }
      } else if (loopCheck.kind === 'nudge' || coordCheck.kind === 'nudge') {
        effectiveKind = 'nudge';
        if (coordCheck.kind === 'nudge') {
          nudgeWarning = `[COORDINATE CLICK WARNING: You've clicked at or near (${fnArgs.x}, ${fnArgs.y}) several times with no visible page change. The click may be missing its target. Try: (a) call get_interactive_elements to find a real selector, (b) click({text: "..."}) to target by visible text, or (c) take a fresh screenshot and look more carefully at element positions. Try a different approach before clicking these coordinates again.]`;
        } else {
          nudgeWarning = loopCheck.warning;
        }
      }

      // Strip `_attachImage` out of the tool result BEFORE stringifying —
      // otherwise `_limitToolResult` would try to embed the whole dataUrl in
      // the tool-result text and `_limitToolResult` would chop it to garbage.
      // The image goes on a follow-up user message instead (see below).
      let attachedImage = null;
      if (toolResult && typeof toolResult === 'object' && toolResult._attachImage) {
        attachedImage = toolResult._attachImage;
        delete toolResult._attachImage;
      }

      // Same pattern for `_attachDocument` — Anthropic Claude can natively
      // consume PDFs as a `document` content block on a user message. We
      // attach the raw bytes (built into a content block by pdf-tools.js)
      // here and let Claude see the full layout/images, while the tool
      // result text still contains the plain-text extraction so the model
      // can quote/reference specific passages without re-reading.
      let attachedDocument = null;
      if (toolResult && typeof toolResult === 'object' && toolResult._attachDocument) {
        attachedDocument = toolResult._attachDocument;
        delete toolResult._attachDocument;
      }

      let resultContent = this._limitToolResult(toolResult);
      if (effectiveKind === 'nudge') {
        resultContent = resultContent + '\n' + nudgeWarning;
        onUpdate('warning', { message: 'Loop detected — nudging the agent.' });
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultContent,
      });

      // Follow-up image attachment. Vision endpoints need the image as an
      // `image_url` block on a user message — an inline dataUrl inside a
      // tool-result's JSON text never gets decoded. Mirrors the auto-
      // screenshot raw-image path above.
      if (attachedImage) {
        const noteText = `[Screenshot from your ${fnName} call. Image is a PNG at native device resolution (image pixels are NOT CSS pixels — use click_ax / click({text}) over pixel clicks). Use it to decide the next action.]`;
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: noteText },
            { type: 'image_url', image_url: { url: attachedImage } },
          ],
        });
        const _runIdForShot = this.currentRunId.get(tabId);
        if (_runIdForShot) {
          trace.recordScreenshot(_runIdForShot, null, attachedImage, `screenshot-tool:${fnName}`);
        }
      }

      // Document attachment for Claude PDF passthrough. The block is an
      // Anthropic `document` content block (built in pdf-tools.js) that we
      // hand to the model as a user message. anthropic.js translates our
      // generic message shape into Anthropic's API shape and forwards the
      // block as-is.
      if (attachedDocument) {
        const docTitle = attachedDocument.title || 'document.pdf';
        const noteText = `[PDF document "${docTitle}" attached from your ${fnName} call. The plain-text extraction is in the tool result above; this attachment lets you also see the original layout, tables, and embedded images. Use both — quote text from the extraction, reference visuals from the document.]`;
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: noteText },
            attachedDocument,
          ],
        });
      }

      if (effectiveKind === 'stop') {
        messages.push({ role: 'assistant', content: stopMessage });
        onUpdate('text', { content: stopMessage });
        onUpdate('error', { message: 'Stuck in a loop. Stopped.' });
        this._clearLoopState(tabId);
        this._persist(tabId);
        return { action: 'return', value: stopMessage };
      }

      if (this._shouldAutoScreenshot(fnName) && !toolResult?.error) {
        didStateChange = true;
      }
    }

    // Inject any navigation notices BEFORE the auto-screenshot, so the
    // model sees the warning and the new viewport in the same turn.
    if (navNotices.length > 0) {
      const last = navNotices[navNotices.length - 1];
      const noticeText =
        `[NAVIGATION OCCURRED — the page changed as a side effect of your last action.\n` +
        `  Was on: ${last.before}\n` +
        `  Now on: ${last.after}\n` +
        `  Triggered by: ${last.viaTool}\n` +
        `\n` +
        `The previous page is GONE. Any plan you had for that page no longer applies. ` +
        `DO NOT continue executing steps from the previous page's plan — those elements no longer exist. ` +
        `STOP, take a fresh screenshot, call get_interactive_elements, decide whether this new page is what you wanted, ` +
        `and re-plan from scratch. If this navigation was unintended (you clicked the wrong thing), navigate back ` +
        `with \`navigate({url: "${last.before}"})\` and try a more specific click.]`;
      messages.push({ role: 'user', content: noticeText });
      onUpdate('warning', { message: 'Page navigated unexpectedly — agent notified.' });
    }

    // Auto-screenshot once per batch, debounced 500ms. Capture if either
    // the main provider supports images, or a dedicated vision model is
    // configured to describe them.
    const visionProvider = await this.providerManager.getVisionProvider();
    if (didStateChange && (provider.supportsVision || visionProvider)) {
      const lastTs = this.lastAutoScreenshotTs.get(tabId) || 0;
      if (Date.now() - lastTs >= 500) {
        await new Promise(r => setTimeout(r, 250));
        const shot = await this._captureAutoScreenshot(tabId);
        if (shot) {
          this.lastAutoScreenshotTs.set(tabId, Date.now());
          // Pair the image with a textual list of visible clickables so
          // the model can ground "the Publish button" by name instead of
          // guessing pixels — fixes the "click landed on the wrong thing"
          // failure mode for local vision models.
          const visible = await this._getVisibleInteractiveElements(tabId);
          const elementsText = this._formatElementsList(visible);
          let pushed = false;

          // Vision-model path: describe the screenshot, push only text.
          if (visionProvider) {
            const desc = await this._describeScreenshot(tabId, shot.dataUrl, 'auto_screenshot');
            if (desc) {
              const textBlock = `[Auto-screenshot description (from vision model ${desc.model}) after the action above:\n${desc.text}\n]${elementsText}`;
              messages.push({ role: 'user', content: textBlock });
              pushed = true;
            } else if (!provider.supportsVision) {
              // Sub-call failed and main provider can't read images — drop
              // the screenshot, but still give the model the elements list
              // so it has SOMETHING to ground on.
              if (elementsText) {
                messages.push({ role: 'user', content: `[Auto-screenshot after the action above — vision sub-call failed, image omitted.]${elementsText}` });
                pushed = true;
              }
            }
          }

          // Raw-image path (no vision provider, or sub-call fallback).
          if (!pushed && provider.supportsVision) {
            const textBlock = `[Auto-screenshot of current viewport after the action above (native device resolution for visual fidelity — image pixels are NOT CSS pixels). Use this to confirm the result and plan the next step. Prefer click_ax({ref_id}) after get_accessibility_tree, or click({text:"..."}). If you must use click({x,y}), call screenshot({coord_aligned: true}) first to get a CSS-pixel-aligned image.]${elementsText}`;
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: textBlock },
                { type: 'image_url', image_url: { url: shot.dataUrl } },
              ],
            });
            pushed = true;
          }

          if (pushed) {
            onUpdate('tool_call', { name: 'auto_screenshot', args: {} });
            onUpdate('tool_result', { name: 'auto_screenshot', result: { success: true, bytes: shot.dataUrl.length, elements: visible.length } });
            const _runIdForShot = this.currentRunId.get(tabId);
            if (_runIdForShot) {
              trace.recordScreenshot(_runIdForShot, null, shot.dataUrl, 'auto-screenshot after tool batch');
            }
          }
        }
      }
    }

    this._persist(tabId);
    return { action: 'continue' };
  }

  /**
   * Quick scan of visible interactive elements with their CSS-pixel
   * positions, used to annotate screenshots. The model gets BOTH the image
   * and a compact list of what's clickable where, so it can resolve "the
   * Publish button" without guessing pixels — just by name.
   */
  async _getVisibleInteractiveElements(tabId) {
    // Element cap: 25 for all providers. (Compact-prompt check disabled
    // while compact prompts are globally off.)
    let maxElements = 25;

    try {
      const result = await cdpClient.evaluate(tabId, `
        (() => {
          const maxEl = ${maxElements};
          const sels = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), textarea, select, summary, [onclick]';
          const all = Array.from(document.querySelectorAll(sels));
          const out = [];
          // Prioritize form inputs and buttons over links — they're more
          // likely to be the target of an action.
          const prioritized = all.sort((a, b) => {
            const aIsInput = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/i.test(a.tagName) || a.getAttribute('role') === 'button';
            const bIsInput = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/i.test(b.tagName) || b.getAttribute('role') === 'button';
            if (aIsInput && !bIsInput) return -1;
            if (!aIsInput && bIsInput) return 1;
            return 0;
          });
          // Helper: find the visible label associated with a form element.
          function getLabel(el) {
            // 1. Explicit <label for="...">
            if (el.id) {
              const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (lbl) return lbl.innerText.trim().slice(0, 40);
            }
            // 2. Wrapping <label>
            const parent = el.closest('label');
            if (parent) {
              const t = parent.innerText.trim().slice(0, 40);
              if (t && t !== (el.value || '').trim()) return t;
            }
            // 3. aria-label / aria-labelledby
            if (el.ariaLabel) return el.ariaLabel.trim().slice(0, 40);
            if (el.getAttribute('aria-labelledby')) {
              const lbl = document.getElementById(el.getAttribute('aria-labelledby'));
              if (lbl) return lbl.innerText.trim().slice(0, 40);
            }
            // 4. Preceding sibling or parent text that looks like a label
            const prev = el.previousElementSibling;
            if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
              const t = prev.innerText.trim().slice(0, 40);
              if (t && t.length < 40) return t;
            }
            // 5. name attribute as last resort
            if (el.name) return el.name;
            return '';
          }

          for (const el of prioritized) {
            let r = el.getBoundingClientRect();
            // If element has zero dimensions, try label/wrapper rect instead
            // (Stripe, Radix, Material use hidden inputs inside styled wrappers)
            if ((r.width === 0 || r.height === 0) && /^(INPUT|SELECT|TEXTAREA)$/i.test(el.tagName)) {
              let fallback = null;
              if (el.id) {
                try {
                  const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                  if (lbl) { const lr = lbl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fallback = lr; }
                } catch {}
              }
              if (!fallback) {
                const wl = el.closest('label');
                if (wl) { const lr = wl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fallback = lr; }
              }
              if (!fallback) {
                let p = el.parentElement;
                for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                  const pr = p.getBoundingClientRect();
                  if (pr.width > 0 && pr.height > 0) { fallback = pr; break; }
                }
              }
              if (fallback) r = fallback; else continue;
            } else if (r.width === 0 || r.height === 0) {
              continue;
            }
            if (r.bottom < 0 || r.top > window.innerHeight) continue;
            if (r.right < 0 || r.left > window.innerWidth) continue;
            const text = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().slice(0, 50);
            if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') continue;

            // For form fields, include the label so the model knows what the field is for.
            let label = '';
            if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
              label = getLabel(el);
            }

            const entry = {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              text: text || \`<\${el.tagName.toLowerCase()}>\`,
            };
            if (label) entry.label = label;
            out.push(entry);
            if (out.length >= maxEl) break;
          }
          return out;
        })()
      `);
      return result?.result?.value || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Auto-select a <select> option by keyboard arrows.
   * Scans ALL selects on the page. If `optionText` matches a non-current
   * option, focuses that select, sends ArrowDown/Up via CDP, verifies,
   * and returns a success result.  Returns null if no match found.
   *
   * When `optionText` matches the ALREADY-SELECTED option, returns a
   * result telling the agent it's already set (no action needed).
   */
  async _autoSelectOption(tabId, cdpClient, optionText) {
    const needle = (optionText || '').trim();
    if (!needle) return null;
    const scanResult = await cdpClient.evaluate(tabId, `
      (() => {
        const needle = ${JSON.stringify(needle)};
        const lc = needle.toLowerCase();
        const sels = document.querySelectorAll('select');
        for (const sel of sels) {
          const opts = Array.from(sel.options);
          const match = opts.find(o => o.text.trim() === needle)
            || opts.find(o => o.text.trim().toLowerCase() === lc)
            || opts.find(o => o.value === needle)
            || opts.find(o => o.value.toLowerCase() === lc);
          if (match) {
            sel.focus();
            const cur = sel.selectedIndex;
            return {
              found: true,
              alreadySelected: cur === match.index,
              currentIndex: cur,
              targetIndex: match.index,
              targetText: match.text.trim(),
              targetValue: match.value,
              currentText: sel.options[cur]?.text?.trim() || '',
              allOptions: opts.map(o => o.text.trim()),
            };
          }
        }
        return { found: false };
      })()
    `);
    const scan = scanResult?.result?.value;
    if (!scan?.found) return null;

    if (scan.alreadySelected) {
      return {
        success: true,
        method: 'select-already-set',
        selectedText: scan.targetText,
        selectedValue: scan.targetValue,
        note: `"${scan.targetText}" is already selected. Available options: ${scan.allOptions.join(', ')}`,
      };
    }

    // Close any open native dropdown
    await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    // Re-focus the select (Escape may have blurred it)
    await cdpClient.evaluate(tabId, `
      (() => {
        const el = document.activeElement;
        if (el && el.tagName === 'SELECT') return;
        const sels = document.querySelectorAll('select');
        for (const sel of sels) {
          const opts = Array.from(sel.options);
          if (opts.some(o => o.text.trim() === ${JSON.stringify(needle)} || o.text.trim().toLowerCase() === ${JSON.stringify(needle.toLowerCase())})) {
            sel.focus(); return;
          }
        }
      })()
    `);

    // Navigate with ArrowDown/ArrowUp
    const delta = scan.targetIndex - scan.currentIndex;
    const arrowKey = delta > 0 ? 'ArrowDown' : 'ArrowUp';
    const arrowVK = delta > 0 ? 40 : 38;
    for (let i = 0; i < Math.abs(delta); i++) {
      await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: arrowKey, code: arrowKey, windowsVirtualKeyCode: arrowVK,
      });
      await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: arrowKey, code: arrowKey, windowsVirtualKeyCode: arrowVK,
      });
    }

    // Verify
    const verify = await cdpClient.evaluate(tabId, `
      (() => {
        const el = document.activeElement;
        if (!el || el.tagName !== 'SELECT') return { verified: false };
        return { verified: true, selectedText: el.options[el.selectedIndex]?.text?.trim(), selectedValue: el.value };
      })()
    `);
    const v = verify?.result?.value;

    return {
      success: true,
      method: 'auto-select-keyboard',
      selectedText: v?.selectedText || scan.targetText,
      selectedValue: v?.selectedValue || scan.targetValue,
      keyPresses: Math.abs(delta),
    };
  }

  /**
   * Format interactive elements as a compact text block for inclusion in
   * the screenshot's accompanying message.
   */
  _formatElementsList(elements) {
    if (!elements || elements.length === 0) return '';
    const lines = elements.map(e => {
      const tagInfo = e.type ? `${e.tag}[${e.type}]` : e.tag;
      let line = `  (${e.x},${e.y}) ${tagInfo} "${e.text}"`;
      if (e.label) line += ` [${e.label}]`;
      if (e.tag === 'select') line += ' ← use type_text to change';
      return line;
    });
    return `\nVisible interactive elements at these positions (use these names with click({text:"..."}) — much more reliable than guessing coordinates from the image):\n${lines.join('\n')}`;
  }

  /**
   * Capture a viewport JPEG via CDP. Defaults to native surface resolution
   * (CSS pixels × devicePixelRatio) because the primary click path is now
   * `click_ax({ref_id})` — higher-fidelity screenshots help the model read
   * small text and tight UI, and coordinate-accuracy doesn't matter when
   * clicks resolve through accessibility-tree ref_ids.
   *
   * For the legacy pixel-click path (`click({x, y})`), set `coordAligned:
   * true` to pin the capture to CSS pixels (scale=1). With `fromSurface:
   * true`, the default capture is at surface resolution — but
   * `Input.dispatchMouseEvent` interprets coordinates as CSS pixels, so on
   * a DPR=2 display a click at "pixel (400,300) from a native capture"
   * would land at (200,150). Forcing `clip.scale=1` produces an image
   * where pixel-(X,Y) maps exactly to CSS-(X,Y). The `screenshot` tool
   * exposes this via the `coord_aligned` parameter.
   *
   * Returns { dataUrl, width, height } (in image pixels) or null.
   */
  /**
   * Wrap a screenshot capture in messages that ask the agent-visual-
   * indicator content script to hide its pulsing border + Stop button
   * for the duration of the capture. Without this, the agent's own
   * indicator gets baked into every screenshot it sends to the vision
   * model — which is both ugly and a small token-budget tax.
   *
   * Best-effort: if the content script isn't loaded (chrome:// /
   * chrome-extension:// / file:// pages), the sendMessage rejects and
   * we capture as-is. Same on tabs the user opened before the extension
   * had a chance to inject.
   */
  async _withIndicatorsHidden(tabId, fn) {
    let needsRestore = false;
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'WB_HIDE_FOR_TOOL_USE' });
      needsRestore = true;
      // One paint frame for Chrome to apply the display:none the
      // content script just set, before CDP grabs the surface.
      await new Promise((r) => setTimeout(r, 16));
    } catch { /* content script absent — that's fine, no UI to hide */ }
    try {
      return await fn();
    } finally {
      if (needsRestore) {
        try {
          chrome.tabs.sendMessage(tabId, { type: 'WB_SHOW_AFTER_TOOL_USE' }).catch(() => {});
        } catch { /* ignore */ }
      }
    }
  }

  async _captureAutoScreenshot(tabId, { coordAligned = false } = {}) {
    try {
      await cdpClient.attach(tabId);
      await cdpClient.sendCommand(tabId, 'Page.enable');
      await this._bringToFrontForCapture(tabId);

      // Probe the CSS viewport first so we can either (a) clip exactly
      // to it for pixel-accurate captures, or (b) compute a budget-aware
      // CDP-side scale that downsizes during capture rather than after.
      const vp = await cdpClient.evaluate(tabId, '({w: window.innerWidth, h: window.innerHeight})');
      const cssW = Math.max(1, Math.round(vp?.result?.value?.w || 1024));
      const cssH = Math.max(1, Math.round(vp?.result?.value?.h || 768));

      if (coordAligned) {
        // Pixel-accuracy mode: image pixels must equal CSS pixels so the
        // planner can click by coordinate off the screenshot. Skip the
        // token-budget resize — the whole point of this mode is fidelity.
        // We DO still run the byte-ceiling fallback afterwards: if the
        // CSS viewport happens to be huge, we'd rather lose some JPEG
        // quality than overflow the provider's image cap.
        const shot = await this._withIndicatorsHidden(tabId, () =>
          cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
            format: 'jpeg',
            quality: 60,
            clip: { x: 0, y: 0, width: cssW, height: cssH, scale: 1 },
          })
        );
        if (!shot?.data) return null;
        const rawDataUrl = `data:image/jpeg;base64,${shot.data}`;
        const shrunk = await this._compressJpegToByteCeiling(rawDataUrl);
        return { dataUrl: shrunk, width: cssW, height: cssH, coordAligned: true };
      }

      // Non-coord-aligned mode: pre-compute target dims via the budget
      // binary-search, then ask CDP to capture + scale in one pass. This
      // avoids ever materializing a multi-MB native-DPR JPEG that we'd
      // then have to decode and resize in the service worker.
      const [targetW, targetH] = Agent._fitImageDimensions(cssW, cssH);
      const scale = targetW < cssW ? targetW / cssW : 1;
      const shot = await this._withIndicatorsHidden(tabId, () =>
        cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: Math.round(Agent.IMAGE_BUDGET.initialJpegQuality * 100),
          fromSurface: true,
          clip: { x: 0, y: 0, width: cssW, height: cssH, scale },
        })
      );
      if (!shot?.data) return null;
      const rawDataUrl = `data:image/jpeg;base64,${shot.data}`;

      // CDP-side resize + JPEG q=75 usually fits. Iterative quality
      // downgrade is the safety net for high-DPR screens where the
      // captured image can still exceed the base64 ceiling.
      const shrunk = await this._compressJpegToByteCeiling(rawDataUrl);
      return {
        dataUrl: shrunk,
        width: targetW,
        height: targetH,
        coordAligned: false,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * If the user configured a dedicated vision model in settings, route a
   * screenshot to it and return a terse text description. The planning
   * model then receives only the description (plus whatever the caller
   * wraps around it) — the raw image never reaches the main provider.
   *
   * Returns { text, model } on success, or null on any failure. Callers
   * fall back to sending the raw image_url block to the main provider.
   *
   * The sub-call is recorded in the trace under a `vision_sub_call` event
   * so description quality can be inspected alongside the main turn.
   */
  async _describeScreenshot(tabId, dataUrl, context = 'unknown') {
    if (!dataUrl) return null;
    const vision = await this.providerManager.getVisionProvider();
    if (!vision) return null;

    const runId = this.currentRunId.get(tabId);
    const started = Date.now();
    try {
      const messages = [
        { role: 'system', content: Agent.VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this screenshot of the current browser viewport for a web-automation agent. Follow the format in the system prompt.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ];
      const res = await vision.chat(messages, {
        maxTokens: 800,
        temperature: 0,
        // Ask vLLM/sglang-style servers to suppress chain-of-thought for
        // Qwen3/3.5 etc. Harmless on servers that ignore unknown fields.
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
      });
      const description = Agent._cleanVisionDescription(res?.content || '');
      if (!description) throw new Error('empty description');
      const latencyMs = Date.now() - started;
      trace.recordVisionSubCall(runId, {
        context,
        model: vision.config.model,
        baseUrl: vision.config.baseUrl,
        description,
        latencyMs,
      });
      return { text: description, model: vision.config.model };
    } catch (e) {
      trace.recordVisionSubCall(runId, {
        context,
        model: vision.config.model,
        baseUrl: vision.config.baseUrl,
        latencyMs: Date.now() - started,
        error: e?.message || String(e),
      });
      console.warn('[agent] vision sub-call failed, falling back to raw image:', e);
      return null;
    }
  }

  /**
   * Lightweight pre-capture page-health probe. Runs alongside a screenshot
   * to give the agent a few numbers that explain what it's about to look at
   * (is the page still loading? how heavy is it? any iframes?). Borrowed in
   * spirit from the Claude for Chrome extension — cheap telemetry that
   * sometimes turns a confusing screenshot into an obvious diagnosis.
   *
   * Never throws; returns null on any failure so screenshot paths don't get
   * taken down by a missing CDP or a frozen tab.
   */
  async _captureViewportProbe(tabId) {
    try {
      await cdpClient.attach(tabId);
      const probe = await cdpClient.evaluate(tabId, `
        (() => {
          const mem = (performance && performance.memory) ? performance.memory : null;
          // documentTextChars: total visible text on the page. Cheap and
          // definitive — when this is in the thousands but the JPEG looks
          // blank, the model can recognize that the screenshot is stale /
          // mid-lazy-load rather than the page being empty (which is what
          // trace 2 misread on CNN's slow-loading article).
          // visibleTextChars: sampled text from block-level elements whose
          // bbox intersects the current viewport. Bounded so a giant page
          // doesn't make the probe expensive.
          let documentTextChars = 0;
          let visibleTextChars = 0;
          try {
            documentTextChars = (document.body && document.body.innerText || '').length;
          } catch (e) {}
          try {
            const sels = 'p, h1, h2, h3, h4, h5, h6, li, td, blockquote, article, section, [role="article"]';
            const els = document.querySelectorAll(sels);
            const vw = window.innerWidth, vh = window.innerHeight;
            for (let i = 0; i < els.length; i++) {
              const el = els[i];
              const r = el.getBoundingClientRect();
              if (r.bottom < 0 || r.top > vh) continue;
              if (r.right < 0 || r.left > vw) continue;
              if (r.width === 0 || r.height === 0) continue;
              visibleTextChars += (el.innerText || '').length;
              if (visibleTextChars > 20000) break;
            }
          } catch (e) {}
          return {
            url: location.href,
            title: document.title || '',
            readyState: document.readyState,
            visibility: document.visibilityState,
            domNodes: document.getElementsByTagName('*').length,
            iframes: document.getElementsByTagName('iframe').length,
            scrollX: Math.round(window.scrollX || 0),
            scrollY: Math.round(window.scrollY || 0),
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            scrollHeight: Math.round((document.documentElement && document.documentElement.scrollHeight) || document.body.scrollHeight || 0),
            dpr: window.devicePixelRatio || 1,
            jsHeapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
            documentTextChars,
            visibleTextChars,
          };
        })()
      `);
      return probe?.result?.value || null;
    } catch {
      return null;
    }
  }

  /**
   * Try to bring a tab to the front via CDP before capturing. The surface
   * screenshot path (`fromSurface: true`) can produce stale/blank frames if
   * the page is occluded or backgrounded in some compositor states. This is
   * best-effort — ignore failures and let the capture proceed.
   */
  async _bringToFrontForCapture(tabId) {
    try {
      await cdpClient.sendCommand(tabId, 'Page.bringToFront');
    } catch { /* ignore */ }
  }

  // ───────────── Image-budget (token-conscious screenshots) ─────────────
  // Local vision models are cheap enough that a few thousand image tokens
  // per screenshot doesn't sting, but the moment you point the dedicated
  // vision model at a paid API (OpenAI, Anthropic, OpenRouter) every
  // screenshot's pixel area translates directly into dollars. Anthropic's
  // own "Claude for Chrome" extension solves this by:
  //   (1) computing a target (w,h) that fits both a pixel-dimension cap
  //       AND a token cap, via a binary search over the long side;
  //   (2) capturing at that reduced size via CDP's clip.scale — and if
  //       the resulting JPEG is still over a byte ceiling, iteratively
  //       dropping JPEG quality (0.75 → 0.1 in 0.05 steps) until it fits.
  //
  // Defaults below match Anthropic's exactly (pxPerToken=28, 1568/1568,
  // initial 0.75, step 0.05, min 0.1, ~1.4 MB base64 ceiling) — those
  // are tuned to Claude's native vision encoder and happen to be
  // reasonable for most other endpoints too. Override per-capture if you
  // need sharper (coord_aligned) or looser (full_page) constraints.
  static IMAGE_BUDGET = {
    pxPerToken: 28,        // rough px² per vision token across providers
    maxTargetPx: 1568,     // no dimension bigger than this
    maxTargetTokens: 1568, // total image tokens budget
    maxBase64Chars: 1398100, // ~1.4 MB base64, matches Anthropic's cap
    initialJpegQuality: 0.75,
    minJpegQuality: 0.10,
    jpegQualityStep: 0.05,
  };

  /**
   * Anthropic's token-cost approximation: ceil((w*h) / pxPerToken²).
   * Good enough to compare two capture sizes under the same budget; not
   * exact for any specific provider's tokenizer, but better than eyeballing.
   */
  static _estimateImageTokens(w, h, pxPerToken) {
    return Math.ceil((w / pxPerToken) * (h / pxPerToken));
  }

  /**
   * Largest (w, h) ≤ original that fits BOTH maxTargetPx per side AND
   * maxTargetTokens total at the given pxPerToken. Aspect ratio preserved.
   * Binary-searches over the long side; short side follows. Ported from
   * Claude-for-Chrome's `C(w, h, params)` (same algorithm, clearer names).
   */
  static _fitImageDimensions(origW, origH, budget = Agent.IMAGE_BUDGET) {
    const { pxPerToken, maxTargetPx, maxTargetTokens } = budget;
    // Already fits — no work.
    if (origW <= maxTargetPx && origH <= maxTargetPx &&
        Agent._estimateImageTokens(origW, origH, pxPerToken) <= maxTargetTokens) {
      return [origW, origH];
    }
    // Search the long side; the other follows from aspect ratio.
    if (origH > origW) {
      const [h, w] = Agent._fitImageDimensions(origH, origW, budget);
      return [w, h];
    }
    const aspect = origW / origH;
    let hi = origW, lo = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (lo + 1 >= hi) {
        return [lo, Math.max(Math.round(lo / aspect), 1)];
      }
      const mid = Math.floor((lo + hi) / 2);
      const midH = Math.max(Math.round(mid / aspect), 1);
      if (mid <= maxTargetPx &&
          Agent._estimateImageTokens(mid, midH, pxPerToken) <= maxTargetTokens) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }

  /**
   * Convert an ArrayBuffer of JPEG/PNG bytes to a base64 dataUrl, chunking
   * through String.fromCharCode so we don't blow the call stack on
   * multi-MB images. Pure helper, no state.
   */
  static _bufferToDataUrl(buf, mime) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  }

  /**
   * If `dataUrl`'s base64 payload is already under `maxBase64Chars`, return
   * it unchanged. Otherwise decode, draw to an OffscreenCanvas, and
   * re-encode as JPEG, iteratively dropping quality from
   * `initialJpegQuality` down to `minJpegQuality` in `jpegQualityStep`
   * increments until the output fits — or until we hit `minJpegQuality`,
   * in which case we return the min-quality version anyway (best-effort).
   *
   * Never throws: returns the original dataUrl on any decode/encode
   * failure so screenshot paths don't take down the whole agent turn
   * over a single bad capture.
   */
  async _compressJpegToByteCeiling(dataUrl, budget = Agent.IMAGE_BUDGET) {
    try {
      if (!dataUrl) return dataUrl;
      const payloadStart = dataUrl.indexOf(',') + 1;
      const payloadLen = payloadStart > 0 ? dataUrl.length - payloadStart : dataUrl.length;
      if (payloadLen <= budget.maxBase64Chars) return dataUrl;

      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);

      let quality = budget.initialJpegQuality;
      let lastBuf = null;
      while (quality >= budget.minJpegQuality - 1e-9) {
        const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        const buf = await outBlob.arrayBuffer();
        lastBuf = buf;
        // Base64 length ≈ 4/3 × byte count (plus rounding). Cheap estimate
        // avoids the base64 encode cost per iteration.
        if (Math.ceil(buf.byteLength * 4 / 3) <= budget.maxBase64Chars) {
          return Agent._bufferToDataUrl(buf, 'image/jpeg');
        }
        quality -= budget.jpegQualityStep;
      }
      // Floor quality reached and still over budget — send it anyway.
      return lastBuf ? Agent._bufferToDataUrl(lastBuf, 'image/jpeg') : dataUrl;
    } catch {
      return dataUrl;
    }
  }

  /**
   * End-to-end "shrink this screenshot to fit the vision budget" pass.
   * Decodes, resizes to the target dims picked by `_fitImageDimensions`,
   * and runs JPEG iterative-quality fallback if bytes are still too large.
   *
   * Returns { dataUrl, width, height } — width/height are the actual
   * pixel dimensions of the returned image (useful for callers that want
   * to report what the model will see).
   *
   * `origW`/`origH` should be the decoded image's natural dimensions.
   * Pass them in rather than relying on createImageBitmap twice; callers
   * that captured via CDP already know the viewport dims and can feed
   * them here.
   */
  async _shrinkImageForBudget(dataUrl, origW, origH, budget = Agent.IMAGE_BUDGET) {
    try {
      if (!dataUrl) return { dataUrl, width: origW, height: origH };

      // If caller passed dims, check the fast-exit path up front (no decode).
      if (origW && origH) {
        const [targetW, targetH] = Agent._fitImageDimensions(origW, origH, budget);
        const payloadStart = dataUrl.indexOf(',') + 1;
        const payloadLen = payloadStart > 0 ? dataUrl.length - payloadStart : dataUrl.length;
        if (targetW === origW && targetH === origH && payloadLen <= budget.maxBase64Chars) {
          return { dataUrl, width: origW, height: origH };
        }
      }

      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);

      // If dims weren't passed (e.g. full_page_screenshot where we don't
      // know the document height up front), use the decoded bitmap's.
      if (!origW || !origH) {
        origW = bmp.width;
        origH = bmp.height;
      }
      const [targetW, targetH] = Agent._fitImageDimensions(origW, origH, budget);

      // If the decoded bitmap is already smaller than our target (e.g. CDP
      // pre-scaled it for us via clip.scale), use the bitmap's own dims.
      const finalW = Math.min(targetW, bmp.width);
      const finalH = Math.min(targetH, bmp.height);

      const canvas = new OffscreenCanvas(finalW, finalH);
      const ctx = canvas.getContext('2d');
      // High-quality downscale — matters at 2-4× ratios we often hit.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, finalW, finalH);

      // Iterative JPEG quality until bytes fit.
      let quality = budget.initialJpegQuality;
      let lastBuf = null;
      while (quality >= budget.minJpegQuality - 1e-9) {
        const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        const buf = await outBlob.arrayBuffer();
        lastBuf = buf;
        if (Math.ceil(buf.byteLength * 4 / 3) <= budget.maxBase64Chars) {
          return {
            dataUrl: Agent._bufferToDataUrl(buf, 'image/jpeg'),
            width: finalW,
            height: finalH,
          };
        }
        quality -= budget.jpegQualityStep;
      }
      return {
        dataUrl: lastBuf ? Agent._bufferToDataUrl(lastBuf, 'image/jpeg') : dataUrl,
        width: finalW,
        height: finalH,
      };
    } catch {
      return { dataUrl, width: origW, height: origH };
    }
  }

  /**
   * Draw a red outline rectangle over a base64 PNG/JPEG screenshot, at the
   * given CSS-pixel rect. Scales the rect by the ratio between the image's
   * actual pixel dimensions and the CSS viewport so it lines up regardless
   * of whether the capture was taken at scale=1 or native DPR.
   *
   * Runs in the service worker via OffscreenCanvas — no DOM required.
   * Returns the annotated image as a data URL, or the original dataUrl on
   * any failure (so callers can treat this as a best-effort enhancement).
   */
  async _annotateScreenshot(dataUrl, rect, cssViewport) {
    try {
      if (!dataUrl || !rect || !rect.w || !rect.h) return dataUrl;
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      // Scale CSS rect into image pixels. If we have a CSS viewport hint,
      // compute the exact ratio; otherwise assume 1:1 (scale=1 captures).
      const sx = cssViewport?.width ? (bmp.width / cssViewport.width) : 1;
      const sy = cssViewport?.height ? (bmp.height / cssViewport.height) : 1;
      const x = Math.max(0, Math.round(rect.x * sx));
      const y = Math.max(0, Math.round(rect.y * sy));
      const w = Math.max(1, Math.round(rect.w * sx));
      const h = Math.max(1, Math.round(rect.h * sy));
      // Outer glow for contrast on any background
      ctx.lineWidth = Math.max(2, Math.round(4 * Math.min(sx, sy)));
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      ctx.strokeStyle = 'rgba(255, 0, 64, 0.95)';
      ctx.strokeRect(x, y, w, h);
      const outBlob = await canvas.convertToBlob({ type: 'image/png' });
      const buf = await outBlob.arrayBuffer();
      // Base64-encode without blowing the call stack on large buffers.
      const bytes = new Uint8Array(buf);
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return `data:image/png;base64,${btoa(bin)}`;
    } catch {
      return dataUrl;
    }
  }

  // ---- Persistence: keep per-tab conversation state alive across service
  // worker restarts by mirroring it to chrome.storage.session. Without this,
  // killing the worker between turns means the model loses all prior context
  // even though the sidebar UI still shows the messages.

  _convKey(tabId) { return `agentConv:${tabId}`; }

  /**
   * Pull a tab's conversation from storage.session into memory if we haven't
   * already this worker lifetime. Safe to call repeatedly.
   */
  async _hydrate(tabId) {
    if (this.hydratedTabs.has(tabId)) return;
    this.hydratedTabs.add(tabId);
    if (this.conversations.has(tabId)) return;
    try {
      const key = this._convKey(tabId);
      const stored = await chrome.storage.session.get(key);
      const entry = stored?.[key];
      if (entry && Array.isArray(entry.messages) && entry.messages.length > 0) {
        this.conversations.set(tabId, entry.messages);
        if (entry.mode) {
          this.conversationModes.set(tabId, entry.mode);
          this._conversationMode = entry.mode;
        }
        // Restore the conversationId so traces from before the SW restart
        // and traces from after it stay grouped together.
        if (entry.conversationId) {
          this.conversationIds.set(tabId, entry.conversationId);
        }
      }
    } catch (e) { /* session storage may be unavailable */ }
  }

  /**
   * Debounced write of a tab's conversation to storage.session. Multiple
   * rapid mutations within 300ms collapse into one write.
   */
  _persist(tabId) {
    if (tabId == null) return;
    const existing = this.persistTimers.get(tabId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.persistTimers.delete(tabId);
      const messages = this.conversations.get(tabId);
      if (!messages) return;
      const mode = this.conversationModes.get(tabId) || 'ask';
      const conversationId = this.conversationIds.get(tabId) || null;
      try {
        chrome.storage.session.set({
          [this._convKey(tabId)]: { mode, messages, conversationId },
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    }, 300);
    this.persistTimers.set(tabId, handle);
  }

  /**
   * Request abort for a specific tab's running agent.
   */
  abort(tabId) {
    this.abortFlags.set(tabId, true);
    this._cancelClarifications(tabId, 'aborted by user');
  }

  /**
   * Resolve a pending clarify() tool call with the user's answer. Called by
   * background.js when the side panel posts `clarify_response`.
   * Returns true if a matching pending clarification was found.
   */
  submitClarifyResponse(tabId, clarifyId, answer, source = 'user') {
    const tabPending = this._pendingClarifications.get(tabId);
    if (!tabPending) return false;
    const entry = tabPending.get(clarifyId);
    if (!entry) return false;
    try { entry.resolve({ answer, source }); } catch {}
    return true;
  }

  /**
   * Cancel every pending clarify() on a tab. Used by abort() and
   * clearConversation() to keep the agent loop from deadlocking when the
   * user bails out mid-question.
   */
  _cancelClarifications(tabId, reason) {
    const tabPending = this._pendingClarifications.get(tabId);
    if (!tabPending) return;
    for (const [, entry] of tabPending) {
      try { entry.resolve({ cancelled: true, reason }); } catch {}
    }
    this._pendingClarifications.delete(tabId);
  }

  /**
   * Check and clear abort flag.
   */
  _checkAbort(tabId) {
    if (this.abortFlags.get(tabId)) {
      this.abortFlags.delete(tabId);
      return true;
    }
    return false;
  }

  /**
   * Get or create a conversation for a tab.
   */
  /**
   * Select the appropriate ACT system prompt based on the active provider.
   * Small/local models get a compact prompt to save context budget.
   */
  _getActPrompt() {
    try {
      const provider = this.providerManager.getActive();
      if (provider.useCompactPrompt) return SYSTEM_PROMPT_ACT_COMPACT;
    } catch { /* provider not ready yet — use full prompt */ }
    return SYSTEM_PROMPT_ACT;
  }

  /**
   * Compose the full system prompt: base (ASK or ACT) + optional universal
   * cookie/paywall guidance + optional user profile block.
   *
   * Everything past the base prompt is appended, NOT prepended — this keeps
   * the cache-stable prefix (base prompt) at the front so providers that
   * prompt-cache (Anthropic, OpenAI) hit the cache even when the user
   * toggles adapters or edits their profile. Re-invoked on mode switches
   * and on settings changes via _refreshSystemPrompts().
   */
  _buildSystemPrompt(mode) {
    let prompt = mode === 'act' ? this._getActPrompt() : SYSTEM_PROMPT_ASK;

    // Universal cookie/paywall guidance. Always relevant for http(s)
    // browsing; cheap enough to carry on chrome:///file:// pages too
    // since it's just a few dozen cached tokens.
    if (this.useSiteAdapters) {
      prompt += `\n\n${UNIVERSAL_PREAMBLE.trim()}`;
    }

    // Profile auto-fill. Only injected when the user has both enabled the
    // feature AND provided non-empty text — we don't want to push an empty
    // "[User profile]" header to the model.
    if (this.profileEnabled && this.profileText && this.profileText.trim()) {
      prompt +=
        `\n\n[User profile — use these details when a form or signup needs them, INSTEAD of asking the user. The user has opted in to sharing this with you. Do NOT volunteer these details on pages that don't need them, and NEVER reveal the password in chat output or screenshots. Treat it as sensitive.]\n` +
        this.profileText.trim();
    }

    // CAPTCHA solver. Only injected when the user has explicitly enabled
    // CapSolver — otherwise the default "stop and ask the user" rule in
    // SYSTEM_PROMPT_ACT stands. The note unlocks the solve_captcha tool
    // path described there.
    if (this.captchaSolverEnabled) {
      prompt += `\n\n[CAPTCHA SOLVER — the user has configured CapSolver. When a CAPTCHA blocks a step, call \`solve_captcha\` once (with no arguments — it auto-detects reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile). On success, click the form's submit button and continue. On failure, ask the user to solve it manually — do not retry solve_captcha repeatedly.]`;
    }

    return prompt;
  }

  /**
   * Rewrite the system prompt on every live conversation — called when the
   * user toggles `useSiteAdapters` or edits their profile in settings, so
   * the change takes effect on the next turn without forcing a conversation
   * reset.
   */
  _refreshSystemPrompts() {
    for (const [tabId, messages] of this.conversations) {
      if (!messages || messages[0]?.role !== 'system') continue;
      const mode = this.conversationModes.get(tabId) || 'ask';
      messages[0].content = this._buildSystemPrompt(mode);
    }
  }

  getConversation(tabId, mode = 'ask') {
    if (!this.conversations.has(tabId)) {
      this.conversations.set(tabId, [
        { role: 'system', content: this._buildSystemPrompt(mode) },
      ]);
      this.conversationModes.set(tabId, mode);
      this._conversationMode = mode;
      // New conversation → mint a new conversationId. Stable for the
      // lifetime of this conversation (until clearConversation), so every
      // trace produced from this chat carries the same id and the Traces
      // viewer can group sibling turns.
      if (!this.conversationIds.has(tabId)) {
        this.conversationIds.set(tabId, `conv_${tabId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      }
    }
    // If mode changed, update the system prompt
    const lastMode = this.conversationModes.get(tabId);
    if (lastMode !== mode) {
      const messages = this.conversations.get(tabId);
      if (messages[0]?.role === 'system') {
        messages[0].content = this._buildSystemPrompt(mode);
      }
      this.conversationModes.set(tabId, mode);
      this._conversationMode = mode;
    }
    return this.conversations.get(tabId);
  }

  /**
   * Clear conversation for a tab.
   */
  clearConversation(tabId) {
    this._cancelClarifications(tabId, 'conversation cleared');
    this.conversations.delete(tabId);
    this.conversationModes.delete(tabId);
    this.conversationIds.delete(tabId); // next getConversation() mints a fresh id
    this.hydratedTabs.delete(tabId);
    this.apiAllowedTabs.delete(tabId);
    this.apiAllowedInjected.delete(tabId);
    this._lastInteractionRect.delete(tabId);
    if (this._doneBlockCount) this._doneBlockCount.delete(tabId);
    if (this._recentSubmitClicks) this._recentSubmitClicks.delete(tabId);
    this._clearLoopState(tabId);
    const t = this.persistTimers.get(tabId);
    if (t) { clearTimeout(t); this.persistTimers.delete(tabId); }
    try {
      chrome.storage.session.remove(this._convKey(tabId)).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // ─── Scratchpad ──────────────────────────────────────────────────────
  // A single pinned user message (`[Agent scratchpad...]`) that lives near
  // the top of the conversation. The model writes to it via the
  // `scratchpad_write` tool; it survives summarization because both
  // _manageContext and _emergencyTrim skip messages with this prefix when
  // looking for the original task, and re-insert the scratchpad into the
  // rebuilt messages array. Purpose: give the model a durable place to
  // record facts (download IDs, file paths, progress counters) that it
  // would otherwise lose when older tool results get compressed away.

  _scratchpadHeader() {
    return '[Agent scratchpad — your own persistent notes, pinned in context and surviving summarization. Update with scratchpad_write({text, replace?}). Current contents follow:]';
  }

  _isScratchpadMessage(msg) {
    return msg && msg.role === 'user'
      && typeof msg.content === 'string'
      && msg.content.startsWith('[Agent scratchpad');
  }

  _findScratchpadIndex(messages) {
    for (let i = 1; i < messages.length; i++) {
      if (this._isScratchpadMessage(messages[i])) return i;
    }
    return -1;
  }

  _extractScratchpadBody(content) {
    if (typeof content !== 'string') return '';
    // Everything after the first blank line is the body; fall back to empty.
    const idx = content.indexOf('\n\n');
    return idx >= 0 ? content.slice(idx + 2) : '';
  }

  _buildScratchpadMessage(body) {
    const trimmed = (body || '').replace(/^\s+|\s+$/g, '');
    return {
      role: 'user',
      content: `${this._scratchpadHeader()}\n\n${trimmed || '(empty)'}`,
    };
  }

  /**
   * Handle the scratchpad_write tool. Creates the pinned scratchpad message
   * the first time it's called, and updates it in place thereafter.
   */
  _scratchpadWrite(tabId, args) {
    const text = (args && typeof args.text === 'string') ? args.text : '';
    if (!text.trim() && !args?.replace) {
      return { success: false, error: 'scratchpad_write: `text` is required (non-empty). Pass replace:true with an empty string to clear the pad.' };
    }

    const messages = this.conversations.get(tabId);
    if (!messages) {
      return { success: false, error: 'No active conversation on this tab.' };
    }

    const idx = this._findScratchpadIndex(messages);
    const currentBody = idx >= 0 ? this._extractScratchpadBody(messages[idx].content) : '';
    const replace = !!args?.replace;
    // Hard cap per-pad at ~8k chars to prevent it from eating the whole
    // context budget. Older lines get trimmed off the top when we hit it.
    const MAX_BODY = 8000;
    let nextBody = replace ? text : (currentBody ? `${currentBody}\n${text}` : text);
    if (nextBody.length > MAX_BODY) {
      nextBody = '[...older scratchpad lines dropped — pad is full, consider compacting with replace:true]\n' + nextBody.slice(nextBody.length - MAX_BODY + 100);
    }

    const msg = this._buildScratchpadMessage(nextBody);
    if (idx >= 0) {
      messages[idx] = msg;
    } else {
      // Insert just after the pinned original user task (or after system if
      // no real task is pinned yet). Mirrors the originalTaskIdx lookup in
      // _manageContext so the scratchpad lives at a stable, near-top spot.
      let insertAt = 1;
      for (let i = 1; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== 'user') continue;
        const c = typeof m.content === 'string' ? m.content : '';
        if (c.startsWith('[Site guidance') || c.startsWith('[Site context changed') || c.startsWith('[Context window was trimmed') || c.startsWith('[Agent scratchpad')) continue;
        insertAt = i + 1;
        break;
      }
      messages.splice(insertAt, 0, msg);
    }

    this._persist(tabId);
    return {
      success: true,
      mode: replace ? 'replace' : 'append',
      bytes: nextBody.length,
      note: replace ? 'scratchpad replaced' : 'line appended to scratchpad',
    };
  }
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Manage context window — trim and summarize when conversation gets too long.
   * Keeps: system prompt, summary of old messages, recent messages.
   */
  async _manageContext(tabId, messages) {
    // Calculate total char length
    let totalChars = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      totalChars += content.length;
      if (msg.tool_calls) totalChars += JSON.stringify(msg.tool_calls).length;
    }

    const tooManyMessages = messages.length > this.maxContextMessages;
    const tooManyChars = totalChars > this.maxContextChars;

    if (!tooManyMessages && !tooManyChars) return; // context is fine

    // Strategy: keep system prompt + ORIGINAL USER TASK (pinned) + summarize
    // old messages + keep recent messages.
    //
    // CRITICAL: the first real user message is the task statement ("create a
    // new product called namaz..."). Folding it into a synthetic summary
    // causes small models to say "the previous context was removed" and
    // forget what they were doing. Always keep it verbatim at position 1.
    const systemMsg = messages[0]; // always the system prompt
    // Find the first real user turn (skip any seeded site-guidance context
    // we may have prepended which uses role:'user' with a [Site guidance…]
    // heading, and the pinned scratchpad).
    let originalTaskIdx = -1;
    for (let i = 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      const c = typeof m.content === 'string' ? m.content : '';
      if (c.startsWith('[Site guidance') || c.startsWith('[Site context changed') || c.startsWith('[Context window was trimmed') || c.startsWith('[Agent scratchpad')) continue;
      originalTaskIdx = i;
      break;
    }
    const originalTask = originalTaskIdx >= 0 ? messages[originalTaskIdx] : null;
    // Pin the scratchpad alongside the original task so the model's self-
    // written notes survive summarization.
    const scratchpadIdx = this._findScratchpadIndex(messages);
    const scratchpadMsg = scratchpadIdx >= 0 ? messages[scratchpadIdx] : null;

    // Keep last N messages verbatim. Agents doing heavy tool work (scraping,
    // batch downloads) burn messages fast — each tool call is 2 messages
    // (assistant + tool result), so 30 ≈ last 15 tool turns. 16 was too tight
    // for long-horizon tasks and caused the model to "forget" outcomes from
    // ~8 steps back (e.g. the file list from list_downloads).
    const keepRecent = 30;
    // Exclude the pinned original task from both summary and recent slices.
    const afterPin = originalTaskIdx >= 0 ? originalTaskIdx + 1 : 1;
    const oldMessagesRaw = messages.slice(afterPin, -keepRecent);
    const recentMessagesRaw = messages.slice(-keepRecent);
    // Strip the scratchpad out of both slices — we re-pin a single copy of
    // it in the rebuild step below. Without this we'd either lose it (if it
    // fell into oldMessages and got summarized away) or duplicate it.
    const oldMessages = oldMessagesRaw.filter(m => !this._isScratchpadMessage(m));
    const recentMessages = recentMessagesRaw.filter(m => !this._isScratchpadMessage(m));

    if (oldMessages.length < 4) return; // not enough to summarize

    // Build tool_call_id → name map so each tool result in the summary can be
    // labelled with the tool that produced it. Without this we'd lose the
    // association when the assistant turn gets summarized away.
    const toolNameById = new Map();
    for (const msg of oldMessages) {
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.id) toolNameById.set(tc.id, tc.function?.name || 'tool');
        }
      }
    }

    // Build a summary of old messages.
    // We DO emit one-line digests for tool results now — previously they were
    // skipped ("too verbose"), which meant critical outcomes (e.g. "list_downloads
    // returned 69 files") silently disappeared when the summarizer ran. On long
    // tasks that caused the agent to restart work it had already finished.
    let summaryText = 'Previous conversation summary:\n';
    for (const msg of oldMessages) {
      if (msg.role === 'user') {
        summaryText += `- User asked: ${this._truncate(msg.content, 120)}\n`;
      } else if (msg.role === 'assistant' && msg.content && !msg.tool_calls) {
        summaryText += `- Assistant answered: ${this._truncate(msg.content, 150)}\n`;
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // The *result* lines below carry the tool name and outcome, so we
        // don't also need a "called X" line for every tool_call here.
        // Emit a one-liner only if the assistant included prose reasoning
        // alongside the tool calls.
        if (msg.content) {
          summaryText += `- Assistant: ${this._truncate(msg.content, 150)}\n`;
        }
      } else if (msg.role === 'tool') {
        const toolName = toolNameById.get(msg.tool_call_id) || 'tool';
        const digest = this._digestToolResult(toolName, msg.content);
        summaryText += `- ${toolName} → ${digest}\n`;
      }
    }

    // Try to compress the summary using the LLM if it's still huge
    if (summaryText.length > 2000) {
      try {
        const provider = this.providerManager.getActive();
        const res = await provider.chat([
          { role: 'system', content: 'Summarize this conversation history in 3-5 bullet points. Be very concise.' },
          { role: 'user', content: summaryText },
        ], { maxTokens: 300, temperature: 0.2 });
        if (res.content) {
          summaryText = 'Summary of earlier conversation:\n' + res.content;
        }
      } catch {
        // If summarization fails, use the manual summary but truncate it
        summaryText = summaryText.slice(0, 2000) + '\n[...truncated]';
      }
    }

    // Rebuild: system + pinned original task + summary + recent.
    // The pinned task keeps the model anchored to what was asked, while
    // the summary + recent slice preserves progress toward it.
    const summaryMsg = { role: 'user', content: `[Context window was trimmed to stay within budget. Your ORIGINAL TASK is the user message above — keep working on it. ${summaryText}]` };
    const summaryAck = { role: 'assistant', content: 'Understood. I\'ll continue working on the original task.' };

    messages.length = 0;
    messages.push(systemMsg);
    if (originalTask) messages.push(originalTask);
    if (scratchpadMsg) messages.push(scratchpadMsg);
    messages.push(summaryMsg, summaryAck, ...recentMessages);

    console.log(`[WebBrain] Context trimmed for tab ${tabId}: ${oldMessages.length} old messages → summary. ${messages.length} messages remain.`);
  }

  _truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  /**
   * One-line digest of a tool result, used when summarizing older turns so
   * the model retains the key outcome (file count, download IDs, final URL)
   * even after the full JSON is dropped. Target ≤ 140 chars.
   *
   * `content` is the stringified tool result from the messages array; we try
   * to parse it as JSON and pick the most-useful fact per tool. For anything
   * we don't recognize, fall back to a length-bounded truncate.
   */
  _digestToolResult(name, content) {
    if (!content) return '(empty)';
    let parsed = null;
    try { parsed = JSON.parse(content); } catch { /* not JSON */ }
    if (!parsed || typeof parsed !== 'object') {
      return this._truncate(String(content).replace(/\s+/g, ' '), 140);
    }
    if (parsed.error) {
      return `error: ${this._truncate(String(parsed.error), 120)}`;
    }

    switch (name) {
      case 'list_downloads': {
        if (Array.isArray(parsed.downloads)) {
          const n = parsed.downloads.length;
          const complete = parsed.downloads.filter(d => d.state === 'complete').length;
          const latest = parsed.downloads[0];
          const label = latest ? (latest.filename || latest.url || '') : '';
          return `${n} downloads listed (${complete} complete)${label ? `; latest: ${this._truncate(label, 70)}` : ''}`;
        }
        break;
      }
      case 'download_file':
      case 'download_files': {
        if (Array.isArray(parsed.results)) {
          const ok = parsed.results.filter(r => r?.success).length;
          return `${ok}/${parsed.results.length} downloaded`;
        }
        if (parsed.count != null) return `${parsed.count} downloads queued`;
        break;
      }
      case 'read_downloaded_file': {
        if (parsed.filename) {
          const len = parsed.originalLength ?? (typeof parsed.text === 'string' ? parsed.text.length : '?');
          return `read ${this._truncate(parsed.filename, 80)} (${parsed.contentType || '?'}, ${len} chars)`;
        }
        break;
      }
      case 'navigate': {
        if (parsed.url) return `now on ${this._truncate(parsed.url, 110)}`;
        break;
      }
      case 'new_tab': {
        if (parsed.url) return `opened tab ${this._truncate(parsed.url, 100)}`;
        break;
      }
      case 'extract_data': {
        if (Array.isArray(parsed)) {
          const rows = parsed.reduce((s, t) => s + (Array.isArray(t?.rows) ? t.rows.length : 0), 0);
          return `extracted ${parsed.length} item(s), ${rows} row(s)`;
        }
        break;
      }
      case 'fetch_url':
      case 'research_url': {
        const len = parsed.originalLength ?? (typeof parsed.text === 'string' ? parsed.text.length : '?');
        const title = parsed.title ? ` - ${this._truncate(parsed.title, 60)}` : '';
        return `${parsed.status ?? 200}${title} (${len} chars)`;
      }
      case 'get_accessibility_tree':
      case 'read_page': {
        const len = (typeof parsed.text === 'string' ? parsed.text.length : null)
          ?? (typeof parsed.pageContent === 'string' ? parsed.pageContent.length : '?');
        return `read page (${len} chars)`;
      }
      case 'scroll': {
        if (parsed.success) {
          return `scrolled${parsed.containerScrollY != null ? ` (containerY=${Math.round(parsed.containerScrollY)}/${Math.round(parsed.containerScrollHeight ?? 0)})` : ''}`;
        }
        break;
      }
      case 'screenshot':
      case 'full_page_screenshot':
        return parsed.success ? 'screenshot captured' : 'screenshot failed';
      case 'solve_captcha': {
        if (parsed.success === false) return `captcha solve failed: ${this._truncate(parsed.error || '', 100)}`;
        const inj = parsed.injected ? 'injected' : 'token only';
        return `${parsed.type || 'captcha'} solved (${inj})`;
      }
      case 'scratchpad_write': {
        return `scratchpad ${parsed.mode || 'write'} (${parsed.bytes ?? '?'} chars)`;
      }
    }

    // Generic fallback — compact stringified JSON, bounded.
    try {
      return this._truncate(JSON.stringify(parsed), 140);
    } catch {
      return this._truncate(String(content), 140);
    }
  }

  /**
   * Limit tool result size to avoid blowing up the context.
   * Page text in particular can be huge.
   */
  _limitToolResult(result) {
    const maxResultChars = 8000; // ~2k tokens
    let json = JSON.stringify(result);
    if (json.length <= maxResultChars) return json;

    // Try to trim the 'text' field specifically (page content)
    if (result && typeof result.text === 'string' && result.text.length > 4000) {
      const trimmed = { ...result, text: result.text.slice(0, 4000) + '\n[...page text truncated]' };
      json = JSON.stringify(trimmed);
      if (json.length <= maxResultChars) return json;
    }

    // If still too big, just chop the JSON
    return json.slice(0, maxResultChars) + '\n[...result truncated]';
  }

  /**
   * Build a copy of `messages` for sending to the LLM that retains only the
   * `keep` most-recent screenshots. Older image_url blocks are replaced with
   * a small text placeholder, and base64 image data embedded in old tool
   * results is stripped. The persisted history is left untouched.
   *
   * `provider` (optional): if passed and `provider.supportsVision` is false,
   * `keep` is forced to 0 so ALL images are stripped. This is the escape
   * hatch for "user had vision on, captured screenshots, then unchecked
   * the vision checkbox" — the image_url blocks linger in the history and
   * a text-only endpoint (llama.cpp without mmproj, raw Ollama, etc.)
   * 500s the moment it sees one.
   */
  _pruneOldImages(messages, provider = null, keep = 1) {
    if (provider && !provider.supportsVision) keep = 0;
    let imgsKept = 0;
    const out = new Array(messages.length);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (Array.isArray(msg.content)) {
        const newContent = msg.content.map(block => {
          if (block && (block.type === 'image_url' || block.type === 'image')) {
            if (imgsKept < keep) {
              imgsKept++;
              return block;
            }
            return { type: 'text', text: '[older screenshot omitted to save tokens]' };
          }
          return block;
        });
        out[i] = { ...msg, content: newContent };
      } else if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.includes('data:image/')) {
        if (imgsKept < keep) {
          imgsKept++;
          out[i] = msg;
        } else {
          out[i] = { ...msg, content: msg.content.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\\]+/g, '[older screenshot omitted to save tokens]') };
        }
      } else {
        out[i] = msg;
      }
    }
    return out;
  }

  /**
   * Detect if an error is a context overflow from any provider.
   */
  _isContextOverflow(error) {
    const msg = (error?.message || error || '').toLowerCase();
    return msg.includes('context') ||
           msg.includes('token') ||
           msg.includes('exceed') ||
           msg.includes('too long') ||
           msg.includes('maximum context') ||
           msg.includes('context_length_exceeded') ||
           msg.includes('exceed_context_size');
  }

  /**
   * Emergency context trim — aggressively cut to fit.
   * Called when LLM returns a context overflow error.
   * Keeps system prompt + only the last few messages.
   */
  _emergencyTrim(messages) {
    const systemMsg = messages[0];
    // Pin the original user task (same logic as _manageContext).
    let originalTask = null;
    for (let i = 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      const c = typeof m.content === 'string' ? m.content : '';
      if (c.startsWith('[Site guidance') || c.startsWith('[Site context changed') || c.startsWith('[Context') || c.startsWith('[Agent scratchpad')) continue;
      originalTask = m;
      break;
    }
    // Pin the scratchpad too — even under emergency trim, the model's own
    // notes should survive.
    const scratchpadIdx = this._findScratchpadIndex(messages);
    const scratchpadMsg = scratchpadIdx >= 0 ? messages[scratchpadIdx] : null;
    const keepLast = 6; // keep only 6 most recent messages
    const recent = messages.slice(-keepLast).filter(m => !this._isScratchpadMessage(m));

    // Also truncate any huge tool results in remaining messages
    for (const msg of recent) {
      if (msg.role === 'tool' && msg.content && msg.content.length > 2000) {
        msg.content = msg.content.slice(0, 2000) + '\n[...truncated due to context limit]';
      }
      if (typeof msg.content === 'string' && msg.content.length > 5000) {
        msg.content = msg.content.slice(0, 5000) + '\n[...truncated due to context limit]';
      }
    }

    const notice = {
      role: 'user',
      content: '[Context was too large for the model. Older intermediate steps were removed, but your ORIGINAL TASK is pinned above — keep working on it based on the most recent state you can see.]',
    };
    const ack = {
      role: 'assistant',
      content: 'Understood. I\'ll continue the original task with the recent state.',
    };

    messages.length = 0;
    messages.push(systemMsg);
    if (originalTask) messages.push(originalTask);
    if (scratchpadMsg) messages.push(scratchpadMsg);
    messages.push(notice, ack, ...recent);

    console.log(`[WebBrain] Emergency context trim: kept ${messages.length} messages.`);
  }

  /**
   * Execute a tool call by dispatching to the content script or chrome APIs.
   *
   * `onUpdate` is optional and only consumed by tools that need to talk back
   * to the side panel mid-call (currently just `clarify`, which pauses and
   * waits for a user response). All other tools ignore it.
   */
  async executeTool(tabId, name, args, onUpdate = null) {
    // clarify: pause the run and wait for the user to answer. This tool does
    // NOT touch the page — it's a meta-action that bridges agent ↔ user.
    // The handler resolves when background.js routes the user's response via
    // submitClarifyResponse(), or when abort/clearConversation cancels.
    if (name === 'clarify') {
      const question = String(args?.question || '').trim();
      if (!question) {
        return { success: false, error: 'clarify: `question` is required (a single sentence asking the user something specific).' };
      }
      const options = Array.isArray(args?.options)
        ? args.options.map(s => String(s).slice(0, 200)).filter(Boolean).slice(0, 4)
        : [];
      const reason = args?.reason ? String(args.reason).slice(0, 300) : null;
      const clarifyId = `clr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

      const tabPending = this._pendingClarifications.get(tabId) || new Map();
      this._pendingClarifications.set(tabId, tabPending);

      const responsePromise = new Promise((resolve) => {
        tabPending.set(clarifyId, { resolve, ts: Date.now() });
      });

      if (typeof onUpdate === 'function') {
        try {
          onUpdate('clarify', { clarifyId, question, options, reason });
        } catch { /* UI emit must never break the run */ }
      }

      const response = await responsePromise;
      tabPending.delete(clarifyId);
      if (tabPending.size === 0) this._pendingClarifications.delete(tabId);

      if (response && response.cancelled) {
        return { success: false, cancelled: true, reason: response.reason || 'clarify cancelled' };
      }
      const answer = String(response?.answer || '').trim();
      return {
        success: true,
        answer,
        source: response?.source || 'user',
        note: 'This is a direct reply from the user. Treat it as authoritative for the question you asked; do not re-ask. Continue the task with this answer in mind.',
      };
    }

    // Tools handled by the background/service worker
    if (name === 'navigate') {
      let rawUrl = String(args.url || '').trim();
      if (!rawUrl) {
        return { success: false, error: 'navigate: url is required' };
      }
      // Resolve relative URLs (e.g. "/acct_.../products") against the
      // current tab. chrome.tabs.update silently routes bare paths to
      // file:// which produces ERR_FILE_NOT_FOUND — the model then sees
      // success and loops. Resolve against the tab's origin instead, or
      // reject if we can't (e.g. tab on chrome:// with a relative input).
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawUrl)) {
        // Not absolute. Try to resolve against current tab URL.
        try {
          const tab = await chrome.tabs.get(tabId);
          const base = tab && tab.url;
          if (base && /^https?:/i.test(base)) {
            rawUrl = new URL(rawUrl, base).toString();
          } else {
            return {
              success: false,
              error: `navigate: "${args.url}" is not an absolute URL. Provide the full URL including scheme and host (e.g. "https://dashboard.stripe.com/${String(args.url).replace(/^\/+/, '')}"). Do NOT pass bare paths — they resolve to local files.`,
            };
          }
        } catch (e) {
          return { success: false, error: `navigate: cannot resolve relative URL "${args.url}" — no current tab URL available. Pass an absolute URL starting with https://.` };
        }
      }
      await chrome.tabs.update(tabId, { url: rawUrl });
      // Wait for navigation to commit so we can report the real final URL
      // (which may differ from rawUrl after redirects or auth walls).
      await new Promise(r => setTimeout(r, 2000));
      let finalUrl = rawUrl;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.url) finalUrl = tab.url;
      } catch {}
      return { success: true, url: finalUrl, requestedUrl: rawUrl };
    }

    if (name === 'new_tab') {
      const createProps = { url: args.url };
      let sourceTab = null;
      try {
        sourceTab = await chrome.tabs.get(tabId);
      } catch (_) {}
      if (sourceTab?.windowId != null) {
        createProps.windowId = sourceTab.windowId;
      }
      if (typeof sourceTab?.index === 'number') {
        createProps.index = sourceTab.index + 1;
      }
      if (sourceTab?.id != null) {
        createProps.openerTabId = sourceTab.id;
      }

      const tab = await chrome.tabs.create(createProps);
      // Enable the side panel for this new tab. Background.js no longer
      // pre-enables every tab (that was the bug — it leaked the agent's
      // progress into unrelated Cmd+T tabs), so any tab we want the user
      // to be able to inspect with the side panel has to be enabled
      // explicitly. The agent created this tab as part of its work, so
      // it's a "WebBrain tab" and gets the panel.
      try {
        chrome.sidePanel?.setOptions?.({
          tabId: tab.id,
          path: 'src/ui/sidepanel.html',
          enabled: true,
        });
      } catch { /* not critical to the tool's success */ }
      const groupId = await this._addToWebBrainGroup(sourceTab, tab.id);
      return { success: true, tabId: tab.id, url: args.url, groupId: groupId >= 0 ? groupId : null };
    }

    if (name === 'screenshot') {
      try {
        // Capture the image. The dataUrl is handed back through the special
        // `_attachImage` field so the batch loop can push it as an image_url
        // block on a follow-up user message (see _executeToolBatch) — exactly
        // how auto-screenshot already does it.
        //
        // Why not just return {image: dataUrl}? `_limitToolResult` stringifies
        // and chops at 8KB, which shreds any real PNG into invalid base64. And
        // OpenAI-compatible vision endpoints expect `image_url` blocks inside a
        // user message, not a base64 string embedded in a tool-result's JSON
        // text. Either way the model never sees the picture.
        let dataUrl = null;
        let description = '';
        let probe = null;
        let coordAligned = false;
        try {
          await cdpClient.attach(tabId);
          await cdpClient.sendCommand(tabId, 'Page.enable');
          probe = await this._captureViewportProbe(tabId);
          await this._bringToFrontForCapture(tabId);
          coordAligned = !!(args && args.coord_aligned);
          const cssW = Math.max(1, Math.round(probe?.innerWidth || 1024));
          const cssH = Math.max(1, Math.round(probe?.innerHeight || 768));

          if (coordAligned) {
            // Pixel-accuracy mode: image pixels must equal CSS pixels so
            // click({x,y}) off the screenshot lands on the real element.
            // PNG (lossless, no quality knob) so no artifacts at glyph edges.
            const screenshot = await this._withIndicatorsHidden(tabId, () =>
              cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
                format: 'png',
                fromSurface: true,
                clip: { x: 0, y: 0, width: cssW, height: cssH, scale: 1 },
              })
            );
            dataUrl = `data:image/png;base64,${screenshot.data}`;
            description = `Screenshot captured via CDP (${screenshot.data.length} bytes, CSS-pixel aligned for pixel clicks)`;
            // Byte-ceiling fallback only — we don't resize in coord mode.
            dataUrl = await this._compressJpegToByteCeiling(dataUrl);
          } else {
            // Budget-aware mode (default): pick target dims via binary
            // search, ask CDP to capture + scale in one pass, then run
            // the iterative-quality fallback if bytes are still over.
            const [targetW, targetH] = Agent._fitImageDimensions(cssW, cssH);
            const scale = targetW < cssW ? targetW / cssW : 1;
            const screenshot = await this._withIndicatorsHidden(tabId, () =>
              cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
                format: 'jpeg',
                quality: Math.round(Agent.IMAGE_BUDGET.initialJpegQuality * 100),
                fromSurface: true,
                clip: { x: 0, y: 0, width: cssW, height: cssH, scale },
              })
            );
            const rawUrl = `data:image/jpeg;base64,${screenshot.data}`;
            dataUrl = await this._compressJpegToByteCeiling(rawUrl);
            const resized = scale < 1 ? ` (resized ${cssW}×${cssH} → ${targetW}×${targetH} for vision-token budget)` : '';
            description = `Screenshot captured via CDP (${screenshot.data.length} bytes, JPEG)${resized}`;
          }
        } catch {
          const tab = await chrome.tabs.get(tabId);
          if (!tab?.active) {
            return {
              success: false,
              error: 'Cannot capture screenshot: this tab is not the active tab in its window. Switch to the tab to take a screenshot, or use a different tool.',
            };
          }
          // Tabs API fallback: no clip/scale available. Capture full, then
          // decode + resize + recompress via OffscreenCanvas to fit budget.
          const rawUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png', quality: 80 });
          if (!coordAligned) {
            const cssW = Math.max(1, Math.round(probe?.innerWidth || 1024));
            const cssH = Math.max(1, Math.round(probe?.innerHeight || 768));
            const shrunk = await this._shrinkImageForBudget(rawUrl, cssW, cssH);
            dataUrl = shrunk.dataUrl;
            description = `Screenshot captured via tabs API (${dataUrl.length} bytes base64, resized to ${shrunk.width}×${shrunk.height})`;
          } else {
            dataUrl = await this._compressJpegToByteCeiling(rawUrl);
            description = `Screenshot captured via tabs API (${dataUrl.length} bytes base64)`;
          }
        }

        // If the user asked to save this screenshot to Downloads, do it
        // here — directly from the service worker via chrome.downloads.
        // This runs BEFORE the vision-presentation branch because saving
        // is independent of whether the agent can see the image. The
        // screenshot data URLs are clean (image/png or image/jpeg with
        // no parameters) so they pass through downloads.download safely
        // — unlike the recorder's video/webm;codecs=... edge case.
        let savedFile = null;
        if (args && args.save) {
          try {
            const mimeMatch = /^data:([^;]+);/.exec(dataUrl);
            const mime = mimeMatch ? mimeMatch[1] : 'image/png';
            const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
            let filename = (args.filename || `webbrain-screenshot-${stamp}.${ext}`).trim();
            // Strip any directory components for safety; chrome.downloads
            // disallows them in MV3 anyway.
            filename = filename.split('/').pop().split('\\').pop();
            if (!/\.(png|jpg|jpeg)$/i.test(filename)) filename += `.${ext}`;
            const downloadId = await chrome.downloads.download({
              url: dataUrl, filename, saveAs: false,
            });
            savedFile = { downloadId, filename, mimeType: mime };
          } catch (e) {
            savedFile = { error: e.message || String(e) };
          }
        }

        // Pick the presentation path based on what the active providers can
        // actually do with an image. Order matters: a dedicated vision model
        // (cheaper, summary-only) wins over the main provider's own vision.
        const provider = this.providerManager.getActive();
        const visionProvider = await this.providerManager.getVisionProvider();

        if (visionProvider) {
          // Describe via the sidecar vision model. Return text only; no image
          // attachment needed — the main provider never needs to see pixels.
          const desc = await this._describeScreenshot(tabId, dataUrl, 'screenshot_tool');
          if (desc) {
            return {
              success: true,
              method: 'vision_describe',
              description: `[Screenshot described by vision model ${desc.model}]\n${desc.text}`,
              page: probe || undefined,
              coordAligned,
              savedFile: savedFile || undefined,
            };
          }
          // Sub-call failed — fall through to raw-image path if the main
          // provider supports vision, otherwise bail out with a useful error.
        }

        if (provider?.supportsVision) {
          // Raw-image path: hand the dataUrl to the batch loop via
          // `_attachImage`. The loop will strip it before stringifying the
          // tool result (keeping the tool-result text tiny) and then push a
          // `user` message containing the image_url block.
          return {
            success: true,
            method: 'image_attach',
            description,
            page: probe || undefined,
            coordAligned,
            savedFile: savedFile || undefined,
            _attachImage: dataUrl,
          };
        }

        // No vision: still a useful tool if the user asked to save.
        if (savedFile && !savedFile.error) {
          return {
            success: true,
            method: 'save_only',
            description: `Screenshot saved to Downloads as ${savedFile.filename}. (The active model has no vision, so the image was not shown to the model.)`,
            savedFile,
            page: probe || undefined,
            coordAligned,
          };
        }

        // No vision anywhere AND not saving — the model literally cannot see
        // this. Return an error rather than a deceptive "success".
        return {
          success: false,
          error: 'This model cannot see images: it has no vision capability and no dedicated vision model is configured. In provider settings, enable "Model supports vision" for the active provider or set a vision model. For now, use get_accessibility_tree, get_interactive_elements, or read_page to inspect the page. (If you only wanted to save the screenshot to a file, pass `save:true` — that works without vision.)',
        };
      } catch (e) {
        return { success: false, error: `Screenshot failed: ${e.message}` };
      }
    }

    if (name === 'scratchpad_write') {
      return this._scratchpadWrite(tabId, args);
    }

    if (name === 'done') {
      // In act mode, require a verification screenshot + page info before completing.
      const mode = this.conversationModes.get(tabId) || 'ask';
      if (mode === 'act') {
        try {
          await cdpClient.attach(tabId);
          await cdpClient.sendCommand(tabId, 'Page.enable');
          // Probe page health so the model can catch "I verified a stale
          // loading frame" cases, and bring the tab forward so the capture
          // reflects what the user would actually see.
          const probe = await this._captureViewportProbe(tabId);
          await this._bringToFrontForCapture(tabId);
          const shot = await this._withIndicatorsHidden(tabId, () =>
            cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
              format: 'png', quality: 80, fromSurface: true,
            })
          );
          let imageDataUrl = `data:image/png;base64,${shot.data}`;
          // If we remember the rect of the last ax interaction on this tab,
          // outline it on the screenshot so the model can anchor its review
          // to the element it actually touched.
          let annotatedRect = null;
          const last = this._lastInteractionRect.get(tabId);
          if (last) {
            const cssViewport = probe
              ? { width: probe.innerWidth, height: probe.innerHeight }
              : null;
            imageDataUrl = await this._annotateScreenshot(imageDataUrl, last, cssViewport);
            annotatedRect = { x: last.x, y: last.y, w: last.w, h: last.h };
          }

          // Probe for "work in progress" signals: an open dialog/modal or a
          // visible form. If any of these are present while the model claims
          // it created/added/saved/submitted something, that's a red flag —
          // the submit almost certainly didn't happen.
          let pageState = null;
          try {
            const stateProbe = await cdpClient.evaluate(tabId, `
              (() => {
                function visible(el) {
                  try {
                    const r = el.getBoundingClientRect();
                    if (r.width < 1 || r.height < 1) return false;
                    const s = window.getComputedStyle(el);
                    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
                    return true;
                  } catch (e) { return false; }
                }
                const dialogs = Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal="true"],dialog[open]')).filter(visible);
                const forms = Array.from(document.querySelectorAll('form')).filter(visible);
                // Cheap "success toast" signal: a visible element whose text
                // contains created/added/saved/success.
                const toasts = Array.from(document.querySelectorAll('[role=status],[role=alert],[aria-live]'))
                  .filter(visible)
                  .map(e => (e.innerText || '').trim().slice(0, 120))
                  .filter(Boolean);
                return {
                  openDialogCount: dialogs.length,
                  dialogTitles: dialogs.map(d => {
                    const h = d.querySelector('h1,h2,h3,[role=heading]');
                    return (h ? (h.innerText || '') : (d.getAttribute('aria-label') || '')).trim().slice(0, 80);
                  }).filter(Boolean),
                  visibleFormCount: forms.length,
                  liveRegionMessages: toasts,
                };
              })()
            `);
            pageState = stateProbe?.result?.value || null;
          } catch (e) {}

          // Synthesize a warning when summary claims completion but page
          // state contradicts it.
          let completionWarning = null;
          const summaryLower = String(args.summary || '').toLowerCase();
          const claimsCompletion = /\b(created|added|saved|submitted|posted|published|sent|done|completed|finished)\b/.test(summaryLower);
          if (claimsCompletion && pageState) {
            if (pageState.openDialogCount > 0 || pageState.visibleFormCount > 0) {
              const titlesStr = pageState.dialogTitles.length ? ` (dialog titles: ${pageState.dialogTitles.map(t => '"' + t + '"').join(', ')})` : '';
              completionWarning = `WARNING: Your summary claims the task was completed, but a ${pageState.openDialogCount > 0 ? 'modal/dialog' : 'form'} is still visible on the page${titlesStr}. This usually means the submit/save button was never clicked. Before calling done again, actually submit the form (click the primary action button like "Save", "Create", "Submit", or press Enter in the form) and verify a success indicator: a URL change away from the create/edit path, a toast/confirmation message, or the form disappearing. Do NOT claim success without this evidence.`;
            } else if (pageState.liveRegionMessages.length === 0 && probe?.url && /[?&](create|edit|new)\b/i.test(probe.url)) {
              completionWarning = `WARNING: Your summary claims the task was completed, but the URL still contains a create/edit query parameter (${probe.url}) and no success message is visible. Verify the submit actually happened before finishing.`;
            }
          }

          // If completionWarning fires, DO NOT terminate. Return a regular
          // failed tool result so the agent loop continues and the model
          // must actually submit (and verify) before it can call done again.
          // Also track how many times we've blocked on this tab so the model
          // can escape if the heuristic is wrong (e.g. the "form" is a
          // search/filter bar, not a submit form).
          if (completionWarning) {
            if (!this._doneBlockCount) this._doneBlockCount = new Map();
            const blocks = (this._doneBlockCount.get(tabId) || 0) + 1;
            this._doneBlockCount.set(tabId, blocks);
            if (blocks <= 2) {
              return {
                success: false,
                blockedDone: true,
                error: completionWarning + ` (block attempt ${blocks}/2 — if you genuinely believe the task is complete and the visible form/dialog is unrelated, re-call done with summary explicitly acknowledging this, e.g. "already-existing product, no submit needed".)`,
                pageUrl: probe?.url || '',
                pageState,
              };
            }
            // After 2 blocks, let done through with a loud note in verification.
          }
          // Reset block count on successful done.
          if (this._doneBlockCount) this._doneBlockCount.delete(tabId);

          return {
            done: true,
            summary: args.summary,
            verification: {
              pageUrl: probe?.url || '',
              pageTitle: probe?.title || '',
              screenshot: imageDataUrl,
              page: probe || undefined,
              annotatedRect,
              pageState,
              completionWarning,
              note: 'Review this screenshot carefully. Does it confirm the task was completed successfully? If the page shows an existing item from the past (check dates), you may NOT have actually created anything new.' + (annotatedRect ? ' The red-outlined region is the element you last interacted with.' : '') + (completionWarning ? ' ' + completionWarning : ''),
            },
          };
        } catch (_) {
          // Screenshot failed — still allow done but note it
          return { done: true, summary: args.summary, verification: null };
        }
      }
      return { done: true, summary: args.summary };
    }

    // ─── Network & download tools ─────────────────────────────────────
    // These run in the background script context. fetchUrl/readDownloadedFile
    // attach the user's cookies only when the target shares the registrable
    // domain (eTLD+1) of the active tab — see network-tools.js for the
    // cookie & redirect policy. They don't touch the active tab DOM, so
    // they're safe to call any time.

    if (name === 'fetch_url') {
      return await fetchUrl(args.url, args, { tabId });
    }
    if (name === 'research_url') {
      return await researchUrl(args.url, { ...args, sourceTabId: tabId });
    }
    if (name === 'list_downloads') {
      return await listDownloads(args);
    }
    if (name === 'read_downloaded_file') {
      return await readDownloadedFile(args.downloadId, { tabId });
    }
    if (name === 'download_resource_from_page') {
      return await downloadResourceFromPage(tabId, args);
    }
    if (name === 'download_files' || name === 'download_file') {
      if (args.url && !args.urls) args.urls = [args.url];
      return await downloadFiles(args);
    }

    // ─── CAPTCHA solver ──────────────────────────────────────────────
    // Only meaningfully wired when the user has enabled CapSolver in
    // Settings. We re-check on every call so flipping the toggle or
    // rotating the key takes effect without a restart.
    if (name === 'solve_captcha') {
      try {
        const stored = await chrome.storage.local.get(['captchaSolverEnabled', 'capsolverApiKey']);
        if (!stored.captchaSolverEnabled) {
          return { success: false, error: 'CapSolver is not enabled. Ask the user to enable it in Settings → CAPTCHA, or fall back to asking them to solve the captcha manually.' };
        }
        const apiKey = (stored.capsolverApiKey || '').trim();
        if (!apiKey) {
          return { success: false, error: 'CapSolver is enabled but no API key is configured. Ask the user to set one in Settings → CAPTCHA, or fall back to asking them to solve the captcha manually.' };
        }

        // Resolve the website URL — the active tab's URL is what the
        // captcha vendor needs to match its sitekey allowlist.
        let websiteURL = '';
        try {
          const tab = await chrome.tabs.get(tabId);
          websiteURL = tab?.url || '';
        } catch {}

        // Detect when the model didn't pre-specify a captcha type. Image-
        // to-text is a special case that needs an explicit imageBase64.
        let { type, websiteKey, isInvisible, pageAction, minScore, imageBase64 } = args || {};
        if (!type) {
          const detected = await detectCaptcha(tabId);
          if (!detected) {
            return { success: false, error: 'No CAPTCHA detected on the page. If the captcha lives inside a cross-origin iframe or uses a non-standard widget, pass `type` and `websiteKey` explicitly.' };
          }
          type = detected.type;
          if (!websiteKey) websiteKey = detected.websiteKey;
          if (isInvisible == null && detected.isInvisible != null) isInvisible = detected.isInvisible;
          if (!pageAction && detected.pageAction) pageAction = detected.pageAction;
        }

        if (type === 'image_to_text') {
          if (!imageBase64) {
            return { success: false, error: 'solve_captcha: image_to_text requires `imageBase64`.' };
          }
        } else if (!websiteKey) {
          return { success: false, error: `solve_captcha: ${type} requires a websiteKey (data-sitekey). Auto-detection didn't find one — pass it explicitly.` };
        }

        const result = await solveCaptcha(apiKey, {
          type,
          websiteURL,
          websiteKey,
          ...(isInvisible != null ? { isInvisible } : {}),
          ...(pageAction ? { pageAction } : {}),
          ...(minScore ? { minScore } : {}),
          ...(imageBase64 ? { body: imageBase64 } : {}),
        });

        // For non-image types, push the token into the page response field
        // unless the caller explicitly opted out.
        const wantInject = args?.inject !== false && type !== 'image_to_text';
        let injection = null;
        if (wantInject && result.fieldName && result.token) {
          try {
            injection = await injectToken(tabId, {
              fieldName: result.fieldName,
              alsoSet: result.alsoSet,
              token: result.token,
            });
          } catch (e) {
            injection = { success: false, error: e.message };
          }
        }

        return {
          success: true,
          type,
          taskId: result.taskId,
          token: result.token,
          tokenPreview: result.token ? `${String(result.token).slice(0, 24)}…(${String(result.token).length} chars)` : null,
          injected: injection?.success === true,
          injection,
          note: wantInject
            ? 'Token was injected into the page response field. Click the form\'s submit button next; do NOT call solve_captcha again.'
            : 'Token returned, not injected. Pass it to the form via type_text on the response field, then submit.',
        };
      } catch (e) {
        return { success: false, error: `solve_captcha failed: ${e.message}` };
      }
    }

    // ─── Tab Recorder (v7.4) ──────────────────────────────────────────
    // Prompt-driven counterparts to the sidepanel's button. Both wrap the
    // shared orchestration in src/recorder/host.js so user-UI and agent-
    // tool paths can't drift.
    if (name === 'record_tab') {
      const opts = {
        video: args?.video !== false,
        mic: args?.mic !== false,
        transcribeAfter: !!args?.transcribe,
      };
      const r = await recorderStart(tabId, opts);
      if (!r.ok) return { success: false, error: r.error };
      const s = r.state;
      return {
        success: true,
        state: s,
        note: `Recording started at ${new Date(s.startedAt).toISOString()}.` +
              (s.hasMic ? '' : ' (Microphone unavailable — recording tab audio only.)') +
              ' Tell the user the red banner at the top of the sidebar shows the live timer and a Stop button; call `stop_recording` when they ask you to stop, or just let them click Stop themselves.',
      };
    }
    if (name === 'stop_recording') {
      const cur = recorderGetState();
      if (!cur.active) {
        return { success: false, error: 'No active recording to stop.' };
      }
      const r = await recorderStop();
      if (!r.ok) return { success: false, error: r.error };
      return {
        success: true,
        filename: r.filename,
        downloadId: r.downloadId,
        sizeBytes: r.sizeBytes,
        durationMs: r.durationMs,
        transcribeAfter: r.transcribeAfter,
        note: r.transcribeAfter
          ? `Recording saved as ${r.filename}. Whisper transcription is running in the background; the user will see "Transcript saved" in the sidebar when it finishes.`
          : `Recording saved as ${r.filename}.`,
      };
    }

    // ─── PDF reader ───────────────────────────────────────────────────
    // Chrome's built-in PDF viewer is a chrome-extension:// page that our
    // content scripts cannot inject into, so click / read_page / get_ax
    // all silently no-op against PDF tabs and the agent click-loops on
    // the viewer chrome. read_pdf bypasses the viewer entirely: fetches
    // the binary, parses it with the bundled pdfjs-dist, returns text.
    if (name === 'read_pdf') {
      try {
        let pdfUrl = String(args.url || '').trim();
        if (!pdfUrl) {
          // Default to the active tab's URL.
          try {
            const tab = await chrome.tabs.get(tabId);
            pdfUrl = tab?.url || '';
          } catch {}
        }
        if (!pdfUrl) {
          return { success: false, error: 'read_pdf: no url provided and could not read the active tab URL.' };
        }

        const result = await extractPdfText(pdfUrl, {
          fromPage: args.fromPage,
          toPage: args.toPage,
          maxChars: args.maxChars,
        });

        // Tier 2 — Anthropic Claude PDF passthrough. If the active provider
        // can natively consume PDFs as a `document` content block AND the
        // file fits under the size cap, attach the raw bytes via
        // `_attachDocument`. The batch loop strips this field before
        // stringifying the tool result and pushes the document as a
        // follow-up user message (analogous to the `_attachImage` path
        // used by `screenshot`).
        const provider = this.providerManager.getActive();
        const bytes = result._pdfBytes;
        delete result._pdfBytes;

        if (
          bytes &&
          providerSupportsPdfPassthrough(provider) &&
          bytes.length <= PDF_PASSTHROUGH_MAX_BYTES
        ) {
          let docName = result.title || '';
          if (!docName) {
            try {
              const u = new URL(pdfUrl);
              docName = decodeURIComponent(u.pathname.split('/').pop() || 'document.pdf');
            } catch { docName = 'document.pdf'; }
          }
          const docBlock = buildClaudeDocumentBlock(bytes, docName);
          return {
            ...result,
            method: 'pdf_text+claude_document',
            description: `PDF text extracted (${result.pageCount} pages); raw bytes also attached as Claude document block for full-fidelity reading.`,
            _attachDocument: docBlock,
          };
        }

        // Helpful note for the model when text extraction failed (scanned PDF).
        if (!result.hasExtractableText) {
          result.note = 'This PDF appears to have no extractable text layer (likely scanned images). Consider enabling a vision model and using full_page_screenshot, or asking the user for a text-based version.';
        }

        return { ...result, method: 'pdf_text' };
      } catch (e) {
        return { success: false, error: `read_pdf failed: ${e.message}` };
      }
    }

    if (name === 'full_page_screenshot') {
      try {
        await cdpClient.attach(tabId);
        await this._bringToFrontForCapture(tabId);
        const imageData = await this._withIndicatorsHidden(tabId, () =>
          cdpClient.captureFullPageScreenshot(tabId)
        );
        const rawUrl = `data:image/png;base64,${imageData}`;

        // If the caller asked to save, do it with the RAW (uncompressed,
        // full-resolution) PNG — that's what the user actually wants on
        // disk, not the budget-shrunk version we feed the model.
        let savedFile = null;
        if (args && args.save) {
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
            let filename = (args.filename || `webbrain-fullpage-${stamp}.png`).trim();
            filename = filename.split('/').pop().split('\\').pop();
            if (!/\.(png|jpg|jpeg)$/i.test(filename)) filename += '.png';
            const downloadId = await chrome.downloads.download({
              url: rawUrl, filename, saveAs: false,
            });
            savedFile = { downloadId, filename, mimeType: 'image/png' };
          } catch (e) {
            savedFile = { error: e.message || String(e) };
          }
        }

        // Full-page captures are the worst case for size — a 1920×8000
        // document at native DPR easily blows past any provider's image
        // budget. Always shrink to the token/byte budget. Dimensions come
        // from decoding the bitmap (we don't know the real doc size up
        // front the way we do for viewport captures).
        const shrunk = await this._shrinkImageForBudget(rawUrl, 0, 0);

        // Check the planner/vision setup. A text-only model with no
        // vision sub-call can't consume this at all — refuse rather
        // than hand over a huge useless payload.
        const provider = this.providerManager.getActive();
        const visionProvider = await this.providerManager.getVisionProvider();
        if (visionProvider) {
          const desc = await this._describeScreenshot(tabId, shrunk.dataUrl, 'full_page_screenshot');
          if (desc) {
            return {
              success: true,
              method: 'vision_describe',
              description: `[Full-page screenshot described by vision model ${desc.model}, ${shrunk.width}×${shrunk.height} after budget fit]\n${desc.text}`,
              savedFile: savedFile || undefined,
            };
          }
        }
        if (provider?.supportsVision) {
          return {
            success: true,
            method: 'image_attach',
            description: `Full page screenshot captured and fit to vision budget (${shrunk.width}×${shrunk.height}, ${shrunk.dataUrl.length} base64 chars)`,
            savedFile: savedFile || undefined,
            _attachImage: shrunk.dataUrl,
          };
        }
        if (savedFile && !savedFile.error) {
          return {
            success: true,
            method: 'save_only',
            description: `Full-page screenshot saved to Downloads as ${savedFile.filename}.`,
            savedFile,
          };
        }
        return {
          success: false,
          error: 'This model cannot see images. Enable "Model supports vision" for the active provider, configure a dedicated vision model, or pass `save:true` to just save the file.',
        };
      } catch (e) {
        return { success: false, error: `Full page screenshot failed: ${e.message}` };
      }
    }

    if (name === 'verify_form') {
      try {
        await cdpClient.attach(tabId);

        // 1. Read form fields
        const formData = await cdpClient.evaluate(tabId, `
          (() => {
            const sel = ${JSON.stringify(args.selector || '')};
            let form;
            if (sel) {
              form = document.querySelector(sel);
            } else {
              const focused = document.activeElement;
              form = focused?.closest('form') || document.querySelector('form');
            }
            if (!form) return { found: false, error: 'No form found on page' };

            const fields = [];
            for (const el of form.querySelectorAll('input, select, textarea')) {
              const n = el.name || el.id || el.getAttribute('aria-label') || '';
              const t = el.type || el.tagName.toLowerCase();
              if (t === 'hidden' || t === 'submit') continue;
              let v;
              if (t === 'checkbox' || t === 'radio') {
                v = el.checked ? (el.value || 'on') : '(unchecked)';
              } else if (el.tagName === 'SELECT') {
                const o = el.options[el.selectedIndex];
                v = o ? o.text + ' [' + o.value + ']' : '';
              } else {
                v = el.value;
              }
              fields.push({ name: n, type: t, value: v, placeholder: el.placeholder || '' });
            }
            return { found: true, action: form.action || '', method: form.method || 'get', fieldCount: fields.length, fields };
          })()
        `);

        const result = formData?.result?.value || { found: false, error: 'Evaluation returned no data' };

        // 2. Capture screenshot
        try {
          await cdpClient.sendCommand(tabId, 'Page.enable');
          await this._bringToFrontForCapture(tabId);
          const shot = await this._withIndicatorsHidden(tabId, () =>
            cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
              format: 'png', quality: 100, fromSurface: true,
            })
          );
          result.image = `data:image/png;base64,${shot.data}`;
        } catch {
          result.screenshotFailed = true;
        }

        result.success = !!result.found;
        return result;
      } catch (e) {
        return { success: false, error: `verify_form failed: ${e.message}` };
      }
    }

    if (name === 'get_shadow_dom') {
      try {
        await cdpClient.attach(tabId);
        const pageInfo = await cdpClient.readPage(tabId);
        return {
          success: true,
          shadowHosts: pageInfo.shadowHosts || [],
        };
      } catch (e) {
        return { success: false, error: `Failed to get shadow DOM info: ${e.message}` };
      }
    }

    if (name === 'shadow_dom_query') {
      try {
        await cdpClient.attach(tabId);
        await cdpClient.sendCommand(tabId, 'DOM.enable');
        await cdpClient.sendCommand(tabId, 'DOM.getDocument', { depth: 0 });

        const result = await cdpClient.evaluate(tabId, `
          (() => {
            const results = [];
            const pierce = (root, sel) => {
              try {
                const els = root.querySelectorAll(sel);
                els.forEach(el => {
                  results.push({
                    tag: el.tagName.toLowerCase(),
                    text: (el.innerText || '').trim().slice(0, 100),
                    id: el.id || '',
                    hasShadowRoot: !!el.shadowRoot,
                    shadowMode: el.shadowRoot?.mode || null,
                  });
                });
              } catch (e) {}
              root.querySelectorAll('*').forEach(host => {
                if (host.shadowRoot) pierce(host.shadowRoot, sel);
              });
            };
            pierce(document, '${args.selector.replace(/'/g, "\\'")}');
            return results;
          })()
        `);
        return { success: true, elements: result?.result?.value || [] };
      } catch (e) {
        return { success: false, error: `Shadow DOM query failed: ${e.message}` };
      }
    }

    if (name === 'get_frames') {
      try {
        await cdpClient.attach(tabId);
        const frames = await cdpClient.getAllFrames(tabId);
        return { success: true, frames };
      } catch (e) {
        return { success: false, error: `Failed to get frames: ${e.message}` };
      }
    }

    if (name === 'iframe_read') {
      try {
        // chrome.scripting.executeScript with allFrames:true injects into
        // every frame in the tab, INCLUDING cross-origin iframes. This
        // bypasses the same-origin policy that page JS is subject to —
        // extensions with <all_urls> host_permission have this superpower
        // by design. Each result entry includes the frame's URL so we can
        // filter post-hoc.
        const urlFilter = args.urlFilter || '';
        const selector = args.selector || 'body';
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (sel) => {
            try {
              const el = document.querySelector(sel);
              return {
                ok: !!el,
                url: location.href,
                title: document.title || '',
                text: el ? (el.innerText || '').slice(0, 4000) : '',
                html: el ? (el.innerHTML || '').slice(0, 4000) : '',
                tag: el ? el.tagName : null,
              };
            } catch (e) {
              return { ok: false, url: location.href, error: e.message };
            }
          },
          args: [selector],
        });
        // results is an array of {frameId, result} entries — one per frame.
        const frames = results
          .map(r => r.result)
          .filter(r => r && (!urlFilter || (r.url && r.url.includes(urlFilter))));
        return { success: true, frameCount: frames.length, frames };
      } catch (e) {
        return { success: false, error: `Iframe read failed: ${e.message}` };
      }
    }

    if (name === 'iframe_click') {
      try {
        // Inject into all frames; in each frame, see if the selector resolves
        // and if the URL matches the optional filter, then click. Returns the
        // first successful frame.
        const urlFilter = args.urlFilter || '';
        const selector = args.selector;
        if (!selector) return { success: false, error: 'selector is required' };
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (sel, filter) => {
            if (filter && !location.href.includes(filter)) {
              return { ok: false, skipped: 'url-filter', url: location.href };
            }
            try {
              const el = document.querySelector(sel);
              if (!el) return { ok: false, url: location.href, reason: 'not-found' };
              if (el.tagName !== 'SELECT') el.scrollIntoView({ block: 'center', inline: 'center' });
              // Trigger a real-ish click sequence (frameworks often need
              // pointer events, not just click).
              const rect = el.getBoundingClientRect();
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
              try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.click();
              return {
                ok: true,
                url: location.href,
                tag: el.tagName,
                text: (el.innerText || el.value || '').slice(0, 80),
              };
            } catch (e) {
              return { ok: false, url: location.href, error: e.message };
            }
          },
          args: [selector, urlFilter],
        });
        const successes = results.map(r => r.result).filter(r => r && r.ok);
        if (successes.length > 0) {
          return { success: true, method: 'iframe-click', frame: successes[0] };
        }
        const candidates = results.map(r => r.result).filter(r => r && !r.skipped);
        return {
          success: false,
          error: 'Element not found in any matching iframe',
          searchedFrames: candidates.length,
          frameUrls: candidates.map(c => c.url).slice(0, 5),
        };
      } catch (e) {
        return { success: false, error: `Iframe click failed: ${e.message}` };
      }
    }

    if (name === 'iframe_type') {
      try {
        const urlFilter = args.urlFilter || '';
        const selector = args.selector;
        const text = args.text || '';
        const clear = !!args.clear;
        if (!selector) return { success: false, error: 'selector is required' };
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (sel, txt, clr, filter) => {
            if (filter && !location.href.includes(filter)) {
              return { ok: false, skipped: 'url-filter', url: location.href };
            }
            try {
              const el = document.querySelector(sel);
              if (!el) return { ok: false, url: location.href, reason: 'not-found' };
              el.focus();
              if (el.isContentEditable) {
                if (clr) el.textContent = '';
                el.textContent += txt;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: txt }));
                return { ok: true, url: location.href, method: 'contenteditable', value: el.textContent.slice(0, 100) };
              }
              const proto = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              const newVal = (clr ? '' : (el.value || '')) + txt;
              if (setter) setter.call(el, newVal); else el.value = newVal;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, url: location.href, method: 'native-setter', value: (el.value || '').slice(0, 100) };
            } catch (e) {
              return { ok: false, url: location.href, error: e.message };
            }
          },
          args: [selector, text, clear, urlFilter],
        });
        const successes = results.map(r => r.result).filter(r => r && r.ok);
        if (successes.length > 0) {
          return { success: true, frame: successes[0] };
        }
        const candidates = results.map(r => r.result).filter(r => r && !r.skipped);
        return {
          success: false,
          error: 'Input not found in any matching iframe',
          searchedFrames: candidates.length,
          frameUrls: candidates.map(c => c.url).slice(0, 5),
        };
      } catch (e) {
        return { success: false, error: `Iframe type failed: ${e.message}` };
      }
    }

    if (name === 'download_social_media') {
      try {
        // Inject the SocialMediaDownloader library into the page's main
        // world so it shares fetch/XHR/cookies with page scripts — same
        // execution context the script's DevTools-console docs target.
        // Idempotent: subsequent injections re-define window.SocialMediaDownloader.
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/agent/social-media-downloader.js'],
          world: 'MAIN',
        });
        const opts = {
          mode: args.mode || 'auto',
          all: !!args.scroll,
          limit: typeof args.limit === 'number' && args.limit > 0
            ? args.limit
            : Number.MAX_SAFE_INTEGER,
        };
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async (runOpts) => {
            if (!window.SocialMediaDownloader) {
              return { success: false, error: 'SocialMediaDownloader did not load on this page (likely a page CSP block).' };
            }
            try {
              const runResult = await window.SocialMediaDownloader.run(runOpts);
              // v4: run() now returns { urls, stats }. Earlier callers
              // got just the URL array — handle both shapes so a stale
              // injection in another extension realm doesn't blow up.
              const urls = Array.isArray(runResult)
                ? runResult
                : (runResult && runResult.urls) || [];
              const stats = (runResult && runResult.stats) || null;
              const profile = window.SocialMediaDownloader._activeProfile().name;
              // Total bytes the document_start MSE recorder captured
              // for this page (zero if not on a supported social host
              // or the player hasn't been played). Feeds the
              // recommendation builder so we can tell the agent to
              // call saveMse() when there's actually a capture.
              let mseBytes = 0;
              try {
                const rec = window.SocialMediaDownloader.getMseRecording();
                for (const ms of (rec.mediaSources || [])) {
                  for (const b of (ms.buffers || [])) mseBytes += (b.bytes || 0);
                }
                for (const b of (rec.orphanBuffers || [])) mseBytes += (b.bytes || 0);
              } catch (_) { /* recorder optional */ }
              // If the MSE recorder captured bytes, save them HERE rather
              // than asking the agent to call execute_js → saveMse() in a
              // follow-up step. The follow-up pattern was broken by the
              // extension's own CSP (no `unsafe-eval`), and the user-
              // observable behaviour ("28 MB captured but won't save") was
              // a head-scratcher. Now `download_social_media` is a single
              // call that completes the save end-to-end on supported sites.
              // Failures fall through to the recommendation path below.
              let mseSavedFiles = [];
              let mseSaveError = null;
              if (mseBytes > 0) {
                try {
                  mseSavedFiles = await window.SocialMediaDownloader.saveMse({
                    prefix: (window.location && window.location.hostname || 'mse').replace(/^www\./, ''),
                    mode: runOpts.mode,
                  });
                } catch (e) {
                  mseSaveError = (e && e.message) || String(e);
                }
              }
              const recommendation = window.SocialMediaDownloader._buildRecommendation({
                urls, profile, mseBytes, mseSavedFiles, mseSaveError, pageUrl: location.href,
              });
              // Honest per-status counts so the agent can detect cases
              // where 713 URLs were "found" but only 1 file actually
              // downloaded (popup-blocking after the first new-tab
              // fallback). `triggeredCount` is what we attempted;
              // `completedCount` is what we successfully fetched and
              // handed to <a download>; `openedInTabCount` opened a new
              // tab as a last resort (uncertain — verify with
              // list_downloads); `failedCount` is hard errors.
              // Roll mse-saved files into the completed count so the agent
              // sees one consistent "N files downloaded" number rather than
              // having to add up urls + mseSavedFiles itself.
              const completedFromStats = stats ? stats.completed : 0;
              const mseSavedCount = mseSavedFiles.length;
              return {
                success: true,
                site: profile,
                mode: runOpts.mode,
                count: urls.length + mseSavedCount,
                triggeredCount: (stats ? stats.triggered : urls.length) + mseSavedCount,
                completedCount: completedFromStats + mseSavedCount,
                openedInTabCount: stats ? stats.openedInTab : null,
                failedCount: stats ? stats.failed : null,
                failures: stats ? stats.failures : [],
                urls: urls.slice(0, 50),
                mseBytes,
                mseSavedFiles,                  // [{filename, bytes, mime}, ...]
                ...(mseSaveError ? { mseSaveError } : {}),
                recommendation,
              };
            } catch (e) {
              return { success: false, error: (e && e.message) || String(e) };
            }
          },
          args: [opts],
        });
        const result = results?.[0]?.result;
        if (!result) {
          return { success: false, error: 'download_social_media: no result returned (tab may have navigated away).' };
        }
        return result;
      } catch (e) {
        return { success: false, error: `download_social_media failed: ${e.message}` };
      }
    }

    // download_file is now handled by download_files (normalized above)

    if (name === 'upload_file') {
      try {
        await cdpClient.attach(tabId);
        const nodeIds = await cdpClient.querySelectorPierce(tabId, args.selector);
        if (!nodeIds || nodeIds.length === 0) {
          return { success: false, error: 'File input not found' };
        }
        await cdpClient.setFileInputFiles(tabId, nodeIds[0], [args.filePath]);
        return { success: true, file: args.filePath };
      } catch (e) {
        return { success: false, error: `Upload failed: ${e.message}` };
      }
    }

    // Click/type are routed through CDP for robust shadow-DOM piercing,
    // real Input.dispatchMouseEvent / Input.insertText events, and
    // selector-resolution retry. The content-script versions only see flat
    // document.querySelector and el.click(), which fails on Web Components,
    // closed shadow roots, and many React/Vue handlers.
    if (name === 'click') {
      try {
        // ── Normalized-coord guard ──────────────────────────────────────
        // Some models pass {x: 0.91, y: 0.33} thinking coords are
        // normalized (0–1 fractions of the viewport). The click tool takes
        // CSS pixels — so 0.91 hits the very top-left of the page, the
        // click misses, the model retries the same values, and we burn 8
        // attempts before the coord-loop detector trips. Reject up front
        // so the model pivots to click_ax / click({text}) on the first try.
        if (args.x != null && args.y != null) {
          const xn = Number(args.x);
          const yn = Number(args.y);
          if (Number.isFinite(xn) && Number.isFinite(yn) && xn >= 0 && xn <= 1 && yn >= 0 && yn <= 1) {
            return {
              success: false,
              error: `Coordinates (${args.x}, ${args.y}) look like normalized values (0–1 fractions of the viewport), not CSS pixels. The click tool expects CSS pixels (e.g. {x: 437, y: 156}). Prefer click_ax({ref_id}) after get_accessibility_tree or click({text: "..."}) over pixel clicks — they don't depend on screenshot resolution. If you must use pixels, take screenshot({coord_aligned: true}) first and pass integer pixel coordinates from the returned image.`,
            };
          }
        }

        await cdpClient.attach(tabId);

        // ── Duplicate submit-click guard ────────────────────────────────
        // The model often mistakes the modal-open link and the in-modal
        // submit button on Stripe-style UIs (both labeled "Create product",
        // "Add product", etc.) — clicking twice creates duplicate records.
        // Track clicks whose text matches a submit-like pattern and block
        // a second one on the same tab+URL within a short window, UNLESS
        // the URL has changed (real navigation) or the model explicitly
        // acknowledges the duplicate via args._allowResubmit = true.
        if (args.text && !args._allowResubmit) {
          const rawText = String(args.text).trim();
          const submitLikeRE = /^(create|save|submit|add|post|publish|send|confirm|sign up|sign in|log in|register|place order|pay|checkout|update|apply|finish|done)\b/i;
          if (submitLikeRE.test(rawText)) {
            let curUrl = '';
            try { const t = await chrome.tabs.get(tabId); curUrl = t?.url || ''; } catch (e) {}
            if (!this._recentSubmitClicks) this._recentSubmitClicks = new Map();
            const buf = this._recentSubmitClicks.get(tabId) || [];
            const key = `${rawText.toLowerCase()}|${curUrl}`;
            const now = Date.now();
            // Keep entries from the last 45 seconds
            const fresh = buf.filter(e => now - e.ts < 45000);
            const match = fresh.find(e => e.key === key);
            if (match) {
              return {
                success: false,
                blockedDuplicateSubmit: true,
                error: `Blocked: you already clicked "${rawText}" on this page ${Math.round((now - match.ts) / 1000)}s ago and the URL has not changed since. Stripe-style UIs often reuse the same label for the modal-OPEN button and the SUBMIT button inside the modal — a second click typically creates a duplicate record. Before clicking "${rawText}" again, verify: (a) that all required fields are actually filled (take a screenshot or read the form), (b) that this click is intended as a FIRST submit and not a retry. If the previous click did nothing because a field was empty, fill the field first. If you genuinely need to retry, pass _allowResubmit: true in the args.`,
                previousClickUrl: match.url,
                currentUrl: curUrl,
                secondsSincePrevious: Math.round((now - match.ts) / 1000),
              };
            }
            fresh.push({ key, ts: now, url: curUrl, text: rawText });
            this._recentSubmitClicks.set(tabId, fresh);
          }
        }

        // ── Global SELECT guard ─────────────────────────────────────────
        // Inject a capture-phase mousedown+click listener that prevents
        // native <select> dropdown popups from opening via ANY mouse path
        // (CDP events, el.click(), label activation, execute_js, etc.).
        // The listener also focuses the select so type_text can work.
        // Idempotent — the __wb_sel_guard flag prevents double-injection.
        await cdpClient.evaluate(tabId, `
          if (!window.__wb_sel_guard) {
            window.__wb_sel_guard = true;
            function findNearbySelect(el) {
              if (!el) return null;
              if (el.tagName === 'SELECT') return el;
              // Walk up ancestors
              let t = el;
              for (let i = 0; i < 5 && t; i++) {
                if (t.tagName === 'SELECT') return t;
                t = t.parentElement;
              }
              // Check siblings (Stripe pattern: <a> and <select> are siblings)
              const p = el.parentElement;
              if (p) {
                for (const sib of p.children) {
                  if (sib.tagName === 'SELECT') return sib;
                }
              }
              // Check if an ancestor wraps a select
              const anc = el.closest ? el.closest('[class]') : null;
              if (anc) {
                const s = anc.querySelector('select');
                if (s) return s;
              }
              return null;
            }
            ['mousedown','pointerdown','click'].forEach(evt => {
              document.addEventListener(evt, e => {
                const sel = findNearbySelect(e.target);
                if (sel) { e.preventDefault(); e.stopPropagation(); sel.focus(); }
              }, true);
            });
          }
        `);

        // Detect common LLM mistakes: jQuery / Playwright pseudo-classes
        // that look like CSS but aren't.
        if (args.selector && /:contains\(|:has-text\(/.test(args.selector)) {
          return {
            success: false,
            error: `Invalid selector: ":contains()" and ":has-text()" are not valid CSS — they are jQuery/Playwright extensions and browsers do not understand them. Use click({text: "..."}) to click by visible text instead, or click({index: N}) using an index from get_interactive_elements.`,
          };
        }
        if (args.text) {
          // ── Auto-select: if text matches a <select> option, select it ──
          // This catches cases like click({text:"Yearly"}) where the model
          // is trying to click an option inside a native/custom dropdown.
          // Instead of clicking (which fails for native selects), we select
          // the option directly via keyboard arrows.
          const autoSelResult = await this._autoSelectOption(tabId, cdpClient, args.text);
          if (autoSelResult) return autoSelResult;

          // Text-based click with auto-fallback matching.
          // When textMatch is not specified (default), tries exact → prefix →
          // contains in order. At each level, if multiple elements match, an
          // ambiguity error is returned instead of clicking an arbitrary one.
          // When textMatch IS specified, only that mode is used.
          const result = await cdpClient.evaluate(tabId, `
            (() => {
              const needle = ${JSON.stringify(args.text.toLowerCase())};
              const explicit = ${JSON.stringify(args.textMatch || '')};
              // Include inputs/select/textarea so we can match by placeholder,
              // value, or aria-label — not just visible button/link text.
              const sels = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), textarea, select, input[type="button"], input[type="submit"], summary, label, [onclick], [data-action]';
              const all = Array.from(document.querySelectorAll(sels));
              const normalized = all.map(el => ({
                el,
                txt: (el.innerText || el.value || el.placeholder || el.ariaLabel || '').trim().toLowerCase(),
              })).filter(x => !!x.txt);

              // Also build a label→input map so we can match label text
              // and resolve to the associated input field.
              const labelMap = new Map();
              document.querySelectorAll('label').forEach(lbl => {
                const txt = (lbl.innerText || '').trim().toLowerCase();
                if (!txt) return;
                let target = null;
                if (lbl.htmlFor) target = document.getElementById(lbl.htmlFor);
                if (!target) target = lbl.querySelector('input,textarea,select');
                if (target) labelMap.set(txt, target);
              });

              function tryMode(mode) {
                if (mode === 'exact') return normalized.filter(x => x.txt === needle);
                if (mode === 'prefix') return normalized.filter(x => x.txt.startsWith(needle));
                if (mode === 'contains') return normalized.filter(x => x.txt.includes(needle));
                return [];
              }

              // Determine which modes to try.
              const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
              if (explicit && !['exact', 'prefix', 'contains'].includes(explicit)) {
                return { found: false, error: 'Invalid textMatch. Use exact, prefix, or contains.' };
              }

              let matches = [];
              let usedMode = modes[0];
              for (const m of modes) {
                matches = tryMode(m);
                usedMode = m;
                if (matches.length === 1) break;
                if (matches.length > 1) break;
              }

              // If no direct match, try matching against label text → input
              if (matches.length === 0) {
                for (const [ltxt, inp] of labelMap) {
                  const ok = (needle === ltxt) || ltxt.startsWith(needle) || ltxt.includes(needle);
                  if (ok) {
                    inp.scrollIntoView({ block: 'center', inline: 'center' });
                    inp.focus();
                    let r = inp.getBoundingClientRect();
                    // Fallback for zero-dimension inputs (styled wrappers)
                    if (r.width === 0 || r.height === 0) {
                      let p = inp.parentElement;
                      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                        const pr = p.getBoundingClientRect();
                        if (pr.width > 0 && pr.height > 0) { r = pr; break; }
                      }
                    }
                    return {
                      found: true, mode: 'label', x: r.left + r.width / 2,
                      y: r.top + r.height / 2, tag: inp.tagName,
                      text: ltxt.slice(0, 80), focusedInput: true,
                    };
                  }
                }
                return { found: false, mode: usedMode };
              }

              // --- Prioritize interactive elements over passive children ---
              const _INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
              const _INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option']);
              const _PASSIVE_TAGS = new Set(['LABEL', 'SPAN', 'DIV', 'P', 'STRONG', 'EM', 'I', 'B', 'SMALL', 'SVG', 'IMG']);

              function _isInteractive(node) {
                if (_INTERACTIVE_TAGS.has(node.tagName)) return true;
                const role = (node.getAttribute && node.getAttribute('role')) || '';
                if (_INTERACTIVE_ROLES.has(role)) return true;
                if (node.hasAttribute && (node.hasAttribute('onclick') || node.hasAttribute('data-action'))) return true;
                return false;
              }

              if (matches.length > 1) {
                const interactive = matches.filter(m => _isInteractive(m.el));
                if (interactive.length === 1) {
                  matches = interactive;
                } else {
                  const pickList = (interactive.length > 1 ? interactive : matches).slice(0, 6);
                  const candidates = pickList.map((m, idx) => {
                    const e = m.el;
                    let rect = { x: 0, y: 0, w: 0, h: 0 };
                    let cx = 0, cy = 0;
                    try {
                      const r = e.getBoundingClientRect();
                      rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                      cx = Math.round(r.x + r.width / 2);
                      cy = Math.round(r.y + r.height / 2);
                    } catch (e2) {}
                    let ancestor = '';
                    try {
                      const container = e.closest('[role=dialog],[role=alertdialog],[aria-modal="true"],form,section,nav,header,footer,aside,[role=region]');
                      if (container) {
                        const label = container.getAttribute('aria-label') || '';
                        const labelledby = container.getAttribute('aria-labelledby');
                        let labelledText = '';
                        if (labelledby) {
                          try { labelledText = (document.getElementById(labelledby) || {}).innerText || ''; } catch (e3) {}
                        }
                        const headingEl = container.querySelector('h1,h2,h3,h4,[role=heading]');
                        const heading = headingEl ? (headingEl.innerText || '').trim().slice(0, 40) : '';
                        const role = container.getAttribute('role') || container.tagName.toLowerCase();
                        ancestor = [role, label || labelledText || heading].filter(Boolean).join(': ').trim().slice(0, 80);
                      }
                    } catch (e4) {}
                    return {
                      index: idx,
                      tag: e.tagName.toLowerCase(),
                      role: e.getAttribute('role') || '',
                      text: m.txt.slice(0, 80),
                      cx, cy,
                      rect,
                      ancestor,
                    };
                  });
                  return {
                    found: false,
                    ambiguous: true,
                    mode: usedMode,
                    count: matches.length,
                    candidates,
                  };
                }
              }

              // --- Resolve element: label→input, passive→interactive ancestor ---
              let el = matches[0].el;

              // If it's a LABEL, follow to associated input
              if (el.tagName === 'LABEL') {
                let target = null;
                if (el.htmlFor) target = document.getElementById(el.htmlFor);
                if (!target) target = el.querySelector('input,textarea,select');
                // Also check next sibling
                if (!target && el.nextElementSibling) {
                  const ns = el.nextElementSibling;
                  if (/^(INPUT|TEXTAREA|SELECT)$/i.test(ns.tagName)) target = ns;
                  else target = ns.querySelector('input,textarea,select');
                }
                if (target) {
                  target.focus();
                  el = target;
                }
              }

              // Passive tag → walk up to interactive ancestor
              if (_PASSIVE_TAGS.has(el.tagName) && !_isInteractive(el)) {
                let ancestor = el.parentElement;
                for (let i = 0; i < 5 && ancestor; i++, ancestor = ancestor.parentElement) {
                  if (_isInteractive(ancestor)) {
                    el = ancestor;
                    break;
                  }
                }
              }

              // Do NOT scrollIntoView on SELECT elements — hidden/opacity:0
              // selects inside modals (Stripe) cause the modal to jump to
              // the top, creating an infinite loop.
              if (el.tagName !== 'SELECT') {
                try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
              }
              let r = el.getBoundingClientRect();
              // Fallback for zero-dimension inputs
              if ((r.width === 0 || r.height === 0) && /^(INPUT|SELECT|TEXTAREA)$/i.test(el.tagName)) {
                let p = el.parentElement;
                for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                  const pr = p.getBoundingClientRect();
                  if (pr.width > 0 && pr.height > 0) { r = pr; break; }
                }
              }
              return {
                found: true,
                mode: usedMode,
                x: r.left + r.width / 2,
                y: r.top + r.height / 2,
                tag: el.tagName,
                text: (el.innerText || el.value || '').slice(0, 80),
              };
            })()
          `);
          let info = result?.result?.value;

          // Auto-scroll retry: if element not found, scroll down and try again
          // (up to 3 scrolls) to find elements below the fold.
          if (info && !info.found && !info.ambiguous && !info.error) {
            for (let scrollAttempt = 0; scrollAttempt < 3; scrollAttempt++) {
              await cdpClient.evaluate(tabId, `window.scrollBy(0, Math.round(window.innerHeight * 0.7))`);
              await new Promise(r => setTimeout(r, 300));
              const retry = await cdpClient.evaluate(tabId, result._evalScript || `
                (() => {
                  const needle = ${JSON.stringify(args.text.toLowerCase())};
                  const explicit = ${JSON.stringify(args.textMatch || '')};
                  const sels = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), textarea, select, input[type="button"], input[type="submit"], summary, label, [onclick], [data-action]';
                  const all = Array.from(document.querySelectorAll(sels));
                  const normalized = all.map(el => ({ el, txt: (el.innerText || el.value || el.placeholder || el.ariaLabel || '').trim().toLowerCase() })).filter(x => !!x.txt);

                  // Label→input map
                  const labelMap = new Map();
                  document.querySelectorAll('label').forEach(lbl => {
                    const txt = (lbl.innerText || '').trim().toLowerCase();
                    if (!txt) return;
                    let target = null;
                    if (lbl.htmlFor) target = document.getElementById(lbl.htmlFor);
                    if (!target) target = lbl.querySelector('input,textarea,select');
                    if (target) labelMap.set(txt, target);
                  });

                  function tryMode(mode) {
                    if (mode === 'exact') return normalized.filter(x => x.txt === needle);
                    if (mode === 'prefix') return normalized.filter(x => x.txt.startsWith(needle));
                    if (mode === 'contains') return normalized.filter(x => x.txt.includes(needle));
                    return [];
                  }
                  const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
                  let matches = []; let usedMode = modes[0];
                  for (const m of modes) { matches = tryMode(m); usedMode = m; if (matches.length >= 1) break; }

                  // If no direct match, try label→input map
                  if (matches.length === 0) {
                    for (const [ltxt, inp] of labelMap) {
                      const ok = (needle === ltxt) || ltxt.startsWith(needle) || ltxt.includes(needle);
                      if (ok) {
                        inp.scrollIntoView({ block: 'center', inline: 'center' });
                        inp.focus();
                        let r = inp.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) {
                          let p = inp.parentElement;
                          for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                            const pr = p.getBoundingClientRect();
                            if (pr.width > 0 && pr.height > 0) { r = pr; break; }
                          }
                        }
                        return { found: true, mode: 'label', x: r.left + r.width / 2, y: r.top + r.height / 2, tag: inp.tagName, text: ltxt.slice(0, 80), focusedInput: true };
                      }
                    }
                    return { found: false };
                  }

                  const _INTERACTIVE_TAGS = new Set(['BUTTON','A','INPUT','SELECT','TEXTAREA']);
                  const _INTERACTIVE_ROLES = new Set(['button','link','tab','menuitem','option']);
                  const _PASSIVE_TAGS = new Set(['LABEL','SPAN','DIV','P','STRONG','EM','I','B','SMALL','SVG','IMG']);
                  function _isInteractive(n) { return _INTERACTIVE_TAGS.has(n.tagName) || _INTERACTIVE_ROLES.has((n.getAttribute&&n.getAttribute('role'))||'') || (n.hasAttribute&&(n.hasAttribute('onclick')||n.hasAttribute('data-action'))); }
                  if (matches.length > 1) {
                    const inter = matches.filter(m => _isInteractive(m.el));
                    if (inter.length === 1) { matches = inter; }
                    else {
                      const pickList = (inter.length > 1 ? inter : matches).slice(0, 6);
                      const candidates = pickList.map((m, idx) => {
                        const e = m.el;
                        let rect = { x:0, y:0, w:0, h:0 }, cx=0, cy=0;
                        try { const r = e.getBoundingClientRect(); rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; cx = Math.round(r.x + r.width/2); cy = Math.round(r.y + r.height/2); } catch(e2) {}
                        let ancestor = '';
                        try {
                          const container = e.closest('[role=dialog],[role=alertdialog],[aria-modal="true"],form,section,nav,header,footer,aside,[role=region]');
                          if (container) {
                            const label = container.getAttribute('aria-label') || '';
                            const labelledby = container.getAttribute('aria-labelledby');
                            let labelledText = '';
                            if (labelledby) { try { labelledText = (document.getElementById(labelledby) || {}).innerText || ''; } catch(e3) {} }
                            const headingEl = container.querySelector('h1,h2,h3,h4,[role=heading]');
                            const heading = headingEl ? (headingEl.innerText || '').trim().slice(0, 40) : '';
                            const role = container.getAttribute('role') || container.tagName.toLowerCase();
                            ancestor = [role, label || labelledText || heading].filter(Boolean).join(': ').trim().slice(0, 80);
                          }
                        } catch(e4) {}
                        return { index: idx, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', text: m.txt.slice(0, 80), cx, cy, rect, ancestor };
                      });
                      return { found: false, ambiguous: true, mode: usedMode, count: matches.length, candidates };
                    }
                  }
                  let el = matches[0].el;

                  // LABEL → associated input
                  if (el.tagName === 'LABEL') {
                    let target = null;
                    if (el.htmlFor) target = document.getElementById(el.htmlFor);
                    if (!target) target = el.querySelector('input,textarea,select');
                    if (!target && el.nextElementSibling) {
                      const ns = el.nextElementSibling;
                      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(ns.tagName)) target = ns;
                      else target = ns.querySelector('input,textarea,select');
                    }
                    if (target) { target.focus(); el = target; }
                  }

                  // Passive tag → interactive ancestor
                  if (_PASSIVE_TAGS.has(el.tagName) && !_isInteractive(el)) { let anc = el.parentElement; for (let i=0;i<5&&anc;i++,anc=anc.parentElement) { if (_isInteractive(anc)) { el=anc; break; } } }
                  if (el.tagName !== 'SELECT') { try { el.scrollIntoView({block:'center',inline:'center'}); } catch(e){} }
                  let r = el.getBoundingClientRect();
                  // Fallback for zero-dimension inputs
                  if ((r.width === 0 || r.height === 0) && /^(INPUT|SELECT|TEXTAREA)$/i.test(el.tagName)) {
                    let p = el.parentElement;
                    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                      const pr = p.getBoundingClientRect();
                      if (pr.width > 0 && pr.height > 0) { r = pr; break; }
                    }
                  }
                  return { found: true, mode: usedMode, x: r.left+r.width/2, y: r.top+r.height/2, tag: el.tagName, text: (el.innerText||el.value||'').slice(0,80) };
                })()
              `);
              const retryInfo = retry?.result?.value;
              if (retryInfo?.found) {
                info = retryInfo;
                info._scrolledToFind = true;
                break;
              }
              if (retryInfo?.ambiguous) { info = retryInfo; break; }
            }
          }

          if (!info?.found) {
            if (info?.error) {
              return { success: false, error: info.error };
            }
            if (info?.ambiguous) {
              return {
                success: false,
                error: `Ambiguous text match for "${args.text}" (mode=${info.mode}, matches=${info.count}). Candidates in the candidates field include cx/cy (precomputed click center, CSS pixels) and ancestor context. Call click({x: candidate.cx, y: candidate.cy}) — no arithmetic needed. Use the ancestor field to disambiguate (e.g. an alertdialog's Cancel vs a form's Cancel sit in different containers). Do NOT retry click({text: "${args.text}"}) — it will fail the same way.`,
                candidates: info.candidates || [],
              };
            }
            // Before giving up, check for an open listbox/menu/select on the
            // page. If one is visible, enumerate its options — that's almost
            // always what the model needed to see. This turns a useless
            // "not found" into a "here are the actual choices" hint.
            let openOptions = null;
            try {
              const opt = await cdpClient.evaluate(tabId, `
                (() => {
                  function visible(el) {
                    try {
                      const r = el.getBoundingClientRect();
                      if (r.width < 1 || r.height < 1) return false;
                      const s = window.getComputedStyle(el);
                      if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
                      return true;
                    } catch (e) { return false; }
                  }
                  // Detect whether a container/page has an associated
                  // searchbox/filter input (searchable combobox). When true,
                  // the listbox is almost certainly virtualized — clicking
                  // an option that isn't in the visible window will never
                  // match. The right move is to TYPE the value to filter.
                  function findFilterInput(container) {
                    // Option A: the combobox itself is an editable input
                    const cb = document.querySelector('[role=combobox][aria-expanded="true"]');
                    if (cb && (cb.tagName === 'INPUT' || cb.getAttribute('aria-autocomplete'))) {
                      return { kind: 'combobox', text: (cb.value || cb.innerText || '').trim().slice(0, 40), autocomplete: cb.getAttribute('aria-autocomplete') || '' };
                    }
                    // Option B: a visible searchbox / [type=search] input is
                    // associated with the listbox (aria-controls/activedescendant
                    // or just physically near it).
                    const sbox = Array.from(document.querySelectorAll('input[type=search],input[role=searchbox],[role=searchbox],input[aria-autocomplete]')).filter(visible)[0];
                    if (sbox) return { kind: 'searchbox', text: (sbox.value || '').trim().slice(0, 40), autocomplete: sbox.getAttribute('aria-autocomplete') || '' };
                    // Option C: editable focused input inside the listbox container
                    if (container) {
                      const inp = container.querySelector('input:not([type=hidden]),textarea');
                      if (inp && visible(inp)) return { kind: 'input-in-listbox', text: (inp.value || '').trim().slice(0, 40), autocomplete: inp.getAttribute('aria-autocomplete') || '' };
                    }
                    return null;
                  }
                  // 1) Visible ARIA listbox/menu containers
                  const containers = Array.from(document.querySelectorAll('[role=listbox],[role=menu],[role=combobox][aria-expanded="true"]')).filter(visible);
                  for (const c of containers) {
                    const opts = Array.from(c.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]'))
                      .filter(visible)
                      .map(o => (o.innerText || o.getAttribute('aria-label') || '').trim())
                      .filter(Boolean)
                      .slice(0, 20);
                    if (opts.length) {
                      const totalOptions = c.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]').length;
                      return {
                        source: c.getAttribute('role') || 'listbox',
                        options: opts,
                        visibleCount: opts.length,
                        totalCount: totalOptions,
                        virtualized: totalOptions > opts.length,
                        filter: findFilterInput(c),
                      };
                    }
                  }
                  // 2) Focused <select>
                  const ae = document.activeElement;
                  if (ae && ae.tagName === 'SELECT') {
                    const opts = Array.from(ae.options).map(o => (o.text || '').trim()).filter(Boolean).slice(0, 20);
                    if (opts.length) return { source: 'select', options: opts, visibleCount: opts.length, totalCount: ae.options.length, virtualized: false, filter: null };
                  }
                  // 3) Any visible <select> on page (last resort, only 1)
                  const sels = Array.from(document.querySelectorAll('select')).filter(visible);
                  if (sels.length === 1) {
                    const opts = Array.from(sels[0].options).map(o => (o.text || '').trim()).filter(Boolean).slice(0, 20);
                    if (opts.length) return { source: 'select (only one visible on page)', options: opts, visibleCount: opts.length, totalCount: sels[0].options.length, virtualized: false, filter: null };
                  }
                  return null;
                })()
              `);
              openOptions = opt?.result?.value || null;
            } catch (e) {}

            if (openOptions && openOptions.options && openOptions.options.length) {
              // Filterable combobox case: the model needs to TYPE, not click.
              if (openOptions.filter) {
                const needle = args.text;
                const filterKind = openOptions.filter.kind;
                const filterHint = filterKind === 'combobox'
                  ? `The combobox itself is editable`
                  : filterKind === 'searchbox'
                    ? `There is an associated searchbox on the page`
                    : `There is an input field inside the listbox`;
                return {
                  success: false,
                  error: `"${needle}" is not in the currently-visible options of the open ${openOptions.source}. ${filterHint} — this is a SEARCHABLE combobox (likely virtualized, only ${openOptions.visibleCount} of ${openOptions.totalCount} options rendered). Instead of clicking, TYPE the value to filter: call type_text({text: "${needle}", clear: true}) with NO selector (the combobox input should already be focused), then click the matching option or press Enter. Do NOT retry click({text: "${needle}"}) — the option isn't in the visible window.`,
                  availableOptions: openOptions.options,
                  source: openOptions.source,
                  filterable: true,
                  filter: openOptions.filter,
                  visibleCount: openOptions.visibleCount,
                  totalCount: openOptions.totalCount,
                };
              }
              return {
                success: false,
                error: `No clickable element found for text "${args.text}". However, an open ${openOptions.source} is visible on the page with these options: ${openOptions.options.map(o => '"' + o + '"').join(', ')}. Pick one of those exact labels (or "Custom" if the value you want isn't listed) and call click({text: "..."}) again.`,
                availableOptions: openOptions.options,
                source: openOptions.source,
              };
            }

            // Last-resort widened scan: contenteditable editors + ARIA
            // roles + [tabindex] elements. The strict selector set at the top
            // skips custom widgets (tag pickers, flair lists, rich-text
            // bodies like Discourse/Gmail/Slack/Notion). Retrying with a
            // wider net catches them without bloating the primary scanner.
            let fbInfo = null;
            try {
              const fbRes = await cdpClient.evaluate(tabId, `
                (() => {
                  const needle = ${JSON.stringify(args.text.toLowerCase())};
                  const explicit = ${JSON.stringify(args.textMatch || '')};
                  const sels = '[contenteditable="true"],[contenteditable=""],[role="option"],[role="listbox"],[role="combobox"],[role="textbox"],[role="switch"],[role="checkbox"],[role="radio"],[tabindex]:not([tabindex="-1"])';
                  function vis(el) {
                    try {
                      const r = el.getBoundingClientRect();
                      if (r.width < 1 || r.height < 1) return false;
                      const s = window.getComputedStyle(el);
                      if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
                      return true;
                    } catch(e) { return false; }
                  }
                  const all = Array.from(document.querySelectorAll(sels)).filter(vis);
                  const norm = all.map(el => ({
                    el,
                    txt: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().toLowerCase(),
                  })).filter(x => !!x.txt);
                  const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
                  for (const m of modes) {
                    const matches = norm.filter(x =>
                      m === 'exact' ? x.txt === needle :
                      m === 'prefix' ? x.txt.startsWith(needle) :
                      x.txt.includes(needle)
                    );
                    if (matches.length >= 1) {
                      const el = matches[0].el;
                      try { el.scrollIntoView({block:'center',inline:'center'}); } catch(e){}
                      const r = el.getBoundingClientRect();
                      return {
                        found: true,
                        mode: m,
                        x: r.left + r.width/2,
                        y: r.top + r.height/2,
                        tag: el.tagName,
                        role: el.getAttribute('role') || (el.getAttribute('contenteditable') != null ? 'contenteditable' : ''),
                        text: matches[0].txt.slice(0, 80),
                        widgetFallback: true,
                      };
                    }
                  }
                  return { found: false };
                })()
              `);
              fbInfo = fbRes?.result?.value || null;
            } catch(e) {}
            if (fbInfo?.found) {
              info = fbInfo;
            } else {
              return {
                success: false,
                error: `No clickable element found for text "${args.text}" (also tried scrolling down and widening to contenteditable/[role=*]/[tabindex]). Try get_interactive_elements to see what's on the page, or use a selector.`,
              };
            }
          }
          // <select> intercept: don't dispatch mouse events — the native
          // dropdown popup can't be controlled via CDP. Focus the element
          // via JS so the follow-up type_text() finds it as activeElement,
          // then return guidance.
          if (info.tag === 'SELECT') {
            const optionsInfo = await cdpClient.evaluate(tabId, `
              (() => {
                const sels = 'select';
                const all = Array.from(document.querySelectorAll(sels));
                for (const sel of all) {
                  const t = (sel.innerText || sel.value || '').trim().toLowerCase();
                  if (t.includes(${JSON.stringify((args.text || '').toLowerCase())})) {
                    sel.focus();
                    return {
                      current: sel.options[sel.selectedIndex]?.text?.trim() || '',
                      options: Array.from(sel.options).map(o => o.text.trim()),
                    };
                  }
                }
                return null;
              })()
            `);
            const opts = optionsInfo?.result?.value;
            return {
              success: false,
              tag: 'SELECT',
              text: opts?.current || info.text,
              error: 'CANNOT CLICK a <select> dropdown — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused. Use type_text({text: "option name"}) to change the value.' + (opts?.options ? ' Available options: ' + opts.options.join(', ') : ''),
            };
          }

          // Secondary SELECT check: the text resolved to a non-SELECT element,
          // but the click coordinates might land on/near a SELECT (e.g. text
          // "Monthly" resolves to a label/button but a sibling/nearby select exists).
          const coordSelCheck = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.elementFromPoint(${info.x}, ${info.y});
              if (!el) return null;
              function findSelect(node) {
                // Walk up ancestors
                let t = node;
                for (let i = 0; i < 5 && t; i++) {
                  if (t.tagName === 'SELECT') return t;
                  t = t.parentElement;
                }
                // Check siblings (Stripe pattern)
                const p = node.parentElement;
                if (p) { for (const sib of p.children) { if (sib.tagName === 'SELECT') return sib; } }
                // Check ancestor wrapper
                const anc = node.closest ? (node.closest('[class*="select"]') || node.closest('[class*="dropdown"]') || node.closest('[class]')) : null;
                if (anc) { const s = anc.querySelector('select'); if (s) return s; }
                // Check labels
                const lbl = node.closest ? node.closest('label') : null;
                if (lbl) {
                  const forId = lbl.htmlFor || lbl.getAttribute('for');
                  if (forId) { const s = document.getElementById(forId); if (s?.tagName === 'SELECT') return s; }
                  const s = lbl.querySelector('select');
                  if (s) return s;
                }
                return null;
              }
              const sel = findSelect(el);
              if (!sel) return null;
              sel.focus();
              return { isSelect: true, current: sel.options[sel.selectedIndex]?.text?.trim() || '', options: Array.from(sel.options).map(o => o.text.trim()) };
            })()
          `);
          if (coordSelCheck?.result?.value?.isSelect) {
            // Instead of returning a hint, try auto-selecting if the
            // clicked text matches an option (already handled above).
            // If we got here, the text matched the current value or a
            // non-option label. Return guidance but also focus the select.
            const cs = coordSelCheck.result.value;
            return {
              success: true,
              tag: 'SELECT',
              text: cs.current,
              hint: `This is a <select> dropdown (current: "${cs.current}"). Use type_text({text: "option name"}) to change it. Available options: ${cs.options.join(', ')}`,
            };
          }

          // Wait for scroll to settle, then dispatch a real click via CDP.
          // Snapshot existing tabs first so we can detect a target=_blank
          // link that spawns a background tab instead of navigating in-place
          // (see _redirectTargetBlankClick).
          const beforeTabIdsText = new Set((await chrome.tabs.query({})).map(t => t.id));
          await new Promise(r => setTimeout(r, 100));
          await cdpClient.dispatchMouseEvent(tabId, 'mouseMoved', info.x, info.y);
          await cdpClient.dispatchMouseEvent(tabId, 'mousePressed', info.x, info.y);
          await cdpClient.dispatchMouseEvent(tabId, 'mouseReleased', info.x, info.y);
          // Kicked off in parallel with the SELECT post-click check below;
          // awaited before we return so we can fold the redirect into the
          // tool result.
          const newTabPromiseText = this._redirectTargetBlankClick(tabId, beforeTabIdsText);

          // Post-click SELECT detection: the click may have activated a
          // <select> via a label, wrapper, or overlapping element. The
          // global guard prevents the native dropdown from opening, but we
          // still need to detect and return guidance.
          await new Promise(r => setTimeout(r, 200));
          const postClickSel1 = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.activeElement;
              if (el?.tagName === 'SELECT') {
                return { current: el.options[el.selectedIndex]?.text?.trim() || '', options: Array.from(el.options).map(o => o.text.trim()) };
              }
              // Also check all selects — one might have been focused then blurred
              const sels = document.querySelectorAll('select');
              for (const s of sels) {
                if (s === document.activeElement || s.matches(':focus-within')) {
                  return { current: s.options[s.selectedIndex]?.text?.trim() || '', options: Array.from(s.options).map(o => o.text.trim()) };
                }
              }
              return null;
            })()
          `);
          if (postClickSel1?.result?.value) {
            const pOpts = postClickSel1.result.value;
            return {
              success: false,
              tag: 'SELECT',
              text: pOpts.current,
              error: `CANNOT CLICK a <select> dropdown — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused (current: "${pOpts.current}"). Use type_text({text: "option name"}) to change the value. Available options: ${pOpts.options.join(', ')}`,
            };
          }

          // Stale click detection
          const clickIdent = `${info.tag}|${(info.text || '').slice(0, 50)}`;
          const prevIdent = this._lastCdpClickIdent.get(tabId);
          this._lastCdpClickIdent.set(tabId, clickIdent);
          const warning = (prevIdent === clickIdent)
            ? 'Same element clicked again with no page change. Try click({x, y}) with coordinates from a screenshot, or click({index: N}) from get_interactive_elements.'
            : undefined;

          const redirectedText = await newTabPromiseText;
          if (redirectedText?.redirected) {
            // The clicked link had target="_blank". We closed the spawned
            // tab and navigated the current tab to its URL, so the model's
            // next screenshot will actually show the destination instead
            // of the same search results page.
            this._lastCdpClickIdent.delete(tabId);
            return {
              success: true,
              method: 'cdp-by-text',
              textMatch: info.mode || (args.textMatch || 'exact'),
              tag: info.tag,
              text: info.text,
              matched: args.text,
              redirectedFromNewTab: true,
              url: redirectedText.url,
              hint: `The clicked link had target="_blank" and opened in a new tab. To keep the agent on one tab, the spawned tab was closed and this tab was navigated to ${redirectedText.url}. Take a screenshot or call read_page to see the destination.`,
            };
          }
          return {
            success: true,
            method: 'cdp-by-text',
            textMatch: info.mode || (args.textMatch || 'exact'),
            tag: info.tag,
            text: info.text,
            matched: args.text,
            ...(warning ? { warning } : {}),
          };
        }
        if (args.selector) {
          // Check if the selector targets a <select> element before clicking.
          // If it is, focus the element (so type_text finds it) and return guidance.
          const selTagCheck = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.querySelector(${JSON.stringify(args.selector)});
              if (!el) return null;
              if (el.tagName === 'SELECT') {
                el.focus();
                const opts = Array.from(el.options).map(o => o.text.trim());
                return { isSelect: true, current: el.options[el.selectedIndex]?.text?.trim() || '', options: opts };
              }
              return { isSelect: false };
            })()
          `);
          const selTag = selTagCheck?.result?.value;
          if (selTag?.isSelect) {
            return {
              success: true,
              tag: 'SELECT',
              text: selTag.current,
              hint: `This is a <select> dropdown (current: "${selTag.current}"). Do NOT click it — use type_text({text: "option name"}) to select an option. Available options: ${selTag.options.join(', ')}`,
            };
          }
          const beforeTabIdsSel = new Set((await chrome.tabs.query({})).map(t => t.id));
          const selResult = await cdpClient.clickElement(tabId, args.selector);
          const redirectedSel = await this._redirectTargetBlankClick(tabId, beforeTabIdsSel);
          if (redirectedSel?.redirected) {
            return {
              ...(selResult || { success: true }),
              redirectedFromNewTab: true,
              url: redirectedSel.url,
              hint: `The selector resolved to a target="_blank" link. The spawned tab was closed and this tab was navigated to ${redirectedSel.url} so the agent stays on a single tab.`,
            };
          }
          return selResult;
        }
        if (args.x != null && args.y != null) {
          // Check if the element at these coordinates is or is near a <select>.
          const coordTagCheck = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.elementFromPoint(${args.x}, ${args.y});
              if (!el) return null;
              // Walk up ancestors
              let target = el;
              for (let i = 0; i < 5 && target; i++) {
                if (target.tagName === 'SELECT') {
                  target.focus();
                  const opts = Array.from(target.options).map(o => o.text.trim());
                  return { isSelect: true, current: target.options[target.selectedIndex]?.text?.trim() || '', options: opts };
                }
                target = target.parentElement;
              }
              // Check siblings (Stripe pattern)
              const p = el.parentElement;
              if (p) {
                for (const sib of p.children) {
                  if (sib.tagName === 'SELECT') {
                    sib.focus();
                    const opts = Array.from(sib.options).map(o => o.text.trim());
                    return { isSelect: true, current: sib.options[sib.selectedIndex]?.text?.trim() || '', options: opts };
                  }
                }
              }
              return { isSelect: false };
            })()
          `);
          const coordTag = coordTagCheck?.result?.value;
          if (coordTag?.isSelect) {
            return {
              success: false,
              tag: 'SELECT',
              text: coordTag.current,
              error: `CANNOT CLICK a <select> dropdown at (${args.x}, ${args.y}) — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused (current: "${coordTag.current}"). Use type_text({text: "option name"}) to change the value. Available options: ${coordTag.options.join(', ')}`,
            };
          }
          // Smart coordinate redirect: if (x,y) lands on a label, wrapper,
          // or non-input element, find the nearby input and redirect the
          // click to its center — like a human clicking inside the text box,
          // not on the label above it.
          const coordRedirect = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.elementFromPoint(${args.x}, ${args.y});
              if (!el) return null;

              // Already on an input — just focus it, click as-is
              if (/^(INPUT|TEXTAREA)$/i.test(el.tagName)) {
                el.focus();
                return null; // no redirect needed
              }
              // SELECT: focus but flag it so we can intercept before mouse events
              if (el.tagName === 'SELECT') {
                el.focus();
                const opts = Array.from(el.options).map(o => o.text.trim());
                return { isSelect: true, current: el.options[el.selectedIndex]?.text?.trim() || '', options: opts };
              }

              // Find the real input target
              let target = null;

              // 1. Label association (htmlFor, inner input, next sibling)
              const lbl = el.closest('label') || (el.tagName === 'LABEL' ? el : null);
              if (lbl) {
                if (lbl.htmlFor) target = document.getElementById(lbl.htmlFor);
                if (!target) target = lbl.querySelector('input,textarea,select');
                if (!target && lbl.nextElementSibling) {
                  const ns = lbl.nextElementSibling;
                  if (/^(INPUT|TEXTAREA|SELECT)$/i.test(ns.tagName)) target = ns;
                  else target = ns.querySelector('input,textarea,select');
                }
              }

              // 2. Wrapper: element or parent contains an input
              if (!target) {
                target = el.querySelector('input:not([type="hidden"]),textarea,select');
              }
              if (!target && el.parentElement) {
                target = el.parentElement.querySelector('input:not([type="hidden"]),textarea,select');
              }

              // 3. Walk up to find a form-group-like wrapper with an input
              if (!target) {
                let p = el.parentElement;
                for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
                  const inp = p.querySelector('input:not([type="hidden"]),textarea,select');
                  if (inp) { target = inp; break; }
                }
              }

              if (!target) return null;

              // Focus the input and return its center coordinates
              if (target.tagName !== 'SELECT') target.scrollIntoView({ block: 'center', inline: 'center' });
              target.focus();
              let r = target.getBoundingClientRect();

              // Zero-width input fallback (Stripe pattern)
              if (r.width === 0 || r.height === 0) {
                let p = target.parentElement;
                for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                  const pr = p.getBoundingClientRect();
                  if (pr.width > 0 && pr.height > 0) { r = pr; break; }
                }
              }

              return {
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                tag: target.tagName,
              };
            })()
          `);
          const redir = coordRedirect?.result?.value;

          // If coordinate redirect detected a SELECT, don't dispatch mouse
          // events — return error so the model uses type_text instead.
          if (redir?.isSelect) {
            return {
              success: false,
              tag: 'SELECT',
              text: redir.current,
              error: `CANNOT CLICK a <select> dropdown at (${args.x}, ${args.y}) — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused (current: "${redir.current}"). Use type_text({text: "option name"}) to change the value. Available options: ${redir.options.join(', ')}`,
            };
          }

          const clickX = redir ? redir.x : args.x;
          const clickY = redir ? redir.y : args.y;

          const beforeTabIdsCoord = new Set((await chrome.tabs.query({})).map(t => t.id));
          await cdpClient.dispatchMouseEvent(tabId, 'mouseMoved', clickX, clickY);
          await cdpClient.dispatchMouseEvent(tabId, 'mousePressed', clickX, clickY);
          await cdpClient.dispatchMouseEvent(tabId, 'mouseReleased', clickX, clickY);
          const newTabPromiseCoord = this._redirectTargetBlankClick(tabId, beforeTabIdsCoord);

          // Post-click SELECT detection (same as text-based path above).
          await new Promise(r => setTimeout(r, 200));
          const postClickSel2 = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.activeElement;
              if (el?.tagName === 'SELECT') {
                return { current: el.options[el.selectedIndex]?.text?.trim() || '', options: Array.from(el.options).map(o => o.text.trim()) };
              }
              return null;
            })()
          `);
          if (postClickSel2?.result?.value) {
            const pOpts2 = postClickSel2.result.value;
            return {
              success: false,
              tag: 'SELECT',
              text: pOpts2.current,
              error: `CANNOT CLICK a <select> dropdown — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused (current: "${pOpts2.current}"). Use type_text({text: "option name"}) to change the value. Available options: ${pOpts2.options.join(', ')}`,
            };
          }

          const redirectedCoord = await newTabPromiseCoord;
          if (redirectedCoord?.redirected) {
            return {
              success: true,
              method: 'cdp-coords',
              x: args.x,
              y: args.y,
              redirectedFromNewTab: true,
              url: redirectedCoord.url,
              hint: `The clicked coordinate hit a target="_blank" link. The spawned tab was closed and this tab was navigated to ${redirectedCoord.url} so the agent stays on a single tab.`,
            };
          }
          return { success: true, method: 'cdp-coords', x: args.x, y: args.y };
        }
        // index-based: fall through to content-script path which knows the
        // interactive-elements ordering.
      } catch (e) {
        return { success: false, error: `Click failed: ${e.message}` };
      }
    }

    if (name === 'type_text') {
      try {
        await cdpClient.attach(tabId);
        if (args.index != null) {
          return {
            success: false,
            error: `type_text does not accept an \`index\` parameter. To type into an element by its index, first call click({index: ${args.index}}) to focus it, then call type_text({text: "${String(args.text || '').slice(0, 60)}"}) with NO selector and NO index. Alternatively, use click_ax + type_ax with a ref_id from get_accessibility_tree.`,
          };
        }
        if (args.selector) {
          const result = await cdpClient.typeText(tabId, args.selector, args.text || '', !!args.clear);
          // Track field for duplicate-typing detection
          if (result.success) {
            const fieldIdent = `sel:${args.selector}`;
            const prev = this._lastTypeFieldIdent?.get(tabId);
            if (prev === fieldIdent) {
              result.warning = 'You typed into the same field twice in a row. If you intended to fill a DIFFERENT field, click it first before calling type_text.';
            }
            if (!this._lastTypeFieldIdent) this._lastTypeFieldIdent = new Map();
            this._lastTypeFieldIdent.set(tabId, fieldIdent);
          }
          return result;
        }
        // No selector and no index → type into the currently focused element
        // via CDP Input.insertText. The model is expected to have just
        // clicked the field in a prior tool call. This is the most reliable
        // path for forms with weird selectors (GitHub release[name],
        // Stripe-style nested inputs, etc.) — no resolution needed.
        if (args.index == null) {
          // Check what element is actually focused before typing
          const focusCheck = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.activeElement;
              if (!el || el === document.body || el === document.documentElement) {
                return { focused: false };
              }
              const tag = el.tagName;
              const editable = el.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(tag);
              return {
                focused: true,
                editable,
                tag,
                type: el.type || '',
                name: el.name || el.id || el.getAttribute('aria-label') || '',
                value: (el.value || '').slice(0, 50),
              };
            })()
          `);
          const focus = focusCheck?.result?.value;

          if (!focus?.focused || !focus?.editable) {
            return {
              success: false,
              error: 'No editable element is currently focused. Click the target input/textarea first, then call type_text with no selector.',
              focusedElement: focus || null,
            };
          }

          // <select> fast-path: use CDP keyboard ArrowDown/ArrowUp events
          // to change the selected option. This fires native browser events
          // that React and other frameworks pick up — much more reliable
          // than setting .value via JS.
          if (focus.tag === 'SELECT') {
            const needle = JSON.stringify((args.text || '').trim());
            const selectInfo = await cdpClient.evaluate(tabId, `
              (() => {
                const el = document.activeElement;
                if (!el || el.tagName !== 'SELECT') return { success: false, error: 'Focused element is not a select' };
                const needle = ${needle};
                const opts = Array.from(el.options);
                const match = opts.find(o => o.value === needle)
                  || opts.find(o => o.text.trim() === needle)
                  || opts.find(o => o.text.trim().toLowerCase().includes(needle.toLowerCase()));
                if (!match) {
                  const available = opts.map(o => o.text.trim()).join(', ');
                  return { success: false, error: 'No option matching "' + needle + '". Available: ' + available };
                }
                return {
                  success: true,
                  currentIndex: el.selectedIndex,
                  targetIndex: match.index,
                  targetText: match.text.trim(),
                  targetValue: match.value,
                  totalOptions: opts.length,
                };
              })()
            `);
            const sInfo = selectInfo?.result?.value;
            if (!sInfo?.success) return sInfo || { success: false, error: 'Select interaction failed' };

            // Close any open native dropdown first
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
            });
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
            });
            // Re-focus the select (Escape may have blurred it)
            await cdpClient.evaluate(tabId, `
              (() => {
                const el = document.activeElement;
                if (!el || el.tagName !== 'SELECT') {
                  const sels = document.querySelectorAll('select');
                  for (const s of sels) { s.focus(); return; }
                }
              })()
            `);

            // Navigate with ArrowDown/ArrowUp — each key press changes the
            // selected option and fires native change events.
            const delta = sInfo.targetIndex - sInfo.currentIndex;
            const arrowKey = delta > 0 ? 'ArrowDown' : 'ArrowUp';
            const arrowCode = delta > 0 ? 'ArrowDown' : 'ArrowUp';
            const arrowVK = delta > 0 ? 40 : 38;
            for (let i = 0; i < Math.abs(delta); i++) {
              await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
                type: 'keyDown', key: arrowKey, code: arrowCode, windowsVirtualKeyCode: arrowVK,
              });
              await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
                type: 'keyUp', key: arrowKey, code: arrowCode, windowsVirtualKeyCode: arrowVK,
              });
            }

            // Verify the selection actually changed
            const verify = await cdpClient.evaluate(tabId, `
              (() => {
                const el = document.activeElement;
                if (!el || el.tagName !== 'SELECT') return { verified: false };
                return { verified: true, selectedText: el.options[el.selectedIndex]?.text?.trim(), selectedValue: el.value };
              })()
            `);
            const v = verify?.result?.value;

            return {
              success: true,
              method: 'select-keyboard',
              selectedText: v?.selectedText || sInfo.targetText,
              selectedValue: v?.selectedValue || sInfo.targetValue,
              keyPresses: Math.abs(delta),
              direction: delta > 0 ? 'down' : 'up',
            };
          }

          if (args.clear) {
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
            });
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
            });
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
            });
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
            });
          }
          await cdpClient.sendCommand(tabId, 'Input.insertText', { text: args.text || '' });

          // Track field for duplicate-typing detection
          const fieldIdent = `focused:${focus.tag}|${focus.name}`;
          const prev = this._lastTypeFieldIdent?.get(tabId);
          let warning;
          if (prev === fieldIdent) {
            warning = 'You typed into the same field twice in a row. If you intended to fill a DIFFERENT field, click it first before calling type_text.';
          }
          if (!this._lastTypeFieldIdent) this._lastTypeFieldIdent = new Map();
          this._lastTypeFieldIdent.set(tabId, fieldIdent);

          return {
            success: true,
            method: 'cdp-insert-focused',
            text: (args.text || '').slice(0, 100),
            focusedField: { tag: focus.tag, type: focus.type, name: focus.name },
            ...(warning ? { warning } : {}),
          };
        }
        // Should be unreachable — all branches above return.
        return { success: false, error: 'type_text: internal — no branch matched. Provide {text} (with focused field) or {selector, text}.' };
      } catch (e) {
        return { success: false, error: `Type failed: ${e.message}` };
      }
    }

    if (name === 'press_keys') {
      const key = args.key;
      const repeatRaw = Number(args.repeat ?? 1);
      const repeat = Math.max(1, Math.min(3, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 1));
      if (!['Escape', 'Tab', 'Enter'].includes(key)) {
        return { success: false, error: `Unsupported key "${key}". V1 supports Escape, Tab, and Enter.` };
      }

      try {
        await cdpClient.attach(tabId);
        const keyMeta = {
          Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
          Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
          Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
        }[key];

        for (let i = 0; i < repeat; i++) {
          await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key,
            code: keyMeta.code,
            windowsVirtualKeyCode: keyMeta.windowsVirtualKeyCode,
          });
          await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code: keyMeta.code,
            windowsVirtualKeyCode: keyMeta.windowsVirtualKeyCode,
          });
        }

        return { success: true, method: 'cdp-key', key, repeat };
      } catch (e) {
        // Fall through to content-script path if CDP is unavailable.
      }
    }

    // ── hover / drag_drop — CDP-trusted pointer tools ──────────────────────
    //
    // ref_id → on-screen coords are resolved by content.js (`ax_resolve_rect`,
    // which also scrollIntoView's the element). The actual pointer events go
    // out via CDP Input.dispatchMouseEvent so they are isTrusted — page
    // handlers that gate on event.isTrusted (reveal-on-hover menus,
    // pointer-event drag handlers) see real events instead of synthetic ones.
    if (name === 'hover') {
      const refId = args.ref_id || args.refId;
      if (typeof refId !== 'string') {
        return { success: false, error: 'hover: ref_id (string, e.g. "ref_42") is required' };
      }
      try {
        const rectResp = await chrome.tabs.sendMessage(tabId, {
          target: 'content', action: 'ax_resolve_rect', params: { ref_id: refId },
        });
        if (!rectResp || !rectResp.success) {
          return rectResp || { success: false, error: 'hover: failed to resolve ref_id' };
        }
        if (!rectResp.inViewport) {
          // scrollIntoView happened in content.js — wait a tick for it to settle,
          // then re-resolve so we use the post-scroll coords.
          await new Promise(r => setTimeout(r, 80));
          const r2 = await chrome.tabs.sendMessage(tabId, {
            target: 'content', action: 'ax_resolve_rect', params: { ref_id: refId },
          });
          if (r2 && r2.success) Object.assign(rectResp, r2);
        }
        await cdpClient.attach(tabId);
        const x = rectResp.x;
        const y = rectResp.y;
        // mouseMoved with button=none is enough for reveal-on-hover handlers
        // listening to mouseenter/mouseover/pointerover. We move twice (once
        // ~10px outside, once at center) so sites that only fire on the
        // first crossing of the element boundary still see a transition.
        await cdpClient.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: Math.max(0, x - 10), y, button: 'none', buttons: 0,
        });
        await cdpClient.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y, button: 'none', buttons: 0,
        });
        return {
          success: true,
          method: 'cdp-hover',
          ref_id: refId,
          tag: rectResp.tag,
          name: rectResp.name,
          rect: rectResp.rect,
          hint: 'A hover-revealed menu/tooltip typically renders in a React portal at the end of <body>. Re-read the tree with get_accessibility_tree({filter:"visible"}) — do NOT pass a ref_id (subtree filter will miss the portal).',
        };
      } catch (e) {
        return { success: false, error: `hover failed: ${e.message || e}` };
      }
    }

    if (name === 'drag_drop') {
      const fromRef = args.fromRefId || args.from_ref_id;
      const toRef = args.toRefId || args.to_ref_id;
      if (typeof fromRef !== 'string' || typeof toRef !== 'string') {
        return { success: false, error: 'drag_drop: fromRefId and toRefId (both strings, e.g. "ref_42") are required' };
      }
      const stepsRaw = Number(args.steps ?? 10);
      const steps = Math.max(2, Math.min(40, Number.isFinite(stepsRaw) ? Math.floor(stepsRaw) : 10));
      try {
        // Single round-trip: content.js scrolls source-then-dest and
        // measures BOTH rects in the same viewport snapshot. The previous
        // three-call dance (resolve fromRef → resolve toRef → re-resolve
        // fromRef) had a scroll race: the re-resolve scrolled source back
        // into view and invalidated the dest coords we'd just measured.
        const rectsResp = await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'ax_resolve_two_rects',
          params: { fromRefId: fromRef, toRefId: toRef },
        });
        if (!rectsResp || !rectsResp.success) {
          return { success: false, error: `drag_drop: ${rectsResp?.error || 'resolve failed'}` };
        }
        const from = rectsResp.from;
        const toResp = rectsResp.to;

        // Both elements scrolled into view but if source and dest are far
        // apart vertically the final viewport (centered on dest) may have
        // pushed source off-screen. CDP mouse events at off-screen coords
        // don't hit anything, so the drag silently no-ops. Surface a clear
        // error in that case rather than going through the motions.
        if (!from.inViewport || !toResp.inViewport) {
          return {
            success: false,
            error: `drag_drop: source and destination are too far apart to fit in the viewport simultaneously (from inViewport=${from.inViewport}, to inViewport=${toResp.inViewport}). CDP mouse events at off-screen coordinates don't land. Workaround: scroll the page so both elements fit, OR use keyboard-based reordering if the site exposes it (Tab + arrow keys on many drag handles).`,
            from: { ref_id: fromRef, ...from },
            to: { ref_id: toRef, ...toResp },
          };
        }

        await cdpClient.attach(tabId);
        const x1 = from.x, y1 = from.y, x2 = toResp.x, y2 = toResp.y;

        // mouseMoved (no button) → mousePressed at source → N waypoints
        // (mouseMoved with buttons=1) → mouseReleased at destination. The
        // mid-drag waypoints are what HTML5 dnd dragenter/dragover handlers
        // listen to; Trello/Linear/Notion need at least a handful so the
        // drop indicator can settle before the release.
        await cdpClient.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: x1, y: y1, button: 'none', buttons: 0,
        });
        await cdpClient.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1,
        });
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const ix = Math.round(x1 + (x2 - x1) * t);
          const iy = Math.round(y1 + (y2 - y1) * t);
          await cdpClient.sendCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: ix, y: iy, button: 'left', buttons: 1,
          });
          // Tiny pause so framework dnd state machines (drag-over throttling)
          // get a chance to tick between waypoints. Total ~steps*15ms = ~150ms.
          await new Promise(r => setTimeout(r, 15));
        }
        await cdpClient.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1,
        });
        return {
          success: true,
          method: 'cdp-drag',
          from: { ref_id: fromRef, x: x1, y: y1, name: from.name },
          to: { ref_id: toRef, x: x2, y: y2, name: toResp.name },
          steps,
          hint: 'Re-read the accessibility tree to confirm the order/position changed. If nothing moved, the site may use HTML5 drag-and-drop with custom DataTransfer payloads that CDP cannot fully emulate — try the drag again with higher `steps` (15–20) or fall back to keyboard-based reorder controls if the site exposes them.',
        };
      } catch (e) {
        return { success: false, error: `drag_drop failed: ${e.message || e}` };
      }
    }

    // Map tool names to content script actions
    const actionMap = {
      'read_page': 'get_page_info_cdp',
      'get_interactive_elements': 'get_interactive_elements_cdp',
      // Accessibility-tree path (preferred). Ported from Claude for Chrome —
      // flat indented text output with persistent WeakRef-backed ref_ids.
      'get_accessibility_tree': 'get_accessibility_tree',
      'click_ax': 'click_ax',
      'type_ax': 'type_ax',
      'set_field': 'set_field',
      'click': 'click',
      'type_text': 'type',
      'press_keys': 'press_keys',
      'scroll': 'scroll',
      'extract_data': 'extract_data',
      'wait_for_element': 'wait_for_element',
      'wait_for_stable': 'wait_for_stable',
      'get_selection': 'get_selection',
    };

    const action = actionMap[name];
    if (!action) {
      return { error: `Unknown tool: ${name}` };
    }

    // PDF redirect. Chrome's PDF viewer is a chrome-extension:// page that
    // our content scripts can't inject into, so read_page / click /
    // get_accessibility_tree all silently no-op against PDF tabs and the
    // agent ends up click-looping on the viewer's chrome (sidebar, page
    // input, etc.). For the read-only path we transparently redirect to
    // read_pdf so the model gets actual content; for action tools we
    // surface a clear error so the model stops trying.
    try {
      const tabForPdfCheck = await chrome.tabs.get(tabId);
      const pageUrl = tabForPdfCheck?.url || '';
      // _isPdfTab does sync URL-pattern match first, then a HEAD probe
      // (credentialed) so PDFs served from extension-less paths like
      // `/download?id=42` with `Content-Type: application/pdf` are
      // caught too. Cached per (tabId, pageUrl) — at most one probe
      // per tab+URL.
      if (await this._isPdfTab(tabId, pageUrl)) {
        if (name === 'read_page') {
          const pdfResult = await this.executeTool(tabId, 'read_pdf', { url: pageUrl });
          return {
            ...pdfResult,
            redirectedFrom: 'read_page',
            warning: 'This tab is a PDF — Chrome\'s PDF viewer is a chrome-extension:// page that content scripts can\'t inject into, so read_page would have returned no content. Redirected to read_pdf which fetches the binary and extracts text directly. To read more pages call read_pdf again with fromPage / toPage.',
          };
        }
        if (
          name === 'click' || name === 'click_ax' ||
          name === 'type_text' || name === 'type_ax' || name === 'set_field' ||
          name === 'press_keys' || name === 'scroll' ||
          name === 'get_accessibility_tree' || name === 'get_interactive_elements' ||
          name === 'extract_data' || name === 'wait_for_element' || name === 'wait_for_stable' ||
          name === 'get_selection'
        ) {
          return {
            success: false,
            error: `${name} cannot be used on Chrome's built-in PDF viewer (a chrome-extension:// page our scripts cannot reach). Use read_pdf to extract the document's text instead. If you need to read a specific page, pass fromPage/toPage to read_pdf.`,
          };
        }
      }
    } catch { /* tab lookup failures are non-fatal — fall through */ }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        target: 'content',
        action,
        params: args,
      });
      this._recordInteractionRect(tabId, name, response);
      this._annotateCredentialField(name, response);
      return response;
    } catch (e) {
      // Content script might not be injected — try injecting it.
      // accessibility-tree.js must load first so content.js's
      // get_accessibility_tree / click_ax / type_ax handlers can reach
      // window.__generateAccessibilityTree and window.__wb_ax_lookup.
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content/accessibility-tree.js', 'src/content/content.js'],
        });
        const response = await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action,
          params: args,
        });
        this._recordInteractionRect(tabId, name, response);
        this._annotateCredentialField(name, response);
        return response;
      } catch (e2) {
        return { error: `Failed to communicate with page: ${e2.message}` };
      }
    }
  }

  /**
   * If a successful set_field touched a credential/secret field, append a
   * note to the tool result so the model is reminded not to echo the value
   * in subsequent text/summaries. Detection lives in credential-fields.js
   * (pure ESM, node-testable). Content scripts ship `fieldMeta`; we apply
   * the policy here so the regex stays in one place.
   */
  _annotateCredentialField(toolName, response) {
    if (toolName !== 'set_field') return;
    if (!response || !response.success || !response.fieldMeta) return;
    try {
      const det = isCredentialField(response.fieldMeta);
      if (!det.sensitive) return;
      // Always set the flag — useful for trace review and downstream tooling
      // — but only emit a model-facing `note` in STRICT mode. Rationale:
      //  (1) webbrain runs small local models (qwen 3-30B class). They handle
      //      "do X unless Y" instructions poorly — the loose hint either
      //      collapses into a hard rule (the bug we're trying to avoid) or
      //      gets ignored. Mid-run nuance buys us little and risks misfires.
      //  (2) The done.summary tool description already carries the hygiene
      //      hint, fired at point-of-use (when the model writes the summary).
      //      A set_field note fires potentially many turns earlier and is
      //      usually forgotten by summary time on small-model contexts.
      //  (3) Saves ~80 tokens per credential field in contexts already
      //      running near the budget on local models.
      // In STRICT mode we DO emit, because the user has explicitly asked for
      // paranoid behaviour throughout the run.
      response.sensitiveField = true;
      response.sensitiveReason = det.reason;
      response.strictSecretMode = !!this.strictSecretMode;
      if (this.strictSecretMode) {
        response.note = CREDENTIAL_NOTE_STRICT;
      }
    } catch { /* never let detection failure break the tool call */ }
  }

  /**
   * Remember the rect returned by a successful click_ax / type_ax so the
   * `done` verification screenshot can outline the last-touched element.
   * No-op for other tool responses or when the rect is missing/degenerate.
   */
  _recordInteractionRect(tabId, toolName, response) {
    if (!response || !response.success) return;
    if (toolName !== 'click_ax' && toolName !== 'type_ax' && toolName !== 'set_field') return;
    const r = response.rect;
    if (!r || !r.w || !r.h) return;
    this._lastInteractionRect.set(tabId, { x: r.x, y: r.y, w: r.w, h: r.h, ts: Date.now() });
  }

  /**
   * Continue processing from where we left off (after max steps).
   * Adds a "please continue" user message and resumes the agent loop.
   */
  async continueProcessing(tabId, onUpdate = () => {}, mode = 'ask') {
    return this.processMessage(tabId, 'Please continue from where you left off.', onUpdate, mode);
  }

  /**
   * Process a single user message — may trigger a multi-step tool-use loop.
   * @param {number} tabId
   * @param {string} userMessage
   * @param {function} onUpdate - callback(type, data) for streaming updates
   * @returns {Promise<string>} final text response
   */

  // ── Deep verbose / debug log ──────────────────────────────────────────
  _logDebug(entry) {
    entry.timestamp = new Date().toISOString();
    this._debugLog.push(entry);
    if (this._debugLog.length > this._debugLogMax) {
      this._debugLog.splice(0, this._debugLog.length - this._debugLogMax);
    }
  }

  getDebugLog() {
    return this._debugLog;
  }

  clearDebugLog() {
    this._debugLog = [];
  }

  /**
   * Attempt to parse tool calls from raw LLM text output.
   * Some local models emit tool calls as text markup instead of using the
   * structured tool_calls field. This catches the most common formats:
   *   - <tool_call>{"name":"...","arguments":{...}}</tool_call>
   *   - <|tool_call|>...<|/tool_call|>  or  <|tool_call>...<tool_call|>
   *   - <functioncall>{"name":"...","arguments":{...}}</functioncall>
   *   - call:toolName{key:<|"|>value<|"|>}  (custom quote-token format)
   *   - Bare JSON objects with a known tool name
   * Returns an array of tool call objects in OpenAI format, or [] if nothing
   * was found. Only tool names present in the allowlist are accepted.
   * @param {Set} [allowedNames] — defaults to AGENT_TOOL_NAMES; pass a
   *   smaller set (e.g. COMPACT_TOOL_NAMES) to restrict in compact mode.
   */
  _tryParseToolCallsFromText(text, allowedNames = AGENT_TOOL_NAMES) {
    if (!text || text.length > 10000) return [];

    const results = [];
    // Collect candidate JSON strings from known wrapper patterns.
    const patterns = [
      // <tool_call>JSON</tool_call>
      /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
      // <|tool_call|>JSON<|/tool_call|>  or  <|tool_call>JSON<tool_call|>
      /<\|tool_call\|?>\s*([\s\S]*?)\s*<\|?\/?tool_call\|?>/gi,
      // <functioncall>JSON</functioncall>
      /<functioncall>\s*([\s\S]*?)\s*<\/functioncall>/gi,
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const inner = m[1].trim();
        // Try JSON first (most common).
        try {
          const obj = JSON.parse(inner);
          if (obj && obj.name && allowedNames.has(obj.name)) {
            results.push(obj);
            continue;
          }
        } catch { /* not JSON — try call:name{} format below */ }

        // call:toolName{key:<|"|>value<|"|>, ...} format.
        // Some local models use <|"|> as quote tokens and call:name as the
        // invocation syntax.  Normalize to JSON and parse.
        const callMatch = /^call:(\w+)\s*\{([\s\S]*)\}$/.exec(inner);
        if (callMatch && allowedNames.has(callMatch[1])) {
          const toolName = callMatch[1];
          let argsBody = callMatch[2]
            .replace(/<\|"\|>/g, '"')  // replace quote tokens with real quotes
            .replace(/<\|'\\?\|>/g, "'");  // handle single-quote tokens if any
          // argsBody is now like: url:"https://example.com",text:"hello"
          // Wrap unquoted keys to make valid JSON: key:"val" → "key":"val"
          argsBody = argsBody.replace(/(?<=^|,)\s*(\w+)\s*:/g, '"$1":');
          try {
            const args = JSON.parse(`{${argsBody}}`);
            results.push({ name: toolName, arguments: args });
          } catch {
            // If JSON parse still fails, try treating entire body as single
            // string argument for zero-arg or simple calls.
            results.push({ name: toolName, arguments: {} });
          }
          continue;
        }
      }
    }

    // Fallback: scan for bare JSON objects containing a "name" key with a
    // known tool name. Only look for top-level objects (starts with {).
    if (results.length === 0) {
      const bareRe = /\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*\}/g;
      let m;
      while ((m = bareRe.exec(text)) !== null) {
        if (!allowedNames.has(m[1])) continue;
        try {
          const obj = JSON.parse(m[0]);
          if (obj && obj.name && allowedNames.has(obj.name)) {
            results.push(obj);
          }
        } catch { /* skip */ }
      }
    }

    // Last resort: call:toolName{...} outside of any wrapper tags.
    if (results.length === 0) {
      const callRe = /call:(\w+)\s*\{([\s\S]*?)\}/g;
      let m;
      while ((m = callRe.exec(text)) !== null) {
        if (!allowedNames.has(m[1])) continue;
        const toolName = m[1];
        let argsBody = m[2]
          .replace(/<\|"\|>/g, '"')
          .replace(/<\|'\\?\|>/g, "'");
        argsBody = argsBody.replace(/(?<=^|,)\s*(\w+)\s*:/g, '"$1":');
        try {
          const args = JSON.parse(`{${argsBody}}`);
          results.push({ name: toolName, arguments: args });
        } catch {
          results.push({ name: toolName, arguments: {} });
        }
      }
    }

    // Convert to OpenAI tool_calls format.
    return results.map((obj, i) => ({
      id: `fallback_call_${Date.now()}_${i}`,
      type: 'function',
      function: {
        name: obj.name,
        arguments: typeof obj.arguments === 'string'
          ? obj.arguments
          : JSON.stringify(obj.arguments || obj.parameters || {}),
      },
    }));
  }
  // ─────────────────────────────────────────────────────────────────────

  async processMessage(tabId, userMessage, onUpdate = () => {}, mode = 'ask') {
    await this._hydrate(tabId);
    const messages = this.getConversation(tabId, mode);

    // Trim context if it's getting too long
    await this._manageContext(tabId, messages);

    const enriched = await this._enrichUserMessageWithCurrentPage(tabId, messages, userMessage);
    messages.push(enriched);
    this._persist(tabId);

    const provider = this.providerManager.getActive();
    const tools = getToolsForMode(mode, { strictSecretMode: this.strictSecretMode, compact: provider.useCompactPrompt });
    const plannerTemperature = mode === 'act' ? 0.15 : 0.3;
    let steps = 0;
    let finalResponse = '';
    // Tracks whether we've already nudged the model after an empty
    // (no-content + no-tool-call) response. Used by the recovery branch
    // in the main loop to avoid an infinite empty→nudge→empty→nudge loop.
    let emptyOutputRecoveryAttempted = false;

    this.abortFlags.delete(tabId); // clear any stale abort
    let _traceStatus = 'done'; // updated on early exits

    // Start a trace run (no-op if tracing is disabled in settings).
    let tabUrl = '', tabTitle = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab?.url || '';
      tabTitle = tab?.title || '';
    } catch {}
    const runId = await trace.startRun({
      model: provider.model, providerId: provider.name,
      providerClass: provider.constructor.name,
      userMessage: typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage).slice(0, 2000),
      tabUrl, tabTitle, mode,
      conversationId: this.conversationIds.get(tabId) || null,
    });
    if (runId) this.currentRunId.set(tabId, runId);

    try {
    while (steps < this.maxSteps) {
      // Check for abort before each step
      if (this._checkAbort(tabId)) {
        finalResponse = finalResponse || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

      // Re-inject adapter notes if the user navigated to a different
      // high-traffic site mid-conversation (no-op on the first iteration
      // because _enrichUserMessageWithCurrentPage already seeded lastSeenAdapter).
      if (steps > 0) {
        await this._maybeReinjectAdapter(tabId, messages);
      }

      steps++;
      onUpdate('thinking', { step: steps });

      let result;
      try {
        const useTools = provider.supportsTools;
        const chatOpts = { tools: useTools ? tools : undefined, temperature: plannerTemperature, maxTokens: 4096 };
        const prunedMessages = this._pruneOldImages(messages, provider);
        this._logDebug({ type: 'llm_request', step: steps, provider: provider.constructor.name, messages: prunedMessages, options: chatOpts });
        if (runId) trace.recordLLMRequest(runId, steps, { providerClass: provider.constructor.name, model: provider.model, messageCount: prunedMessages.length, toolsCount: (chatOpts.tools || []).length });
        const _llmStart = Date.now();
        result = await provider.chat(prunedMessages, chatOpts);
        const _llmLatency = Date.now() - _llmStart;
        this._logDebug({ type: 'llm_response', step: steps, content: result.content, toolCalls: result.toolCalls });
        if (runId) trace.recordLLMResponse(runId, steps, { content: result.content, toolCalls: result.toolCalls, usage: result.usage, latencyMs: _llmLatency, model: provider.model });
      } catch (e) {
        this._logDebug({ type: 'llm_error', step: steps, error: e.message });
        // If context overflow, trim aggressively and retry once
        if (this._isContextOverflow(e.message)) {
          onUpdate('thinking', { step: steps, note: 'Context too large, trimming...' });
          this._emergencyTrim(messages);
          try {
            const useTools = provider.supportsTools;
            const chatOpts = { tools: useTools ? tools : undefined, temperature: plannerTemperature, maxTokens: 4096 };
            const prunedMessages = this._pruneOldImages(messages, provider);
            this._logDebug({ type: 'llm_request_retry', step: steps, provider: provider.constructor.name, messages: prunedMessages, options: chatOpts });
            result = await provider.chat(prunedMessages, chatOpts);
            this._logDebug({ type: 'llm_response_retry', step: steps, content: result.content, toolCalls: result.toolCalls });
          } catch (e2) {
            this._logDebug({ type: 'llm_error_retry', step: steps, error: e2.message });
            onUpdate('error', { message: `Context still too large after trimming: ${e2.message}` });
            finalResponse = 'The conversation got too long. Please start a new conversation (click the + button).';
            messages.push({ role: 'assistant', content: finalResponse });
            break;
          }
        } else {
          // Retry once after a short delay for transient errors (rate limits, network).
          this._logDebug({ type: 'llm_error_retrying', step: steps, error: e.message });
          await new Promise(r => setTimeout(r, 2000));
          try {
            const useTools2 = provider.supportsTools;
            const chatOpts2 = { tools: useTools2 ? tools : undefined, temperature: plannerTemperature, maxTokens: 4096 };
            result = await provider.chat(this._pruneOldImages(messages, provider), chatOpts2);
            this._logDebug({ type: 'llm_response_after_retry', step: steps, content: result.content, toolCalls: result.toolCalls });
          } catch (e2) {
            this._logDebug({ type: 'llm_error_final', step: steps, error: e2.message });
            onUpdate('error', { message: e2.message });
            finalResponse = `Error communicating with LLM: ${e2.message}`;
            messages.push({ role: 'assistant', content: finalResponse });
            break;
          }
        }
      }

      // Check for abort after LLM response
      if (this._checkAbort(tabId)) {
        finalResponse = result?.content || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

      // Reset the empty-output recovery flag whenever the model produces
      // any signal of life (text or a tool call). The flag is only meant
      // to prevent ping-pong on consecutive empty responses.
      if ((result.content && result.content.trim()) || (result.toolCalls && result.toolCalls.length > 0)) {
        emptyOutputRecoveryAttempted = false;
      }

      // Fallback: if the LLM emitted tool calls as raw text instead of
      // using the structured tool_calls field, try to parse them out.
      if ((!result.toolCalls || result.toolCalls.length === 0) && result.content) {
        const fallback = this._tryParseToolCallsFromText(result.content, (mode === 'act' && provider.useCompactPrompt) ? COMPACT_TOOL_NAMES : undefined);
        if (fallback.length > 0) {
          this._logDebug({ type: 'llm_text_fallback_parse', step: steps, parsed: fallback.map(tc => tc.function.name) });
          result.toolCalls = fallback;
          result.content = null;
        }
      }

      if (result.toolCalls && result.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls,
        });

        if (result.content) {
          onUpdate('text', { content: result.content });
        }

        const batchResult = await this._executeToolBatch(
          tabId, result.toolCalls, messages, onUpdate, provider, result.content
        );
        if (batchResult.action === 'return') {
          finalResponse = batchResult.value;
          return finalResponse;
        }
        // 'continue' → fall through to next loop iteration
        continue;
      }

      // No tool calls. Two sub-cases:
      //   (a) Model returned non-empty content → genuine final answer.
      //   (b) Model returned NEITHER content NOR tool calls. This is the
      //       "model gave up mid-thought" failure mode (often after burning
      //       its output budget on internal reasoning_tokens). We try to
      //       recover ONCE by nudging the model to emit a summary; if the
      //       second attempt also comes back empty we abandon the run with
      //       a transparent failure message instead of silently recording
      //       a "done" run with empty content (the previous behavior).
      const isEmpty = !result.content || !result.content.trim();
      if (isEmpty) {
        if (!emptyOutputRecoveryAttempted) {
          emptyOutputRecoveryAttempted = true;
          messages.push({
            role: 'user',
            content: '[System nudge: your previous response had neither text nor a tool call. You may have run out of output budget on internal reasoning. In ONE short message, summarize what you accomplished, what you tried, and what blocked you — then stop. Do not start any new tool calls.]',
          });
          continue; // give the model one more turn to summarize
        }
        // Second empty in a row — give up with a transparent message.
        finalResponse = '[Agent emitted no output and no tool call, even after a recovery nudge. This usually means the task exceeded the current model\'s capability or context budget. Try a stronger model, raise the step limit in settings, or break the task into smaller parts.]';
        _traceStatus = 'empty_output';
        messages.push({ role: 'assistant', content: finalResponse });
        onUpdate('warning', { message: finalResponse });
        break;
      }
      // Genuine final answer — emit and exit.
      finalResponse = result.content;
      messages.push({ role: 'assistant', content: finalResponse });
      onUpdate('text', { content: finalResponse });
      break;
    }

    if (steps >= this.maxSteps) {
      onUpdate('max_steps_reached', { steps: this.maxSteps });
      _traceStatus = 'max_steps';
      // Auto-done: if the loop exited at the step limit without a real
      // final answer, synthesize a transparent summary so the user sees
      // WHY the run ended instead of an empty `done` event.
      if (!finalResponse || !finalResponse.trim()) {
        finalResponse = this._buildStepLimitSummary(messages, steps);
        messages.push({ role: 'assistant', content: finalResponse });
        onUpdate('text', { content: finalResponse });
      }
    }

    this._persist(tabId);
    return finalResponse;
    } finally {
      if (runId) {
        trace.endRun(runId, { status: _traceStatus, finalContent: finalResponse });
        this.currentRunId.delete(tabId);
      }
    }
  }

  /**
   * Process a message with streaming output.
   */
  async processMessageStream(tabId, userMessage, onUpdate = () => {}, mode = 'ask') {
    await this._hydrate(tabId);
    const messages = this.getConversation(tabId, mode);

    // Trim context if it's getting too long
    await this._manageContext(tabId, messages);

    const enriched = await this._enrichUserMessageWithCurrentPage(tabId, messages, userMessage);
    messages.push(enriched);
    this._persist(tabId);

    const provider = this.providerManager.getActive();
    const tools = getToolsForMode(mode, { strictSecretMode: this.strictSecretMode, compact: provider.useCompactPrompt });
    const plannerTemperature = mode === 'act' ? 0.15 : 0.3;
    let steps = 0;
    // See processMessage — used to break the empty-response→nudge cycle.
    let emptyOutputRecoveryAttempted = false;

    this.abortFlags.delete(tabId);

    while (steps < this.maxSteps) {
      if (this._checkAbort(tabId)) {
        onUpdate('warning', { message: 'Stopped by user.' });
        return '[Stopped by user]';
      }

      if (steps > 0) {
        await this._maybeReinjectAdapter(tabId, messages);
      }

      steps++;
      onUpdate('thinking', { step: steps });

      try {
        let fullText = '';
        let toolCallsAccumulator = {};
        let hasToolCalls = false;

        const streamOpts = { tools: provider.supportsTools ? tools : undefined, temperature: plannerTemperature, maxTokens: 4096 };
        const prunedMessages = this._pruneOldImages(messages, provider);
        this._logDebug({ type: 'llm_stream_request', step: steps, provider: provider.constructor.name, messages: prunedMessages, options: streamOpts });

        for await (const chunk of provider.chatStream(prunedMessages, streamOpts)) {
          if (chunk.type === 'text') {
            fullText += chunk.content;
            onUpdate('text_delta', { content: chunk.content });
          } else if (chunk.type === 'tool_call') {
            hasToolCalls = true;
            // Accumulate streaming tool call deltas (OpenAI format)
            for (const tc of chunk.content) {
              const idx = tc.index ?? 0;
              if (!toolCallsAccumulator[idx]) {
                toolCallsAccumulator[idx] = { id: '', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCallsAccumulator[idx].id = tc.id;
              if (tc.function?.name) toolCallsAccumulator[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCallsAccumulator[idx].function.arguments += tc.function.arguments;
            }
          } else if (chunk.type === 'tool_call_start') {
            hasToolCalls = true;
            const idx = Object.keys(toolCallsAccumulator).length;
            toolCallsAccumulator[idx] = {
              id: chunk.content.id,
              function: { name: chunk.content.name, arguments: '' },
            };
          } else if (chunk.type === 'tool_call_delta') {
            const idx = Object.keys(toolCallsAccumulator).length - 1;
            if (toolCallsAccumulator[idx]) {
              toolCallsAccumulator[idx].function.arguments += chunk.content;
            }
          } else if (chunk.type === 'done') {
            break;
          }
        }

        // Fallback: parse tool calls from streamed text if structured calls are missing.
        if (!hasToolCalls && fullText) {
          const fallback = this._tryParseToolCallsFromText(fullText, (mode === 'act' && provider.useCompactPrompt) ? COMPACT_TOOL_NAMES : undefined);
          if (fallback.length > 0) {
            this._logDebug({ type: 'llm_text_fallback_parse', step: steps, parsed: fallback.map(tc => tc.function.name) });
            hasToolCalls = true;
            fallback.forEach((tc, i) => { toolCallsAccumulator[i] = tc; });
            fullText = '';
          }
        }

        if (hasToolCalls) {
          const toolCalls = Object.values(toolCallsAccumulator);
          this._logDebug({ type: 'llm_stream_response', step: steps, content: fullText, toolCalls });
          messages.push({
            role: 'assistant',
            content: fullText || null,
            tool_calls: toolCalls,
          });

          const batchResult = await this._executeToolBatch(
            tabId, toolCalls, messages, onUpdate, provider, fullText
          );
          if (batchResult.action === 'return') {
            return batchResult.value;
          }
          continue;
        }

        // No tool calls — final response. Detect the "empty output"
        // failure mode (no text + no tool call after non-trivial reasoning)
        // and recover once via a summary-nudge before giving up.
        this._logDebug({ type: 'llm_stream_response', step: steps, content: fullText, toolCalls: null });
        if (!fullText || !fullText.trim()) {
          if (!emptyOutputRecoveryAttempted) {
            emptyOutputRecoveryAttempted = true;
            messages.push({
              role: 'user',
              content: '[System nudge: your previous response had neither text nor a tool call. You may have run out of output budget on internal reasoning. In ONE short message, summarize what you accomplished, what you tried, and what blocked you — then stop. Do not start any new tool calls.]',
            });
            this._persist(tabId);
            continue;
          }
          const failMsg = '[Agent emitted no output and no tool call, even after a recovery nudge. This usually means the task exceeded the current model\'s capability or context budget. Try a stronger model, raise the step limit in settings, or break the task into smaller parts.]';
          messages.push({ role: 'assistant', content: failMsg });
          onUpdate('warning', { message: failMsg });
          this._persist(tabId);
          return failMsg;
        }
        emptyOutputRecoveryAttempted = false;
        messages.push({ role: 'assistant', content: fullText });
        this._persist(tabId);
        return fullText;

      } catch (e) {
        this._logDebug({ type: 'llm_stream_error', step: steps, error: e.message });
        // If context overflow, trim and retry
        if (this._isContextOverflow(e.message)) {
          onUpdate('thinking', { step: steps, note: 'Context too large, trimming...' });
          this._emergencyTrim(messages);
          this._persist(tabId);
          continue; // retry the loop with trimmed context
        }
        onUpdate('error', { message: e.message });
        const errMsg = `Error: ${e.message}`;
        messages.push({ role: 'assistant', content: errMsg });
        this._persist(tabId);
        return errMsg;
      }
    }

    onUpdate('max_steps_reached', { steps: this.maxSteps });
    this._persist(tabId);
    // Synthesize a transparent summary of what was attempted instead of
    // the generic "reached maximum steps" line. Same helper as the
    // non-streaming path uses.
    const summary = this._buildStepLimitSummary(messages, steps);
    messages.push({ role: 'assistant', content: summary });
    onUpdate('text', { content: summary });
    return summary;
  }
}
