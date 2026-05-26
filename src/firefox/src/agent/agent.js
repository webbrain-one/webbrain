import { AGENT_TOOLS, AGENT_TOOL_NAMES, getToolsForMode, SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT } from './tools.js';
import { URL_FAMILY_TOOLS, resourceBucket, bucketArgsKey } from './loop-bucket.js';
import { isCredentialField, CREDENTIAL_NOTE_STRICT } from './credential-fields.js';
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

/**
 * The WebBrain Agent — orchestrates multi-step LLM + tool-use loops.
 */
export class Agent {
  constructor(providerManager) {
    this.providerManager = providerManager;
    this.conversations = new Map(); // tabId -> messages[]
    this.conversationIds = new Map(); // tabId -> stable conversationId (regenerated on clearConversation)
    this.conversationModes = new Map(); // tabId -> 'ask' | 'act'
    this.abortFlags = new Map(); // tabId -> boolean
    this.currentRunId = new Map(); // tabId -> active trace runId
    this.maxSteps = 130; // safety limit for autonomous loops (configurable via settings)
    this.maxContextMessages = 50; // trim beyond this
    this._debugLog = []; // ring buffer for deep verbose (LLM requests/responses)
    this._debugLogMax = 200; // max entries before oldest are dropped
    this.maxContextChars = 80000; // rough char budget (~20k tokens)
    this.autoScreenshot = 'state_change';
    this.useSiteAdapters = true;
    // Profile auto-fill (plaintext bio + throwaway password used on
    // signup forms). Loaded in background.js and refreshed live on change.
    this.profileEnabled = false;
    this.profileText = '';
    // CapSolver opt-in. Off by default. When enabled AND an API key is
    // set, the system prompt gets a "[CAPTCHA SOLVER]" note telling the
    // model to try `solve_captcha` once before falling back to asking
    // the user. The API key is read at call time from browser.storage.
    this.captchaSolverEnabled = false;
    // Strict secret-handling mode — see chrome/agent.js for rationale.
    // Default off; user opts in via Settings → "Strict secret handling".
    this.strictSecretMode = false;
    this.recentCalls = new Map();
    this.loopNudges = new Map();
    this.healthyCallsSinceLoop = new Map();
    this.lastAutoScreenshotTs = new Map();
    this.lastSeenAdapter = new Map();
    this.recentCoordClicks = new Map();
    this.apiAllowedTabs = new Set();
    this.apiAllowedInjected = new Set();
    // Cache for `_isPdfTab` HEAD probes — see Chrome agent.js for
    // design notes. Same (tabId,url) → isPdf shape.
    this._isPdfTabCache = new Map();
    // Pending clarify() tool calls awaiting user input — see Chrome
    // agent.js. Keyed by tabId → (clarifyId → {resolve, ts}).
    this._pendingClarifications = new Map();
  }

  setApiMutationsAllowed(tabId, allowed) {
    if (allowed) {
      this.apiAllowedTabs.add(tabId);
    } else {
      this.apiAllowedTabs.delete(tabId);
      this.apiAllowedInjected.delete(tabId);
    }
  }

