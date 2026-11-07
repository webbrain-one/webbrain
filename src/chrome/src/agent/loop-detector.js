import { URL_FAMILY_TOOLS, bucketArgsKey } from './loop-bucket.js';

// Error codes of a call the runtime refused because the run does not offer
// the named tool (retired, or outside the mode/provider tool set).
const UNAVAILABLE_TOOL_ERROR_CODES = new Set(['tool_unavailable', 'retired_tool']);
// How far apart (CSS px) two vision clicks may be and still count as the
// same point read off a screenshot (_checkCoordClickLoop).
const VISION_REPEAT_RADIUS_PX = 12;

/**
 * Browser-free loop detection used by Agent and the unit tests.
 *
 * Catches the agent stuck repeating an ineffective action or oscillating
 * between two calls. Cheap, runs after every tool execution. On first
 * detection we soft-nudge by injecting a [LOOP DETECTED] note into the
 * tool result the model sees. On second detection within the same loop,
 * we hard-stop the run with a clear final message.
 *
 * This module is deliberately browser-free so both extension builds and the
 * unit suite exercise the same production class. Subclasses supply the
 * browser-specific pieces: _isBrowserMutationTool() classifies tools, and
 * _clearPageLoopState() may be extended to clear related page-scoped state
 * alongside the detector's own maps.
 */
export class LoopDetector {
  constructor() {
    // Per-tab ring buffer of recent tool calls + nudge count.
    this.recentCalls = new Map(); // tabId -> [{ key, name, ts }]
    this.loopNudges = new Map();  // tabId -> consecutive-nudge counter
    this.healthyCallsSinceLoop = new Map(); // tabId -> count of clean calls since last nudge
    this.failedActionLoops = new Map(); // tabId -> Map(stable failure scope -> count)
    this.filePickerDiscoveries = new Map(); // tabId -> bounded Set(first guarded selector discoveries)
    // Last few normalized URLs each tab arrived at during the active run.
    // Deliberately NOT cleared by _clearLoopState: it gates those intra-run
    // resets, so it must survive them until the outer run boundary.
    this.recentNavUrls = new Map(); // tabId -> [normalized URL, ...]
    // A model can walk ref_1, ref_2, … forever while every call looks unique
    // to the exact-argument loop detector. Track that semantic read pattern.
    this.axReadStates = new Map(); // tabId -> { total, suspicious, nextPage, scopeKey, seenPages, warned }
    // Scroll calls can keep returning success even when no pane moved. Track
    // repeated dead-end attempts separately so changing the amount or
    // interleaving reads cannot evade the generic loop detector.
    this.noProgressScrolls = new Map(); // tabId -> { key, count }
    // Separate buffer for coordinate-based click attempts. The general loop
    // detector keys on the exact argument bucket, so when the model interleaves
    // execute_js with different code strings between clicks, the same
    // (x,y) click never accumulates to the threshold inside its window.
    // This buffer tracks ONLY coord clicks and survives any amount of
    // unrelated noise between them, catching the "click missing its target,
    // model retries forever" failure mode in 2-3 attempts instead of never.
    this.recentCoordClicks = new Map(); // tabId -> [{ key, ts }]
    // Verification overlays often allocate fresh accessibility ref ids every
    // time they are dismissed and reopened. Track their semantic identity
    // separately so ref churn and interleaved close/Continue calls cannot
    // disguise the same challenge loop.
    this.verificationChallengeStates = new Map(); // tabId -> { key, active, reopenCount }
    // Semantic carousel intent survives tool/selector/ref changes so a model
    // cannot hide Next/Previous ping-pong by alternating arrows, AX clicks,
    // screenshot points, and adapter navigation.
    this.carouselIntentStates = new Map(); // tabId -> { history, cycleCount }
    // Verified navigation can return to an unchanged page with a fresh
    // document, fresh refs and a fresh one-use nonce. This semantic state is
    // independent of document-scoped click/read/scroll history.
    this.semanticPageRetries = new Map();
    // Calls naming a tool the run does not offer, counted per name apart from
    // recentCalls: in that window a refusal would dilute or complete another
    // call's loop, and as a clean call it would retire a real loop's nudges.
    // A navigation does not make such a tool available, so only the run
    // boundary (or two clean calls in a row) clears it.
    this.unavailableToolCalls = new Map(); // tabId -> { counts: Map(name -> refusals), cleanCalls }
  }

  /**
   * Whether `toolName` mutates browser/page state, which gates the stricter
   * failed-action loop counters. Browser-neutral by default; each Agent build
   * overrides it with that build's real tool surface.
   */
  _isBrowserMutationTool(_toolName) {
    return false;
  }

  /**
   * What a call acted on beyond its arguments, added to its loop identity.
   * Browser-neutral by default; a vision run (vision-runtime.js) names the
   * screen, so the same point after the screen changed is a new call while a
   * repeat on an unchanged screen stays the same one.
   */
  _loopScreenIdentity(_tabId, _name, _args) {
    return '';
  }

  /** Whether loop advice should name vision tools (vision-runtime.js). */
  _loopVisionRun(_tabId) {
    return false;
  }

  /** The tool name the model used: a vision run's coordinate click is its click_at. */
  _loopToolLabel(tabId, name) {
    return name === 'click' && this._loopVisionRun(tabId) ? 'click_at' : name;
  }

  _isToolResultErroredForLoop(name, _args, result) {
    if (!result || typeof result !== 'object') return false;
    // A vision click on a native dropdown focuses it for type_text instead of
    // opening a popup no screenshot shows (vision-runtime.js): the designed
    // path for choosing an option, however often a form needs it, not a miss.
    if (result.nativeSelect === true && result.dispatched === false) return false;
    // A text write that went out but could not be read back exactly is an
    // advisory result (success with unverifiedWrite, see the agent's
    // text-write advisories), not a failed target: a content failureScope
    // such as 'field-value:<ref>' must not count it toward the stop.
    // Refusals and real errors are reported as failures and still count.
    if (result.success === true && result.unverifiedWrite === true && !result.error) return false;
    if (result.error || result.success === false || result.noProgress) return true;
    const status = Number(result.status);
    return URL_FAMILY_TOOLS.has(name) && Number.isFinite(status) && status >= 400;
  }