  // ---- Loop detection ----
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
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3) return { type: 'repeat', key, name: key.split('|')[0], count: n };
    }
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
   * without producing a final answer. See chrome's copy for the rationale.
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

  _checkLoop(tabId, toolName, toolArgs, toolResult) {
    const buf = this._recordCall(tabId, toolName, toolArgs, toolResult);
    const loop = this._detectLoop(buf);
    if (!loop) {
      // Healthy run — reset nudges only after a sustained streak.
      const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
      this.healthyCallsSinceLoop.set(tabId, healthy);
      if (healthy >= 2) {
        this.loopNudges.delete(tabId);
        this.healthyCallsSinceLoop.delete(tabId);
      }
      return { kind: 'none' };
    }
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
    s = s.replace(/<think[\s\S]*?<\/think>/gi, '');
    const markerRe = /(^|\n)\s*(?:\*\*)?1[.)][\s\S]/;
    const m = s.match(markerRe);
    if (m && m.index != null) {
      const cut = m.index + (m[1] ? m[1].length : 0);
      s = s.slice(cut);
    }
    return s.trim();
  }

  _shouldAutoScreenshot(toolName) {
    const mode = this.autoScreenshot;
    if (mode === 'off' || !mode) return false;
    if (mode === 'every_step') return true;
    if (mode === 'state_change') return Agent.STATE_CHANGE_TOOLS.has(toolName);
    if (mode === 'navigation') return Agent.NAV_TOOLS.has(toolName);
    return false;
  }

  async _currentUrl(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      return tab?.url || '';
    } catch (e) { return ''; }
  }

  _normalizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) { return url; }
  }

  async _getVisibleInteractiveElements(tabId) {
    try {
      const code = `
        (() => {
          const sels = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), textarea, select, summary, [onclick]';
          const all = Array.from(document.querySelectorAll(sels));
          const out = [];
          for (const el of all) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.bottom < 0 || r.top > window.innerHeight) continue;
            if (r.right < 0 || r.left > window.innerWidth) continue;
            const text = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().slice(0, 50);
            if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') continue;
            out.push({
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              text: text || '<' + el.tagName.toLowerCase() + '>',
            });
            if (out.length >= 25) break;
          }
          return out;
        })()
      `;
      const result = await browser.tabs.executeScript(tabId, { code });
      return (result && result[0]) || [];
    } catch (e) {
      return [];
    }
  }

  _formatElementsList(elements) {
    if (!elements || elements.length === 0) return '';
    const lines = elements.map(e => {
      const tagInfo = e.type ? `${e.tag}[${e.type}]` : e.tag;
      return `  (${e.x},${e.y}) ${tagInfo} "${e.text}"`;
    });
    return `\nVisible interactive elements at these positions (use these names with click({text:"..."}) — much more reliable than guessing coordinates from the image):\n${lines.join('\n')}`;
  }

  /**
   * Re-inject site adapter notes if the user navigated to a different
   * adapted site mid-conversation.
   */
  async _maybeReinjectAdapter(tabId, messages) {
    if (!this.useSiteAdapters) return false;
    let url = '';
    try {
      const tab = await browser.tabs.get(tabId);
      url = tab?.url || '';
    } catch (e) { return false; }
    if (!url) return false;
    const adapter = getActiveAdapter(url);
    const lastName = this.lastSeenAdapter.get(tabId) || null;
    const currentName = adapter ? adapter.name : null;
    if (currentName === lastName) return false;
    this.lastSeenAdapter.set(tabId, currentName);
    if (!adapter) return false;
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
   * Shared tool-batch executor used by both processMessage and
   * processMessageStream so they can't drift.
   */
  async _executeToolBatch(tabId, toolCalls, messages, onUpdate, provider, partialAssistantText = null) {
    let didStateChange = false;
    const NAV_PRONE_TOOLS = new Set(['click', 'navigate', 'execute_js', 'iframe_click']);
    const navNotices = [];

    for (const tc of toolCalls) {
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

      let beforeUrl = '';
      if (NAV_PRONE_TOOLS.has(fnName)) {
        beforeUrl = await this._currentUrl(tabId);
      }

      onUpdate('tool_call', { name: fnName, args: fnArgs });
      const _toolStart = Date.now();
      const toolResult = await this.executeTool(tabId, fnName, fnArgs, onUpdate);
      try {
        const runId = this.currentRunId.get(tabId);
        if (runId) {
          await trace.recordToolCall(runId, null, {
            name: fnName, args: fnArgs, result: toolResult,
            latencyMs: Date.now() - _toolStart,
          });
        }
      } catch {}
      onUpdate('tool_result', { name: fnName, result: toolResult });

      if (NAV_PRONE_TOOLS.has(fnName) && beforeUrl && !toolResult?.error) {
        await new Promise(r => setTimeout(r, 200));
        const afterUrl = await this._currentUrl(tabId);
        const beforeNorm = this._normalizeUrl(beforeUrl);
        const afterNorm = this._normalizeUrl(afterUrl);
        if (beforeNorm && afterNorm && beforeNorm !== afterNorm && fnName !== 'navigate') {
          navNotices.push({ before: beforeUrl, after: afterUrl, viaTool: fnName });
        }
      }

      if (toolResult && toolResult.done) {
        const finalResponse = toolResult.summary || partialAssistantText || 'Task completed.';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: this._limitToolResult(toolResult),
        });
        return { action: 'return', value: finalResponse };
      }

      // Loop detection — general + coordinate-specific. Strongest wins.
      const loopCheck = this._checkLoop(tabId, fnName, fnArgs, toolResult);
      let coordCheck = { kind: 'none' };
      if (fnName === 'click' && fnArgs?.x != null && fnArgs?.y != null) {
        coordCheck = this._checkCoordClickLoop(tabId, fnArgs.x, fnArgs.y);
      }

      let effectiveKind = 'none';
      let nudgeWarning = '';
      let stopMessage = '';
      if (loopCheck.kind === 'stop' || coordCheck.kind === 'stop') {
        effectiveKind = 'stop';
        // Show the model's actual args, not _checkCoordClickLoop's 5px
        // bucket — for fractional inputs like (0.911, 0.331) the bucket
        // rounds to (0, 0) and the message reads as if we'd clicked the
        // top-left corner, hiding what really happened.
        stopMessage = coordCheck.kind === 'stop'
          ? `Stopped: I clicked at (or near) coordinates (${fnArgs.x}, ${fnArgs.y}) multiple times and the page never responded. That position is hitting empty space, an overlay, or the wrong element. Please give a different instruction or check the page yourself.`
          : loopCheck.message;
      } else if (loopCheck.kind === 'nudge' || coordCheck.kind === 'nudge') {
        effectiveKind = 'nudge';
        nudgeWarning = coordCheck.kind === 'nudge'
          ? `[COORDINATE CLICK WARNING: You've clicked at or near (${fnArgs.x}, ${fnArgs.y}) several times with no visible page change. The click may be missing its target. Try: (a) call get_interactive_elements to find a real selector, (b) click({text: "..."}) to target by visible text, or (c) take a fresh screenshot and look more carefully at element positions. Try a different approach before clicking these coordinates again.]`
          : loopCheck.warning;
      }

      // Strip `_attachImage` BEFORE stringifying the tool result — otherwise
      // `_limitToolResult` would chop the base64 dataUrl mid-string and the
      // model would never see a decodable image.
      let attachedImage = null;
      if (toolResult && typeof toolResult === 'object' && toolResult._attachImage) {
        attachedImage = toolResult._attachImage;
        delete toolResult._attachImage;
      }

      // Same pattern for `_attachDocument` — Anthropic Claude consumes PDFs
      // natively as a `document` content block on a user message. The
      // tool-result text still has the plain-text extraction so the model
      // can quote/reference passages without re-reading.
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
      if (attachedImage) {
        const noteText = `[Screenshot from your ${fnName} call. Image is a PNG at native device resolution (image pixels are NOT CSS pixels — prefer click_ax / click({text}) over pixel clicks). Use it to decide the next action.]`;
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: noteText },
            { type: 'image_url', image_url: { url: attachedImage } },
          ],
        });
      }
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
        return { action: 'return', value: stopMessage };
      }
      if (this._shouldAutoScreenshot(fnName) && !toolResult?.error) {
        didStateChange = true;
      }
    }

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
        `and re-plan from scratch. If this navigation was unintended, navigate back with \`navigate({url: "${last.before}"})\` and try a more specific click.]`;
      messages.push({ role: 'user', content: noticeText });
      onUpdate('warning', { message: 'Page navigated unexpectedly — agent notified.' });
    }

    // Auto-screenshot after state change. Capture if either the main
    // provider supports images, or a dedicated vision model is configured
    // to describe them.
    const visionProvider = await this.providerManager.getVisionProvider();
    if (didStateChange && (provider.supportsVision || visionProvider)) {
      const lastTs = this.lastAutoScreenshotTs.get(tabId) || 0;
      if (Date.now() - lastTs >= 500) {
        await new Promise(r => setTimeout(r, 250));
        const shot = await this._captureAutoScreenshot(tabId);
        if (shot) {
          this.lastAutoScreenshotTs.set(tabId, Date.now());
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
            const textBlock = `[Auto-screenshot of current viewport after the action above. Image is ${shot.width}×${shot.height} pixels = the CSS viewport at 1:1. A click at image pixel (X, Y) maps directly to click(x:X, y:Y). Use this to confirm the result and plan the next step. Prefer click({text:"..."}) over coordinate clicks — coordinates are a last resort.]${elementsText}`;
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
            try {
              const runIdForShot = this.currentRunId.get(tabId);
              if (runIdForShot) {
                await trace.recordScreenshot(runIdForShot, null, shot.dataUrl, 'auto-screenshot after tool batch');
              }
            } catch {}
          }
        }
      }
    }

    return { action: 'continue' };
  }

  // ───────────── Image-budget (token-conscious screenshots) ─────────────
  // See src/chrome/src/agent/agent.js for the full rationale. Firefox MV2
  // runs in a background PAGE (not a worker) so we have a real `document`
  // and can use regular <canvas> / toBlob instead of OffscreenCanvas.
  // Constants match Anthropic's Claude-for-Chrome defaults and the Chrome
  // Agent's IMAGE_BUDGET — keep them in sync.
  static IMAGE_BUDGET = {
    pxPerToken: 28,
    maxTargetPx: 1568,
    maxTargetTokens: 1568,
    maxBase64Chars: 1398100,
    initialJpegQuality: 0.75,
    minJpegQuality: 0.10,
    jpegQualityStep: 0.05,
  };

  static _estimateImageTokens(w, h, pxPerToken) {
    return Math.ceil((w / pxPerToken) * (h / pxPerToken));
  }

  static _fitImageDimensions(origW, origH, budget = Agent.IMAGE_BUDGET) {
    const { pxPerToken, maxTargetPx, maxTargetTokens } = budget;
    if (origW <= maxTargetPx && origH <= maxTargetPx &&
        Agent._estimateImageTokens(origW, origH, pxPerToken) <= maxTargetTokens) {
      return [origW, origH];
    }
    if (origH > origW) {
      const [h, w] = Agent._fitImageDimensions(origH, origW, budget);
      return [w, h];
    }
    const aspect = origW / origH;
    let hi = origW, lo = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (lo + 1 >= hi) return [lo, Math.max(Math.round(lo / aspect), 1)];
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
   * Load a dataUrl into an <img>, returning it after `load`. Used by the
   * budget helpers since Firefox MV2's background page has DOM.
   */
  _loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    });
  }

  _canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode canvas'));
      }, type, quality);
    });
  }

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
   * Decode, resize to the budget target dims, and JPEG-quality-iterate
   * until the base64 fits. DOM-based (not OffscreenCanvas) because MV2's
   * background page has a real document. Returns { dataUrl, width, height }.
   */
  async _shrinkImageForBudget(dataUrl, origW, origH, budget = Agent.IMAGE_BUDGET) {
    try {
      if (!dataUrl) return { dataUrl, width: origW, height: origH };

      if (origW && origH) {
        const [targetW, targetH] = Agent._fitImageDimensions(origW, origH, budget);
        const payloadStart = dataUrl.indexOf(',') + 1;
        const payloadLen = payloadStart > 0 ? dataUrl.length - payloadStart : dataUrl.length;
        if (targetW === origW && targetH === origH && payloadLen <= budget.maxBase64Chars) {
          return { dataUrl, width: origW, height: origH };
        }
      }

      const img = await this._loadImageFromDataUrl(dataUrl);
      if (!origW || !origH) {
        origW = img.naturalWidth || img.width;
        origH = img.naturalHeight || img.height;
      }
      const [targetW, targetH] = Agent._fitImageDimensions(origW, origH, budget);
      const finalW = Math.min(targetW, origW);
      const finalH = Math.min(targetH, origH);

      const canvas = document.createElement('canvas');
      canvas.width = finalW;
      canvas.height = finalH;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, origW, origH, 0, 0, finalW, finalH);

      let quality = budget.initialJpegQuality;
      let lastBuf = null;
      while (quality >= budget.minJpegQuality - 1e-9) {
        const outBlob = await this._canvasToBlob(canvas, 'image/jpeg', quality);
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
   * Byte-ceiling-only re-encode: preserves dimensions, just drops JPEG
   * quality until bytes fit. Useful when you've already decided the
   * dims are correct (e.g. coord-aligned captures) but the payload
   * happens to exceed the provider's image cap.
   */
  async _compressJpegToByteCeiling(dataUrl, budget = Agent.IMAGE_BUDGET) {
    try {
      if (!dataUrl) return dataUrl;
      const payloadStart = dataUrl.indexOf(',') + 1;
      const payloadLen = payloadStart > 0 ? dataUrl.length - payloadStart : dataUrl.length;
      if (payloadLen <= budget.maxBase64Chars) return dataUrl;

      const img = await this._loadImageFromDataUrl(dataUrl);
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0);

      let quality = budget.initialJpegQuality;
      let lastBuf = null;
      while (quality >= budget.minJpegQuality - 1e-9) {
        const outBlob = await this._canvasToBlob(canvas, 'image/jpeg', quality);
        const buf = await outBlob.arrayBuffer();
        lastBuf = buf;
        if (Math.ceil(buf.byteLength * 4 / 3) <= budget.maxBase64Chars) {
          return Agent._bufferToDataUrl(buf, 'image/jpeg');
        }
        quality -= budget.jpegQualityStep;
      }
      return lastBuf ? Agent._bufferToDataUrl(lastBuf, 'image/jpeg') : dataUrl;
    } catch {
      return dataUrl;
    }
  }

  /**
   * Add the new tab to the per-window "WebBrain" tab group so the agent's
   * spawned tabs share visual scope with the user's session. Mirrors
   * src/chrome/src/agent/agent.js — same Option-2 semantics: query for
   * an existing WebBrain group by title (rather than inheriting from
   * sourceTab.groupId), so we never drag agent outputs into the user's
   * own "Dev"/"Research" groups.
   *
   * If the user hasn't opened the sidebar yet (so no WebBrain group
   * exists for this window), create one containing only the new tab.
   * Background.js's browserAction.onClicked handler is the canonical
   * place that opts the source tab in.
   *
   * Returns the group id, or -1 on Firefox <142 (no tabGroups API)
   * or any failure.
   */
  /**
   * Decide whether `pageUrl` is a PDF tab the content-script path
   * cannot reach. URL-pattern fast path + credentialed HEAD probe
   * fallback for Content-Type-only PDFs (e.g. `/download?id=42`
   * returning `application/pdf`). Result cached per (tabId, pageUrl).
   * See Chrome agent.js for the full design notes.
   */
  async _isPdfTab(tabId, pageUrl) {
    if (!pageUrl) return false;
    if (isPdfUrl(pageUrl)) return true;

    const cached = this._isPdfTabCache.get(tabId);
    if (cached && cached.url === pageUrl) return cached.isPdf;

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
    if (!browser.tabGroups || !sourceTab?.id || tabId == null) return -1;
    try {
      let existing = null;
      try {
        const groups = await browser.tabGroups.query({
          title: 'WebBrain',
          windowId: sourceTab.windowId,
        });
        if (Array.isArray(groups) && groups.length > 0) existing = groups[0];
      } catch { /* tabGroups.query unsupported on this Firefox build */ }

      if (existing) {
        await browser.tabs.group({ groupId: existing.id, tabIds: [tabId] });
        return existing.id;
      }

      const gid = await browser.tabs.group({ tabIds: [tabId] });
      try {
        await browser.tabGroups.update(gid, {
          title: 'WebBrain', color: 'blue', collapsed: false,
        });
      } catch { /* style update can fail; group still exists */ }
      return gid;
    } catch (_) {
      return -1;
    }
  }

  /**
   * Wrap a screenshot capture in messages that ask the agent-visual-
   * indicator content script to hide its pulsing border + Stop button
   * for the duration of the capture. Without this, the agent's own
   * indicator gets baked into every screenshot it sends to the vision
   * model — both ugly and a small token-budget tax.
   *
   * Best-effort: if the content script isn't loaded (about:* / file://
   * pages, or pre-existing tabs that loaded before the extension), the
   * sendMessage rejects and we capture as-is.
   */
  async _withIndicatorsHidden(tabId, fn) {
    let needsRestore = false;
    try {
      await browser.tabs.sendMessage(tabId, { type: 'WB_HIDE_FOR_TOOL_USE' });
      needsRestore = true;
      // Give the renderer one paint frame to apply the display:none the
      // content script just set, before we capture.
      await new Promise((r) => setTimeout(r, 16));
    } catch { /* content script absent — capture without hiding */ }
    try {
      return await fn();
    } finally {
      if (needsRestore) {
        try {
          browser.tabs.sendMessage(tabId, { type: 'WB_SHOW_AFTER_TOOL_USE' }).catch(() => {});
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Capture a viewport screenshot via the WebExtension tabs API. Firefox
   * supports `scale: 1` on captureVisibleTab to force a CSS-pixel-aligned
   * image (otherwise it captures at devicePixelRatio, causing the same
   * coordinate-mismatch loop chrome had pre-1.5.1). Returns
   * { dataUrl, width, height } in CSS pixels, or null on failure.
   */
  async _captureAutoScreenshot(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (!tab) return null;
      // captureVisibleTab takes a windowId and snapshots whatever is currently
      // visible in that window — it does NOT take a tabId. If the agent's
      // tab isn't the active tab, we'd silently capture an unrelated page
      // and feed misleading visual context to the model. Skip in that case;
      // the model will plan from text only this turn.
      if (!tab.active) return null;
      // Get the actual viewport dimensions from the page so we can include
      // them in the prompt accompanying the screenshot.
      let w = 1024, h = 768;
      try {
        const dims = await browser.tabs.executeScript(tabId, {
          code: 'JSON.stringify({w: window.innerWidth, h: window.innerHeight})',
        });
        if (dims && dims[0]) {
          const parsed = JSON.parse(dims[0]);
          w = Math.max(1, Math.round(parsed.w));
          h = Math.max(1, Math.round(parsed.h));
        }
      } catch (e) { /* fall back to defaults */ }
      // scale: 1 forces 1 image pixel per CSS pixel (Firefox-specific option,
      // ignored by Chrome but Chrome path uses CDP anyway).
      const rawDataUrl = await this._withIndicatorsHidden(tabId, () =>
        browser.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 60,
          scale: 1,
        })
      );
      if (!rawDataUrl) return null;

      // Firefox's captureVisibleTab doesn't take a clip/scale in a way that
      // lets us downsize during capture (scale:1 is viewport-lock, not a
      // factor). So we capture at CSS size and shrink via DOM canvas to
      // the token budget. On small viewports this is a no-op fast-exit.
      const shrunk = await this._shrinkImageForBudget(rawDataUrl, w, h);
      return { dataUrl: shrunk.dataUrl, width: shrunk.width, height: shrunk.height };
    } catch (e) {
      return null;
    }
  }

  /**
   * If the user configured a dedicated vision model in settings, route a
   * screenshot to it and return a terse text description. The planning
   * model then receives only the description — the raw image never reaches
   * the main provider.
   *
   * Returns { text, model } on success, or null on any failure. Callers
   * fall back to sending the raw image_url block to the main provider.
   *
   * Recorded in the trace under a `vision_sub_call` event so description
   * quality can be inspected alongside the main turn.
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
   * Attach the current page's URL/title to every user message so deictic
   * phrases like "this page" resolve to the active tab, not an older page
   * mentioned earlier in the thread. The heavier screenshot context is still
   * limited to the first real user turn.
   */
  async _enrichUserMessageWithCurrentPage(tabId, messages, userMessage) {
    const hasPriorUserTurn = messages.some(m => m.role === 'user');

    let url = '', title = '';
    try {
      const tab = await browser.tabs.get(tabId);
      url = tab?.url || '';
      title = tab?.title || '';
    } catch (e) { /* ignore */ }

    let contextLine = url
      ? `[Current page context — applies to this user message and supersedes older page context for phrases like "this page". URL: ${url}${title ? ` — Title: ${title}` : ''}]\n\n`
      : '';

    if (this.apiAllowedTabs.has(tabId) && !this.apiAllowedInjected.has(tabId)) {
      contextLine += `[USER OVERRIDE — /allow-api: For this conversation the user has explicitly authorized you to use API mutations (POST/PUT/PATCH/DELETE via fetch_url, or fetch() with mutation methods via execute_js) when you judge API to be more reliable than UI for a specific step. The default UI-first rule still applies — only reach for the API when UI has actually failed or is genuinely unworkable. Before any destructive API call, state the URL, method, and payload in plain text in your response so the user can see what you're about to do.]\n\n`;
      this.apiAllowedInjected.add(tabId);
    }

    if (this.useSiteAdapters && url) {
      const adapter = getActiveAdapter(url);
      const currentName = adapter ? adapter.name : null;
      const lastName = this.lastSeenAdapter.get(tabId) || null;
      const shouldInjectAdapter = !hasPriorUserTurn || currentName !== lastName;
      this.lastSeenAdapter.set(tabId, currentName);
      if (adapter && shouldInjectAdapter) {
        const heading = adapter.category === 'finance'
          ? `[Site guidance for ${adapter.name} — FINANCE / HIGH-STAKES]`
          : `[Site guidance for ${adapter.name}]`;
        contextLine += `${heading}\n${adapter.notes.trim()}\n\n`;
      }
    }

    if (hasPriorUserTurn) return { role: 'user', content: contextLine + userMessage };

    // Determine vision capability: either a dedicated vision model is
    // configured (routes screenshots there, text to main), or the main
    // provider itself supports images. Without either, plain text context.
    const provider = this.providerManager.getActive();
    const visionProvider = await this.providerManager.getVisionProvider();
    if (!provider.supportsVision && !visionProvider) {
      return { role: 'user', content: contextLine + userMessage };
    }

    const shot = await this._captureAutoScreenshot(tabId);
    if (!shot) return { role: 'user', content: contextLine + userMessage };

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
    const screenshotNote = `[Initial viewport screenshot follows. The image is ${shot.width}×${shot.height} pixels and represents the visible viewport at a 1:1 CSS-pixel coordinate system — a click at image pixel (X, Y) corresponds exactly to a click tool call with x=X, y=Y. Prefer selector-based clicks (call get_interactive_elements first) when possible; only use coordinates as a last resort.]\n\n`;

    return {
      role: 'user',
      content: [
        { type: 'text', text: contextLine + screenshotNote + userMessage },
        { type: 'image_url', image_url: { url: shot.dataUrl } },
      ],
    };
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
   * Compose the full system prompt: base (ASK or ACT) + optional universal
   * cookie/paywall guidance + optional user profile block. Base goes
   * first so prompt-cache prefixes stay stable when user toggles settings.
   */
  _buildSystemPrompt(mode) {
    let prompt = mode === 'act' ? SYSTEM_PROMPT_ACT : SYSTEM_PROMPT_ASK;
    if (this.useSiteAdapters) {
      prompt += `\n\n${UNIVERSAL_PREAMBLE.trim()}`;
    }
    if (this.profileEnabled && this.profileText && this.profileText.trim()) {
      prompt +=
        `\n\n[User profile — use these details when a form or signup needs them, INSTEAD of asking the user. The user has opted in to sharing this with you. Do NOT volunteer these details on pages that don't need them, and NEVER reveal the password in chat output or screenshots. Treat it as sensitive.]\n` +
        this.profileText.trim();
    }
    if (this.captchaSolverEnabled) {
      prompt += `\n\n[CAPTCHA SOLVER — the user has configured CapSolver. When a CAPTCHA blocks a step, call \`solve_captcha\` once (with no arguments — it auto-detects reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile). On success, click the form's submit button and continue. On failure, ask the user to solve it manually — do not retry solve_captcha repeatedly.]`;
    }
    return prompt;
  }

  _refreshSystemPrompts() {
    for (const [tabId, messages] of this.conversations) {
      if (!messages || messages[0]?.role !== 'system') continue;
      const mode = this._conversationMode || 'ask';
      messages[0].content = this._buildSystemPrompt(mode);
    }
  }

  getConversation(tabId, mode = 'ask') {
    if (!this.conversations.has(tabId)) {
      this.conversations.set(tabId, [
        { role: 'system', content: this._buildSystemPrompt(mode) },
      ]);
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
    if (this._conversationMode !== mode) {
      const messages = this.conversations.get(tabId);
      if (messages[0]?.role === 'system') {
        messages[0].content = this._buildSystemPrompt(mode);
      }
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
    this.conversationIds.delete(tabId); // next getConversation() mints a fresh id
    if (this._doneBlockCount) this._doneBlockCount.delete(tabId);
    this._clearLoopState(tabId);
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
  //
  // Firefox port note: ported from chrome/agent.js. Firefox conversations
  // are in-memory only (no chrome.storage.session persistence), so this
  // implementation skips the post-write _persist call.

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

    // Strategy: keep system prompt + summarize old messages + keep recent messages
    const systemMsg = messages[0]; // always the system prompt
    // Pin the scratchpad alongside system so the model's self-written notes
    // survive summarization. Stripped from old/recent slices below to avoid
    // duplicating it during rebuild.
    const scratchpadIdx = this._findScratchpadIndex(messages);
    const scratchpadMsg = scratchpadIdx >= 0 ? messages[scratchpadIdx] : null;
    const keepRecent = 16; // keep last N messages verbatim
    const oldMessagesRaw = messages.slice(1, -keepRecent);
    const recentMessagesRaw = messages.slice(-keepRecent);
    const oldMessages = oldMessagesRaw.filter(m => !this._isScratchpadMessage(m));
    const recentMessages = recentMessagesRaw.filter(m => !this._isScratchpadMessage(m));

    if (oldMessages.length < 4) return; // not enough to summarize

    // Build a summary of old messages
    let summaryText = 'Previous conversation summary:\n';
    for (const msg of oldMessages) {
      if (msg.role === 'user') {
        summaryText += `- User asked: ${this._truncate(msg.content, 120)}\n`;
      } else if (msg.role === 'assistant' && msg.content && !msg.tool_calls) {
        summaryText += `- Assistant answered: ${this._truncate(msg.content, 150)}\n`;
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        const toolNames = msg.tool_calls.map(tc => tc.function?.name).join(', ');
        summaryText += `- Assistant used tools: ${toolNames}\n`;
      }
      // Skip tool result messages in summary (too verbose)
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

    // Rebuild: system + scratchpad (if any) + summary + recent
    const summaryMsg = { role: 'user', content: `[Context window was trimmed. ${summaryText}]` };
    const summaryAck = { role: 'assistant', content: 'Understood, I have the conversation context. Continuing.' };

    messages.length = 0;
    messages.push(systemMsg);
    if (scratchpadMsg) messages.push(scratchpadMsg);
    messages.push(summaryMsg, summaryAck, ...recentMessages);

    console.log(`[WebBrain] Context trimmed for tab ${tabId}: ${oldMessages.length} old messages → summary. ${messages.length} messages remain.`);
  }

  _truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
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
   * `provider` (optional): if `provider.supportsVision` is false, force
   * keep=0 so ALL images are stripped. Protects against "user had vision
   * on, captured screenshots, then unchecked the vision checkbox" — the
   * stale image_url blocks would otherwise 500 a text-only endpoint.
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
      content: '[Context was too large for the model. Older messages were removed. Please continue based on what you can see.]',
    };
    const ack = {
      role: 'assistant',
      content: 'Understood, some earlier context was trimmed. I\'ll continue with what I have.',
    };

    messages.length = 0;
    messages.push(systemMsg);
    if (scratchpadMsg) messages.push(scratchpadMsg);
    messages.push(notice, ack, ...recent);

    console.log(`[WebBrain] Emergency context trim: kept ${messages.length} messages.`);
  }

  /**
   * Execute a tool call by dispatching to the content script or chrome APIs.
   *
   * `onUpdate` is optional and only consumed by tools that need to talk
   * back to the side panel mid-call (currently just `clarify`).
   */
  async executeTool(tabId, name, args, onUpdate = null) {
    // clarify: pause the run and wait for the user to answer. This tool
    // does NOT touch the page — it's a meta-action that bridges agent ↔
    // user. The handler resolves when background.js routes the user's
    // response via submitClarifyResponse(), or when abort/clearConversation
    // cancels.
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
      await browser.tabs.update(tabId, { url: args.url });
      // Wait a moment for navigation
      await new Promise(r => setTimeout(r, 2000));
      return { success: true, url: args.url };
    }

    if (name === 'new_tab') {
      const createProps = { url: args.url };
      let sourceTab = null;
      try {
        sourceTab = await browser.tabs.get(tabId);
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
      const tab = await browser.tabs.create(createProps);
      // Drop the new tab into the per-window WebBrain group so research
      // chains stay visually together. Best-effort — graceful skip on
      // Firefox <142 (no tabGroups API) via the helper's internal guard.
      const groupId = await this._addToWebBrainGroup(sourceTab, tab.id);
      return {
        success: true,
        tabId: tab.id,
        url: args.url,
        groupId: groupId >= 0 ? groupId : null,
      };
    }

    if (name === 'screenshot') {
      try {
        // Get the tab's window to capture. Firefox captureVisibleTab takes
        // a windowId and snapshots whatever's currently visible in that
        // window — not the tab we ask for. If the agent's tab isn't the
        // active tab, refuse rather than capture an unrelated page.
        const tab = await browser.tabs.get(tabId);
        if (!tab?.active) {
          return {
            success: false,
            error: 'Cannot capture screenshot: this tab is not the active tab in its window. Switch to the tab to take a screenshot, or use a different tool.',
          };
        }
        // Probe the page for layout + text-volume hints BEFORE capture.
        // documentTextChars + visibleTextChars let the model detect cases
        // where a JPEG looks blank (mid-lazy-load) but the page actually
        // has thousands of chars of text — the trace where scroll'd CNN
        // misread "blank screenshot" as "page is empty".
        let probe = null;
        try {
          const probeCode = `
            (() => {
              let documentTextChars = 0;
              let visibleTextChars = 0;
              try { documentTextChars = (document.body && document.body.innerText || '').length; } catch (e) {}
              try {
                const sels = 'p, h1, h2, h3, h4, h5, h6, li, td, blockquote, article, section, [role="article"]';
                const els = document.querySelectorAll(sels);
                const vw = window.innerWidth, vh = window.innerHeight;
                for (let i = 0; i < els.length; i++) {
                  const r = els[i].getBoundingClientRect();
                  if (r.bottom < 0 || r.top > vh) continue;
                  if (r.right < 0 || r.left > vw) continue;
                  if (r.width === 0 || r.height === 0) continue;
                  visibleTextChars += (els[i].innerText || '').length;
                  if (visibleTextChars > 20000) break;
                }
              } catch (e) {}
              return {
                url: location.href,
                title: document.title || '',
                readyState: document.readyState,
                scrollX: Math.round(window.scrollX || 0),
                scrollY: Math.round(window.scrollY || 0),
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                scrollHeight: Math.round((document.documentElement && document.documentElement.scrollHeight) || document.body.scrollHeight || 0),
                documentTextChars,
                visibleTextChars,
              };
            })()
          `;
          const probeResults = await browser.tabs.executeScript(tabId, { code: probeCode });
          probe = (probeResults && probeResults[0]) || null;
        } catch (_) { /* probe failures are non-fatal */ }
        const rawUrl = await this._withIndicatorsHidden(tabId, () =>
          browser.tabs.captureVisibleTab(tab.windowId, {
            format: 'png',
            quality: 80,
          })
        );
        // Shrink to the vision budget before handing the image to the
        // model. Same two-stage dance as Chrome: decode → pick target dims
        // → draw at target → iterative JPEG quality until bytes fit.
        const shrunk = await this._shrinkImageForBudget(rawUrl, 0, 0);
        const dataUrl = shrunk.dataUrl;
        const description = `Screenshot captured (${dataUrl.length} base64 chars, ${shrunk.width}×${shrunk.height})`;

        // Route the image through whichever vision path is actually wired up.
        // Returning a bare `{image: dataUrl}` blob looks like success but
        // gets truncated inside _limitToolResult and never reaches the model
        // as a decodable image_url block — the text-only model then
        // hallucinates what's on screen.
        const provider = this.providerManager.getActive();
        const visionProvider = await this.providerManager.getVisionProvider();

        if (visionProvider) {
          const desc = await this._describeScreenshot(tabId, dataUrl, 'screenshot_tool');
          if (desc) {
            return {
              success: true,
              method: 'vision_describe',
              description: `[Screenshot described by vision model ${desc.model}]\n${desc.text}`,
              page: probe || undefined,
            };
          }
        }

        if (provider?.supportsVision) {
          // The batch loop will strip `_attachImage` before stringifying and
          // push the image on a follow-up user message as an image_url block.
          return {
            success: true,
            method: 'image_attach',
            description,
            page: probe || undefined,
            _attachImage: dataUrl,
          };
        }

        return {
          success: false,
          error: 'This model cannot see images: it has no vision capability and no dedicated vision model is configured. Enable "Model supports vision" for the active provider or set a vision model. For now, use get_accessibility_tree, get_interactive_elements, or read_page.',
        };
      } catch (e) {
        return { success: false, error: `Screenshot failed: ${e.message}` };
      }
    }

    if (name === 'done') {
      // In act mode, require a verification screenshot + page info before completing.
      const mode = this.conversationModes.get(tabId) || 'ask';
      if (mode === 'act') {
        try {
          const tab = await browser.tabs.get(tabId);
          if (tab?.active) {
            // Probe page URL, title, and "work in progress" signals: open
            // dialogs/modals and visible forms. If any of these are present
            // while the model claims it created/added/saved/submitted, the
            // submit almost certainly didn't happen — e.g. the model
            // clicked a button that only OPENED the dialog, never the
            // Create/Submit button inside it.
            const probeCode = `
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
                const toasts = Array.from(document.querySelectorAll('[role=status],[role=alert],[aria-live]'))
                  .filter(visible)
                  .map(e => (e.innerText || '').trim().slice(0, 120))
                  .filter(Boolean);
                return {
                  url: location.href,
                  title: document.title,
                  openDialogCount: dialogs.length,
                  dialogTitles: dialogs.map(d => {
                    const h = d.querySelector('h1,h2,h3,[role=heading]');
                    return (h ? (h.innerText || '') : (d.getAttribute('aria-label') || '')).trim().slice(0, 80);
                  }).filter(Boolean),
                  visibleFormCount: forms.length,
                  liveRegionMessages: toasts,
                };
              })()
            `;
            const results = await browser.tabs.executeScript(tabId, { code: probeCode });
            const pageState = (results && results[0]) || {};
            const dataUrl = await this._withIndicatorsHidden(tabId, () =>
              browser.tabs.captureVisibleTab(tab.windowId, { format: 'png', quality: 80 })
            );

            // Synthesize a warning when summary claims completion but page
            // state contradicts it.
            let completionWarning = null;
            const summaryLower = String(args.summary || '').toLowerCase();
            const claimsCompletion = /\b(created|added|saved|submitted|posted|published|sent|done|completed|finished)\b/.test(summaryLower);
            if (claimsCompletion) {
              if (pageState.openDialogCount > 0 || pageState.visibleFormCount > 0) {
                const titlesStr = pageState.dialogTitles && pageState.dialogTitles.length
                  ? ` (dialog titles: ${pageState.dialogTitles.map(t => '"' + t + '"').join(', ')})`
                  : '';
                completionWarning = `WARNING: Your summary claims the task was completed, but a ${pageState.openDialogCount > 0 ? 'modal/dialog' : 'form'} is still visible on the page${titlesStr}. This usually means the submit/save button was never clicked. Before calling done again, actually submit the form (click the primary action button like "Save", "Create", "Submit", or press Enter in the form) and verify a success indicator: a URL change away from the create/edit path, a toast/confirmation message, or the form/dialog disappearing. Do NOT claim success without this evidence.`;
              } else if ((!pageState.liveRegionMessages || pageState.liveRegionMessages.length === 0) && pageState.url && /[?&](create|edit|new)\b/i.test(pageState.url)) {
                completionWarning = `WARNING: Your summary claims the task was completed, but the URL still contains a create/edit query parameter (${pageState.url}) and no success message is visible. Verify the submit actually happened before finishing.`;
              }
            }

            // If completionWarning fires, DO NOT terminate. Return a failed
            // tool result so the agent loop continues and the model must
            // actually submit (and verify) before it can call done again.
            // Track how many times we've blocked on this tab so the model
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
                  pageUrl: pageState.url || '',
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
                pageUrl: pageState.url || '',
                pageTitle: pageState.title || '',
                screenshot: dataUrl,
                pageState,
                completionWarning,
                note: 'Review this screenshot carefully. Does it confirm the task was completed successfully? If the page shows an existing item from the past (check dates), you may NOT have actually created anything new.' + (completionWarning ? ' ' + completionWarning : ''),
              },
            };
          }
        } catch (_) {
          // Screenshot failed — still allow done but note it
        }
      }
      return { done: true, summary: args.summary };
    }

    // Network & download tools (background context). fetchUrl/readDownloadedFile
    // attach the user's cookies only for fetches that share the registrable
    // domain (eTLD+1) of the active tab — see network-tools.js for cookie &
    // redirect policy.
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
    if (name === 'download_files') {
      return await downloadFiles(args);
    }

    // ─── CAPTCHA solver ──────────────────────────────────────────────
    // Only meaningfully wired when the user has enabled CapSolver in
    // Settings. We re-check on every call so flipping the toggle or
    // rotating the key takes effect without a restart.
    if (name === 'solve_captcha') {
      try {
        const stored = await browser.storage.local.get(['captchaSolverEnabled', 'capsolverApiKey']);
        if (!stored.captchaSolverEnabled) {
          return { success: false, error: 'CapSolver is not enabled. Ask the user to enable it in Settings → CAPTCHA, or fall back to asking them to solve the captcha manually.' };
        }
        const apiKey = (stored.capsolverApiKey || '').trim();
        if (!apiKey) {
          return { success: false, error: 'CapSolver is enabled but no API key is configured. Ask the user to set one in Settings → CAPTCHA, or fall back to asking them to solve the captcha manually.' };
        }

        let websiteURL = '';
        try {
          const tab = await browser.tabs.get(tabId);
          websiteURL = tab?.url || '';
        } catch {}

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

    if (name === 'download_social_media') {
      try {
        // Inject the SocialMediaDownloader library into the page (isolated
        // content-script world — Firefox MV2 has no MAIN-world option for
        // executeScript). The script defines window.SocialMediaDownloader,
        // which subsequent executeScript calls in the same tab can reach.
        // Idempotent across reinjection.
        await browser.tabs.executeScript(tabId, {
          file: 'src/agent/social-media-downloader.js',
        });
        const opts = {
          mode: args.mode || 'auto',
          all: !!args.scroll,
          limit: typeof args.limit === 'number' && args.limit > 0
            ? args.limit
            : Number.MAX_SAFE_INTEGER,
        };
        const code = `
          (async () => {
            if (!window.SocialMediaDownloader) {
              return { success: false, error: 'SocialMediaDownloader did not load on this page (likely a page CSP block).' };
            }
            try {
              const runResult = await window.SocialMediaDownloader.run(${JSON.stringify(opts)});
              // v4: run() now returns { urls, stats }. Tolerate older
              // injections still returning just the URL array.
              const urls = Array.isArray(runResult)
                ? runResult
                : (runResult && runResult.urls) || [];
              const stats = (runResult && runResult.stats) || null;
              const profile = window.SocialMediaDownloader._activeProfile().name;
              // Total bytes the document_start MSE recorder captured for
              // this page. Feeds the recommendation builder so we can
              // tell the agent to call saveMse() when there's actually
              // a capture worth saving.
              let mseBytes = 0;
              try {
                const rec = window.SocialMediaDownloader.getMseRecording();
                for (const ms of (rec.mediaSources || [])) {
                  for (const b of (ms.buffers || [])) mseBytes += (b.bytes || 0);
                }
                for (const b of (rec.orphanBuffers || [])) mseBytes += (b.bytes || 0);
              } catch (_) {}
              // If the MSE recorder captured bytes, save them inline rather
              // than asking the agent to call execute_js → saveMse() in a
              // follow-up step. The follow-up pattern was broken by the
              // extension's own CSP (no \`unsafe-eval\`), and "28 MB captured
              // but won't save" was a head-scratcher. Now download_social_media
              // is a single call that completes the save end-to-end.
              let mseSavedFiles = [];
              let mseSaveError = null;
              if (mseBytes > 0) {
                try {
                  mseSavedFiles = await window.SocialMediaDownloader.saveMse({
                    prefix: (window.location && window.location.hostname || 'mse').replace(/^www\\./, ''),
                    mode: ${JSON.stringify(opts.mode)},
                  });
                } catch (e) {
                  mseSaveError = (e && e.message) || String(e);
                }
              }
              const recommendation = window.SocialMediaDownloader._buildRecommendation({
                urls, profile, mseBytes, mseSavedFiles, mseSaveError, pageUrl: location.href,
              });
              // Honest per-status counts. Roll mse-saved files into the
              // completed count so the agent sees one consistent number.
              const completedFromStats = stats ? stats.completed : 0;
              const mseSavedCount = mseSavedFiles.length;
              return {
                success: true,
                site: profile,
                mode: ${JSON.stringify(opts.mode)},
                count: urls.length + mseSavedCount,
                triggeredCount: (stats ? stats.triggered : urls.length) + mseSavedCount,
                completedCount: completedFromStats + mseSavedCount,
                openedInTabCount: stats ? stats.openedInTab : null,
                failedCount: stats ? stats.failed : null,
                failures: stats ? stats.failures : [],
                urls: urls.slice(0, 50),
                mseBytes,
                mseSavedFiles,
                ...(mseSaveError ? { mseSaveError } : {}),
                recommendation,
              };
            } catch (e) {
              return { success: false, error: (e && e.message) || String(e) };
            }
          })()
        `;
        const results = await browser.tabs.executeScript(tabId, { code });
        const result = (results && results[0]) || null;
        if (!result) {
          return { success: false, error: 'download_social_media: no result returned (tab may have navigated away).' };
        }
        return result;
      } catch (e) {
        return { success: false, error: `download_social_media failed: ${e.message}` };
      }
    }

    // ─── PDF reader ───────────────────────────────────────────────────
    // Firefox's built-in PDF viewer is a privileged page that our content
    // scripts cannot reach, so click / read_page / get_ax all silently
    // no-op against PDF tabs and the agent click-loops on the viewer
    // chrome. read_pdf bypasses the viewer entirely: fetches the binary,
    // parses it with the bundled pdfjs-dist, returns text.
    if (name === 'read_pdf') {
      try {
        let pdfUrl = String(args.url || '').trim();
        if (!pdfUrl) {
          try {
            const tab = await browser.tabs.get(tabId);
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

        // Tier 2 — Anthropic Claude PDF passthrough.
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

        if (!result.hasExtractableText) {
          result.note = 'This PDF appears to have no extractable text layer (likely scanned images). Consider enabling a vision model and using full_page_screenshot, or asking the user for a text-based version.';
        }

        return { ...result, method: 'pdf_text' };
      } catch (e) {
        return { success: false, error: `read_pdf failed: ${e.message}` };
      }
    }

    if (name === 'scratchpad_write') {
      return this._scratchpadWrite(tabId, args);
    }

    if (name === 'verify_form') {
      try {
        const code = `
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
        `;
        const results = await browser.tabs.executeScript(tabId, { code });
        const result = (results && results[0]) || { found: false, error: 'Script returned no data' };

        // Capture screenshot (requires active tab)
        try {
          const tab = await browser.tabs.get(tabId);
          if (tab?.active) {
            result.image = await this._withIndicatorsHidden(tabId, () =>
              browser.tabs.captureVisibleTab(tab.windowId, { format: 'png', quality: 80 })
            );
          } else {
            result.screenshotFailed = true;
          }
        } catch {
          result.screenshotFailed = true;
        }

        result.success = !!result.found;
        return result;
      } catch (e) {
        return { success: false, error: `verify_form failed: ${e.message}` };
      }
    }

    // Iframe tools — use browser.tabs.executeScript with allFrames:true.
    // Extensions with <all_urls> permission can inject into any frame
    // regardless of origin, bypassing the same-origin policy.
    if (name === 'iframe_read') {
      try {
        const urlFilter = args.urlFilter || '';
        const selector = args.selector || 'body';
        const code = `
          (() => {
            try {
              const el = document.querySelector(${JSON.stringify(selector)});
              return {
                ok: !!el,
                url: location.href,
                title: document.title || '',
                text: el ? (el.innerText || '').slice(0, 4000) : '',
                html: el ? (el.innerHTML || '').slice(0, 4000) : '',
                tag: el ? el.tagName : null,
              };
            } catch (e) { return { ok: false, url: location.href, error: e.message }; }
          })()
        `;
        const results = await browser.tabs.executeScript(tabId, { code, allFrames: true });
        const frames = (results || []).filter(r => r && (!urlFilter || (r.url && r.url.includes(urlFilter))));
        return { success: true, frameCount: frames.length, frames };
      } catch (e) {
        return { success: false, error: `Iframe read failed: ${e.message}` };
      }
    }

    if (name === 'iframe_click') {
      try {
        const urlFilter = args.urlFilter || '';
        const selector = args.selector;
        if (!selector) return { success: false, error: 'selector is required' };
        const code = `
          (() => {
            const filter = ${JSON.stringify(urlFilter)};
            if (filter && !location.href.includes(filter)) return { ok: false, skipped: 'url-filter', url: location.href };
            try {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { ok: false, url: location.href, reason: 'not-found' };
              el.scrollIntoView({ block: 'center', inline: 'center' });
              const rect = el.getBoundingClientRect();
              const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, button: 0 };
              try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.click();
              return { ok: true, url: location.href, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80) };
            } catch (e) { return { ok: false, url: location.href, error: e.message }; }
          })()
        `;
        const results = await browser.tabs.executeScript(tabId, { code, allFrames: true });
        const successes = (results || []).filter(r => r && r.ok);
        if (successes.length > 0) return { success: true, method: 'iframe-click', frame: successes[0] };
        const candidates = (results || []).filter(r => r && !r.skipped);
        return { success: false, error: 'Element not found in any matching iframe', searchedFrames: candidates.length, frameUrls: candidates.map(c => c.url).slice(0, 5) };
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
        const code = `
          (() => {
            const filter = ${JSON.stringify(urlFilter)};
            if (filter && !location.href.includes(filter)) return { ok: false, skipped: 'url-filter', url: location.href };
            try {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { ok: false, url: location.href, reason: 'not-found' };
              el.focus();
              if (el.isContentEditable) {
                if (${clear}) el.textContent = '';
                el.textContent += ${JSON.stringify(text)};
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
                return { ok: true, url: location.href, method: 'contenteditable', value: el.textContent.slice(0, 100) };
              }
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              const newVal = (${clear} ? '' : (el.value || '')) + ${JSON.stringify(text)};
              if (setter) setter.call(el, newVal); else el.value = newVal;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, url: location.href, method: 'native-setter', value: (el.value || '').slice(0, 100) };
            } catch (e) { return { ok: false, url: location.href, error: e.message }; }
          })()
        `;
        const results = await browser.tabs.executeScript(tabId, { code, allFrames: true });
        const successes = (results || []).filter(r => r && r.ok);
        if (successes.length > 0) return { success: true, frame: successes[0] };
        const candidates = (results || []).filter(r => r && !r.skipped);
        return { success: false, error: 'Input not found in any matching iframe', searchedFrames: candidates.length, frameUrls: candidates.map(c => c.url).slice(0, 5) };
      } catch (e) {
        return { success: false, error: `Iframe type failed: ${e.message}` };
      }
    }

    // Map tool names to content script actions
    const actionMap = {
      'read_page': 'get_page_info_cdp',
      'get_interactive_elements': 'get_interactive_elements_cdp',
      'get_shadow_dom': 'get_shadow_dom',
      'get_frames': 'get_frames',
      'click': 'click',
      'type_text': 'type',
      'press_keys': 'press_keys',
      'scroll': 'scroll',
      'extract_data': 'extract_data',
      'wait_for_element': 'wait_for_element',
      'wait_for_stable': 'wait_for_stable',
      'get_selection': 'get_selection',
      'execute_js': 'execute_js',
      'get_accessibility_tree': 'get_accessibility_tree',
      'click_ax': 'click_ax',
      'type_ax': 'type_ax',
      'set_field': 'set_field',
      // hover + drag_drop are content-script-only on Firefox (no CDP).
      // The handlers in content.js do the synthetic-event work.
      'hover': 'hover',
      'drag_drop': 'drag_drop',
    };

    const action = actionMap[name];
    if (!action) {
      return { error: `Unknown tool: ${name}` };
    }

    // ── Normalized-coord guard for click({x, y}) ────────────────────────
    // Some models pass {x: 0.91, y: 0.33} thinking coords are normalized
    // (0–1 fractions of the viewport). The click handler takes CSS pixels
    // — so 0.91 hits the very top-left of the page, the click misses, the
    // model retries the same values, and we burn 8 attempts before the
    // coord-loop detector trips. Reject up front so the model pivots to
    // click_ax / click({text}) on the first try.
    if (name === 'click' && args?.x != null && args?.y != null) {
      const xn = Number(args.x);
      const yn = Number(args.y);
      if (Number.isFinite(xn) && Number.isFinite(yn) && xn >= 0 && xn <= 1 && yn >= 0 && yn <= 1) {
        return {
          success: false,
          error: `Coordinates (${args.x}, ${args.y}) look like normalized values (0–1 fractions of the viewport), not CSS pixels. The click tool expects CSS pixels (e.g. {x: 437, y: 156}). Prefer click_ax({ref_id}) after get_accessibility_tree or click({text: "..."}) over pixel clicks — they don't depend on screenshot resolution. If you must use pixels, take a fresh screenshot and pass integer pixel coordinates from the image.`,
        };
      }
    }

    // PDF redirect. Firefox's built-in PDF viewer is a privileged page
    // we cannot reach via content scripts — read_page / click /
    // get_accessibility_tree silently no-op. Redirect read_page to
    // read_pdf, and reject action tools with a clear error.
    try {
      const tabForPdfCheck = await browser.tabs.get(tabId);
      const pageUrl = tabForPdfCheck?.url || '';
      // _isPdfTab does sync URL-pattern match + credentialed HEAD
      // fallback so PDFs served from extension-less paths (e.g.
      // `/download?id=42` with `Content-Type: application/pdf`) are
      // also caught. Cached per (tabId, pageUrl).
      if (await this._isPdfTab(tabId, pageUrl)) {
        if (name === 'read_page') {
          const pdfResult = await this.executeTool(tabId, 'read_pdf', { url: pageUrl });
          return {
            ...pdfResult,
            redirectedFrom: 'read_page',
            warning: 'This tab is a PDF — Firefox\'s PDF viewer is a privileged page that content scripts can\'t inject into, so read_page would have returned no content. Redirected to read_pdf which fetches the binary and extracts text directly. To read more pages call read_pdf again with fromPage / toPage.',
          };
        }
        if (
          name === 'click' || name === 'click_ax' ||
          name === 'type_text' || name === 'type_ax' || name === 'set_field' ||
          name === 'press_keys' || name === 'scroll' ||
          name === 'hover' || name === 'drag_drop' ||
          name === 'get_accessibility_tree' || name === 'get_interactive_elements' ||
          name === 'extract_data' || name === 'wait_for_element' || name === 'wait_for_stable' ||
          name === 'get_selection' || name === 'execute_js'
        ) {
          return {
            success: false,
            error: `${name} cannot be used on the browser's built-in PDF viewer (a privileged page our scripts cannot reach). Use read_pdf to extract the document's text instead. If you need to read a specific page, pass fromPage/toPage to read_pdf.`,
          };
        }
      }
    } catch { /* tab lookup failures are non-fatal — fall through */ }

    try {
      const response = await browser.tabs.sendMessage(tabId, {
        target: 'content',
        action,
        params: args,
      });
      this._annotateCredentialField(name, response);
      return response;
    } catch (e) {
      // Content script might not be injected — try injecting it
      try {
        await browser.tabs.executeScript(tabId, {
          file: 'src/content/content.js',
        });
        const response = await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action,
          params: args,
        });
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
      // — but only emit a model-facing `note` in STRICT mode. See chrome/
      // agent.js for rationale: mid-run nuanced hints confuse small models;
      // the done.summary description already carries the hygiene hint at
      // point-of-use. Strict mode is the explicit opt-in for paranoid
      // behaviour throughout the run.
      response.sensitiveField = true;
      response.sensitiveReason = det.reason;
      response.strictSecretMode = !!this.strictSecretMode;
      if (this.strictSecretMode) {
        response.note = CREDENTIAL_NOTE_STRICT;
      }
    } catch { /* never let detection failure break the tool call */ }
  }

  /**
   * Continue processing from where we left off (after max steps).
   */
  async continueProcessing(tabId, onUpdate = () => {}, mode = 'ask') {
    return this.processMessage(tabId, 'Please continue from where you left off.', onUpdate, mode);
  }

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
   * was found. Only tool names present in AGENT_TOOL_NAMES are accepted.
   */
  _tryParseToolCallsFromText(text) {
    if (!text || text.length > 10000) return [];

    const results = [];
    const patterns = [
      /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
      /<\|tool_call\|?>\s*([\s\S]*?)\s*<\|?\/?tool_call\|?>/gi,
      /<functioncall>\s*([\s\S]*?)\s*<\/functioncall>/gi,
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const inner = m[1].trim();
        // Try JSON first (most common).
        try {
          const obj = JSON.parse(inner);
          if (obj && obj.name && AGENT_TOOL_NAMES.has(obj.name)) {
            results.push(obj);
            continue;
          }
        } catch { /* not JSON — try call:name{} format below */ }

        // call:toolName{key:<|"|>value<|"|>, ...} format.
        const callMatch = /^call:(\w+)\s*\{([\s\S]*)\}$/.exec(inner);
        if (callMatch && AGENT_TOOL_NAMES.has(callMatch[1])) {
          const toolName = callMatch[1];
          let argsBody = callMatch[2]
            .replace(/<\|"\|>/g, '"')
            .replace(/<\|'\\?\|>/g, "'");
          argsBody = argsBody.replace(/(?<=^|,)\s*(\w+)\s*:/g, '"$1":');
          try {
            const args = JSON.parse(`{${argsBody}}`);
            results.push({ name: toolName, arguments: args });
          } catch {
            results.push({ name: toolName, arguments: {} });
          }
          continue;
        }
      }
    }

    // Fallback: scan for bare JSON objects containing a "name" key.
    if (results.length === 0) {
      const bareRe = /\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*\}/g;
      let m;
      while ((m = bareRe.exec(text)) !== null) {
        if (!AGENT_TOOL_NAMES.has(m[1])) continue;
        try {
          const obj = JSON.parse(m[0]);
          if (obj && obj.name && AGENT_TOOL_NAMES.has(obj.name)) {
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
        if (!AGENT_TOOL_NAMES.has(m[1])) continue;
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

  /**
   * Process a single user message — may trigger a multi-step tool-use loop.
   * @param {number} tabId
   * @param {string} userMessage
   * @param {function} onUpdate - callback(type, data) for streaming updates
   * @returns {Promise<string>} final text response
   */
  async processMessage(tabId, userMessage, onUpdate = () => {}, mode = 'ask') {
    const messages = this.getConversation(tabId, mode);

    // Trim context if it's getting too long
    await this._manageContext(tabId, messages);

    const enriched = await this._enrichUserMessageWithCurrentPage(tabId, messages, userMessage);
    messages.push(enriched);

    const provider = this.providerManager.getActive();
    const tools = getToolsForMode(mode, { strictSecretMode: this.strictSecretMode });
    const plannerTemperature = mode === 'act' ? 0.15 : 0.3;
    let steps = 0;
    let finalResponse = '';
    let _traceStatus = 'done';
    // Tracks whether we've already nudged the model after an empty
    // (no-content + no-tool-call) response. Prevents an infinite
    // empty→nudge→empty→nudge cycle.
    let emptyOutputRecoveryAttempted = false;

    this.abortFlags.delete(tabId); // clear any stale abort

    // Start trace run (gated inside recorder by tracingEnabled setting).
    let runId = null;
    try {
      let tabUrl = '', tabTitle = '';
      try {
        const tab = await browser.tabs.get(tabId);
        tabUrl = tab?.url || ''; tabTitle = tab?.title || '';
      } catch {}
      runId = await trace.startRun({
        model: provider.model,
        providerId: provider.name,
        providerClass: provider.constructor.name,
        userMessage: typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage).slice(0, 2000),
        tabUrl, tabTitle, mode,
        conversationId: this.conversationIds.get(tabId) || null,
      });
      if (runId) this.currentRunId.set(tabId, runId);
    } catch {}

    try {
    while (steps < this.maxSteps) {
      if (this._checkAbort(tabId)) {
        finalResponse = finalResponse || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

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
        const _llmStart = Date.now();
        if (runId) { try { await trace.recordLLMRequest(runId, steps, { providerClass: provider.constructor.name, model: provider.model, messageCount: prunedMessages.length, toolsCount: (chatOpts.tools || []).length }); } catch {} }
        result = await provider.chat(prunedMessages, chatOpts);
        if (runId) { try { await trace.recordLLMResponse(runId, steps, { content: result.content, toolCalls: result.toolCalls, usage: result.usage, latencyMs: Date.now() - _llmStart, model: provider.model }); } catch {} }
        this._logDebug({ type: 'llm_response', step: steps, content: result.content, toolCalls: result.toolCalls });
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
      // any signal of life (text or a tool call).
      if ((result.content && result.content.trim()) || (result.toolCalls && result.toolCalls.length > 0)) {
        emptyOutputRecoveryAttempted = false;
      }

      // Fallback: if the LLM emitted tool calls as raw text instead of
      // using the structured tool_calls field, try to parse them out.
      if ((!result.toolCalls || result.toolCalls.length === 0) && result.content) {
        const fallback = this._tryParseToolCallsFromText(result.content);
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
        continue;
      }

      // No tool calls. Detect the "empty output" failure mode (no text +
      // no tool call after non-trivial reasoning) and recover ONCE via a
      // summary-nudge before giving up.
      const isEmpty = !result.content || !result.content.trim();
      if (isEmpty) {
        if (!emptyOutputRecoveryAttempted) {
          emptyOutputRecoveryAttempted = true;
          messages.push({
            role: 'user',
            content: '[System nudge: your previous response had neither text nor a tool call. You may have run out of output budget on internal reasoning. In ONE short message, summarize what you accomplished, what you tried, and what blocked you — then stop. Do not start any new tool calls.]',
          });
          continue;
        }
        finalResponse = '[Agent emitted no output and no tool call, even after a recovery nudge. This usually means the task exceeded the current model\'s capability or context budget. Try a stronger model, raise the step limit in settings, or break the task into smaller parts.]';
        _traceStatus = 'empty_output';
        messages.push({ role: 'assistant', content: finalResponse });
        onUpdate('warning', { message: finalResponse });
        break;
      }
      finalResponse = result.content;
      messages.push({ role: 'assistant', content: finalResponse });
      onUpdate('text', { content: finalResponse });
      break;
    }

    if (steps >= this.maxSteps) {
      _traceStatus = 'max_steps';
      onUpdate('max_steps_reached', { steps: this.maxSteps });
      // Auto-done summary so the user sees WHY the run ended instead of
      // an empty `done` event.
      if (!finalResponse || !finalResponse.trim()) {
        finalResponse = this._buildStepLimitSummary(messages, steps);
        messages.push({ role: 'assistant', content: finalResponse });
        onUpdate('text', { content: finalResponse });
      }
    }

    return finalResponse;
    } finally {
      try {
        if (runId) {
          await trace.endRun(runId, { status: _traceStatus, finalContent: finalResponse });
          this.currentRunId.delete(tabId);
        }
      } catch {}
    }
  }

  /**
   * Process a message with streaming output.
   */
  async processMessageStream(tabId, userMessage, onUpdate = () => {}, mode = 'ask') {
    const messages = this.getConversation(tabId, mode);

    // Trim context if it's getting too long
    await this._manageContext(tabId, messages);

    const enriched = await this._enrichUserMessageWithCurrentPage(tabId, messages, userMessage);
    messages.push(enriched);

    const provider = this.providerManager.getActive();
    const tools = getToolsForMode(mode, { strictSecretMode: this.strictSecretMode });
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
          const fallback = this._tryParseToolCallsFromText(fullText);
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

        // No tool calls. Detect the "empty output" failure and recover
        // once via a summary-nudge; on second empty in a row, give up
        // with a transparent message instead of returning empty content.
        this._logDebug({ type: 'llm_stream_response', step: steps, content: fullText, toolCalls: null });
        if (!fullText || !fullText.trim()) {
          if (!emptyOutputRecoveryAttempted) {
            emptyOutputRecoveryAttempted = true;
            messages.push({
              role: 'user',
              content: '[System nudge: your previous response had neither text nor a tool call. You may have run out of output budget on internal reasoning. In ONE short message, summarize what you accomplished, what you tried, and what blocked you — then stop. Do not start any new tool calls.]',
            });
            continue;
          }
          const failMsg = '[Agent emitted no output and no tool call, even after a recovery nudge. This usually means the task exceeded the current model\'s capability or context budget. Try a stronger model, raise the step limit in settings, or break the task into smaller parts.]';
          messages.push({ role: 'assistant', content: failMsg });
          onUpdate('warning', { message: failMsg });
          return failMsg;
        }
        emptyOutputRecoveryAttempted = false;
        messages.push({ role: 'assistant', content: fullText });
        return fullText;

      } catch (e) {
        this._logDebug({ type: 'llm_stream_error', step: steps, error: e.message });
        // If context overflow, trim and retry
        if (this._isContextOverflow(e.message)) {
          onUpdate('thinking', { step: steps, note: 'Context too large, trimming...' });
          this._emergencyTrim(messages);
          continue; // retry the loop with trimmed context
        }
        onUpdate('error', { message: e.message });
        const errMsg = `Error: ${e.message}`;
        messages.push({ role: 'assistant', content: errMsg });
        return errMsg;
      }
    }

    onUpdate('max_steps_reached', { steps: this.maxSteps });
    // Synthesize a transparent summary of what was attempted instead of
    // a generic "reached maximum steps" line.
    const summary = this._buildStepLimitSummary(messages, steps);
    messages.push({ role: 'assistant', content: summary });
    onUpdate('text', { content: summary });
    return summary;
  }
}