  _fetchUsesHttpByteRange(args) {
    if (!args?.headers || typeof args.headers !== 'object') return false;
    for (const [name, value] of Object.entries(args.headers)) {
      if (String(name).toLowerCase() === 'range' && /^\s*bytes\s*=/i.test(String(value || ''))) {
        return true;
      }
    }
    return false;
  }

  _findTextMatchLoopIdentity(result) {
    if (result?.success !== true || result?.verified === false || !result?.rect || typeof result.rect !== 'object') return '';
    const rect = result.rect;
    const pageX = typeof rect.pageX === 'number' ? rect.pageX : NaN;
    const pageY = typeof rect.pageY === 'number' ? rect.pageY : NaN;
    const viewportX = typeof rect.x === 'number' ? rect.x : NaN;
    const viewportY = typeof rect.y === 'number' ? rect.y : NaN;
    const width = typeof rect.width === 'number' ? rect.width : NaN;
    const height = typeof rect.height === 'number' ? rect.height : NaN;
    const x = Number.isFinite(pageX) ? pageX : viewportX;
    const y = Number.isFinite(pageY) ? pageY : viewportY;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return '';
    let selectionIdentity = 'document';
    if (result.selectionSource === 'text_control') {
      const selectionStart = result.selectionStart;
      const selectionEnd = result.selectionEnd;
      if (
        !Number.isInteger(selectionStart)
        || !Number.isInteger(selectionEnd)
        || selectionStart < 0
        || selectionEnd <= selectionStart
      ) return '';
      selectionIdentity = `text_control:${selectionStart}:${selectionEnd}`;
    }
    const rectIdentity = [x, y, width, height]
      .map(value => Math.round(value * 2) / 2)
      .join(',');
    return `${selectionIdentity}|${rectIdentity}`;
  }

  _noteHealthyLoopCall(tabId) {
    // Do not reset the nudge counter immediately: one healthy call between
    // two stuck actions must not launder the surrounding loop.
    const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
    this.healthyCallsSinceLoop.set(tabId, healthy);
    if (healthy >= 2) {
      this.loopNudges.delete(tabId);
      this.healthyCallsSinceLoop.delete(tabId);
    }
    // Two clean calls with no refusal between them likewise retire repeated
    // unavailable-tool calls; each refusal restarts this count.
    const refusals = this.unavailableToolCalls.get(tabId);
    if (refusals && ++refusals.cleanCalls >= 2) this.unavailableToolCalls.delete(tabId);
    return { kind: 'none' };
  }

  /**
   * A call naming a tool the run does not offer was refused before anything
   * ran, so its arguments never reached a page target or URL and only the
   * name identifies a repeat. It never enters recentCalls, the healthy streak
   * or the per-target and read-only resource counters. The third refusal of
   * one name is nudged and the tenth stops the run, the budget of an exact
   * repeat of any other call.
   */
  _checkUnavailableToolLoop(tabId, toolName, toolResult) {
    const name = String(toolName || '').slice(0, 80);
    const state = this.unavailableToolCalls.get(tabId) || { counts: new Map(), cleanCalls: 0 };
    const count = (state.counts.get(name) || 0) + 1;
    state.counts.set(name, count);
    if (state.counts.size > 16) state.counts.delete(state.counts.keys().next().value);
    state.cleanCalls = 0;
    this.unavailableToolCalls.set(tabId, state);
    const reason = toolResult?.errorCode === 'retired_tool' ? 'it is retired' : 'this run does not offer it';
    if (count >= 10) {
      this._clearLoopState(tabId);
      this.unavailableToolCalls.delete(tabId);
      return {
        kind: 'stop',
        message: `Stopped: I called ${name} ${count} times, but ${reason}, so nothing was run. Please give a different instruction.`,
      };
    }
    if (count >= 3) {
      return {
        kind: 'nudge',
        warning: `[UNAVAILABLE TOOL LOOP: You have called ${name} ${count} times, but ${reason}, so nothing was run. Do not call ${name} again. Use only the advertised tools; if they cannot do what the task needs, finish with what you have and say what is missing.]`,
      };
    }
    return { kind: 'none' };
  }

  _loopCallKey(name, args, result) {
    if (result?.nonRetryableScope) {
      // Definitive platform/permission failures keep one identity across
      // tools and URL variants, so changing fetch strategies cannot evade
      // the stop condition.
      return `nonretryable|${String(result.nonRetryableScope).slice(0, 240)}|err`;
    }
    const checkboxState = result?.checkboxState;
    if (
      checkboxState
      && typeof checkboxState.desiredChecked === 'boolean'
      && typeof checkboxState.actualChecked === 'boolean'
      && checkboxState.desiredChecked !== checkboxState.actualChecked
    ) {
      const identity = String(
        checkboxState.identity
        || result.checkboxIdentity
        || result.ref_id
        || '',
      ).trim().slice(0, 240);
      if (identity) {
        return `checkbox|${identity}|desired:${checkboxState.desiredChecked}|actual:${checkboxState.actualChecked}`;
      }
    }
    // URL-family tools (fetch_url, research_url, …) bucket by resource
    // identity so the agent can't escape loop detection by fetching the
    // same logical file via 8 different API endpoints. See loop-bucket.js.
    const errored = this._isToolResultErroredForLoop(name, args, result);
    const argsHash = bucketArgsKey(name, args);
    if (name === 'chat_observe' && !errored && result?.success === true
        && result.threadKey && result.chatWorkflow?.threadKey === result.threadKey) {
      const deltaIds = (Array.isArray(result.chatWorkflow.newMessages) ? result.chatWorkflow.newMessages : [])
        .slice(-20).map(message => String(message?.id || '').slice(0, 80)).filter(Boolean);
      const deliveryId = result.chatDeliveryVerification?.threadKey === result.threadKey
        ? String(result.chatDeliveryVerification.messageId || '').slice(0, 80) : '';
      if (deltaIds.length || deliveryId) {
        return `${name}|${argsHash}|thread:${String(result.threadKey).slice(0, 120)}|delta:${JSON.stringify(deltaIds)}|delivery:${deliveryId}`;
      }
    }
    if (name === 'find_text' && !errored) {
      const matchIdentity = this._findTextMatchLoopIdentity(result);
      if (matchIdentity) return `${name}|${argsHash}|match:${matchIdentity}`;
    }
    return `${name}|${argsHash}|${errored ? 'err' : 'ok'}`;
  }

  _recordCall(tabId, name, args, result) {
    const screen = this._loopScreenIdentity(tabId, name, args);
    const key = this._loopCallKey(name, args, result) + (screen ? `|screen:${screen}` : '');
    const buf = this.recentCalls.get(tabId) || [];
    buf.push({ key, name, ts: Date.now() });
    if (buf.length > 6) buf.shift();
    this.recentCalls.set(tabId, buf);
    return { buf, key };
  }

  // A step through a carousel: its direction when the tool itself has one
  // (carousel_navigate, arrow keys, going back), and the slide it reached when
  // the result reports one. A click's caption is not read, in any language;
  // the slide index it reaches shows whether the carousel went back and forth.
  _semanticCarouselIntent(name, args = {}, result = {}) {
    let direction = '';
    const key = String(args?.key || '');
    if (name === 'carousel_navigate') direction = result?.traversalDirection === 'reverse' ? 'backward' : 'forward';
    else if (name === 'press_keys' && key === 'ArrowRight') direction = 'forward';
    else if (name === 'press_keys' && key === 'ArrowLeft') direction = 'backward';
    else if (name === 'go_back') direction = 'backward';

    const url = String(result?.resolvedUrl || result?.currentUrl || result?.pageUrl || '');
    let canonical = String(result?.canonicalPostUrl || '');
    let index = Number(result?.resolvedIndex ?? result?.requestedIndex);
    try {
      const parsed = new URL(url);
      const parsedIndex = Number(parsed.searchParams.get('img_index'));
      if (!Number.isInteger(index) && parsed.searchParams.has('img_index') && Number.isInteger(parsedIndex)) index = parsedIndex;
      parsed.searchParams.delete('img_index');
      if (!canonical) canonical = parsed.href;
    } catch {}
    if (!direction && !Number.isInteger(index)) return null;
    return {
      direction,
      canonical: canonical || 'carousel',
      index: Number.isInteger(index) ? index : null,
      fingerprint: String(result?.visibleMediaFingerprint || '').slice(0, 320),
    };
  }

  _checkSemanticCarouselLoop(tabId, name, args, result) {
    const intent = this._semanticCarouselIntent(name, args, result);
    if (!intent) return { kind: 'none', intent: null };
    const previous = this.carouselIntentStates.get(tabId) || { history: [], cycleCount: 0 };
    const history = previous.history.filter(entry => entry.canonical === intent.canonical);
    history.push(intent);
    if (history.length > 8) history.shift();
    const last4 = history.slice(-4);
    const directionCycle = last4.length === 4
      && last4.every(entry => entry.direction)
      && last4[0].direction === last4[2].direction
      && last4[1].direction === last4[3].direction
      && last4[0].direction !== last4[1].direction;
    const indexCycle = last4.length === 4
      && last4.every(entry => Number.isInteger(entry.index))
      && last4[0].index === last4[2].index
      && last4[1].index === last4[3].index
      && last4[0].index !== last4[1].index;
    if (!directionCycle && !indexCycle) {
      this.carouselIntentStates.set(tabId, { history, cycleCount: previous.cycleCount });
      return { kind: 'none', intent };
    }
    const cycleCount = previous.cycleCount + 1;
    this.carouselIntentStates.set(tabId, { history, cycleCount });
    if (cycleCount >= 2) {
      this.carouselIntentStates.delete(tabId);
      return {
        kind: 'stop',
        intent,
        message: 'Stopped: carousel state oscillated between the same two slides twice across mixed Next/Previous tools. Re-read the current slide; do not press arrows, click Previous/Next, or reuse screenshot coordinates.',
      };
    }
    return {
      kind: 'nudge',
      intent,
      warning: this._loopVisionRun(tabId)
        ? '[CAROUSEL OSCILLATION: The page returned to a recently visited slide after alternating forward/back actions. Stop using arrows, clicks and Previous/Next. Look at the current screen once and decide from the slide it shows.]'
        : '[CAROUSEL OSCILLATION: The page returned to a recently visited slide after alternating forward/back actions. Stop using arrows, coordinate clicks, and Previous/Next. On a supported Instagram permalink use carousel_navigate with a strictly increasing index; otherwise re-read the current page once.]',
    };
  }

  _detectLoop(buf, activeKey = null) {
    if (!buf || buf.length < 3) return null;
    // 1. Same key 3+ times in the window.
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3 && (!activeKey || key === activeKey)) {
        return { type: 'repeat', key, name: key.split('|')[0], count: n };
      }
    }
    // 2. ABAB oscillation in the last 4.
    if (buf.length >= 4) {
      const last4 = buf.slice(-4);
      if (
        last4[0].key === last4[2].key
        && last4[1].key === last4[3].key
        && last4[0].key !== last4[1].key
      ) {
        return { type: 'oscillation', a: last4[0].name, b: last4[1].name };
      }
    }
    return null;
  }

  /**
   * Clear the state that is only meaningful for the page currently loaded in
   * `tabId` — ref ids, coordinates, scroll surfaces, and per-target failure
   * counters all stop describing reality once the page is replaced. Subclasses
   * extend this (via super) to drop their own page-scoped state alongside it.
   */
  _clearPageLoopState(tabId) {
    this.failedActionLoops.delete(tabId);
    this.filePickerDiscoveries.delete(tabId);
    this.axReadStates.delete(tabId);
    this.noProgressScrolls.delete(tabId);
    this.recentCoordClicks.delete(tabId);
  }

  _checkVerificationChallengeLoop(tabId, { pageUrl = '', dialogLabel = '' } = {}) {
    const normalizedLabel = String(dialogLabel || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .slice(0, 160);
    const previous = this.verificationChallengeStates.get(tabId);

    if (!normalizedLabel) {
      if (previous?.active) {
        this.verificationChallengeStates.set(tabId, { ...previous, active: false });
      }
      return { kind: 'none' };
    }

    const key = `${this._normalizeUrl(pageUrl)}\n${normalizedLabel}`;
    if (!previous || previous.key !== key) {
      this.verificationChallengeStates.set(tabId, { key, active: true, reopenCount: 0 });
      return { kind: 'none' };
    }
    if (previous.active) return { kind: 'none' };

    const reopenCount = previous.reopenCount + 1;
    this.verificationChallengeStates.set(tabId, { key, active: true, reopenCount });
    if (reopenCount >= 2) {
      return {
        kind: 'stop',
        message: 'Stopped: the same verification dialog was dismissed and reopened repeatedly on the same page. Do not close it or resubmit the form again. Use the CAPTCHA solver when supported, or ask the user to complete the verification manually.',
      };
    }
    return {
      kind: 'nudge',
      warning: '[VERIFICATION DIALOG REOPENED: The same verification challenge returned on the same page. Do not dismiss or close it and do not click Continue/Submit again. Use solve_captcha once if supported; otherwise ask the user to complete it manually.]',
    };
  }

  /**
   * Clear everything the detector accumulated for `tabId` except the nav
   * arrival history and the unavailable-tool counts, which must outlive
   * intra-run resets so navigation ping-pong and a repeated refused tool are
   * still catchable. See _clearRunLoopState for the run boundary.
   */
  _clearLoopState(tabId) {
    this.recentCalls.delete(tabId);
    this.loopNudges.delete(tabId);
    this.healthyCallsSinceLoop.delete(tabId);
    this._clearPageLoopState(tabId);
  }

  /**
   * Run-boundary reset. Only here is the nav arrival history discarded, since
   * a new run may legitimately revisit URLs the previous run already saw, and
   * the unavailable-tool counts, which every real navigation would otherwise
   * reset (navigate, screenshot, navigate, screenshot... never repeats).
   */
  _clearRunLoopState(tabId) {
    this.recentNavUrls.delete(tabId);
    this.unavailableToolCalls.delete(tabId);
    this._clearLoopState(tabId);
    this.verificationChallengeStates.delete(tabId);
    this.carouselIntentStates.delete(tabId);
    this.semanticPageRetries.delete(tabId);
  }

  _semanticRetryUrl(url, baseUrl = '') {
    try {
      const parsed = new URL(url, baseUrl || undefined);
      // This is only retry identity, never navigation/authorization identity.
      // Keep search, pagination and hash views. Collapse only explicit nonce
      // parameters with opaque hex values, such as Mastodon's acceptance key.
      for (const [key, value] of [...parsed.searchParams]) {
        if (/^(?:accept|nonce|csrf_token|authenticity_token)$/i.test(key)
            && /^[a-f0-9]{24,128}$/i.test(value)) parsed.searchParams.delete(key);
      }
      return parsed.origin + parsed.pathname + parsed.search + parsed.hash;
    } catch { return ''; }
  }

  _rememberSemanticRetryScope(tabId, pageUrl) {
    if (!pageUrl) return;
    const state = this.semanticPageRetries.get(tabId) || { attempts: new Map() };
    state.scopeUrl = String(pageUrl);
    this.semanticPageRetries.set(tabId, state);
  }

  _checkSemanticPageRetry(tabId, name, args, result) {
    const state = this.semanticPageRetries.get(tabId) || { attempts: new Map() };
    if (name === 'chat_observe' && result?.success === true
        && result.threadKey && result.chatWorkflow?.threadKey === result.threadKey
        && result.chatWorkflow.newMessages?.length) {
      this.semanticPageRetries.delete(tabId);
      return { kind: 'none' };
    }
    if (['set_field', 'type_ax', 'type_text', 'set_checked', 'select_option', 'chat_send'].includes(name)
        && result?.success === true && result.verified !== false && !result.outcomeUnknown) {
      state.observation = null;
      state.pending = null;
      state.attempts.clear();
      this.semanticPageRetries.set(tabId, state);
      return { kind: 'none' };
    }
    if (name === 'get_accessibility_tree') {
      const content = typeof result?.pageContent === 'string' ? result.pageContent : '';
      if (result?.error || result?.success === false || args?.ref_id
          || Number(args?.page || 1) !== 1 || result?.hasMore === true
          || result?.depthTruncated === true || result?.conversationRootRefId
          || content.length < 80 || content.length > 32000
          || !/^\s*heading\s+"[^"\n]+"/m.test(content)) return { kind: 'none' };
      const pageUrl = result.refScopeUrl || result.pageUrl || result.url || state.scopeUrl || '';
      const pageKey = this._semanticRetryUrl(pageUrl);
      const body = content.split('\n')
        .filter(line => !/dom_id="webbrain-agent-stop-button"/.test(line))
        .join('\n').replace(/\s*\[ref_[\w-]+\]/g, '')
        .replace(/\s+occluded=true\b/g, '')
        .replace(/href="([^"]*)"/g, (_match, href) => `href="${this._semanticRetryUrl(href, pageUrl) || href}"`)
        .replace(/\s+/g, ' ').trim();
      const previous = state.observation;
      const pending = state.pending;
      const unchanged = previous && previous.body === body && previous.pageKey === pageKey;
      state.observation = { pageKey, body };
      state.pending = null;
      if (!unchanged) state.attempts.clear();
      if (unchanged && pending && pending.pageKey === pageKey) {
        const count = (state.attempts.get(pending.key) || 0) + 1;
        state.attempts.set(pending.key, count);
        if (state.attempts.size > 8) state.attempts.delete(state.attempts.keys().next().value);
        this.semanticPageRetries.set(tabId, state);
        if (count >= 4) return {
          kind: 'stop',
          message: 'Stopped: the same verified navigation control returned to the unchanged page four times, despite fresh page references or one-use URL values. Do not click it again or replay its URL. Explain the blocker and continue only after the page or server state changes.',
        };
        if (count >= 2) return {
          kind: 'nudge',
          warning: '[UNCHANGED PAGE RETRY: The same verified navigation control returned to the same page twice. Fresh references and one-use URL values are not progress. Stop repeating this control. Inspect the current page once for a blocker; if it cannot be resolved, report it instead of clicking or replaying the URL again.]',
        };
      }
      this.semanticPageRetries.set(tabId, state);
      return { kind: 'none' };
    }
    if (!['click', 'click_ax'].includes(name) || result?.success !== true
        || result.verified !== true || result.outcomeUnknown || result.inconclusive
        || result.noDispatch === true || result.dispatched === false
        || !Array.isArray(result.observedEffects) || result.observedEffects.length === 0
        || result.observedEffects.some(effect => effect !== 'url')) return { kind: 'none' };
    const label = String(result.name || result.matched || result.text || '').trim().slice(0, 200);
    const href = result.resolvedHref || result.href || '';
    const role = String(result.role || '').toLowerCase();
    if (!label || !href || (String(result.tag || '').toLowerCase() !== 'a' && role !== 'link')) return { kind: 'none' };
    const before = this._semanticRetryUrl(result.previousUrl || state.scopeUrl || '');
    const after = this._semanticRetryUrl(result.currentUrl || '');
    const target = this._semanticRetryUrl(href, result.previousUrl || state.scopeUrl || '');
    if (!before || before !== after || target !== after) return { kind: 'none' };
    // Standalone detector replays may lack the browser's AX scope envelope.
    // A verified link result supplies its actual before/after URL, but it
    // cannot establish an unchanged page without an earlier root observation.
    state.scopeUrl = result.currentUrl;
    if (state.observation && !state.observation.pageKey) state.observation.pageKey = before;
    this.semanticPageRetries.set(tabId, state);
    if (state.observation?.pageKey !== before) return { kind: 'none' };
    state.pending = { pageKey: after, key: `link|${label}|${target}` };
    state.scopeUrl = result.currentUrl;
    this.semanticPageRetries.set(tabId, state);
    return { kind: 'none' };
  }

  /**
   * Normalize URLs for navigation-change checks. Keep query and hash so
   * history entries that differ only by search params or anchors still count as
   * successful back/forward movement.
   */
  _normalizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.origin + u.pathname + u.search + u.hash;
    } catch (e) { return url; }
  }

  /**
   * Record that `tabId` arrived at `url` and report whether that URL was
   * already seen in the last few arrivals. A first visit is page-state
   * progress and justifies resetting loop counters; a quick revisit is the
   * signature of a navigation loop and must leave them intact.
   */
  _noteNavArrival(tabId, url) {
    const normalized = this._normalizeUrl(url);
    if (!normalized) return false;
    const seen = this.recentNavUrls.get(tabId) || [];
    const revisited = seen.includes(normalized);
    seen.push(normalized);
    if (seen.length > 5) seen.shift();
    this.recentNavUrls.set(tabId, seen);
    return revisited;
  }

  _isRecentNavUrl(tabId, url) {
    const normalized = this._normalizeUrl(url);
    return !!normalized && (this.recentNavUrls.get(tabId) || []).includes(normalized);
  }

  _checkAccessibilityReadLoop(tabId, name, args, result) {
    if (name !== 'get_accessibility_tree') {
      this.axReadStates.delete(tabId);
      return { kind: 'none' };
    }

    const previous = this.axReadStates.get(tabId) || {
      total: 0,
      suspicious: 0,
      nextPage: null,
      scopeKey: null,
      seenPages: new Set(),
      warned: false,
    };
    const scopeKeyFor = (value = {}) => JSON.stringify({
      filter: String(value?.filter || 'all'),
      maxDepth: Number.isFinite(Number(value?.maxDepth)) ? Number(value.maxDepth) : null,
      maxChars: Number.isFinite(Number(value?.maxChars)) ? Number(value.maxChars) : null,
      refId: typeof value?.ref_id === 'string' ? value.ref_id.trim() : '',
    });
    const page = Number(args?.page || 1);
    const currentScopeKey = scopeKeyFor(args);
    const currentPageKey = `${currentScopeKey}|${page}`;
    const sequentialPage = previous.total > 0
      && Number.isFinite(previous.nextPage)
      && page === previous.nextPage
      && currentScopeKey === previous.scopeKey
      && !previous.seenPages.has(currentPageKey);
    const repeatedScopeOutOfSequence = previous.total > 0
      && currentScopeKey === previous.scopeKey
      && !sequentialPage;
    const repeatedExactPage = previous.seenPages.has(currentPageKey);
    // A first read of a new ref-anchored subtree is legitimate drill-down
    // progress. Only repeated/out-of-order reads of the same scope are loop
    // evidence; the total-read cap below still bounds endless ref hopping.
    const suspicious = !sequentialPage && (repeatedExactPage || repeatedScopeOutOfSequence);

    const state = {
      total: previous.total + 1,
      suspicious: previous.suspicious + (suspicious ? 1 : 0),
      nextPage: Number.isFinite(Number(result?.nextPage)) ? Number(result.nextPage) : null,
      scopeKey: scopeKeyFor(result?.continuationArgs || args),
      seenPages: new Set(previous.seenPages),
      warned: previous.warned,
    };
    state.seenPages.add(currentPageKey);
    this.axReadStates.set(tabId, state);

    // A root or anchored-subtree read followed by the exact returned nextPage
    // can legitimately span large applications. Keep the consecutive-read cap
    // for every other AX pattern, but do not stop a valid sequential step.
    if (state.suspicious >= 6 || (state.total >= 12 && !sequentialPage)) {
      this.axReadStates.delete(tabId);
      return {
        kind: 'stop',
        message: 'Stopped: I kept reading accessibility-tree nodes without taking an action or changing approach. The tree is not meant to be enumerated ref-by-ref. Use an element already found, request the returned nextPage, switch to read_page/extract_data, or ask for help.',
      };
    }
    if (!state.warned && state.suspicious >= 3) {
      state.warned = true;
      return {
        kind: 'nudge',
        warning: '[ACCESSIBILITY READ LOOP: Stop enumerating sibling or generic ref_ids. If the result has hasMore/nextPage, request exactly that page. If the needed textbox/button is already visible, use set_field, type_ax, or click_ax now. Otherwise switch once to read_page/extract_data or finish with what you have. Do not call another arbitrary ref_id subtree.]',
      };
    }
    return { kind: 'none' };
  }

  _noProgressScrollKey(args = {}, result = {}) {
    const direction = String(args?.direction || '').trim().toLowerCase() || 'unspecified';
    const refId = String(args?.ref_id || '').trim();
    if (refId) return `${direction}|ref:${refId}`;

    const x = Number(args?.x);
    const y = Number(args?.y);
    if (args?.x != null && args?.y != null && Number.isFinite(x) && Number.isFinite(y)) {
      return `${direction}|xy:${Math.round(x)},${Math.round(y)}`;
    }

    // For implicit scrolling, distinguish panes using the element that
    // supplied the runtime's last-interaction origin. This avoids combining
    // no-movement results from two different panes while deliberately
    // ignoring `amount`, which is not a meaningful recovery at a hard edge.
    const origin = result?.originElement;
    if (origin && typeof origin === 'object') {
      const rect = origin.rect || {};
      const text = String(origin.text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return `${direction}|origin:${String(result?.origin || '')}:${String(origin.tag || '')}:${String(origin.role || '')}:${Math.round(Number(rect.x) || 0)},${Math.round(Number(rect.y) || 0)},${Math.round(Number(rect.w) || 0)},${Math.round(Number(rect.h) || 0)}:${text}`;
    }
    return `${direction}|auto`;
  }

  _checkNoProgressScroll(tabId, name, args, result) {
    // Preserve a dead-scroll streak across reads or other unrelated calls;
    // only a successful scroll or a different scroll target/direction proves
    // that this particular recovery path changed.
    if (name !== 'scroll') {
      // Accessibility refs and coordinate targets are document-scoped. A
      // successful navigation can reuse the same ref_id/coordinates for a
      // completely different page, so it must break the old scroll streak.
      if (result?.pageUrlChanged === true) this.noProgressScrolls.delete(tabId);
      return { kind: 'none' };
    }
    if (result?.moved !== false) {
      this.noProgressScrolls.delete(tabId);
      return { kind: 'none' };
    }

    const key = this._noProgressScrollKey(args, result);
    const previous = this.noProgressScrolls.get(tabId);
    const count = previous?.key === key ? previous.count + 1 : 1;
    this.noProgressScrolls.set(tabId, { key, count });

    if (count >= 3) {
      this.noProgressScrolls.delete(tabId);
      return {
        kind: 'stop',
        message: 'Stopped: I repeated the same scroll direction on the same target three times, but the page or pane did not move. That scroll surface is already at its limit. Re-read the current view, choose a different pane or direction, act on an element already visible, or ask for help.',
      };
    }
    if (count >= 2) {
      return {
        kind: 'nudge',
        warning: '[NO-PROGRESS SCROLL: The same target did not move twice. Do not repeat this scroll direction or merely change the amount. Re-read the current view, use the opposite direction or a different ref_id/x/y pane, act on an element already visible, or finish.]',
      };
    }
    return { kind: 'none' };
  }

  /**
   * Issue #189 — mutation API observer shortcutter. When _checkLoop flags a
   * repeated click (e.g. "Next Page" clicked 3x), check whether each click
   * fired the same background XHR/fetch (captured by the webRequest
   * listener in background.js). If so, surface the URL/method so the model
   * can call fetch_url directly instead of clicking again.
   *
   * Strict matching only: same tab, exact url+method repeated, and request
   * must land within WINDOW_MS after the click that triggered it. No fuzzy
   * param-pattern matching.
   */
  _detectApiShortcut(tabId, loop, buf) {
    if (loop.type !== 'repeat') return null;
    if (!['click', 'click_ax'].includes(loop.name)) return null;
    const apiRequests = globalThis.__webbrainApiRequests?.get(tabId);
    if (!apiRequests || apiRequests.length === 0) return null;

    const clickTimes = buf.filter(e => e.key === loop.key).map(e => e.ts);
    if (clickTimes.length < 2) return null;

    const WINDOW_MS = 3000;
    let candidate = null;
    let matches = 0;
    const usedRequestIndexes = new Set();
    for (const clickTs of clickTimes) {
      const hitIndex = apiRequests.findIndex((r, idx) =>
        !usedRequestIndexes.has(idx)
        && r.ts >= clickTs
        && r.ts <= clickTs + WINDOW_MS
        && (!candidate || (r.url === candidate.url && String(r.method || '').toUpperCase() === candidate.method))
      );
      if (hitIndex < 0) continue;
      const hit = apiRequests[hitIndex];
      if (!hit) continue;
      if (!candidate) {
        candidate = {
          url: hit.url,
          method: String(hit.method || '').toUpperCase(),
          replayRequestId: hit.replayRequestId,
        };
      }
      usedRequestIndexes.add(hitIndex);
      matches++;
    }
    if (!candidate || matches < 2) return null;
    return {
      url: candidate.url,
      method: candidate.method,
      occurrences: matches,
      replayRequestId: candidate.replayRequestId,
    };
  }

  /**
   * Coordinate-click loop detector. Buckets to nearest 5px so a click that
   * drifts by a pixel or two between attempts still hashes the same. Window
   * of 12 — generous, since the goal is to survive interleaved noise like
   * execute_js / type_text / read_page calls between coord retries.
   *
   * Returns 'nudge' on the 5th repeat and 'stop' on the 8th. Gives the
   * agent more room to retry on pages with loading states or animations.
   */
  _checkCoordClickLoop(tabId, x, y) {
    const bx = Math.round(x / 5) * 5;
    const by = Math.round(y / 5) * 5;
    // In a vision run only clicks on the same screen add up: a point clicked
    // again after the screen changed (a list moving up under it) starts over.
    const screen = this._loopScreenIdentity(tabId, 'click', { x, y, coordinate_space: 'css' });
    const key = `${bx},${by}${screen ? `@${screen}` : ''}`;
    const buf = this.recentCoordClicks.get(tabId) || [];
    buf.push({ key, x: Number(x), y: Number(y), screen, ts: Date.now() });
    if (buf.length > 12) buf.shift();
    this.recentCoordClicks.set(tabId, buf);

    // A point read off a screenshot drifts by a few pixels between tries at
    // the same control (1035,80 / 1030,78 / 1038,76), which split one
    // repeated miss across several 5px buckets. In a vision run, earlier
    // clicks this close on the same screen count as the same point.
    const n = screen
      ? buf.filter(e => e.screen === screen && Math.abs(e.x - x) <= VISION_REPEAT_RADIUS_PX
        && Math.abs(e.y - y) <= VISION_REPEAT_RADIUS_PX).length
      : buf.filter(e => e.key === key).length;
    if (n >= 8) return { kind: 'stop', x: bx, y: by };
    if (n >= 5) return { kind: 'nudge', x: bx, y: by };
    return { kind: 'none' };
  }

  /**
   * Run loop detection on a freshly recorded call. Returns one of:
   *   { kind: 'none' }
   *   { kind: 'nudge', warning: string }   // soft warning to inject into tool result
   *   { kind: 'stop',  message: string }   // hard stop, abort the run
   */
  _checkLoop(tabId, toolName, toolArgs, toolResult) {
    if (UNAVAILABLE_TOOL_ERROR_CODES.has(toolResult?.errorCode)) {
      return this._checkUnavailableToolLoop(tabId, toolName, toolResult);
    }
    // A navigation result is authoritative page-state evidence. Clear before
    // recording this call so same-looking controls on the new page start at
    // attempt one instead of inheriting an old third-strike counter. Arriving
    // back on a recently seen URL is the exception: a click/go_back ping-pong
    // would otherwise reset the detector on every hop and never be caught.
    if (toolResult?.pageUrlChanged === true && !this._noteNavArrival(tabId, toolResult.currentUrl)) {
      this._clearLoopState(tabId);
    }
    const semanticRetry = this._checkSemanticPageRetry(tabId, toolName, toolArgs, toolResult);
    if (semanticRetry.kind !== 'none') return semanticRetry;
    if (
      toolName === 'find_text'
      && toolResult?.success === true
      && !this._findTextMatchLoopIdentity(toolResult)
    ) {
      // A cross-origin frame match can be selected by window.find while its
      // range is unavailable to the top document. Successful same-query calls
      // intentionally advance to the next match, so an unlocated match is not
      // safe evidence of a repeat loop.
      return this._noteHealthyLoopCall(tabId);
    }
    // A guarded chooser can discover the exact upload input on the last failed
    // click. Give that first discovery one fresh decision, without clearing
    // failures, action uncertainty, or authorizing any file assignment.
    const selector = toolResult?.selector;
    if (['click', 'click_ax', 'iframe_click'].includes(toolName)
      && toolResult?.success === false && toolResult.filePickerBlocked === true
      && toolResult.dispatched === true && toolResult.noDispatch !== true
      && toolResult.outcomeUnknown !== true && toolResult.cancelled !== true
      && toolResult.inconclusive !== true && toolResult.mutationMayHaveOccurred !== true
      && toolResult.nonRetryable !== true && (this.loopNudges.get(tabId) || 0) < 8
      && typeof selector === 'string' && selector.length > 0 && selector.length <= 2048
      && selector.trim() === selector && !/[\u0000-\u001F\u007F]/.test(selector)) {
      const discovered = this.filePickerDiscoveries.get(tabId) || new Set();
      if (!discovered.has(selector) && discovered.size < 16) {
        discovered.add(selector); this.filePickerDiscoveries.set(tabId, discovered);
        this._recordCall(tabId, toolName, toolArgs, toolResult);
        return { kind: 'nudge', warning: '[FILE INPUT DISCOVERED: The native chooser was blocked and its exact upload selector is in the current tool result. Inspect that result in a fresh decision and use upload_file if the current task requires it. Do not reopen the chooser, repeat the click, or run a queued upload planned before this discovery. This is not file attachment or remote-save evidence.]' };
      }
    }
    const { buf, key } = this._recordCall(tabId, toolName, toolArgs, toolResult);
    const carouselLoop = this._checkSemanticCarouselLoop(tabId, toolName, toolArgs, toolResult);
    if (carouselLoop.kind !== 'none') return carouselLoop;
    if (this._isBrowserMutationTool(toolName)) {
      const normalizeFailureScope = value => String(value).slice(0, 320);
      const carouselIntent = carouselLoop.intent;
      const defaultFailureScope = normalizeFailureScope(carouselIntent
        ? `carousel-${carouselIntent.direction}|${carouselIntent.canonical}`
        : `${toolName}|${bucketArgsKey(toolName, toolArgs)}`);
      const failureScope = normalizeFailureScope(toolResult?.failureScope || defaultFailureScope);
      const equivalentFailureScopes = new Set([failureScope, defaultFailureScope]);
      if ((toolName === 'set_field' || toolName === 'type_ax') && typeof toolArgs?.ref_id === 'string') {
        equivalentFailureScopes.add(normalizeFailureScope(`field-value:${toolArgs.ref_id}`));
      }
      if (toolName === 'click' && typeof toolArgs?.text === 'string') {
        equivalentFailureScopes.add(normalizeFailureScope(`ambiguous-click:${toolArgs.text.trim().toLowerCase()}`));
      }
      const failures = this.failedActionLoops.get(tabId) || new Map();
      if (this._isToolResultErroredForLoop(toolName, toolArgs, toolResult)) {
        const isOcclusionFailure = toolResult?.occluded === true
          || /occluded|covered by another element|topmost/i.test(String(toolResult?.error || ''));
        const maxAttempts = isOcclusionFailure ? 4 : 3;
        const attempts = (failures.get(failureScope) || 0) + 1;
        failures.set(failureScope, attempts);
        if (failures.size > 32) failures.delete(failures.keys().next().value);
        this.failedActionLoops.set(tabId, failures);
        const label = this._loopToolLabel(tabId, toolName);
        const vision = this._loopVisionRun(tabId);
        if (attempts >= maxAttempts) {
          this._clearLoopState(tabId);
          return {
            kind: 'stop',
            message: isOcclusionFailure
              ? `Stopped: ${label} failed ${maxAttempts} times because the target is occluded by an overlapping layer or docked header. Close the overlay, scroll past the obstruction, or re-read the page before retrying.`
              : `Stopped: ${label} failed or made no progress three times for the same target. Repeating it or switching to a precomputed fallback cannot make progress without fresh page evidence.`,
          };
        }
        if (attempts >= 2) {
          return {
            kind: 'nudge',
            warning: isOcclusionFailure
              ? `[OVERLAY OCCLUSION: ${label} failed because the target element is occluded or covered by an overlapping element (such as a modal backdrop, fixed header, or sticky toolbar). Try closing the overlay (e.g. clicking a close/dismiss button or pressing Escape), scrolling the element into clear view, or ${vision ? 'looking at the current screen again' : 're-reading the accessibility tree'}.]`
              : `[FAILED ACTION LOOP: ${label} has failed or made no progress twice for the same target. Do not retry it or use a queued fallback. ${vision ? 'Look at the current screen (zoom in if the target is small)' : 'Re-read the page/tree'} and choose a new action from current evidence.]`,
          };
        }
      } else if (toolResult?.success === true && toolResult?.verified !== false) {
        // A verified click can recover via coordinates, a selector, or an AX
        // target. Its success must retire the shared preparation failures;
        // reads, fresh captures, and dispatch-only success are not progress.
        if (
          ['click', 'click_ax', 'iframe_click'].includes(toolName)
          && toolResult.verified === true
          && toolResult.noDispatch !== true
          && toolResult.dispatched !== false
          && toolResult.outcomeUnknown !== true
          && toolResult.inconclusive !== true
        ) {
          failures.delete('screenshot-coordinate-capture');
          failures.delete('coordinate-provenance');
        }
        for (const scope of equivalentFailureScopes) failures.delete(scope);
        if (failures.size) this.failedActionLoops.set(tabId, failures);
        else this.failedActionLoops.delete(tabId);
      }
    }
    if (toolResult?.nonRetryable) {
      const repeats = buf.filter(entry => entry.key === key).length;
      if (repeats >= 2) {
        this._clearLoopState(tabId);
        return {
          kind: 'stop',
          message: toolResult.stopMessage || `Stopped: ${this._loopToolLabel(tabId, toolName)} hit the same non-retryable failure twice. Retrying or switching to an equivalent tool will not make progress.`,
        };
      }
    }
    if (key.startsWith('checkbox|')) {
      const repeats = buf.filter(entry => entry.key === key).length;
      if (repeats >= 3) {
        this._clearLoopState(tabId);
        return {
          kind: 'stop',
          message: 'Stopped: the same checkbox is still in the wrong checked state after three attempts. Changing tools or arguments does not change that semantic state. Re-read the form or ask the user instead of toggling it again.',
        };
      }
      if (repeats >= 2) {
        return {
          kind: 'nudge',
          warning: '[CHECKBOX STATE UNCHANGED: The same checkbox is still in the wrong checked state. Do not toggle it again and do not evade this by switching tools. Call set_checked(ref_id, desiredState) once; if its trusted selector-backed attempt also fails, re-read the form or ask the user.]',
        };
      }
    }
    const loop = this._detectLoop(buf, key);
    if (loop?.type === 'oscillation' && loop.a === 'find_text' && loop.b === 'find_text') {
      // Alternating match positions is normal when a finite page search wraps.
      return this._noteHealthyLoopCall(tabId);
    }
    if (!loop) {
      return this._noteHealthyLoopCall(tabId);
    }

    const method = String(toolArgs?.method || 'GET').toUpperCase();
    if (
      loop.type === 'repeat'
      && URL_FAMILY_TOOLS.has(toolName)
      && method === 'GET'
      && this._isToolResultErroredForLoop(toolName, toolArgs, toolResult)
    ) {
      this._clearLoopState(tabId);
      const rangedFetch = toolName === 'fetch_url' && this._fetchUsesHttpByteRange(toolArgs);
      return {
        kind: 'stop',
        message: rangedFetch
          ? 'Stopped: fetch_url failed three times while probing HTTP byte ranges for the same read-only resource. Use find or semantic offset:nextOffset pagination in a new run, or ask for a partial answer from the evidence already collected.'
          : `Stopped: ${loop.name} failed three times for the same read-only resource. Repeating it or changing URL variants will not make progress. Please give a different instruction or inspect the page manually.`,
      };
    }

    // Any new loop detection resets the healthy-streak counter.
    this.healthyCallsSinceLoop.delete(tabId);
    const nudges = (this.loopNudges.get(tabId) || 0) + 1;
    this.loopNudges.set(tabId, nudges);

    const label = name => this._loopToolLabel(tabId, name);
    const vision = this._loopVisionRun(tabId);
    if (nudges >= 8) {
      this._clearLoopState(tabId);
      const desc = loop.type === 'repeat'
        ? `the same call to ${label(loop.name)}`
        : `between ${label(loop.a)} and ${label(loop.b)}`;
      return {
        kind: 'stop',
        message: `Stopped: I detected I was looping on ${desc} without making progress after multiple warnings. Please tell me what's blocking, give me a different instruction, or take a look at the page yourself.`,
      };
    }

    let warning;
    if (loop.type === 'repeat') {
      const shortcut = this._detectApiShortcut(tabId, loop, buf);
      const rangedFetch = toolName === 'fetch_url'
        && method === 'GET'
        && this._fetchUsesHttpByteRange(toolArgs);
      warning = rangedFetch
        ? '[LOOP DETECTED: You are repeatedly probing the same resource with HTTP byte ranges. Stop guessing byte offsets or file size. Use fetch_url({url, find:"literal"}) to search the full decoded response, continue semantic text pagination with offset:nextOffset, or answer now with the evidence already collected. Do not send another Range header for this resource.]'
        : shortcut
        ? `[LOOP DETECTED + API SHORTCUT FOUND: You've called ${label(loop.name)} ${loop.count} times. Each click triggered the same background request pattern: ${shortcut.method} ${shortcut.url}. Instead of clicking again, consider fetch_url({url: "${shortcut.url}", method: "${shortcut.method}"${shortcut.replayRequestId ? `, replayRequestId: "${shortcut.replayRequestId}"` : ''}}) with the same method; follow the UI/API mutation policy for mutating methods.]`
        : vision
          // Only a call keyed on the screen repeated on an unchanged one.
          ? `[LOOP DETECTED: You've just called ${label(loop.name)} ${loop.count} times with the same arguments and ${this._loopScreenIdentity(tabId, toolName, toolArgs) ? 'the screen did not change in between' : 'the same outcome'}. The current approach is NOT working. Try something fundamentally different: a different point or control, a different tool, scroll to find a different element, or zoom into the screen to see what's actually there. DO NOT repeat this exact call again — try a creative alternative.]`
          : `[LOOP DETECTED: You've just called ${loop.name} ${loop.count} times with the same arguments and the same outcome. The current approach is NOT working. Try something fundamentally different: a different selector, a different tool, scroll to find a different element, or re-read the page/tree to see what's actually on screen. DO NOT repeat this exact call again — try a creative alternative.]`;
    } else {
      warning = `[LOOP DETECTED: You're oscillating between ${label(loop.a)} and ${label(loop.b)} without making progress. Stop. ${vision ? 'Look at the current screen (zoom in if needed)' : 'Re-read the page/tree'} to see what's actually happening, then try a completely different approach.]`;
    }
    return { kind: 'nudge', warning };
  }
}
