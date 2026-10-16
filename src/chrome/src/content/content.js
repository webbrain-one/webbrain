/**
 * WebBrain Content Script
 * Injected into every page — handles page reading and DOM actions.
 */

(() => {
  // Prevent double-injection within one extension context — but TAKE OVER
  // from an orphaned installation. When the extension is reloaded, updated,
  // or its folder moves, the previous content script stays in the page with
  // a dead runtime context: it still receives messages but can never answer
  // them, and because `__webbrain_injected` is already set, re-injecting the
  // current build used to be a no-op. That made every page tool fail with
  // "received no answer" until the tab was manually reloaded.
  //
  // A monotonic generation counter fixes this: each install bumps
  // `__webbrain_generation`, and only the listener belonging to the newest
  // install answers. Older (possibly orphaned) listeners stay registered but
  // go inert, and a fresh install always takes over.
  window.__webbrain_generation = (Number(window.__webbrain_generation) || 0) + 1;
  const WEBBRAIN_GENERATION = window.__webbrain_generation;
  // No early return: a fresh install ALWAYS takes over. Re-running the body
  // is safe (everything lives inside this IIFE, so no const redeclaration),
  // and the generation check in the message handler below makes every
  // previous copy inert, so exactly one listener ever answers. Orphaned
  // duplicates only linger as inert JS until the tab is reloaded.
  window.__webbrain_injected = true;

  const RECORDING_DOUBLE_ESCAPE_MS = 1400;
  const SET_CHECKED_MARKER_ATTRIBUTE = 'data-webbrain-set-checked-target';
  const SET_CHECKED_MARKER_TTL_MS = 15000;
  let recordingEscapeAt = 0;
  let recordingActive = false;

  function setCheckedMarkerSelector(marker) {
    const escapedMarker = String(marker || '').replace(/["\\]/g, '\\$&');
    return `[${SET_CHECKED_MARKER_ATTRIBUTE}="${escapedMarker}"]`;
  }

  function removeSetCheckedMarkers(marker) {
    if (!marker) return [];
    const matches = Array.from(document.querySelectorAll(setCheckedMarkerSelector(marker)));
    for (const marked of matches) {
      marked.removeAttribute?.(SET_CHECKED_MARKER_ATTRIBUTE);
    }
    return matches;
  }

  function setRecordingActive(active) {
    recordingActive = !!active;
    if (!recordingActive) recordingEscapeAt = 0;
  }

  if (window.top === window) {
    try {
      chrome.runtime.sendMessage(
        { target: 'background', action: 'get_recording_state' },
        (res) => {
          if (!chrome.runtime.lastError) setRecordingActive(!!res?.state?.active);
        }
      );
    } catch { /* ignore */ }

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.target !== 'content' || msg.action !== 'recording_state') return;
      setRecordingActive(!!msg.active);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.repeat) return;
      if (!recordingActive || !e.isTrusted) {
        recordingEscapeAt = 0;
        return;
      }
      const now = Date.now();
      if (now - recordingEscapeAt <= RECORDING_DOUBLE_ESCAPE_MS) {
        recordingEscapeAt = 0;
        e.preventDefault();
        try {
          chrome.runtime.sendMessage({
            target: 'background',
            action: 'stop_tab_recording',
            reason: 'double_escape',
          });
        } catch { /* ignore */ }
        setRecordingActive(false);
        return;
      }
      recordingEscapeAt = now;
    }, true);
  }

  /**
   * Extract readable text content from the page.
   */
  function getPageText() {
    // Try to get article/main content first
    const selectors = ['article', 'main', '[role="main"]', '.content', '#content'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 200) {
        return el.innerText.trim();
      }
    }
    return document.body.innerText.trim();
  }


  function getPageMediaSummary() {
    const videos = Array.from(document.querySelectorAll('video, source[type^="video/"], a[href]')).filter((el) => {
      const src = el.currentSrc || el.src || el.href || '';
      return /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(src) || el.tagName === 'VIDEO';
    });
    const images = Array.from(document.querySelectorAll('img, picture source, meta[property="og:image"], meta[name="twitter:image"]')).filter((el) => {
      const src = el.currentSrc || el.src || el.srcset || el.content || '';
      // The signed-in account's avatar (alt text = the person's name, src =
      // their photo) is account chrome, not page media (_axModelName).
      return !!src && !_axAccountChrome(el);
    });
    return {
      videoCount: videos.length,
      imageCount: images.length,
      videos: videos.slice(0, 5).map((el) => ({
        tag: el.tagName.toLowerCase(),
        src: (el.currentSrc || el.src || el.href || '').slice(0, 500),
      })),
      images: images.slice(0, 8).map((el) => ({
        tag: el.tagName.toLowerCase(),
        alt: (el.alt || '').slice(0, 120),
        src: (el.currentSrc || el.src || el.srcset || el.content || '').slice(0, 500),
      })),
    };
  }

  function getActiveEditableSummary() {
    let el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (!el.isContentEditable && el.closest) {
      const editableRoot = el.closest('input:not([type="hidden"]), textarea, [role="textbox"], [role="searchbox"], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
      if (editableRoot) el = editableRoot;
    }

    const tag = (el.tagName || '').toLowerCase();
    const role = el.getAttribute?.('role') || '';
    const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
    const editable =
      el.isContentEditable ||
      tag === 'textarea' ||
      (tag === 'input' && !['button', 'checkbox', 'color', 'date', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)) ||
      /^(textbox|searchbox)$/i.test(role);
    if (!editable) return null;

    const textPreview = tag === 'textarea' || el.isContentEditable
      ? String(el.value || el.innerText || el.textContent || '').trim().slice(0, 160)
      : '';
    return {
      tag,
      type,
      role,
      name: el.name || '',
      id: el.id || '',
      placeholder: el.getAttribute?.('placeholder') || '',
      ariaLabel: el.getAttribute?.('aria-label') || '',
      label: _getFieldLabel(el) || '',
      editable: !!el.isContentEditable,
      textPreview,
    };
  }

  /**
   * Get page metadata.
   */
  function getPageInfo() {
    const gate = detectPageGate();
    if (gate) {
      const pageGate = pageGatePublic(gate);
      const articleRoot = gate.surface === 'inline'
        ? gate.element.closest('article, [role="article"], main, [role="main"]')
        : null;
      return {
        url: window.location.href,
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content || '',
        pageGate,
        text: gate.surface === 'dialog'
          ? gate.label
          : (renderedArticleTextBeforeGate(articleRoot, gate.element) || gate.label),
        textSource: gate.surface === 'dialog' ? 'page-gate' : 'article (pre-gate)',
        media: { videoCount: 0, imageCount: 0, videos: [], images: [] },
        activeElement: null,
        links: [],
        forms: [],
      };
    }
    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      text: getPageText(),
      visibleLayers: getVisibleLayers(),
      media: getPageMediaSummary(),
      activeElement: getActiveEditableSummary(),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: _axModelName(a, a.innerText.trim().slice(0, 100)),
        href: _axModelHref(a, a.href),
      })),
      forms: Array.from(document.querySelectorAll('form')).map((form, i) => ({
        id: form.id || `form-${i}`,
        action: form.action,
        inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(el => ({
          type: el.type || el.tagName.toLowerCase(),
          name: el.name,
          id: el.id,
          placeholder: el.placeholder || '',
          value: el.value || '',
        })),
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Interactive-element discovery.
  //
  // IMPORTANT: this is the single source of truth for what counts as an
  // "interactive element" on a page. The agent-facing enumeration
  // (`get_interactive_elements` → `getInteractiveElementsFull`) and every
  // index-based follow-up action (`clickElement({index})`,
  // `typeText({index})`) MUST all go through `queryInteractiveFull()` so
  // that index N means the same element in all code paths. Historically
  // they used different selector lists / orderings, which caused the
  // "missing inputs" / "clicked the wrong thing" bug on complex pages
  // (shadow DOM, overlays, rich editors). The legacy `queryInteractive()`
  // order is still used by the plain content handler
  // (`getInteractiveElements`), but it is not the list the agent sees.
  // ---------------------------------------------------------------------
  const INTERACTIVE_SELECTORS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[onclick]',
    '[data-action]',
    'summary',
    'label',
  ];

  function _siteInteractiveSelectors() {
    try {
      return window.__wbSiteInteractions?.selectors?.() || [];
    } catch {
      return [];
    }
  }

  function _siteInteractionText(el) {
    try {
      const descriptor = window.__wbSiteInteractions?.describe?.(el);
      if (descriptor?.name) return descriptor.name;
    } catch {}
    const aria = el?.getAttribute?.('aria-label') || el?.ariaLabel || '';
    return (el?.innerText || el?.value || el?.placeholder || el?.title || aria || '').trim();
  }

  function _isSiteInteractive(el) {
    try {
      return !!window.__wbSiteInteractions?.isInteractive?.(el);
    } catch {
      return false;
    }
  }

  function _isSiteSelectorCandidate(el) {
    try {
      return _siteInteractiveSelectors().some(selector => el.matches(selector));
    } catch {
      return false;
    }
  }

  function _isStandardInteractive(el) {
    try {
      return INTERACTIVE_SELECTORS.some(selector => el.matches(selector));
    } catch {
      return false;
    }
  }

  function _isUsableSiteInteractive(el) {
    return _isStandardInteractive(el) || !_isSiteSelectorCandidate(el) || _isSiteInteractive(el);
  }

  function _composedParent(node) {
    if (!node) return null;
    if (node.assignedSlot) return node.assignedSlot;
    const parent = node.parentNode;
    if (parent) {
      return (typeof ShadowRoot !== 'undefined' && parent instanceof ShadowRoot)
        ? parent.host
        : parent;
    }
    const root = node.getRootNode?.();
    return (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot)
      ? root.host
      : null;
  }

  function _getViewportDockedInsets(view = window, target = null) {
    let top = 0;
    let bottom = 0;
    try {
      const doc = view.document;
      if (!doc) return { top: 0, bottom: 0 };
      const htmlStyle = view.getComputedStyle(doc.documentElement);
      const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
      const parsePadding = val => {
        const n = parseFloat(val);
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      let targetInTopDock = false;
      let targetInBottomDock = false;
      for (let node = target; node && node !== doc; node = _composedParent(node)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const style = view.getComputedStyle(node);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        const rect = node.getBoundingClientRect();
        if (rect.top >= -10 && rect.top < view.innerHeight * 0.4 && rect.bottom > 0 && rect.bottom <= view.innerHeight * 0.4) targetInTopDock = true;
        if (rect.bottom <= view.innerHeight + 10 && rect.bottom > view.innerHeight * 0.6 && rect.top >= view.innerHeight * 0.6) targetInBottomDock = true;
      }
      if (!targetInTopDock) top = Math.max(top, parsePadding(htmlStyle.scrollPaddingTop));
      if (!targetInBottomDock) bottom = Math.max(bottom, parsePadding(htmlStyle.scrollPaddingBottom));
      if (bodyStyle) {
        if (!targetInTopDock) top = Math.max(top, parsePadding(bodyStyle.scrollPaddingTop));
        if (!targetInBottomDock) bottom = Math.max(bottom, parsePadding(bodyStyle.scrollPaddingBottom));
      }
      const candidates = doc.querySelectorAll('header, nav, [role="banner"], [role="navigation"], [role="toolbar"], [class*="header" i], [class*="navbar" i], [class*="toolbar" i]');
      const vw = view.innerWidth || 800;
      const vh = view.innerHeight || 600;
      const topRects = [];
      const bottomRects = [];
      for (const c of candidates) {
        if (target && _isComposedAncestor(c, target)) continue;
        if (!c.isConnected || c.offsetWidth <= 0 || c.offsetHeight <= 0) continue;
        const cs = view.getComputedStyle(c);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = c.getBoundingClientRect();
        if (r.width < vw * 0.4) continue;
        if (r.top < vh * 0.4 && r.bottom > 0 && r.bottom < vh * 0.4) topRects.push(r);
        if (r.bottom > vh * 0.6 && r.top < vh && r.top > vh * 0.6) bottomRects.push(r);
      }
      // Recheck until all contiguous bars are included, regardless of DOM order.
      let changed = true;
      while (changed) {
        changed = false;
        for (const r of topRects) {
          if (r.top <= top + 10 && r.bottom > top) {
            top = r.bottom;
            changed = true;
          }
        }
        for (const r of bottomRects) {
          if (r.bottom >= vh - bottom - 10 && r.top < vh - bottom) {
            bottom = vh - r.top;
            changed = true;
          }
        }
      }
    } catch {}
    return {
      top: Math.min(top, (view.innerHeight || 600) * 0.4),
      bottom: Math.min(bottom, (view.innerHeight || 600) * 0.4),
    };
  }

  function _floatingTopBarRect(blocker, view = window) {
    const vh = view.innerHeight || 600;
    const vw = view.innerWidth || 800;
    for (let node = blocker; node; node = _composedParent(node)) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches?.('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) return null;
      const style = view.getComputedStyle(node);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = node.getBoundingClientRect();
      if (rect.top > 10 && rect.top < vh * 0.35 && rect.bottom < vh * 0.45
        && rect.height <= vh * 0.25 && rect.width >= vw * 0.4) return rect;
    }
    return null;
  }

  function _isCoveredByFixedNonModalSurface(el, view = window) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= view.innerWidth || cy >= view.innerHeight) return false;
    const hit = _shadowAwareElementFromPoint(cx, cy);
    if (!hit || _isComposedAncestor(el, hit) || _isComposedAncestor(hit, el)) return false;
    for (let node = hit; node; node = _composedParent(node)) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches?.('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) return false;
      const style = view.getComputedStyle(node);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const blocker = node.getBoundingClientRect();
      if (blocker.width >= view.innerWidth * 0.8 && blocker.height >= view.innerHeight * 0.8) return false;
      return true;
    }
    return false;
  }

  function _withTypingPreparation(kind, el, callback) {
    const monitor = window.__wbPageMonitor;
    if (monitor?.withLocalPreparation) return monitor.withLocalPreparation(kind, el, callback);
    monitor?.beforeLocalDispatch({ preparation: kind === 'focus', kind, target: el });
    return callback();
  }

  function _scrollElementIntoClearView(el) {
    if (!el?.isConnected) return;
    try {
      const view = el.ownerDocument?.defaultView || window;
      if (_isAlreadyVisibleInFixedSurface(el, view)) return;
      const insets = _getViewportDockedInsets(view, el);
      // A viewport-only rect check misses elements clipped by a scrollable
      // ancestor even when their bounding box is inside the viewport.
      const fullyVisible = _isFullyVisibleForInteraction(el, insets);
      const coveredByFixed = fullyVisible && _isCoveredByFixedNonModalSurface(el, view);
      if (!fullyVisible || coveredByFixed) {
        _withTypingPreparation('scroll', el, () => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
        const rAfter = el.getBoundingClientRect();
        if (rAfter.top < insets.top) {
          _withTypingPreparation('scroll', el, () => view.scrollBy({ top: rAfter.top - insets.top - 16, behavior: 'instant' }));
        } else if (rAfter.bottom > view.innerHeight - insets.bottom) {
          _withTypingPreparation('scroll', el, () => view.scrollBy({ top: rAfter.bottom - (view.innerHeight - insets.bottom) + 16, behavior: 'instant' }));
        }
      }
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      try { _withTypingPreparation('scroll', el, () => el.scrollIntoView({ block: 'center', inline: 'center' })); } catch (fallbackError) { if (fallbackError?.code === 'page_feedback_pending') throw fallbackError; }
    }
  }

  function _isFullyVisibleForInteraction(el, dockedInsets = null) {
    try {
      if (!el?.isConnected) return false;
      const view = el.ownerDocument?.defaultView || window;
      const rect = el.getBoundingClientRect();
      const insets = dockedInsets || _getViewportDockedInsets(view, el);
      if (
        rect.width < 1
        || rect.height < 1
        || rect.left < 0
        || rect.top < insets.top
        || rect.right > view.innerWidth
        || rect.bottom > (view.innerHeight - insets.bottom)
      ) return false;
      for (let node = _composedParent(el); node && node !== el.ownerDocument; node = _composedParent(node)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const style = view.getComputedStyle(node);
        const clipsX = /^(?:auto|scroll|hidden|clip)$/.test(style.overflowX);
        const clipsY = /^(?:auto|scroll|hidden|clip)$/.test(style.overflowY);
        if (!clipsX && !clipsY) continue;
        const parentRect = node.getBoundingClientRect();
        if (clipsX && (rect.left < parentRect.left || rect.right > parentRect.right)) return false;
        if (clipsY && (rect.top < parentRect.top || rect.bottom > parentRect.bottom)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function _isAlreadyVisibleInFixedSurface(el, view = window) {
    if (!_isFullyVisibleForInteraction(el, { top: 0, bottom: 0 })) return false;
    for (let node = el; node; node = _composedParent(node)) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const style = view.getComputedStyle(node);
      if (style.position === 'fixed') return true;
      if (style.position !== 'sticky') continue;
      let portTop = 0;
      let portBottom = view.innerHeight;
      for (let parent = _composedParent(node); parent; parent = _composedParent(parent)) {
        if (parent.nodeType !== Node.ELEMENT_NODE) continue;
        const parentStyle = view.getComputedStyle(parent);
        if (!/^(?:auto|scroll|hidden)$/.test(parentStyle.overflowY)) continue;
        const parentRect = parent.getBoundingClientRect();
        portTop = parentRect.top + parent.clientTop;
        portBottom = portTop + parent.clientHeight;
        break;
      }
      const rect = node.getBoundingClientRect();
      const top = parseFloat(style.top);
      const bottom = parseFloat(style.bottom);
      if ((Number.isFinite(top) && Math.abs(rect.top - portTop - top) <= 2)
        || (Number.isFinite(bottom) && Math.abs(rect.bottom - portBottom + bottom) <= 2)) return true;
    }
    return false;
  }

  function _isComposedAncestor(ancestor, node) {
    let cur = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = _composedParent(cur);
    }
    return false;
  }

  function _hasComposedClosest(el, selector) {
    return !!_composedClosestElement(el, selector);
  }

  function _composedClosestElement(el, selector) {
    let cur = el;
    while (cur) {
      try {
        if (cur.nodeType === Node.ELEMENT_NODE && cur.matches(selector)) return cur;
      } catch {}
      cur = _composedParent(cur);
    }
    return null;
  }

  function _someComposedDescendant(root, selector, predicate, limit = 2000) {
    const pending = [root];
    const seen = new Set();
    let visited = 0;
    while (pending.length && visited < limit) {
      const scope = pending.shift();
      const descendants = scope?.querySelectorAll?.('*') || [];
      const elements = scope?.nodeType === Node.ELEMENT_NODE
        ? [scope, ...descendants]
        : descendants;
      for (const element of elements) {
        if (seen.has(element)) continue;
        seen.add(element);
        visited += 1;
        if (element.matches?.(selector) && predicate(element)) return true;
        if (element.shadowRoot) pending.push(element.shadowRoot);
        if (element.tagName === 'SLOT') {
          pending.push(...(element.assignedElements?.({ flatten: true }) || []));
        }
        if (visited >= limit) break;
      }
    }
    return false;
  }

  function isVisiblyInteractive(el) {
    if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') return false;
    // aria-hidden / inert subtrees are non-interactive for assistive tech
    // and should be for us too.
    if (_hasComposedClosest(el, '[aria-hidden="true"], [inert]')) return false;

    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // Allow opacity-0 SELECT elements — sites like Stripe overlay a
    // transparent native <select> on top of a custom styled button.
    // These are functional and the agent MUST know about them.
    if (style.opacity === '0' && el.tagName !== 'SELECT') return false;

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;

    // Styled-wrapper pattern: the real <input>/<select> is sized 0×0
    // (e.g. visually-hidden, clipped, or wrapped in a custom component
    // that overlays its own control). If a visible <label for=id> or a
    // visible containing wrapper exists, we still want the agent to be
    // able to target it. Common on Stripe, Radix, Material, etc.
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (el.id) {
        try {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) {
            const lrect = label.getBoundingClientRect();
            if (lrect.width > 0 && lrect.height > 0) return true;
          }
        } catch {}
      }
      // Walk up a couple of levels looking for a visible wrapper.
      let p = el.parentElement;
      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
        const pr = p.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) return true;
      }
    }
    return false;
  }

  let _lastInteractionPoint = null;

  function showAgentWorkingTarget(el, source = 'interaction') {
    try {
      window.__webbrainAgentIndicator?.showTarget?.(el, source);
    } catch {}
  }

  function rememberInteractionPoint(el, source = 'interaction') {
    try {
      if (!el || typeof el.getBoundingClientRect !== 'function') return null;
      const r = el.getBoundingClientRect();
      if (!Number.isFinite(r.left) || !Number.isFinite(r.top) || r.width < 1 || r.height < 1) return null;
      const rect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      _lastInteractionPoint = {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        source,
        ts: Date.now(),
      };
      showAgentWorkingTarget(el, source);
      return rect;
    } catch {
      return null;
    }
  }

  function _isNativeBlockingDialog(dialog) {
    if (!dialog) return false;
    try {
      if (dialog.matches(':modal')) return true;
    } catch {}
    return dialog.getAttribute('aria-modal') === 'true';
  }

  function _hasVisibleBox(el, minWidth = 1, minHeight = 1) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    try {
      for (let ancestor = el; ancestor; ancestor = _composedParent(ancestor)) {
        if (ancestor.getAttribute?.('aria-hidden') === 'true') return false;
      }
      const r = el.getBoundingClientRect();
      if (r.width < minWidth || r.height < minHeight) return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  function _findDialogContentForOverlay(overlay) {
    const selector = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],[data-state="open"][role="dialog"],[class*="DialogContent"],[class*="ModalContent"],.modal.show';
    const pick = (node) => {
      if (!node || node === overlay) return null;
      try {
        if (node.matches?.(selector) && _hasVisibleBox(node, 20, 20)) return node;
        const match = node.querySelector?.(selector);
        if (match && _hasVisibleBox(match, 20, 20)) return match;
      } catch {}
      return null;
    };

    const siblings = overlay?.parentElement ? Array.from(overlay.parentElement.children) : [];
    const idx = siblings.indexOf(overlay);
    if (idx >= 0) {
      for (let i = idx + 1; i < siblings.length; i++) {
        const found = pick(siblings[i]);
        if (found) return found;
      }
      for (let i = idx - 1; i >= 0; i--) {
        const found = pick(siblings[i]);
        if (found) return found;
      }
    }

    return pick(overlay);
  }

  /**
   * Detect the topmost modal/overlay/dialog on the page. If one is found,
   * only elements inside it (and the backdrop) are "reachable" — everything
   * behind the overlay is visually blocked even though it passes visibility
   * checks. Returns the modal container element, or null if no overlay is
   * detected.
   *
   * Detection heuristics (ordered by reliability):
   *   1. <dialog[open]> — native HTML dialog
   *   2. [role="dialog"][aria-modal="true"] — ARIA modal pattern
   *   3. [role="dialog"] that is visible
   *   4. Common overlay class/attribute patterns (Stripe, Material, Radix,
   *      Chakra, etc.): data-overlay, data-state="open", .modal.show, etc.
   */
  function _findTopmostModal(opts = {}) {
    const includeNonModalDialogs = opts.includeNonModalDialogs !== false;
    // 1. Native <dialog open>
    const dialogs = document.querySelectorAll('dialog[open]');
    for (let i = dialogs.length - 1; i >= 0; i--) {
      if (includeNonModalDialogs || _isNativeBlockingDialog(dialogs[i])) return dialogs[i];
    }

    const ariaModals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    for (let i = ariaModals.length - 1; i >= 0; i--) {
      const r = ariaModals[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return ariaModals[i];
    }

    // 3. Visible role="dialog"
    if (includeNonModalDialogs) {
      const roleDialogs = document.querySelectorAll('[role="dialog"]');
      for (let i = roleDialogs.length - 1; i >= 0; i--) {
        const r = roleDialogs[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return roleDialogs[i];
      }
    }

    const candidates = document.querySelectorAll(
      '[data-overlay], ' +
      (includeNonModalDialogs ? '[data-state="open"][role="dialog"], ' : '') +
      '.modal.show, .modal-overlay, .overlay, [class*="modal"][class*="open"], ' +
      '[class*="overlay"][class*="active"], [class*="DialogOverlay"], ' +
      '[class*="ModalOverlay"]'
    );
    for (let i = candidates.length - 1; i >= 0; i--) {
      const r = candidates[i].getBoundingClientRect();
      if (r.width > 100 && r.height > 100) {
        const dialogContent = _findDialogContentForOverlay(candidates[i]);
        if (dialogContent) return dialogContent;
        const interactive = candidates[i].querySelector?.(INTERACTIVE_SELECTORS.join(', '));
        if (interactive) return candidates[i];
      }
    }

    return null;
  }

  function _findTopmostBlockingModal() {
    return _findTopmostModal({ includeNonModalDialogs: false });
  }

  function queryInteractive() {
    const all = document.querySelectorAll([...INTERACTIVE_SELECTORS, ..._siteInteractiveSelectors()].join(', '));
    const modal = _findTopmostBlockingModal();
    const out = [];
    for (const el of all) {
      if (!isVisiblyInteractive(el)) continue;
      if (!_isUsableSiteInteractive(el)) continue;
      // If a modal is open, only include elements that are inside it.
      // This prevents the agent from seeing (and accidentally clicking)
      // elements behind the overlay — the #1 cause of "clicked Export
      // instead of filling the form" on sites like Stripe.
      if (modal && !_isComposedAncestor(modal, el)) continue;
      out.push(el);
    }
    return out;
  }

  window.__wb_resolve_click_target_for_submit_probe = function resolveClickTargetForSubmitProbe(params = {}) {
    return resolveObservedClickTarget(params);
  };

  // Pure counterpart of clickElement's dispatch resolution. Observation must
  // never scroll, focus, select an option or dispatch while identifying a target.
  function resolveObservedClickTarget(params = {}) {
    if (params.selector && /:contains\(|:has-text\(/.test(params.selector)) return null;
    if (params.text) {
      if (typeof params.text !== 'string') return null;
      const needle = params.text.toLowerCase();
      const scope = _findTopmostModal() || document;
      const modes = params.textMatch ? [params.textMatch] : ['exact', 'prefix', 'contains'];
      if (modes.some(mode => !['exact', 'prefix', 'contains'].includes(mode))) return null;
      const candidates = _clickTextCandidates(scope);
      let matches = [];
      let usedMode = modes[0];
      for (const mode of modes) {
        usedMode = mode;
        matches = candidates.filter(({ txt }) => mode === 'exact' ? txt === needle
          : mode === 'prefix' ? txt.startsWith(needle)
            : needle.length >= 3 ? txt.includes(needle)
              : txt === needle || txt.startsWith(needle + ' ') || txt.endsWith(' ' + needle) || txt.includes(' ' + needle + ' '));
        if (matches.length) break;
      }
      const labelTarget = label => {
        let target = label.htmlFor ? document.getElementById(label.htmlFor) : null;
        target ||= label.querySelector('input,textarea,select');
        if (!target && label.nextElementSibling) {
          const sibling = label.nextElementSibling;
          target = /^(INPUT|TEXTAREA|SELECT)$/.test(sibling.tagName) ? sibling : sibling.querySelector('input,textarea,select');
        }
        return target;
      };
      if (!matches.length) {
        const labelMap = new Map();
        for (const label of scope.querySelectorAll('label')) {
          const text = (label.innerText || '').trim().toLowerCase();
          if (!text) continue;
          const target = (label.htmlFor ? document.getElementById(label.htmlFor) : null) || label.querySelector('input,textarea,select');
          if (target) labelMap.set(text, target);
        }
        for (const [text, target] of labelMap) if (needle === text || text.startsWith(needle) || text.includes(needle)) return target;
        return null;
      }
      if (matches.length > 1) {
        const owners = new Map();
        for (const match of matches) {
          const owner = _resolveInteractiveAncestor(match.e) || match.e;
          if (!owners.has(owner) || (match.primary === true && owners.get(owner).primary !== true)) owners.set(owner, match);
        }
        matches = [...owners.values()];
      }
      if (matches.length > 1) {
        const preferred = _preferredPrimaryTextClickMatch(matches);
        if (preferred) matches = [preferred];
      }
      if (matches.length > 1) {
        const interactive = matches.filter(({ e }) => _isInteractive(e));
        if (interactive.length === 1) matches = interactive;
        else {
          const eligible = (interactive.length > 1 ? interactive : matches).filter(({ e }) => _isEligibleTextClickTarget(e));
          if (eligible.length === 1) matches = eligible;
        }
      }
      if (matches.length !== 1) return null;
      const selected = matches[0].e;
      const resolved = selected.tagName === 'LABEL' ? labelTarget(selected) || selected : selected;
      // Dispatch may choose a select option instead of a non-exact text
      // target. Until that local selection is separately bound, do not
      // authorize the earlier button as though it were the clicked control.
      if (resolved instanceof HTMLSelectElement || usedMode !== 'exact') {
        const selects = resolved instanceof HTMLSelectElement ? [resolved] : scope.querySelectorAll('select');
        for (const select of selects) for (const option of select.options) {
          if ([option.textContent, option.label, option.value].some(value => String(value || '').trim().toLowerCase() === needle.trim())) return null;
        }
      }
      return _resolveInteractiveAncestor(resolved) || resolved;
    }
    if (params.selector) return safeIndexedQuerySelector(params.selector, params.matchIndex).element;
    if (params.index != null) {
      const index = typeof params.index === 'number' || (typeof params.index === 'string' && /^\d+$/.test(params.index)) ? Number(params.index) : NaN;
      return Number.isSafeInteger(index) && index >= 0 ? queryInteractiveForToolIndex()[index] || null : null;
    }
    return Number.isFinite(params.x) && Number.isFinite(params.y) ? _shadowAwareElementFromPoint(params.x, params.y) : null;
  }

  /**
   * Get a simplified DOM snapshot for the agent.
   */
  /** Find the visible label associated with a form element. */
  function _getFieldLabel(el) {
    // 1. Explicit <label for="...">
    if (el.id) {
      try {
        const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl) return lbl.innerText.trim().slice(0, 50);
      } catch {}
    }
    // 2. Wrapping <label>
    const parent = el.closest('label');
    if (parent) {
      const t = parent.innerText.trim().slice(0, 50);
      if (t && t !== (el.value || '').trim()) return t;
    }
    // 3. aria-label / aria-labelledby
    if (el.ariaLabel) return el.ariaLabel.trim().slice(0, 50);
    if (el.getAttribute('aria-labelledby')) {
      const lbl = document.getElementById(el.getAttribute('aria-labelledby'));
      if (lbl) return lbl.innerText.trim().slice(0, 50);
    }
    // 4. Preceding sibling that looks like a label
    const prev = el.previousElementSibling;
    if (prev && /^(LABEL|SPAN|DIV)$/i.test(prev.tagName)) {
      const t = prev.innerText.trim().slice(0, 50);
      if (t && t.length < 50) return t;
    }
    return '';
  }

  function getInteractiveElements() {
    return queryInteractive().map((el, index) => {
      let rect = el.getBoundingClientRect();
      // If the element itself has zero dimensions (hidden/styled input
      // inside a custom wrapper — common on Stripe, Radix, Material),
      // use the visible label or wrapper rect instead so coordinates
      // are useful for clicking.
      if (rect.width === 0 || rect.height === 0) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          let fallbackRect = null;
          // Try explicit label
          if (el.id) {
            try {
              const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (lbl) { const lr = lbl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fallbackRect = lr; }
            } catch {}
          }
          // Try wrapping label
          if (!fallbackRect) {
            const wl = el.closest('label');
            if (wl) { const lr = wl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fallbackRect = lr; }
          }
          // Try parent wrapper
          if (!fallbackRect) {
            let p = el.parentElement;
            for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
              const pr = p.getBoundingClientRect();
              if (pr.width > 0 && pr.height > 0) { fallbackRect = pr; break; }
            }
          }
          if (fallbackRect) rect = fallbackRect;
        }
      }
      const entry = {
        index,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        role: el.getAttribute('role') || '',
        text: _axModelName(el, _siteInteractionText(el).slice(0, 100)),
        id: el.id || '',
        name: el.name || '',
        href: _axModelHref(el, el.href || ''),
        editable: el.isContentEditable || false,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
      // Include associated label for form fields so the model knows what each field is for.
      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
        const label = _getFieldLabel(el);
        if (label) entry.label = label;
      }
      // Hint for <select> elements
      if (el.tagName === 'SELECT') {
        entry.hint = 'Use type_text({index: ' + index + ', text: "option"}) to change this dropdown';
        entry.options = Array.from(el.options).map(o => o.text.trim()).slice(0, 10);
      }
      return entry;
    });
  }

  // When click({index}) or type_text({index}) gets an out-of-range index,
  // return both a SPECIFIC stale-index error AND a fresh enumeration of
  // what's actually clickable now. Background: with the generic
  // "Element not found" message, several models (qwen3.6-27b q7kix9 was
  // the loudest) interpret the failure as a broken page state and try to
  // "reset" via navigate(same URL) → scroll → click(same stale index),
  // looping indefinitely. Embedding the current enumeration in the tool
  // result means even a model that ignores the prose has to see that
  // index 6 doesn't exist among the 23 elements actually on the page.
  function _staleIndexError(requestedIndex, interactive) {
    const total = interactive.length;
    // Compact snapshot — first ~40 elements, just the fields a model
    // needs to pick the right one: index, tag, role, text.
    const available = interactive.slice(0, 40).map((el, i) => {
      const text = _axModelName(el, _siteInteractionText(el).slice(0, 80));
      return {
        index: i,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        text,
      };
    });
    return {
      success: false,
      error: `Index ${requestedIndex} not found — only ${total} interactive element${total === 1 ? '' : 's'} on the current page (max valid index: ${total - 1}). Indices are NOT stable across scrolls, navigations, or DOM updates — the index you used was from a previous turn's get_interactive_elements call and no longer applies. Pick a new index from \`available\` below, OR use click({text: "..."}) which re-resolves every call. DO NOT reload, re-navigate, or scroll-then-retry with the same index — the page is fine; your index is stale.`,
      indexRequested: requestedIndex,
      totalAvailable: total,
      available,
      truncated: total > available.length,
    };
  }

  // -- Click helpers: interactive-element detection & parent traversal --------
  const _INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
  const _INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option']);
  const _PASSIVE_TAGS = new Set(['LABEL', 'SPAN', 'DIV', 'P', 'STRONG', 'EM', 'I', 'B', 'SMALL', 'SVG', 'IMG']);

  function _isInteractive(node) {
    if (_INTERACTIVE_TAGS.has(node.tagName)) return true;
    if (_isSiteInteractive(node)) return true;
    const role = (node.getAttribute && node.getAttribute('role')) || '';
    if (_INTERACTIVE_ROLES.has(role)) return true;
    if (node.hasAttribute && (node.hasAttribute('onclick') || node.hasAttribute('data-action'))) return true;
    return false;
  }

  function _isSubmitControl(el) {
    const control = el?.closest ? el.closest('button,input') : el;
    if (!control || !control.tagName) return false;
    const tag = control.tagName.toUpperCase();
    const type = (control.getAttribute?.('type') || '').trim().toLowerCase();
    if (tag === 'INPUT') return type === 'submit' || type === 'image';
    if (tag === 'BUTTON') return type === 'submit' || (!type && !!(control.form || control.closest?.('form')));
    return false;
  }

  function _axCanonicalName(el) {
    try {
      if (typeof window.__wb_ax_name === 'function') {
        const name = window.__wb_ax_name(el);
        if (name) return String(name).trim().slice(0, 160);
      }
    } catch {}
    try {
      const labelledBy = String(el?.getAttribute?.('aria-labelledby') || '').trim();
      const labelledText = labelledBy
        .split(/\s+/)
        .filter(Boolean)
        .map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      return String(
        el?.getAttribute?.('aria-label')
        || labelledText
        || el?.getAttribute?.('title')
        || ''
      ).trim().slice(0, 160);
    } catch {
      return '';
    }
  }

  function _axAccessibleName(el) {
    return _axCanonicalName(el)
      || String(el?.innerText || '').trim().slice(0, 160);
  }

  // A name or href a tool result shows the model takes the tree's
  // model-facing form: Google's signed-in account chrome is named and
  // addressed generically (accessibility-tree.js), so no tool hands the
  // model the person's name, e-mail or continue= URL. Matching and state
  // fingerprints keep the raw name.
  function _axModelName(el, name) {
    try {
      if (name && typeof window.__wb_ax_model_name === 'function') return window.__wb_ax_model_name(el, name);
    } catch {}
    return name;
  }

  function _axModelHref(el, href) {
    try {
      if (href && typeof window.__wb_ax_model_href === 'function') return window.__wb_ax_model_href(el, href);
    } catch {}
    return href;
  }

  function _axAccountChrome(el) {
    try {
      return window.__wb_ax_account_chrome?.(el) === true;
    } catch {
      return false;
    }
  }

  function _axVisibleConfirmationSurfaces() {
    const surfaces = [];
    const seen = new Set();
    const selectors = [
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
      'dialog[open]',
      '.modal',
    ].join(',');
    const visible = (el) => {
      try {
        if (!el?.isConnected) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 20 && rect.height >= 20;
      } catch {
        return false;
      }
    };
    try {
      for (const surface of document.querySelectorAll(selectors)) {
        if (!visible(surface)) continue;
        const id = String(surface.id || '').trim();
        const role = String(surface.getAttribute('role') || surface.tagName || '').trim().toLowerCase();
        const heading = surface.querySelector(
          '[role="heading"],h1,h2,h3,h4,h5,h6,[aria-label]'
        );
        const title = String(
          surface.getAttribute('aria-label')
          || heading?.innerText
          || heading?.textContent
          || ''
        ).replace(/\s+/g, ' ').trim().slice(0, 160);
        const actions = [];
        for (const control of surface.querySelectorAll('button,a,[role="button"]')) {
          if (!visible(control)) continue;
          const name = _axAccessibleName(control).replace(/\s+/g, ' ').trim();
          if (name && !actions.includes(name)) actions.push(name.slice(0, 120));
          if (actions.length >= 6) break;
        }
        const signature = id
          ? `id:${id}`
          : `surface:${role}|${title}|${actions.join('|')}`.slice(0, 480);
        if (!signature || seen.has(signature)) continue;
        seen.add(signature);
        surfaces.push({ signature, title, actions });
        if (surfaces.length >= 8) break;
      }
    } catch {}
    return surfaces;
  }

  function _axNewConfirmationSurface(before = []) {
    const previous = new Set(
      (Array.isArray(before) ? before : [])
        .map(surface => String(surface?.signature || ''))
        .filter(Boolean)
    );
    return _axVisibleConfirmationSurfaces()
      .find(surface => !previous.has(surface.signature)) || null;
  }

  function _axCheckboxIdentity(el, refId = '') {
    try {
      const id = String(el?.id || '').trim();
      if (id) return `id:${id}`;
      const name = String(el?.getAttribute?.('name') || '').trim();
      const value = String(el?.getAttribute?.('value') || '').trim();
      if (name) return `name:${name}|value:${value}`;
    } catch {}
    return `ref:${String(refId || '')}`;
  }

  function _axStableControlSelector(el) {
    try {
      const id = String(el?.id || '').trim();
      if (id) {
        const escaped = globalThis.CSS?.escape
          ? CSS.escape(id)
          : id.replace(/["\\]/g, '\\$&');
        return `#${escaped}`;
      }
    } catch {}
    return '';
  }

  function _axDocumentToken() {
    if (!window.__wbAxDocumentToken) {
      window.__wbAxDocumentToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    return window.__wbAxDocumentToken;
  }

  function _axFallbackState(el) {
    const empty = { full: '', strong: '', weak: '' };
    if (!el) return empty;
    try {
      const serializeAttrs = names => names.map(name => (
        el.hasAttribute?.(name)
          ? `${name}=${el.getAttribute?.(name) || ''}`
          : `${name}=<absent>`
      )).join('|');
      const strong = JSON.stringify({
        connected: !!el.isConnected,
        nativeChecked: (
          el.tagName?.toLowerCase() === 'input'
          && ['checkbox', 'radio'].includes(String(el.type || '').toLowerCase())
        ) ? !!el.checked : null,
        attrs: serializeAttrs([
          'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed',
          'aria-current', 'data-state', 'hidden',
        ]),
      });
      const weak = JSON.stringify({
        role: (el.getAttribute?.('role') || '').trim().toLowerCase(),
        name: _axAccessibleName(el),
        className: String(el.getAttribute?.('class') || '').slice(0, 240),
        style: String(el.getAttribute?.('style') || '').slice(0, 240),
        attrs: serializeAttrs([
          'aria-busy', 'data-status',
        ]),
        childCount: Number(el.childElementCount || 0),
      });
      return {
        strong,
        weak,
        // The full fingerprint is compared only across the synchronous
        // el.click() call stack, where unrelated page tasks cannot interleave.
        // Delayed observations compare strong/weak independently.
        full: JSON.stringify({ strong, weak }),
      };
    } catch {
      return empty;
    }
  }

  function _axFallbackVisibility(el) {
    if (!el?.isConnected) return { visible: false, reason: 'target is no longer connected to the document' };
    try {
      for (let node = el; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          return { visible: false, reason: 'target or an ancestor is CSS-hidden' };
        }
        if (Number.parseFloat(style.opacity || '1') <= 0) {
          return { visible: false, reason: 'target or an ancestor is fully transparent' };
        }
        // A child can override an ancestor's pointer-events:none. Its own
        // computed value and the physical hit test determine clickability.
        if (node === el && style.pointerEvents === 'none') {
          return { visible: false, reason: 'target does not receive pointer events' };
        }
      }
    } catch {
      return { visible: false, reason: 'target visibility could not be verified' };
    }
    return { visible: true, reason: '' };
  }

  function _axFallbackStaticAssessment(el) {
    const tag = el?.tagName ? el.tagName.toLowerCase() : '';
    const role = (el?.getAttribute?.('role') || '').trim().toLowerCase();
    const name = _axAccessibleName(el);
    const isEditable = !!el?.isContentEditable || tag === 'input' || tag === 'textarea';
    const isNativeControl = [
      'button', 'a', 'input', 'select', 'textarea', 'label', 'option',
      // Native disclosure activation toggles <details open>. Retrying its
      // <summary> with trusted input can immediately undo a working
      // synthetic click, so both disclosure elements stay synthetic-only.
      'summary', 'details',
    ].includes(tag);
    const isButtonLike = role === 'button' || !!el?.closest?.('[role="button"]');
    const isSubmitControl = _isSubmitControl(el);
    // Only structure decides here. What the target's name means (a send,
    // delete, like or download) is read by the agent in any language before
    // it sends a second, trusted click.
    const isDownloadControl = !!el?.closest?.('a[download],[download],[data-download]');
    const hasStatefulSemantics = ['treeitem', 'option'].includes(role)
      || ['aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-haspopup', 'data-state']
        .some(attr => el?.hasAttribute?.(attr));
    // Explicit handlers on the generic row itself are precisely where an
    // isTrusted-only application may need the fallback. Only interactive
    // ancestors remain a static veto; center-hit descendants are checked
    // separately against the actual pointer destination.
    const unsafeAncestor = el?.parentElement?.closest?.(
      'button,a,input,select,textarea,label,form,[role="button"],[role="link"],[onclick],[data-action]'
    );
    const safeRole = !role || ['generic', 'listitem', 'row'].includes(role);
    let blockedReason = '';
    if (isEditable) blockedReason = 'editable targets must not be auto-clicked twice';
    else if (tag === 'select') blockedReason = 'native select controls must use keyboard selection';
    else if (isNativeControl || isButtonLike) blockedReason = 'native/button-like controls keep the existing synthetic path';
    else if (isSubmitControl || !!el?.closest?.('form')) blockedReason = 'form controls must not be auto-retried';
    else if (isDownloadControl) blockedReason = 'download controls must not be auto-retried';
    else if (hasStatefulSemantics) blockedReason = 'toggle/selection controls must not be auto-clicked twice';
    else if (unsafeAncestor) blockedReason = 'targets inside explicit interactive handlers must not be auto-retried';
    else if (!safeRole) blockedReason = `role "${role}" is not eligible for automatic trusted fallback`;
    return {
      tag,
      role,
      name,
      isEditable,
      isNativeControl,
      isButtonLike,
      isSubmitControl,
      isDownloadControl,
      hasStatefulSemantics,
      blockedReason,
    };
  }

  function _axInteractiveHitDescendant(el, topmost) {
    if (!el || !topmost || topmost === el || !el.contains?.(topmost)) return null;
    for (let node = topmost; node && node !== el; node = node.parentElement) {
      const tag = (node.tagName || '').toUpperCase();
      const role = (node.getAttribute?.('role') || '').trim().toLowerCase();
      if (
        _isInteractive(node)
        || ['LABEL', 'OPTION', 'SUMMARY'].includes(tag)
        || ['checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox'].includes(role)
        || !!node.isContentEditable
        || node.hasAttribute?.('download')
      ) {
        return node;
      }
    }
    return null;
  }

  /** Walk up from a passive child to find its interactive ancestor (up to 5 levels). */
  function _resolveInteractiveAncestor(el) {
    if (!_PASSIVE_TAGS.has(el.tagName) || _isInteractive(el)) return el;
    let ancestor = el.parentElement;
    for (let i = 0; i < 5 && ancestor; i++, ancestor = ancestor.parentElement) {
      if (_isInteractive(ancestor)) return ancestor;
    }
    return el; // no interactive ancestor found — use original
  }

  /**
   * querySelector with resilience against selectors that contain unescaped
   * React-Aria-style IDs like `#react-aria-:r1a:` — the literal colons
   * blow up CSS parsing. If the selector is a bare id-hash and throws,
   * retry with the `[id="..."]` attribute-selector form. Also handles
   * escaping colons as a last resort.
   */
  function safeQuerySelector(selector) {
    if (typeof selector !== 'string' || !selector) return null;
    try { return document.querySelector(selector); } catch {}
    // Bare ID form: "#raw-id-with-:-in-it"
    if (selector.startsWith('#') && !/[\s>+~,\[\]\.:]/.test(selector.slice(1).replace(/\\:/g, ''))) {
      const rawId = selector.slice(1).replace(/\\:/g, ':');
      try {
        const byId = document.getElementById(rawId);
        if (byId) return byId;
      } catch {}
      try { return document.querySelector(`[id="${rawId.replace(/"/g, '\\"')}"]`); } catch {}
    }
    // Last resort: escape unescaped colons and retry once
    try {
      const escaped = selector.replace(/(^|[^\\]):/g, '$1\\:');
      return document.querySelector(escaped);
    } catch {}
    return null;
  }

  function safeQuerySelectorAll(selector) {
    if (typeof selector !== 'string' || !selector) return [];
    try { return Array.from(document.querySelectorAll(selector)); } catch {}
    const fallback = safeQuerySelector(selector);
    return fallback ? [fallback] : [];
  }

  function safeIndexedQuerySelector(selector, matchIndex) {
    const matches = safeQuerySelectorAll(selector);
    const requested = Number.isInteger(Number(matchIndex)) && Number(matchIndex) >= 0
      ? Number(matchIndex)
      : 0;
    return { element: matches[requested] || null, matchCount: matches.length, matchIndex: requested };
  }

  /**
   * Run one synthetic agent click while suppressing any immediate or deferred
   * <input type=file>.click() it triggers. Uploads should go through
   * upload_file, which attaches the bytes directly; allowing the page click
   * first opens an OS picker that remains orphaned after the direct upload.
   */
  function uniqueFileInputSelector(input) {
    const allPiercedMatches = (selector) => {
      const matches = [];
      const visit = (root) => {
        try { matches.push(...root.querySelectorAll(selector)); } catch { return; }
        let elements = [];
        try { elements = root.querySelectorAll('*'); } catch {}
        for (const element of elements) {
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(document);
      return matches;
    };
    const unique = (selector) => {
      if (!selector) return null;
      const matches = allPiercedMatches(selector);
      return matches.length === 1 && matches[0] === input ? selector : null;
    };
    try {
      if (input.id && window.CSS?.escape) {
        const byId = unique('#' + CSS.escape(input.id));
        if (byId) return byId;
      }
      if (input.name && window.CSS?.escape) {
        const byName = unique('input[type="file"][name=' + CSS.escape(String(input.name)) + ']');
        if (byName) return byName;
      }
      const parts = [];
      let node = input;
      while (node?.nodeType === Node.ELEMENT_NODE) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        const byPath = unique(parts.join(' > '));
        if (byPath) return byPath;
        node = parent;
      }
    } catch {}
    return null;
  }

  const FILE_PICKER_GUARD_SETTLE_MS = 500;
  const FILE_PICKER_GUARD_RETENTION_MS = 5000;
  const _filePickerGuardStates = new Map();
  let _filePickerGuardSequence = 0;

  function clickWithoutNativeFilePicker(runClick, settleMs = FILE_PICKER_GUARD_SETTLE_MS) {
    const guardId = `fpg_${Date.now().toString(36)}_${++_filePickerGuardSequence}`;
    const state = {
      blocked: null,
      settled: false,
      guard: null,
      cleanupPageShowPickerGuard: null,
      settleTimer: null,
      cleanupTimer: null,
    };
    const isFileInput = (input) =>
      input?.tagName === 'INPUT'
      && String(input.getAttribute?.('type') || input.type || '').toLowerCase() === 'file';
    const blockFileInput = (input) => {
      state.blocked = { selector: uniqueFileInputSelector(input) };
    };
    const guard = (event) => {
      const path = typeof event.composedPath === 'function'
        ? event.composedPath()
        : [event.target];
      const input = path.find(isFileInput);
      if (!input) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      blockFileInput(input);
    };
    const installPageShowPickerGuard = () => {
      const root = document.documentElement;
      if (!root) return () => {};
      const guardAttr = 'data-webbrain-file-picker-guard';
      const blockedAttr = 'data-webbrain-file-picker-blocked';
      const blockedEvent = 'webbrain:file-picker-guard-blocked';
      const armPageGuard = () => {
        root.setAttribute(guardAttr, guardId);
        document.dispatchEvent(new Event('webbrain:file-picker-guard-arm'));
      };
      const onBlocked = () => {
        try {
          const payload = JSON.parse(root.getAttribute(blockedAttr) || 'null');
          if (payload?.guardId !== guardId) return;
          state.blocked = {
            selector: typeof payload.selector === 'string' && payload.selector
              ? payload.selector
              : null,
          };
        } catch {}
      };
      document.addEventListener(blockedEvent, onBlocked, true);
      armPageGuard();
      return (disarmPageGuard = true) => {
        if (disarmPageGuard) {
          document.dispatchEvent(new Event('webbrain:file-picker-guard-disarm'));
        }
        if (root.getAttribute(guardAttr) === guardId) root.removeAttribute(guardAttr);
        document.removeEventListener(blockedEvent, onBlocked, true);
      };
    };
    const cleanupGuard = () => {
      document.removeEventListener('click', guard, true);
      state.cleanupPageShowPickerGuard?.();
    };
    state.guard = guard;
    _filePickerGuardStates.set(guardId, state);
    document.addEventListener('click', guard, true);
    state.cleanupPageShowPickerGuard = installPageShowPickerGuard();
    try {
      runClick();
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      cleanupGuard();
      _filePickerGuardStates.delete(guardId);
      throw error;
    }
    if (state.blocked) {
      cleanupGuard();
      _filePickerGuardStates.delete(guardId);
      return { blocked: state.blocked, guardId: null };
    }
    state.settleTimer = setTimeout(() => {
      state.settled = true;
      state.cleanupTimer = setTimeout(() => {
        if (_filePickerGuardStates.get(guardId) === state) {
          cleanupGuard();
          _filePickerGuardStates.delete(guardId);
        }
      }, FILE_PICKER_GUARD_RETENTION_MS);
    }, Math.max(0, Number(settleMs) || 0));
    return { blocked: null, guardId };
  }

  function consumeFilePickerGuard(guardId) {
    const state = typeof guardId === 'string' ? _filePickerGuardStates.get(guardId) : null;
    if (!state) return { success: true, settled: true, filePickerBlocked: false };
    if (!state.settled) return { success: true, settled: false, filePickerBlocked: false };
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    document.removeEventListener('click', state.guard, true);
    // Stop content-side observation, but leave the page-world programmatic
    // click/showPicker guard active until its own short TTL. This suppresses
    // longer debounces without blocking the tool response or intercepting a
    // user's direct native input click.
    //
    // This has to hold most of all when something WAS blocked. An app that
    // routes an upload affordance through a file input often retries on a
    // timer, and disarming here on the strength of the first interception left
    // that retry unguarded — it opened a real OS chooser that nothing can
    // close, and it stayed on screen through the rest of the run while
    // upload_file attached the file directly.
    state.cleanupPageShowPickerGuard?.(false);
    _filePickerGuardStates.delete(guardId);
    if (state.blocked) {
      return { ...filePickerBlockedResponse(state.blocked), settled: true };
    }
    return { success: true, settled: true, filePickerBlocked: false };
  }

  function filePickerBlockedResponse(blocked, label = '') {
    const selector = typeof blocked?.selector === 'string' && blocked.selector
      ? blocked.selector
      : null;
    const guidance = selector
      ? `Call upload_file with selector ${JSON.stringify(selector)} and the existing downloadId or absolute filePath; it attaches the file without opening an OS dialog.`
      : 'Re-inspect the page to find an exact, unique <input type=file> selector, then call upload_file directly. Do not use a generic input[type="file"] selector when the page has multiple file inputs.';
    return {
      success: false,
      dispatched: true,
      filePickerBlocked: true,
      ...(selector ? { selector } : {}),
      error: `Blocked a native file chooser${label ? ` opened by "${label}"` : ''}. ${guidance}`,
    };
  }

  // Shared by click dispatch and its recipient-safety preflight. In
  // particular, navigation links must participate in text-match ambiguity.
  //
  // This walk is the most expensive part of a text click: it scans the page
  // (including every shadow host) and reads innerText per match. clickElement,
  // the recipient preflight, and every retry all call it. Cache the result and
  // reuse it until the DOM actually changes.
  const _domRevision = { value: 0, observer: null, observedRoots: new WeakSet() };
  function _observeDomRevisionRoot(root) {
    if (!root || _domRevision.observedRoots.has(root) || typeof MutationObserver === 'undefined') return;
    try {
      if (!_domRevision.observer) {
        _domRevision.observer = new MutationObserver(() => { _domRevision.value += 1; });
      }
      _domRevision.observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        // Only the attributes that can change a text-click match; a broad
        // filter keeps the callback cheap on busy SPAs.
        attributeFilter: [
          'aria-label', 'aria-labelledby', 'title', 'placeholder', 'value', 'disabled',
          'aria-expanded', 'aria-selected', 'aria-checked', 'aria-hidden', 'hidden',
          'class', 'style', 'role', 'tabindex',
        ],
      });
      _domRevision.observedRoots.add(root);
    } catch {
      // Some roots cannot be observed. The uncached caller still retains the
      // original click behaviour; do not prevent other roots from registering.
    }
  }

  function _ensureDomRevisionObserver() {
    _observeDomRevisionRoot(document);
  }

  // Text preference and recipient preflight must use the control that can
  // actually receive the click, including when the label is a passive child.
  function _isEligibleTextClickTarget(el) {
    try {
      const control = _resolveInteractiveAncestor(el) || el;
      const r = control.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (control.disabled === true || control.matches?.(':disabled')
          || control.getAttribute?.('aria-disabled') === 'true') return false;
      const hit = _shadowAwareElementFromPoint(
        Math.round(r.left + r.width / 2),
        Math.round(r.top + r.height / 2),
      );
      return !!hit && (hit === control || control.contains?.(hit) || hit.contains?.(control));
    } catch {
      return false;
    }
  }

  function _primaryClickText(el) {
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'textarea') return '';
    if (tag === 'input') {
      const type = String(el.getAttribute?.('type') || 'text').toLowerCase();
      return /^(button|submit|reset)$/.test(type) ? String(el.value || '').trim().toLowerCase() : '';
    }
    return String(el.innerText || '').trim().toLowerCase();
  }

  // A painted passive label is not a competing control. Collapse primary
  // labels to their actionable owner before dispatch and preflight choose it.
  function _preferredPrimaryTextClickMatch(matches) {
    const controls = new Map();
    for (const match of matches) {
      if (match.primary !== true) continue;
      const actionable = _resolveInteractiveAncestor(match.e) || match.e;
      if (!_isInteractive(actionable) || !_isEligibleTextClickTarget(actionable)) continue;
      if (!controls.has(actionable)) controls.set(actionable, match);
    }
    if (controls.size !== 1) return null;
    const [actionable, match] = controls.entries().next().value;
    // A visible caption wins only over passive text. A distinct interactive
    // element with the same accessible name remains an explicit ambiguity.
    for (const candidate of matches) {
      const owner = _resolveInteractiveAncestor(candidate.e) || candidate.e;
      if (owner !== actionable && _isInteractive(owner)) return null;
    }
    return match;
  }

  const _textCandidateCache = new WeakMap();
  function _clickTextCandidates(scope) {
    _ensureDomRevisionObserver();
    const revision = _domRevision.value;
    const cacheScope = scope && typeof scope === 'object' ? scope : document;
    const cached = _textCandidateCache.get(cacheScope);
    if (cached && cached.revision === revision) return cached.list.slice();
    const selectors = [
      'a', 'button', '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
      '[role="menuitemcheckbox"]', '[role="combobox"]', '[role="searchbox"]', '[role="textbox"]',
      'input:not([type="hidden"])', 'textarea', 'select', 'input[type="button"]',
      'input[type="submit"]', 'summary', 'label', '[onclick]', '[data-action]',
      '[aria-label]', '[tabindex]', '[data-tooltip]',
      ..._siteInteractiveSelectors(),
    ].join(', ');
    // LinkedIn can render the feed itself inside an open shadow root. Keep
    // preflight and dispatch on the same candidate set, including duplicate
    // labels across roots, without searching outside the selected modal.
    const candidates = [];
    const visit = (root) => {
      _observeDomRevisionRoot(root);
      candidates.push(...root.querySelectorAll(selectors));
      if (root.shadowRoot) visit(root.shadowRoot);
      for (const host of root.querySelectorAll('*')) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    visit(cacheScope);
    const out = [];
    for (const e of candidates) {
      if (!_hasVisibleBox(e)) continue;
      const text = _siteInteractionText(e).toLowerCase();
      const primaryText = _primaryClickText(e);
      if (text) out.push({ e, txt: text, primary: !!primaryText && text === primaryText });
      if (primaryText && primaryText !== text) out.push({ e, txt: primaryText, primary: true });
      // A control's aria-label / title / placeholder often names it far better
      // than its visible glyphs — icon-only buttons and combobox-style fields
      // ("Search for contacts") are unreachable by visible text alone. Offer
      // those as extra needles so a text click resolves in one round trip.
      // They are secondary (primary: false): in ambiguity resolution a
      // visible-text match on a different control must not lose to them.
      for (const attr of ['aria-label', 'title', 'placeholder', 'data-tooltip']) {
        const value = String(e.getAttribute?.(attr) || '').trim().toLowerCase();
        if (value && value !== text) out.push({ e, txt: value, primary: false });
      }
    }
    _textCandidateCache.set(cacheScope, { revision, list: out });
    return out.slice();
  }

  function _shadowAwareElementFromPoint(x, y) {
    let topmost = document.elementFromPoint(x, y);
    const seen = new Set();
    while (topmost && topmost.shadowRoot && !seen.has(topmost)) {
      seen.add(topmost);
      let inner = null;
      try { inner = topmost.shadowRoot.elementFromPoint(x, y); } catch {}
      if (!inner || inner === topmost) break;
      topmost = inner;
    }
    return topmost;
  }

  let _lastClickIdent = null;

  /**
   * Click an element by selector or coordinates.
   */
  function clickElement(params, actionDeadlineExpired = () => false) {
    let dispatched = false;
    const deadlineFailure = () => ({
      success: false,
      dispatched,
      ...(dispatched
        ? { outcomeUnknown: true, retryable: false }
        : { noDispatch: true, outcomeUnknown: false, retryable: true }),
      deadlineExpired: true,
      error: dispatched
        ? 'The page action deadline expired during click dispatch.'
        : 'The page action deadline expired before click dispatch.',
    });
    if (actionDeadlineExpired()) return deadlineFailure();
    let el;
    // Tracks whether text matching below resolved el via an EXACT-tier
    // match. The auto-select rescue yields only to exact clickables — a
    // contains-tier match (e.g. "Contact us" for needle "US") must not
    // suppress selecting an exactly-matching <select> option.
    let textResolvedExact = false;
    if (params.selector && /:contains\(|:has-text\(/.test(params.selector)) {
      return {
        success: false,
        dispatched: false,
        error: 'Invalid selector: ":contains()" and ":has-text()" are jQuery/Playwright extensions, not valid CSS. Use click({text: "..."}) instead.',
      };
    }
    if (params.text) {
      const needle = params.text.toLowerCase();
      const explicit = params.textMatch || '';
      // Modal scoping: if a topmost modal/dialog is open, restrict the search
      // to elements inside it. Without this, click({text: "Create"}) can land
      // on a background button (GitHub's "Create new tag" dialog over the
      // dimmed "Publish release" — both contain the same verb). This mirrors
      // what queryInteractive() already does for index-based clicks.
      const _modalRoot = _findTopmostModal();
      const _scope = _modalRoot || document;
      const normalized = _clickTextCandidates(_scope);

      // Build label→input map so we can match label text and resolve to associated input
      const labelMap = new Map();
      _scope.querySelectorAll('label').forEach(lbl => {
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
        if (mode === 'contains') {
          // A 1-2 character needle in contains mode matches half the page:
          // click({text:"X"}) matched 13 controls and burned an entire turn on
          // an ambiguity report. Short needles must hit a word boundary so they
          // can only resolve to something that is actually that token.
          if (needle.length >= 3) return normalized.filter(x => x.txt.includes(needle));
          const padded = ` ${needle} `;
          return normalized.filter(x => x.txt === needle
            || x.txt.startsWith(`${needle} `)
            || x.txt.endsWith(` ${needle}`)
            || x.txt.includes(padded));
        }
        return [];
      }

      const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
      if (explicit && !['exact', 'prefix', 'contains'].includes(explicit)) {
        return { success: false, dispatched: false, error: `Invalid textMatch "${explicit}". Use exact, prefix, or contains.` };
      }

      let matches = [];
      let usedMode = modes[0];
      for (const m of modes) {
        matches = tryMode(m);
        usedMode = m;
        if (matches.length === 1) break;
        if (matches.length > 1) break;
      }

      // If no direct match, try label→input map
      if (matches.length === 0) {
        for (const [ltxt, inp] of labelMap) {
          const ok = (needle === ltxt) || ltxt.startsWith(needle) || ltxt.includes(needle);
          if (ok) {
            if (actionDeadlineExpired()) return deadlineFailure();
            inp.scrollIntoView({ block: 'center', inline: 'center' });
            if (actionDeadlineExpired()) return deadlineFailure();
            window.__wbPageMonitor?.beforeLocalDispatch({ kind: 'focus', target: inp });
            inp.focus();
            el = inp;
            textResolvedExact = (needle === ltxt);
            break;
          }
        }
      }

      if (!el && matches.length === 0) {
        // Auto-scroll retry: scroll down up to 3 times to find elements below the fold.
        // Still respect modal scoping — scrollable dialogs exist.
        for (let scrollAttempt = 0; scrollAttempt < 3 && matches.length === 0; scrollAttempt++) {
          if (actionDeadlineExpired()) return deadlineFailure();
          window.scrollBy(0, Math.round(window.innerHeight * 0.7));
          const _retryScope = _findTopmostModal() || document;
          const normRetry = _clickTextCandidates(_retryScope);
          for (const m of modes) {
            if (m === 'exact') matches = normRetry.filter(x => x.txt === needle);
            else if (m === 'prefix') matches = normRetry.filter(x => x.txt.startsWith(needle));
            else if (m === 'contains') matches = normRetry.filter(x => x.txt.includes(needle));
            usedMode = m;
            if (matches.length >= 1) break;
          }
          // Also retry label→input map after scroll
          if (matches.length === 0) {
            const labelMap2 = new Map();
            _retryScope.querySelectorAll('label').forEach(lbl => {
              const txt = (lbl.innerText || '').trim().toLowerCase();
              if (!txt) return;
              let target = null;
              if (lbl.htmlFor) target = document.getElementById(lbl.htmlFor);
              if (!target) target = lbl.querySelector('input,textarea,select');
              if (target) labelMap2.set(txt, target);
            });
            for (const [ltxt, inp] of labelMap2) {
              const ok = (needle === ltxt) || ltxt.startsWith(needle) || ltxt.includes(needle);
              if (ok) {
                if (actionDeadlineExpired()) return deadlineFailure();
                inp.scrollIntoView({ block: 'center', inline: 'center' });
                if (actionDeadlineExpired()) return deadlineFailure();
                window.__wbPageMonitor?.beforeLocalDispatch({ kind: 'focus', target: inp });
                inp.focus();
                el = inp;
                textResolvedExact = (needle === ltxt);
                break;
              }
            }
            if (el) break;
          }
        }
        if (!el && matches.length === 0) {
          const _noteModal = _modalRoot ? ' (search was scoped to the open modal/dialog; if the target is outside it, dismiss or complete the dialog first)' : '';
          return { success: false, dispatched: false, error: `No clickable element found for text "${params.text}" (also tried scrolling down)${_noteModal}` };
        }
      }
      // Collapse text matches that resolve to the SAME actionable element
      // before treating the text as ambiguous. An icon+label button wraps its
      // text in nested divs/spans, so an exact text match legitimately matches
      // the control AND its inner text node — two matches, one button. Gmail's
      // "Send" is exactly this shape, which made an unambiguous click look
      // ambiguous and sent the model off to do coordinate arithmetic.
      // Playwright-style locators resolve to the element that actually
      // receives the click; doing that here fixes "Send", "Post", "Connect",
      // and every other label-wrapped control on the web.
      if (!el && matches.length > 1) {
        const collapsedByAncestor = new Map();
        for (const m of matches) {
          const actionable = _resolveInteractiveAncestor(m.e) || m.e;
          if (!collapsedByAncestor.has(actionable)
              || (m.primary === true && collapsedByAncestor.get(actionable).primary !== true)) {
            collapsedByAncestor.set(actionable, m);
          }
        }
        if (collapsedByAncestor.size < matches.length) {
          matches = [...collapsedByAncestor.values()];
        }
        if (matches.length === 1) {
          el = _resolveInteractiveAncestor(matches[0].e) || matches[0].e;
          textResolvedExact = (usedMode === 'exact');
        }
      }
      if (!el && matches.length > 1) {
        // Prefer a unique visible caption only when its actionable owner can
        // receive the click. Passive text and attribute-only names retain the
        // existing interactive-target and ambiguity rules.
        const entry = _preferredPrimaryTextClickMatch(matches);
        if (entry) {
          el = _resolveInteractiveAncestor(entry.e) || entry.e;
          textResolvedExact = (usedMode === 'exact');
          matches = [entry];
        }
      }
      if (!el && matches.length > 1) {
        // Prefer interactive elements over passive children (label, span, etc.)
        const interactiveMatches = matches.filter(m => _isInteractive(m.e));
        if (interactiveMatches.length === 1) {
          matches = interactiveMatches;
        } else {
          // Playwright-style narrowing: a click must land on the element that
          // actually receives the event. Prefer candidates that are their own
          // hit target — visible, enabled, not covered by an overlay. This
          // usually collapses a reported ambiguity to the one control a real
          // click would hit, and often to a single element, which then resolves
          // here instead of spending an entire LLM turn on candidate
          // coordinates.
          const hitTargetPool = (interactiveMatches.length > 1 ? interactiveMatches : matches)
            .filter(m => _isEligibleTextClickTarget(m.e));
          if (hitTargetPool.length === 1) {
            el = _resolveInteractiveAncestor(hitTargetPool[0].e) || hitTargetPool[0].e;
            textResolvedExact = (usedMode === 'exact');
            matches = hitTargetPool;
          } else if (hitTargetPool.length > 1 && hitTargetPool.length < matches.length) {
            // Still ambiguous, but report only the controls a real click could
            // hit — fewer, better candidates for the one turn it costs.
            matches = hitTargetPool;
          }
          if (matches.length > 1) {
          // Build rich candidates: position (rect), tag, role, surrounding
          // context (closest landmark/dialog/button text), and a suggested
          // disambiguator. When the same text appears twice (e.g. "Cancel"
          // on both outer modal and inner sub-dialog), the model needs rects
          // to pick by location, not just the same string twice.
          const pickList = (interactiveMatches.length > 1 ? interactiveMatches : matches).slice(0, 6);
          const candidates = pickList.map((m, idx) => {
            const e = m.e;
            let rect = { x: 0, y: 0, w: 0, h: 0 };
            let cx = 0, cy = 0;
            try {
              const r = e.getBoundingClientRect();
              rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
              cx = Math.round(r.x + r.width / 2);
              cy = Math.round(r.y + r.height / 2);
            } catch {}
            let ancestor = '';
            try {
              const container = e.closest('[role=dialog],[role=alertdialog],[aria-modal="true"],form,section,nav,header,footer,aside,[role=region]');
              if (container) {
                const label = container.getAttribute('aria-label') || '';
                const labelledby = container.getAttribute('aria-labelledby');
                let labelledText = '';
                if (labelledby) {
                  try { labelledText = (document.getElementById(labelledby) || {}).innerText || ''; } catch {}
                }
                const headingEl = container.querySelector('h1,h2,h3,h4,[role=heading]');
                const heading = headingEl ? (headingEl.innerText || '').trim().slice(0, 40) : '';
                const role = container.getAttribute('role') || container.tagName.toLowerCase();
                ancestor = [role, label || labelledText || heading].filter(Boolean).join(': ').trim().slice(0, 80);
              }
            } catch {}
            return {
              index: idx,
              tag: e.tagName.toLowerCase(),
              role: e.getAttribute('role') || '',
              text: _axModelName(e, m.txt.slice(0, 80)),
              cx, cy,
              rect,
              ancestor,
            };
          });
          const _scopeNote = _modalRoot ? ' (search was scoped to the open modal/dialog)' : '';
          return {
            success: false,
            dispatched: false,
            error: `Ambiguous text match for "${params.text}" (mode=${usedMode}, matches=${matches.length})${_scopeNote}. ${candidates.length} candidates returned with cx/cy (precomputed click center, in CSS pixels) and ancestor context. Pick one and call click({x: candidate.cx, y: candidate.cy, coordinate_space: "css"}) — no arithmetic needed. Use the ancestor field to disambiguate (e.g. an alertdialog's Cancel vs a form's Cancel sit in different containers). Do NOT retry click({text: "${params.text}"}) — it will fail the same way.`,
            candidates,
          };
          }
        }
      }
      if (!el) {
        let resolved = matches[0].e;
        textResolvedExact = (usedMode === 'exact');
        // LABEL → associated input resolution
        if (resolved.tagName === 'LABEL') {
          let target = null;
          if (resolved.htmlFor) target = document.getElementById(resolved.htmlFor);
          if (!target) target = resolved.querySelector('input,textarea,select');
          if (!target && resolved.nextElementSibling) {
            const ns = resolved.nextElementSibling;
            if (/^(INPUT|TEXTAREA|SELECT)$/i.test(ns.tagName)) target = ns;
            else target = ns.querySelector('input,textarea,select');
          }
          if (target) {
            if (actionDeadlineExpired()) return deadlineFailure();
            window.__wbPageMonitor?.beforeLocalDispatch({ kind: 'focus', target });
            target.focus();
            resolved = target;
          }
        }
        el = _resolveInteractiveAncestor(resolved);
      }
    } else if (params.selector) {
      el = safeIndexedQuerySelector(params.selector, params.matchIndex).element;
    } else if (params.index != null) {
      // Must use the SAME traversal as get_interactive_elements so the
      // index the agent saw is the index we resolve.
      const interactive = queryInteractiveForToolIndex();
      el = interactive[params.index];
      if (!el) return { ..._staleIndexError(params.index, interactive), dispatched: false };
    } else if (params.x != null && params.y != null) {
      el = _shadowAwareElementFromPoint(params.x, params.y);
    }

    // A selector miss is a discovery failure, not a changed bound target. Do
    // not consume the one-shot toolbar binding when no element was resolved;
    // the caller's advised re-read/retry must still be able to bind a target.
    if (params.selector && !el) {
      return { success: false, dispatched: false, error: 'Element not found' };
    }

    if (actionDeadlineExpired()) return deadlineFailure();
    if (!_consumeDispatchBinding(params.dispatchBinding?.token, el)) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        retryable: true,
        error: 'The click target changed after the rich-text toolbar safety preflight. Re-read the page and retry.',
      };
    }
    if (actionDeadlineExpired()) return deadlineFailure();

    // ── Auto-select: if click text matches a <select> option, select it ──
    // Runs when text matching resolved NO element, resolved the <select>
    // itself (a select's innerText contains its options, so the contains
    // level routinely lands here for option clicks — skipping the rescue
    // then would wrongly fall through to the CANNOT-CLICK intercept), or
    // resolved a clickable only via a NON-exact tier (option text matches
    // exactly, so it beats a "Contact us"-style contains hit for "US").
    // It must NOT run when a genuine button/link labeled X matched
    // exactly — that element is what the model meant.
    if (params.text && (!el || el instanceof HTMLSelectElement || !textResolvedExact)) {
      const needle = params.text.trim();
      const lc = needle.toLowerCase();
      const selectScope = _findTopmostModal() || document;
      const allSels = el instanceof HTMLSelectElement
        ? [el]
        : selectScope.querySelectorAll('select');
      const matchingSelects = [];
      for (const sel of allSels) {
        const opts = Array.from(sel.options);
        const match = opts.find(o => o.text.trim() === needle)
          || opts.find(o => o.text.trim().toLowerCase() === lc)
          || opts.find(o => o.value === needle)
          || opts.find(o => o.value.toLowerCase() === lc);
        if (match) matchingSelects.push({ sel, match });
      }
      if (matchingSelects.length > 1) {
        return {
          success: false,
          dispatched: false,
          failureScope: `ambiguous-select-option:${lc}`,
          error: `Ambiguous select option match for "${needle}" (${matchingSelects.length} dropdowns). Identify the intended field and use type_text on that select instead.`,
        };
      }
      if (matchingSelects.length === 1) {
        const { sel, match } = matchingSelects[0];
        if (sel.selectedIndex === match.index) {
          return { success: true, method: 'select-already-set', selectedText: match.text.trim(), selectedValue: match.value };
        }
        if (actionDeadlineExpired()) return deadlineFailure();
        window.__wbPageMonitor?.beforeLocalDispatch({ kind: 'focus', target: sel });
        sel.focus();
        if (actionDeadlineExpired()) return deadlineFailure();
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        window.__wbPageMonitor?.beforeLocalDispatch();
        dispatched = true;
        if (nativeSetter) nativeSetter.call(sel, match.value);
        else sel.value = match.value;
        if (actionDeadlineExpired()) return deadlineFailure();
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        if (actionDeadlineExpired()) return deadlineFailure();
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        if (actionDeadlineExpired()) return deadlineFailure();
        return { success: true, method: 'auto-select', selectedText: match.text.trim(), selectedValue: match.value };
      }
    }

    if (!el) return { success: false, dispatched: false, error: 'Element not found' };
    const targetIsSubmitControl = _isSubmitControl(el);

    // <select> intercept: clicking opens a native OS dropdown that cannot be
    // controlled programmatically. Return error so the model uses type_text.
    // Do NOT scrollIntoView (hidden selects inside modals scroll to wrong position).
    if (el instanceof HTMLSelectElement) {
      if (actionDeadlineExpired()) return deadlineFailure();
      window.__wbPageMonitor?.beforeLocalDispatch({ kind: 'focus', target: el });
      el.focus();
      if (actionDeadlineExpired()) return deadlineFailure();
      const options = Array.from(el.options).map(o => o.text.trim());
      return {
        success: false,
        dispatched: false,
        tag: 'SELECT',
        text: el.options[el.selectedIndex]?.text?.trim() || '',
        error: `CANNOT CLICK a <select> dropdown — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused (current: "${el.options[el.selectedIndex]?.text?.trim() || ''}"). Use type_text({text: "option name"}) to change the value. Available options: ${options.join(', ')}`,
      };
    }

    // Also check if the target element is near a SELECT (sibling pattern)
    if (!(el instanceof HTMLSelectElement) && !targetIsSubmitControl) {
      const p = el.parentElement;
      let nearbySel = null;
      if (p) { for (const sib of p.children) { if (sib.tagName === 'SELECT') { nearbySel = sib; break; } } }
      if (!nearbySel) {
        const anc = el.closest ? el.closest('[class]') : null;
        if (anc) nearbySel = anc.querySelector('select');
      }
      if (nearbySel) {
        if (actionDeadlineExpired()) return deadlineFailure();
        window.__wbPageMonitor?.beforeLocalDispatch({ kind: 'focus', target: nearbySel });
        nearbySel.focus();
        if (actionDeadlineExpired()) return deadlineFailure();
        const options = Array.from(nearbySel.options).map(o => o.text.trim());
        return {
          success: false,
          dispatched: false,
          tag: 'SELECT',
          text: nearbySel.options[nearbySel.selectedIndex]?.text?.trim() || '',
          error: `CANNOT CLICK — a <select> dropdown is near this element (current: "${nearbySel.options[nearbySel.selectedIndex]?.text?.trim() || ''}"). The dropdown is now focused. Use type_text({text: "option name"}) to change the value. Available options: ${options.join(', ')}`,
        };
      }
    }

    // Do NOT scrollIntoView on SELECT elements (hidden selects in modals cause scroll jumps)
    if (el.tagName !== 'SELECT') {
      if (actionDeadlineExpired()) return deadlineFailure();
      _scrollElementIntoClearView(el);
    }

    // Occlusion hit-test: for text/selector/index clicks, verify that the
    // target's center is actually the topmost paint at that point. If an
    // overlay/modal/toast is covering the target, elementFromPoint returns
    // the cover instead — .click() will fire on the target but the user's
    // visual mental model is "I clicked the cover". Refuse so the model
    // dismisses the cover first. Skip for x,y clicks (the model chose the
    // point on purpose) and for SELECT (already handled). Only applies to
    // elements with real bounding rects.
    if (el.tagName !== 'SELECT' && params.x == null && params.y == null) {
      try {
        let r = el.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth) {
          let cx = Math.round(r.left + r.width / 2);
          let cy = Math.round(r.top + r.height / 2);
          let topmost = _shadowAwareElementFromPoint(cx, cy);

          // If covered at center, test if scrolling can clear a fixed/sticky header
          if (topmost && !_isComposedAncestor(el, topmost) && !_isComposedAncestor(topmost, el)) {
            const floatingBar = _floatingTopBarRect(topmost);
            const bRect = floatingBar || topmost.getBoundingClientRect();
            if (!_isAlreadyVisibleInFixedSurface(el)
              && (floatingBar || bRect.top <= _getViewportDockedInsets(window, el).top + 10)
              && bRect.bottom > r.top && bRect.bottom < window.innerHeight * 0.45) {
              window.scrollBy({ top: r.top - bRect.bottom - 20, behavior: 'instant' });
              r = el.getBoundingClientRect();
              cx = Math.round(r.left + r.width / 2);
              cy = Math.round(r.top + r.height / 2);
              topmost = _shadowAwareElementFromPoint(cx, cy);
            }
          }

          // If still covered at center, test sample perimeter points
          if (topmost && !_isComposedAncestor(el, topmost) && !_isComposedAncestor(topmost, el)) {
            const sampleOffsets = [
              [cx, Math.round(r.top + Math.max(2, Math.min(8, r.height * 0.2)))],
              [cx, Math.round(r.bottom - Math.max(2, Math.min(8, r.height * 0.2)))],
              [Math.round(r.left + Math.max(2, Math.min(8, r.width * 0.2))), cy],
              [Math.round(r.right - Math.max(2, Math.min(8, r.width * 0.2))), cy],
            ];
            for (const [sx, sy] of sampleOffsets) {
              if (sx < 0 || sy < 0 || sx > window.innerWidth || sy > window.innerHeight) continue;
              const sampleHit = _shadowAwareElementFromPoint(sx, sy);
              if (sampleHit && (_isComposedAncestor(el, sampleHit) || _isComposedAncestor(sampleHit, el))) {
                topmost = sampleHit;
                cx = sx;
                cy = sy;
                break;
              }
            }
          }

          // If still covered, check if the blocker chain has pointer-events: none
          if (topmost && !_isComposedAncestor(el, topmost) && !_isComposedAncestor(topmost, el)) {
            try {
              const elements = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [];
              const targetIdx = elements.indexOf(el);
              if (targetIdx > 0) {
                const allAboveNone = elements.slice(0, targetIdx).every(item => {
                  const pe = window.getComputedStyle(item).pointerEvents;
                  return pe === 'none' || _isComposedAncestor(el, item) || _isComposedAncestor(item, el);
                });
                if (allAboveNone) topmost = el;
              }
            } catch {}
          }

          if (topmost && !_isComposedAncestor(el, topmost) && !_isComposedAncestor(topmost, el)) {
            // Another element is painted on top. Give the model actionable
            // info (what's blocking, where, what to do) instead of silently
            // clicking the wrong thing.
            let blockerInfo = topmost.tagName.toLowerCase();
            const role = topmost.getAttribute && topmost.getAttribute('role');
            if (role) blockerInfo += `[role=${role}]`;
            const txt = _axModelName(topmost, (topmost.innerText || topmost.getAttribute?.('aria-label') || '').trim().slice(0, 60));
            if (txt) blockerInfo += ` "${txt}"`;
            let blockerContainer = '';
            try {
              const container = topmost.closest('[role=dialog],[role=alertdialog],[aria-modal="true"],dialog');
              if (container) {
                const h = container.querySelector('h1,h2,h3,[role=heading]');
                const heading = h ? (h.innerText || '').trim().slice(0, 40) : (container.getAttribute('aria-label') || '');
                if (heading) blockerContainer = ` inside dialog "${heading}"`;
              }
            } catch {}
            return {
              success: false,
              dispatched: false,
              error: `Click blocked: an overlay is covering the target. Topmost element at (${cx}, ${cy}) is <${blockerInfo}>${blockerContainer}, not your target <${el.tagName.toLowerCase()}>. Dismiss the overlay (press Escape, click its close button, or complete the modal flow) before retrying. If you're sure you want to force the click, use click({x: ${cx}, y: ${cy}, coordinate_space: "css"}) — that will hit whatever's on top.`,
              occluded: true,
              occludedBy: { tag: topmost.tagName.toLowerCase(), text: txt, cx, cy },
            };
          }
        }
      } catch {}
    }

    if (actionDeadlineExpired()) return deadlineFailure();
    if (params?.messageRecipientGuardRequired === true) {
      const recipientValidation = _consumeMessageRecipientDispatchBinding(params, el);
      if (recipientValidation.success !== true) return recipientValidation;
      if (actionDeadlineExpired()) return deadlineFailure();
    }
    if (actionDeadlineExpired()) return deadlineFailure();
    const clickedRect = rememberInteractionPoint(el, 'click');
    if (actionDeadlineExpired()) return deadlineFailure();
    const filePickerGuard = withLocalPageDispatch(() => {
      dispatched = true;
      return clickWithoutNativeFilePicker(() => el.click());
    });
    if (filePickerGuard.blocked) {
      return {
        ...filePickerBlockedResponse(filePickerGuard.blocked, params.text || el.innerText?.trim() || ''),
        ...(clickedRect ? { rect: clickedRect } : {}),
      };
    }
    if (actionDeadlineExpired()) return deadlineFailure();
    const filePickerGuardMeta = filePickerGuard.guardId
      ? { _filePickerGuardId: filePickerGuard.guardId }
      : {};

    // Post-click SELECT detection: the click may have activated a <select>
    // via a label, wrapper, or overlapping element. Return error, not success.
    const postActive = document.activeElement;
    if (!targetIsSubmitControl && postActive && postActive !== el && postActive instanceof HTMLSelectElement) {
      if (actionDeadlineExpired()) return deadlineFailure();
      postActive.blur();
      if (actionDeadlineExpired()) return deadlineFailure();
      postActive.focus(); // close native popup, keep focus
      const postOpts = Array.from(postActive.options).map(o => o.text.trim());
      return {
        success: false,
        dispatched: true,
        tag: 'SELECT',
        text: postActive.options[postActive.selectedIndex]?.text?.trim() || '',
        error: `CANNOT CLICK — a <select> dropdown was activated by this click (current: "${postActive.options[postActive.selectedIndex]?.text?.trim() || ''}"). The dropdown is now focused. Use type_text({text: "option name"}) to change the value. Available options: ${postOpts.join(', ')}`,
        ...filePickerGuardMeta,
      };
    }

    // Stale click detection: warn if the same element is clicked again.
    // Skip for editable targets — re-clicking a text field / contenteditable
    // is legitimate (positions cursor / re-focuses) and "no page change" is
    // the expected outcome there, not a failure signal.
    const inputType = String(el.getAttribute?.('type') || 'text').toLowerCase();
    const isEditableTarget = el.isContentEditable
      || el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType));
    const ident = `${el.tagName}|${(el.innerText || '').slice(0, 50)}|${location.href}`;
    let warning;
    if (_lastClickIdent === ident && !isEditableTarget) {
      warning = 'Same element clicked again with no page change. Prefer click({index: N}) from get_interactive_elements. For a screenshot point, inspect the current viewport and call click({x, y, coordinate_space: "screenshot", capture_id: "..."}).';
    }
    _lastClickIdent = ident;
    return {
      success: true,
      tag: el.tagName,
      type: String(el.getAttribute?.('type') || '').toLowerCase(),
      isSubmitControl: targetIsSubmitControl,
      text: el.innerText?.slice(0, 50),
      ...(clickedRect ? { rect: clickedRect } : {}),
      ...(warning ? { warning } : {}),
      ...filePickerGuardMeta,
    };
  }

  let _lastTypeFieldIdent = null;

  /**
   * Type text into an input/textarea.
   */
  function typeText(params, actionDeadlineExpired = () => false) {
    return _typeTextInner(params, actionDeadlineExpired);
  }

  function withLocalPageDispatch(callback) {
    const monitor = window.__wbPageMonitor;
    if (typeof monitor?.withLocalDispatch === 'function') return monitor.withLocalDispatch(callback);
    monitor?.beforeLocalDispatch();
    return callback();
  }

  async function pasteDraftJsText(el, text, clear, readDocument, options = {}) {
    const doc = el?.ownerDocument, view = doc?.defaultView, root = el?.getRootNode(), url = doc?.URL;
    let dispatched = false;
    const failure = (error, extra = {}) => ({
      success: false, verified: false, dispatched,
      ...(dispatched
        ? { mutationMayHaveOccurred: true, outcomeUnknown: true, retryable: false, recoveryRequired: 'verify_or_restore_field' }
        : { noDispatch: true, outcomeUnknown: false, retryable: false }),
      error, ...extra,
    });
    const expired = () => options.deadlineExpired?.() === true;
    const deadlineFailure = () => failure('The page action deadline expired during rich-text entry.', { deadlineExpired: true });
    const current = () => !!el?.isConnected && el.ownerDocument === doc && doc.defaultView === view
      && view.document === doc && el.getRootNode() === root && doc.URL === url;
    const active = () => {
      let target = root?.activeElement || doc?.activeElement;
      while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
      return target;
    };
    const selection = () => root?.getSelection?.() || view?.getSelection();
    const range = () => { const selected = selection(); return selected?.rangeCount === 1 ? selected.getRangeAt(0) : null; };
    const within = selected => !!selected && el.contains(selected.startContainer) && el.contains(selected.endContainer);
    const wait = () => new Promise(resolve => view.setTimeout(resolve, 30));
    const fence = phase => {
      if (options.beforeDispatch?.(phase) === false) {
        throw Object.assign(new Error('Browser changed during action preparation. Re-observe before acting.'), { code: 'page_feedback_pending' });
      }
    };
    try {
      if (expired()) return deadlineFailure();
      if (!current() || !el.isContentEditable || typeof readDocument !== 'function') return failure('The editable target is no longer available.');
      text = String(text).replace(/\r\n?/g, '\n');
      const previous = readDocument(el), htmlBefore = el.innerHTML;
      if (typeof previous !== 'string') return failure('The DraftJS document could not be read completely.', { recoveryRequired: 'fresh_tree' });
      if (!text.includes('\n')) return failure('This page-handled path requires multiline DraftJS text.');
      fence('focus');
      if (expired()) return deadlineFailure();
      el.focus({ preventScroll: true });
      await wait();
      if (!current() || readDocument(el) !== previous || el.innerHTML !== htmlBefore) {
        dispatched = true;
        return failure('The editor changed while preparing plain-text paste. No paste was sent.');
      }
      if (expired()) return deadlineFailure();
      if (active() !== el) return failure('The editor focus changed before plain-text paste.');
      // DraftJS maps marked text leaves to its public DOM selection. Selecting
      // the root or replacing its nodes can leave the model selection stale.
      const leaves = Array.from(el.querySelectorAll('[data-text="true"]'));
      const first = leaves[0], last = leaves[leaves.length - 1], selected = doc.createRange();
      if (!first || !last) return failure('The DraftJS text selection could not be established.');
      if (first.tagName === 'BR') selected.setStartBefore(first);
      else if (first.firstChild?.nodeType === 3) selected.setStart(first.firstChild, 0);
      else return failure('The DraftJS text selection could not be established.');
      if (last.tagName === 'BR') selected.setEndBefore(last);
      else if (last.lastChild?.nodeType === 3) selected.setEnd(last.lastChild, last.lastChild.nodeValue.length);
      else return failure('The DraftJS text selection could not be established.');
      if (!clear) selected.collapse(false);
      const selectedText = selection();
      if (!selectedText) return failure('The text selection is unavailable.');
      selectedText.removeAllRanges(); selectedText.addRange(selected);
      const prepared = range()?.cloneRange();
      await wait();
      if (!current() || readDocument(el) !== previous || el.innerHTML !== htmlBefore) {
        dispatched = true;
        return failure('The editor changed while preparing plain-text paste. No paste was sent.');
      }
      if (expired()) return deadlineFailure();
      const liveRange = range();
      if (active() !== el || !within(liveRange) || !prepared
          || liveRange.startContainer !== prepared.startContainer || liveRange.startOffset !== prepared.startOffset
          || liveRange.endContainer !== prepared.endContainer || liveRange.endOffset !== prepared.endOffset) {
        return failure('The editor focus or selection changed before plain-text paste.');
      }
      const transfer = new view.DataTransfer();
      transfer.setData('text/plain', text);
      const event = new view.ClipboardEvent('paste', { bubbles: true, composed: true, cancelable: true, clipboardData: transfer });
      // Firefox drops ClipboardEventInit.clipboardData. This event-local payload
      // is plain text only and never reads or writes the system clipboard.
      if (event.clipboardData?.getData('text/plain') !== text) Object.defineProperty(event, 'clipboardData', { value: transfer });
      if (event.clipboardData?.getData('text/plain') !== text) return failure('The plain-text paste payload could not be established.');
      fence('input');
      if (expired()) return deadlineFailure();
      const fencedRange = range();
      if (!current() || readDocument(el) !== previous || el.innerHTML !== htmlBefore) {
        dispatched = true;
        return failure('The editor changed during the paste dispatch fence. No paste was sent.');
      }
      if (active() !== el || !within(fencedRange)
          || fencedRange.startContainer !== prepared.startContainer || fencedRange.startOffset !== prepared.startOffset
          || fencedRange.endContainer !== prepared.endContainer || fencedRange.endOffset !== prepared.endOffset) {
        return failure('The editor focus or selection changed at the paste dispatch fence.');
      }
      const invoke = () => { dispatched = true; return el.dispatchEvent(event); };
      const accepted = options.dispatch ? options.dispatch(invoke) : invoke();
      await wait(); await wait();
      if (expired()) return deadlineFailure();
      if (!current() || active() !== el || !within(range())) return failure('The editor scope changed during plain-text paste.');
      const value = readDocument(el), expected = (clear ? '' : previous) + text;
      if (accepted || typeof value !== 'string' || value !== expected) {
        return failure('The complete settled DraftJS value could not be verified after plain-text paste. No additional text was sent.');
      }
      return { success: true, verified: true, dispatched: true, outcomeUnknown: false,
        pageHandledPaste: true, method: 'contenteditable-page-handled-paste', value: value.slice(0, 100) };
    } catch (error) {
      return failure(error?.message || String(error), error?.code === 'page_feedback_pending' ? { pageFeedbackPending: true } : {});
    }
  }

  async function _insertContentEditableText(el, text, clear, actionDeadlineExpired = () => false, ownInputScope = null) {
    if (isDraftJsEditor(el) && /[\r\n]/.test(text)) {
      const result = await pasteDraftJsText(el, text, clear, readDraftJsText, {
        deadlineExpired: actionDeadlineExpired,
        beforeDispatch: phase => window.__wbPageMonitor?.beforeLocalDispatch({ preparation: phase === 'focus', kind: 'input', target: el }),
        dispatch: callback => withLocalPageDispatch(callback),
      });
      return { ...result, fieldMeta: _fieldMeta(el) };
    }
    const doc = el.ownerDocument;
    let dispatched = false;
    const failure = (error, extra = {}) => ({
      success: false,
      verified: false,
      dispatched,
      ...(dispatched
        ? { mutationMayHaveOccurred: true, outcomeUnknown: true, retryable: false }
        : { noDispatch: true, outcomeUnknown: false, retryable: true }),
      error,
      ...extra,
    });
    const expired = () => failure('The page action deadline expired during rich-text entry.', { deadlineExpired: true });
    if (actionDeadlineExpired()) return expired();
    if (isModelManagedEditor(el)) {
      if (isDraftJsEditor(el) && readDraftJsText(el) === null) {
        return failure('The editor document could not be read completely. Refresh the page observation before typing.',
          { recoveryRequired: 'fresh_tree', retryable: false });
      }
      // These editors own their DOM. Even plain execCommand insertion can
      // replace framework-owned nodes; never attempt it before trusted input.
      const ref_id = window.__wb_ax_ref?.(el);
      return failure('This rich-text editor requires trusted browser typing.', {
        trustedTypeRequired: true, ref_id, fieldMeta: _fieldMeta(el),
        _expectedValue: (clear ? '' : _editableTextValue(el)) + text,
      });
    }
    if (typeof doc.execCommand !== 'function') {
      return failure('This editor has no supported native text insertion path. No content was changed.');
    }
    const selection = el.getRootNode?.().getSelection?.() || doc.defaultView?.getSelection();
    if (!selection || !el.isConnected) return failure('The editable target is no longer available.');
    // Model-backed paragraph editors have semantic document line breaks.
    // Ordinary editors must verify the same rendered value their input
    // handlers read; accepting browser-created blank lines corrupts saves.
    const draftJsEditor = isDraftJsEditor(el);
    if (draftJsEditor && readDraftJsText(el) === null) {
      return failure('The DraftJS editor structure cannot establish its exact document text. Re-observe this editor before typing.',
        { recoveryRequired: 'fresh_tree', retryable: false });
    }
    const semanticEditor = readProseMirrorText(el) !== null;
    const readValue = () => _editableTextValue(el);
    const previous = readValue();
    const nativeClearContext = clear && text === '' ? _nativeChatCaretContext(el) : null;
    const selectContents = (collapse) => {
      const range = doc.createRange();
      let container = el;
      if (collapse) {
        // End the append inside the last editable block. Collapsing at the
        // root end inserts a new sibling after the paragraph on Firefox.
        while (container.lastChild?.nodeType === 1
            && container.lastChild.isContentEditable
            && container.lastChild.nodeName !== 'BR') container = container.lastChild;
      }
      range.selectNodeContents(container);
      if (collapse) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const edit = async (command, inputType, data = null, commandData = data) => {
      const htmlBefore = el.innerHTML;
      const rootBefore = el.getRootNode?.() || doc;
      const pageUrlBefore = doc.location?.href || doc.URL || '';
      const nativeContextBefore = _nativeChatCaretContext(el);
      const rangeBefore = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      if (!rangeBefore || !el.contains(rangeBefore.startContainer) || !el.contains(rangeBefore.endContainer)) {
        return failure('The text selection moved outside the intended editor before insertion.');
      }
      // execCommand is the native editing fallback: it preserves markup and
      // the editor's undo stack. Its beforeinput behavior differs by browser,
      // so offer the page a cancellable gate BEFORE invoking the command.
      window.__wbPageMonitor?.beforeLocalDispatch();
      const verifyNativeObservation = nativeContextBefore && typeof window.__wbPageMonitor?.captureLocalInputObservation === 'function'
        ? window.__wbPageMonitor.captureLocalInputObservation(el) : null;
      const beforeInputGate = () => el.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, composed: true, cancelable: true, inputType, data,
      }));
      const accepted = window.__wbPageMonitor?.withLocalDispatch
        ? window.__wbPageMonitor.withLocalDispatch(beforeInputGate) : beforeInputGate();
      if (!accepted) {
        // React/model editors can cancel native insertion while handling the
        // requested edit themselves. Allow their bounded render to settle
        // before claiming that no mutation happened. Never send another edit.
        await new Promise(resolve => setTimeout(resolve, SET_FIELD_VERIFY_DELAY_MS));
        const changed = el.innerHTML !== htmlBefore || !el.isConnected;
        if (changed) dispatched = true;
        if (actionDeadlineExpired()) return expired();
        if (!changed) return failure('The editor cancelled text entry before mutation.', { cancelled: true });
        const nativeContextAfter = _nativeChatCaretContext(el);
        const sameScope = el.isConnected && el.ownerDocument === doc
          && doc.defaultView?.document === doc && (el.getRootNode?.() || doc) === rootBefore
          && (doc.location?.href || doc.URL || '') === pageUrlBefore
          && ((!nativeContextBefore && !nativeContextAfter)
            || _sameNativeChatCaretContext(nativeContextBefore, nativeContextAfter));
        const unknown = () => failure('The editor handled a cancelled beforeinput and changed. Its complete value could not be verified in the same scope. No additional text was dispatched.',
          { cancelled: true, recoveryRequired: 'verify_or_restore_field', retryable: false });
        if (!sameScope || (draftJsEditor && readDraftJsText(el) === null)) return unknown();
        try {
          if (verifyNativeObservation) {
            if (!verifyNativeObservation()) throw Object.assign(new Error(`The native text observation lost its original operation or received browser intervention (${verifyNativeObservation.reason || 'observation_invalid'})${verifyNativeObservation.diagnostic ? ' [' + verifyNativeObservation.diagnostic + ']' : ''}.`), { code: 'page_feedback_pending' });
          } else window.__wbPageMonitor?.beforeLocalDispatch();
        }
        catch (error) { return failure(error?.message || 'The editor scope changed during page-handled text entry.',
          { cancelled: true, recoveryRequired: 'verify_or_restore_field', retryable: false,
            ...(error?.code === 'page_feedback_pending' ? { pageFeedbackPending: true } : {}) }); }
        const value = readValue();
        const expected = clear ? text : previous + text;
        const normalize = value => String(value).replace(/\r\n?/g, '\n');
        if (normalize(value) !== normalize(expected)) return unknown();
        return { success: true, verified: true, dispatched: true, outcomeUnknown: false,
          pageHandledBeforeInput: true, nativeBeforeInputCancelled: true,
          method: 'contenteditable-page-handled-beforeinput', value: value.slice(0, 100), fieldMeta: _fieldMeta(el) };
      }
      if (el.innerHTML !== htmlBefore || !el.isConnected) {
        window.__wbPageMonitor?.beforeLocalDispatch();
        dispatched = true;
        return failure('The editor changed while handling beforeinput. No additional text was dispatched.');
      }
      if (actionDeadlineExpired()) return expired();
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      let active = doc.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (!range || !rangeBefore || (active !== el && !el.contains(active))
          || range.startContainer !== rangeBefore.startContainer || range.startOffset !== rangeBefore.startOffset
          || range.endContainer !== rangeBefore.endContainer || range.endOffset !== rangeBefore.endOffset) {
        return failure('The editor focus or selection changed before text insertion.');
      }
      window.__wbPageMonitor?.beforeLocalDispatch();
      dispatched = true;
      try {
        const execute = () => {
          const previous = _messageRecipientOwnedInputScope;
          _messageRecipientOwnedInputScope = ownInputScope?.el === el ? ownInputScope : null;
          const classBefore = ownInputScope?.el === el
            ? _nativeChatDraftClassTokens(el.getAttribute('class') || '') : null;
          const inputCount = ownInputScope?.count;
          try { return doc.execCommand(command, false, commandData); }
          finally {
            _messageRecipientOwnedInputScope = previous;
            if (classBefore && ownInputScope.count > inputCount) {
              const classAfter = _nativeChatDraftClassTokens(el.getAttribute('class') || '');
              if (classAfter) {
                ownInputScope.classRemovalTokens ||= new Set();
                for (const token of classAfter) if (!classBefore.has(token)) ownInputScope.classRemovalTokens.add(token);
              }
            }
          }
        };
        const inserted = window.__wbPageMonitor?.withLocalDispatch ? window.__wbPageMonitor.withLocalDispatch(execute) : execute();
        if (!inserted) {
          return failure('The editor rejected native text entry. No DOM replacement was attempted.');
        }
      } catch (error) {
        if (error?.code === 'page_feedback_pending') throw error;
        return failure(`Native text entry failed: ${error?.message || String(error)}`);
      }
      return null;
    };

    const hasNonTextContent = () => !!el.querySelector('img, svg, canvas, video, audio, iframe, object, embed, [contenteditable="false"]');
    const mustClear = clear && (previous !== '' || hasNonTextContent());
    if (mustClear && (!text || semanticEditor)) {
      selectContents(false);
      const deletionFailure = await edit('delete', 'deleteContentBackward');
      if (deletionFailure) return deletionFailure;
      await new Promise(resolve => setTimeout(resolve, 30));
      if (actionDeadlineExpired()) return expired();
      if (!el.isConnected || String(el.textContent || '') !== '' || hasNonTextContent()) {
        return failure('The editor could not be proven empty. No replacement text was inserted.');
      }
      if (nativeClearContext) _rememberNativeChatEmptyCaret(el, nativeClearContext);
    }
    if (text) {
      // Keep the legacy append contract, but retain every existing rich-text
      // node instead of assigning textContent for the entire editor.
      // Replace an ordinary editor in one native operation. Deleting first
      // creates caret/whitespace nodes that can survive the second insertion.
      if (!semanticEditor || !mustClear) selectContents(!clear && !_nativeChatCaretValueIsEmpty(el));
      // Chromium's multiline insertText creates empty DIV blocks that add
      // extra innerText line feeds. Native HTML insertion of escaped literal
      // text preserves whitespace and undo/input handling without replacing
      // the editor DOM. The wrapper only formats the newly inserted text.
      const literal = String(text).replace(/\r\n?/g, '\n')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const insertionFailure = semanticEditor
        ? await edit('insertText', 'insertText', text)
        : await edit('insertHTML', 'insertText', text, `<span style="white-space: pre-wrap">${literal}</span>`);
      if (insertionFailure) return insertionFailure;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    if (actionDeadlineExpired()) return expired();
    if (draftJsEditor && readDraftJsText(el) === null) {
      return failure('The DraftJS editor structure changed during typing and cannot establish its exact document text.',
        { recoveryRequired: 'verify_or_restore_field', retryable: false });
    }
    const value = readValue();
    const expected = clear ? text : previous + text;
    const normalize = value => String(value).replace(/\r\n?/g, '\n');
    if (!el.isConnected || normalize(value) !== normalize(expected)) {
      return failure('The complete settled rich-text value could not be verified exactly.');
    }
    return {
      success: true, verified: true, dispatched,
      ...(!dispatched ? { noDispatch: true, noop: true } : {}),
      method: 'contenteditable-native', value: value.slice(0, 100), fieldMeta: _fieldMeta(el),
    };
  }

  async function _typeTextInner(params, actionDeadlineExpired = () => false) {
    let dispatched = false;
    const deadlineFailure = () => ({
      success: false,
      dispatched,
      ...(dispatched
        ? { outcomeUnknown: true, retryable: false }
        : { noDispatch: true, outcomeUnknown: false, retryable: true }),
      deadlineExpired: true,
      error: dispatched
        ? 'The page action deadline expired during text dispatch.'
        : 'The page action deadline expired before text dispatch.',
    });
    const noDispatchFailure = (error, extra = {}) => ({
      success: false,
      error,
      ...extra,
      dispatched: false,
      noDispatch: true,
    });
    if (actionDeadlineExpired()) return deadlineFailure();
    const exactInsertion = (before, after, inserted) => _richTextToolbarExactInsertion(before, after, inserted);
    const verifyValue = async (target, expected, clear, beforeValue) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      if (!target?.isConnected) return false;
      const value = String(target.isContentEditable ? (target.textContent || '') : (target.value || ''));
      return clear
        ? value === expected
        : typeof beforeValue === 'string' && exactInsertion(beforeValue, value, expected);
    };
    const typedText = String(params.text || '');
    let el;
    if (params.selector) {
      el = safeIndexedQuerySelector(params.selector, params.matchIndex).element;
    } else if (params.index != null) {
      // Same index space as get_interactive_elements / clickElement.
      const interactive = queryInteractiveForToolIndex();
      el = interactive[params.index];
      if (!el) {
        const stale = _staleIndexError(params.index, interactive);
        return noDispatchFailure(stale.error, stale);
      }
    } else {
      // Fallback path: type into the currently focused element. Used when
      // CDP isn't available or as the secondary path. Usually unreached on
      // chrome because agent.js routes type_text → cdpClient first.
      el = _deepActiveElement();
      if (!el || el === document.body || el === document.documentElement) {
        return noDispatchFailure('No editable element is currently focused. Click the target input/textarea first, then call type_text again with no selector.');
      }
      // Verify it's actually editable
      const editable = el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
      if (!editable) {
        return noDispatchFailure(`Focused element <${el.tagName.toLowerCase()}> is not an editable field. Click the target input/textarea first, then call type_text again.`);
      }
    }

    if (!el) return noDispatchFailure('Element not found');

    if (!_consumeDispatchBinding(params.dispatchBinding?.token, el)) {
      return noDispatchFailure(
        'The selector target changed after the rich-text toolbar safety preflight. Re-read the page and retry.',
        { retryable: true },
      );
    }

    // Guard: only INPUT, TEXTAREA, SELECT, and contenteditable are typeable.
    // Calling HTMLInputElement's native value setter on anything else throws
    // "Illegal invocation" because the setter requires `this` to be an input.
    const isTypeable = el.isContentEditable
      || el instanceof HTMLInputElement
      || el instanceof HTMLTextAreaElement
      || el instanceof HTMLSelectElement;
    if (!isTypeable) {
      const tag = (el.tagName || '').toLowerCase();
      return noDispatchFailure(`Cannot type into <${tag}> — it is not an editable field. If you wanted to activate it, use click instead. If the real target is a nearby input, click the input first, then call type_text({text: "..."}) with no selector.`);
    }

    // Empty appends mutate nothing: skip focus/dispatch entirely and report
    // a proven no-op so no uncertainty debt is recorded downstream.
    // (clear:true still empties below and takes the verified path. Native
    // selects are excluded: choosing an empty-valued option IS a mutation.)
    if (!typedText && !params.clear && !(el instanceof HTMLSelectElement)) {
      return { success: true, dispatched: false, noDispatch: true, noop: true, method: 'noop-empty-append' };
    }

    // A cleared field must not be refilled with only a preview of itself.
    const truncatedPreview = params.clear ? _truncatedPreviewReplacementFailure(el, typedText) : null;
    if (truncatedPreview) return { ...truncatedPreview, fieldMeta: _fieldMeta(el) };

    if (actionDeadlineExpired()) return deadlineFailure();
    _withTypingPreparation('focus', el, () => el.focus());
    if (actionDeadlineExpired()) return deadlineFailure();
    showAgentWorkingTarget(el, 'type_text');
    const beforeValue = String(el.isContentEditable ? (el.textContent || '') : (el.value || ''));
    const routeHrefBeforeType = location.href;

    if (el.isContentEditable) {
      return _insertContentEditableText(el, typedText, params.clear === true, actionDeadlineExpired);
    }

    // <select>: match by value, then by visible option text.
    // Use native setter to bypass React's value property wrapper.
    if (el instanceof HTMLSelectElement) {
      const needle = (params.text || '').trim();
      const byValue = Array.from(el.options).find(o => o.value === needle);
      const byText = Array.from(el.options).find(o => o.text.trim() === needle)
        || Array.from(el.options).find(o => o.text.trim().toLowerCase().includes(needle.toLowerCase()));
      const match = byValue || byText;
      if (!match) {
        return noDispatchFailure(`No <option> matching "${params.text}" in select.`);
      }
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (actionDeadlineExpired()) return deadlineFailure();
      const dispatchResult = withLocalPageDispatch(() => {
        dispatched = true;
        if (nativeSetter) nativeSetter.call(el, match.value);
        else el.value = match.value;
        if (actionDeadlineExpired()) return deadlineFailure();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (actionDeadlineExpired()) return deadlineFailure();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      if (dispatchResult) return dispatchResult;
      await new Promise(resolve => setTimeout(resolve, 30));
      if (actionDeadlineExpired()) return deadlineFailure();
      return { success: true, ...(el.isConnected && el.value === match.value ? { verified: true } : {}), method: 'select', value: el.value };
    }

    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (actionDeadlineExpired()) return deadlineFailure();
    const dispatchResult = withLocalPageDispatch(() => {
      dispatched = true;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, (params.clear ? '' : (el.value || '')) + params.text);
      } else {
        el.value = (params.clear ? '' : (el.value || '')) + params.text;
      }
      if (actionDeadlineExpired()) return deadlineFailure();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (actionDeadlineExpired()) return deadlineFailure();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (dispatchResult) return dispatchResult;
    const verified = await verifyValue(el, typedText, params.clear === true, beforeValue);
    if (actionDeadlineExpired()) return deadlineFailure();

    // Duplicate-field detection. Input handlers can synchronously start a
    // same-document navigation, so never attribute the old field to the route
    // that happens to be current after verification yields.
    const routeStayedCurrent = location.href === routeHrefBeforeType;
    const fieldIdent = `${routeHrefBeforeType}|${el.tagName}|${el.name || el.id || ''}|${params.selector || 'focused'}`;
    let typeWarning;
    if (routeStayedCurrent && _lastTypeFieldIdent === fieldIdent) {
      typeWarning = 'You typed into the same field twice in a row. If you intended to fill a DIFFERENT field, click it first before calling type_text.';
    }
    _lastTypeFieldIdent = routeStayedCurrent ? fieldIdent : null;

    return { success: true, ...(verified === true ? { verified: true } : {}), value: (el.value || '').slice(0, 100), fieldMeta: _fieldMeta(el), ...(typeWarning ? { warning: typeWarning } : {}) };
  }

  /**
   * Locate and select literal page text without relying on browser chrome or
   * unsupported Ctrl/Cmd keyboard shortcuts.
   */
  function findText(params) {
    const text = String(params?.text || '').trim();
    if (!text) {
      return { success: false, found: false, dispatched: false, noDispatch: true, error: 'find_text: text is required.' };
    }
    if (text.length > 500) {
      return { success: false, found: false, dispatched: false, noDispatch: true, error: 'find_text: text must be 500 characters or fewer.' };
    }
    if (typeof window.find !== 'function') {
      return { success: false, found: false, dispatched: false, noDispatch: true, error: 'find_text is not supported on this page.' };
    }

    try {
      const matchCase = params?.matchCase === true;
      const backwards = params?.backwards === true;
      const wrap = params?.wrap !== false;
      // Match browser Find semantics across the whole page, including frames.
      // When the active match moves into a frame, the top document can retain
      // an older selection; frame focus keeps that stale range from verifying
      // the current hit.
      const found = window.find(text, matchCase, backwards, wrap, false, true, false);
      if (!found) {
        return {
          success: false,
          found: false,
          dispatched: false,
          noDispatch: true,
          query: text,
          error: `find_text: "${text}" was not found on the current page. Re-read the page or try a shorter literal phrase.`,
        };
      }
      const activeElement = window.document?.activeElement;
      const activeElementTag = String(activeElement?.tagName || '').toUpperCase();
      const inputType = String(activeElement?.type || 'text').toLowerCase();
      const isTextControl = activeElementTag === 'TEXTAREA'
        || (activeElementTag === 'INPUT' && ['text', 'search', 'url', 'tel', 'email'].includes(inputType));
      const normalizedQuery = text.normalize('NFC');
      const matchesQuery = (value) => {
        const normalizedValue = String(value || '').normalize('NFC');
        return matchCase
          ? normalizedValue === normalizedQuery
          : normalizedValue.toLowerCase() === normalizedQuery.toLowerCase();
      };
      const hasVisibleBounds = (candidate) => !!candidate
        && [candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite)
        && candidate.width > 0
        && candidate.height > 0;
      const selection = window.getSelection?.();
      const documentSelectedText = String(selection?.toString?.() || '');
      const documentBounds = selection?.rangeCount
        ? selection.getRangeAt(0).getBoundingClientRect()
        : undefined;
      let controlSelectedText = '';
      let controlBounds;
      const controlSelectionStart = activeElement?.selectionStart;
      const controlSelectionEnd = activeElement?.selectionEnd;
      if (
        isTextControl
        && Number.isInteger(controlSelectionStart)
        && Number.isInteger(controlSelectionEnd)
        && controlSelectionStart >= 0
        && controlSelectionEnd > controlSelectionStart
      ) {
        controlSelectedText = String(activeElement.value || '').slice(controlSelectionStart, controlSelectionEnd);
        controlBounds = activeElement.getBoundingClientRect?.();
      }
      const documentMatchesQuery = matchesQuery(documentSelectedText);
      const controlMatchesQuery = matchesQuery(controlSelectedText);
      let selectedText = documentSelectedText;
      let selectionSource = 'document';
      let bounds = documentBounds;
      if (documentMatchesQuery && hasVisibleBounds(documentBounds)) {
        // Keep the page selection. A focused field can retain an unrelated
        // selection while window.find advances to a normal document match.
      } else if (controlMatchesQuery && hasVisibleBounds(controlBounds)) {
        selectedText = controlSelectedText;
        bounds = controlBounds;
        selectionSource = 'text_control';
      }
      let rect;
      if (bounds) {
        const scrollX = Number.isFinite(Number(window.scrollX)) ? Number(window.scrollX) : 0;
        const scrollY = Number.isFinite(Number(window.scrollY)) ? Number(window.scrollY) : 0;
        rect = {
          x: bounds.x,
          y: bounds.y,
          pageX: bounds.x + scrollX,
          pageY: bounds.y + scrollY,
          width: bounds.width,
          height: bounds.height,
        };
      }
      const hasVisibleRect = !!rect
        && [rect.x, rect.y, rect.pageX, rect.pageY, rect.width, rect.height].every(Number.isFinite)
        && rect.width > 0
        && rect.height > 0;
      const selectionMatchesQuery = matchesQuery(selectedText);
      const selectionInFrame = activeElementTag === 'IFRAME' || activeElementTag === 'FRAME';
      const hasSelectionIdentity = selectionSource !== 'text_control'
        || (
          Number.isInteger(controlSelectionStart)
          && Number.isInteger(controlSelectionEnd)
          && controlSelectionStart >= 0
          && controlSelectionEnd > controlSelectionStart
        );
      const verified = selectionMatchesQuery && hasVisibleRect && hasSelectionIdentity && !selectionInFrame;
      return {
        success: true,
        found: true,
        verified,
        query: text,
        selectedText,
        selectionMatchesQuery,
        selectionSource,
        selectionInFrame,
        selectionScope: selectionInFrame ? 'frame_match_unverified' : 'current_match_only',
        ...(selectionSource === 'text_control'
          ? { selectionStart: controlSelectionStart, selectionEnd: controlSelectionEnd }
          : {}),
        replacesPreviousSelection: !selectionInFrame,
        browserFindUiOpened: false,
        ...(rect ? { rect } : {}),
        warning: verified
          ? 'Only this match is selected. This call replaced any previous page selection, and it did not open the browser Find UI. Do not claim earlier find_text matches remain highlighted.'
          : 'window.find reported a match, but WebBrain could not verify a visible current selection in the top document (for example, the active match may be inside a frame while an older top-document selection remains). Do not claim it is visibly highlighted. The browser Find UI was not opened.',
      };
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      return { success: false, found: false, dispatched: false, noDispatch: true, error: `find_text failed: ${error.message || error}` };
    }
  }

  /**
   * Press supported keyboard keys.
   */
  function pressKeys(params, actionDeadlineExpired = () => false) {
    let dispatched = false;
    const deadlineFailure = () => ({
      success: false,
      deadlineExpired: true,
      ...(dispatched
        ? { dispatched: true, outcomeUnknown: true, retryable: false }
        : { dispatched: false, noDispatch: true, outcomeUnknown: false, retryable: true }),
      error: dispatched
        ? 'The page action deadline expired during key dispatch.'
        : 'The page action deadline expired before key dispatch.',
    });
    const key = params?.key;
    const repeatRaw = Number(params?.repeat ?? 1);
    const repeat = Math.max(1, Math.min(3, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 1));
    const SUPPORTED_KEYS = ['Escape', 'Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ';'];
    if (!SUPPORTED_KEYS.includes(key)) {
      if (params?.dispatchBinding?.token) {
        _releaseDispatchBinding(params);
      }
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        error: `Unsupported key "${key}". Supported keys: ${SUPPORTED_KEYS.join(', ')}.`,
      };
    }

    // NOTE: this path dispatches untrusted (isTrusted: false) KeyboardEvents,
    // used only when CDP is unavailable (agent.js prefers the trusted CDP
    // dispatch — see agent.js's press_keys handler). Native browser default
    // actions (e.g. a range input actually moving) are only guaranteed for
    // trusted events, so arrow keys here reliably reach JS keydown listeners
    // but may not step native controls the way the CDP path does.
    const keyMeta = {
      Escape: { code: 'Escape', keyCode: 27 },
      Tab: { code: 'Tab', keyCode: 9 },
      Enter: { code: 'Enter', keyCode: 13 },
      ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 },
      ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      ';': { code: 'Semicolon', keyCode: 186 },
    }[key];
    const focusedTarget = _deepActiveElement();
    if (params?.dispatchBinding?.token) {
      const validation = _consumeFocusedDispatchBinding(params);
      if (validation.success !== true) return validation;
    }
    if (actionDeadlineExpired()) return deadlineFailure();
    if (params?.messageRecipientGuardRequired === true) {
      const recipientValidation = _consumeMessageRecipientDispatchBinding(params, focusedTarget);
      if (recipientValidation.success !== true) return recipientValidation;
    }
    if (actionDeadlineExpired()) return deadlineFailure();
    const target = (focusedTarget && focusedTarget !== document.body && focusedTarget !== document.documentElement)
      ? focusedTarget
      : document;

    const moveTabFocus = () => {
      const focusables = Array.from(document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (focusables.length === 0) return !actionDeadlineExpired();
      const active = document.activeElement;
      const currentIndex = focusables.indexOf(active);
      const nextIndex = (currentIndex + 1 + focusables.length) % focusables.length;
      if (actionDeadlineExpired()) return false;
      try { focusables[nextIndex].focus(); } catch (e) {}
      return !actionDeadlineExpired();
    };

    for (let i = 0; i < repeat; i++) {
      const down = new KeyboardEvent('keydown', {
        key,
        code: keyMeta.code,
        keyCode: keyMeta.keyCode,
        which: keyMeta.keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      const up = new KeyboardEvent('keyup', {
        key,
        code: keyMeta.code,
        keyCode: keyMeta.keyCode,
        which: keyMeta.keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      // Dispatch once on the target only. The events bubble, so listeners
      // attached at document/window level already receive them — dispatching
      // the same event object on document again would fire those listeners
      // twice per key (double-advancing ARIA listboxes, menus, etc.).
      if (actionDeadlineExpired()) return deadlineFailure();
      const expiredAfterKeydown = withLocalPageDispatch(() => {
        // Private page validation can consume the last part of the budget.
        // Recheck inside the dispatch callback before emitting keydown.
        if (actionDeadlineExpired()) return true;
        dispatched = true;
        target.dispatchEvent(down);
        // A keydown listener may run across the deadline. Always release the
        // synthetic key before returning the partial-dispatch timeout so pages
        // that track held keys are not left in a stuck state.
        const expired = actionDeadlineExpired();
        target.dispatchEvent(up);
        return expired;
      });
      if (expiredAfterKeydown) return deadlineFailure();
      if (key === 'Tab' && !moveTabFocus()) return deadlineFailure();
    }

    return { success: true, dispatched: true, key, repeat, method: 'keyboardevent', focusedTag: document.activeElement?.tagName || null };
  }

  /**
   * Scroll the page.
   */
  function legacyScrollPage(params, actionDeadlineExpired = () => false) {
    let dispatched = false;
    const deadlineFailure = () => ({
      success: false,
      dispatched,
      ...(dispatched
        ? { outcomeUnknown: true, retryable: false }
        : { noDispatch: true, outcomeUnknown: false, retryable: true }),
      deadlineExpired: true,
      error: dispatched
        ? 'The page action deadline expired during scroll dispatch.'
        : 'The page action deadline expired before scroll dispatch.',
    });
    if (actionDeadlineExpired()) return deadlineFailure();
    const amount = params.amount || 500;
    const direction = params.direction || 'down';

    // Find the best scrollable container. On many sites (Stripe, Jira, etc.)
    // the window itself isn't scrollable — the content lives inside a
    // scrollable div/section. Walk ancestors of the focused or last-clicked
    // element, or fall back to the most scrollable element on the page.
    let target = null;

    // Strategy 1: find a scrollable ancestor of the active/focused element.
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      let el = active.parentElement;
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = window.getComputedStyle(el);
          const ov = style.overflowY;
          if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') {
            target = el;
            break;
          }
        }
        el = el.parentElement;
      }
    }

    // Is the document itself scrollable? Used by Strategy 2 to decide whether
    // to also accept overflow:hidden panes (see the comment there). Strategy 3
    // — the unconditional window scroll near the end — runs regardless.
    const windowScrollable = document.documentElement.scrollHeight > window.innerHeight + 10;

    // Strategy 2: find the largest scrollable container on the page.
    if (!target) {
      let best = null;
      let bestArea = 0;
      const candidates = document.querySelectorAll('div, section, main, article, [role="main"], [role="dialog"]');
      for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = window.getComputedStyle(el);
          const ov = style.overflowY;
          // Normally require explicit scroll. When the document itself can't
          // scroll, also accept overflow:hidden — LinkedIn messaging and
          // similar virtualized scrollers wrap their content in
          // overflow:hidden panes that still update scrollTop and fire
          // scroll events programmatically, which their lazy-loaders listen
          // for. (overflow:clip blocks programmatic scrolling per spec, so
          // we don't accept it.)
          const isScrollable = ov === 'auto' || ov === 'scroll' || ov === 'overlay'
            || (!windowScrollable && ov === 'hidden');
          if (isScrollable) {
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
              bestArea = area;
              best = el;
            }
          }
        }
      }
      // Only use the container if it takes up a meaningful portion of the viewport.
      if (best && bestArea > window.innerWidth * window.innerHeight * 0.15) {
        target = best;
      }
    }

    if (target) {
      if (actionDeadlineExpired()) return deadlineFailure();
      window.__wbPageMonitor?.beforeLocalDispatch();
      dispatched = true;
      if (direction === 'down') target.scrollBy(0, amount);
      else if (direction === 'up') target.scrollBy(0, -amount);
      else if (direction === 'top') target.scrollTo(0, 0);
      else if (direction === 'bottom') target.scrollTo(0, target.scrollHeight);
    }
    if (actionDeadlineExpired()) return deadlineFailure();

    // Always also scroll the window in case both are needed (some pages have
    // both window and container scrolling).
    if (actionDeadlineExpired()) return deadlineFailure();
    window.__wbPageMonitor?.beforeLocalDispatch();
    dispatched = true;
    if (direction === 'down') window.scrollBy(0, amount);
    else if (direction === 'up') window.scrollBy(0, -amount);
    else if (direction === 'top') window.scrollTo(0, 0);
    else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);

    return {
      success: true,
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
      ...(target ? { scrolledContainer: true, containerScrollY: target.scrollTop, containerScrollHeight: target.scrollHeight } : {}),
    };
  }

  function smartScrollPage(params, actionDeadlineExpired = () => false) {
    let dispatched = false;
    const deadlineFailure = () => ({
      success: false,
      dispatched,
      ...(dispatched
        ? { outcomeUnknown: true, retryable: false }
        : { noDispatch: true, outcomeUnknown: false, retryable: true }),
      deadlineExpired: true,
      error: dispatched
        ? 'The page action deadline expired during scroll dispatch.'
        : 'The page action deadline expired before scroll dispatch.',
    });
    if (actionDeadlineExpired()) return deadlineFailure();
    params = params || {};
    const rawAmount = Number(params.amount);
    const amount = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : 500;
    const direction = params.direction || 'down';
    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    const beforeWindowY = window.scrollY;

    function docScrollHeight() {
      return Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        scrollingElement?.scrollHeight || 0
      );
    }

    function canMove(start, max, dir) {
      if (dir === 'down' || dir === 'bottom') return start < max - 1;
      if (dir === 'up' || dir === 'top') return start > 1;
      return false;
    }

    function canScrollWindow(dir) {
      const max = Math.max(0, docScrollHeight() - window.innerHeight);
      return canMove(window.scrollY, max, dir);
    }

    function canScrollElement(el, dir) {
      if (!el || el === document.body || el === document.documentElement) return false;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      return max > 1 && canMove(el.scrollTop, max, dir);
    }

    function scrollElementInstant(el, dir, px) {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (dir === 'down') el.scrollTop = Math.min(max, el.scrollTop + px);
      else if (dir === 'up') el.scrollTop = Math.max(0, el.scrollTop - px);
      else if (dir === 'top') el.scrollTop = 0;
      else if (dir === 'bottom') el.scrollTop = max;
    }

    function isScrollableElement(el, allowHidden = false) {
      if (!el || el === document.body || el === document.documentElement) return false;
      if (el.scrollHeight <= el.clientHeight + 10) return false;
      const ov = window.getComputedStyle(el).overflowY;
      return ov === 'auto' || ov === 'scroll' || ov === 'overlay' || (allowHidden && ov === 'hidden');
    }

    function elementSummary(el) {
      if (!el) return null;
      let rect = null;
      try {
        const r = el.getBoundingClientRect();
        rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      } catch {}
      return {
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        role: el.getAttribute?.('role') || '',
        // The scroll origin is often the focused control, such as the
        // account button just clicked (see _axModelName).
        text: _axModelName(el, (el.innerText || el.getAttribute?.('aria-label') || '').trim().slice(0, 80)),
        rect,
      };
    }

    function findScrollableAncestor(origin, dir, allowHidden = false) {
      const tag = origin?.tagName || '';
      const skipOrigin = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || origin?.isContentEditable;
      let el = skipOrigin ? origin.parentElement : origin;
      while (el && el !== document.body && el !== document.documentElement) {
        if (isScrollableElement(el, allowHidden) && canScrollElement(el, dir)) return el;
        el = el.parentElement;
      }
      return null;
    }

    function visibleTextChars(limit = 2000) {
      try {
        if (!document.body) return 0;
        let total = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const text = (node.nodeValue || '').trim();
            if (!text) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return NodeFilter.FILTER_REJECT;
            const r = parent.getBoundingClientRect();
            if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        let node;
        while ((node = walker.nextNode())) {
          total += (node.nodeValue || '').trim().length;
          if (total >= limit) return total;
        }
        return total;
      } catch {
        return null;
      }
    }

    let originEl = null;
    let origin = 'none';
    if (typeof params.ref_id === 'string' && typeof window.__wb_ax_lookup === 'function') {
      originEl = window.__wb_ax_lookup(params.ref_id);
      origin = originEl ? `ref_id:${params.ref_id}` : `missing-ref_id:${params.ref_id}`;
    }
    if (!originEl && params.x != null && params.y != null) {
      const x = Number(params.x);
      const y = Number(params.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        originEl = document.elementFromPoint(x, y);
        origin = params.origin === 'last_interaction' ? 'last_interaction' : 'point';
      }
    }
    if (!originEl) {
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        originEl = active;
        origin = 'activeElement';
      }
    }
    if (!originEl && _lastInteractionPoint && Date.now() - _lastInteractionPoint.ts < 60000) {
      originEl = document.elementFromPoint(_lastInteractionPoint.x, _lastInteractionPoint.y);
      origin = `last_interaction:${_lastInteractionPoint.source}`;
    }

    const windowScrollable = docScrollHeight() > window.innerHeight + 10;
    const windowCanMove = canScrollWindow(direction);
    let target = originEl ? findScrollableAncestor(originEl, direction, !windowScrollable) : null;
    let targetSource = target ? 'origin-ancestor' : 'none';

    if (!target && !windowCanMove) {
      let best = null;
      let bestArea = 0;
      const candidates = document.querySelectorAll('div, section, main, article, aside, [role="main"], [role="dialog"], [role="region"], [role="listbox"], [role="menu"]');
      for (const el of candidates) {
        if (!isScrollableElement(el, !windowScrollable) || !canScrollElement(el, direction)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1 || rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
      if (best && bestArea > window.innerWidth * window.innerHeight * 0.15) {
        target = best;
        targetSource = 'largest-visible-container';
      }
    }

    let containerBefore = null;
    let containerAfter = null;
    if (target) {
      containerBefore = target.scrollTop;
      if (actionDeadlineExpired()) return deadlineFailure();
      window.__wbPageMonitor?.beforeLocalDispatch();
      dispatched = true;
      scrollElementInstant(target, direction, amount);
      containerAfter = target.scrollTop;
    }
    if (actionDeadlineExpired()) return deadlineFailure();

    const movedContainer = target && Math.abs((containerAfter || 0) - (containerBefore || 0)) > 0.5;
    const shouldScrollWindow = params.alsoWindow === true || !movedContainer;
    if (shouldScrollWindow && windowCanMove) {
      if (actionDeadlineExpired()) return deadlineFailure();
      window.__wbPageMonitor?.beforeLocalDispatch();
      dispatched = true;
      if (direction === 'down') window.scrollBy(0, amount);
      else if (direction === 'up') window.scrollBy(0, -amount);
      else if (direction === 'top') window.scrollTo(0, 0);
      else if (direction === 'bottom') window.scrollTo(0, docScrollHeight());
    }

    const afterWindowY = window.scrollY;
    const movedWindow = Math.abs(afterWindowY - beforeWindowY) > 0.5;
    const textChars = visibleTextChars();
    const totalTextChars = (document.body?.innerText || '').trim().length;
    const warningParts = [];
    if (!movedContainer && !movedWindow) {
      warningParts.push('No scroll movement occurred; the current target may already be at its limit. Try the opposite direction, top/bottom, or pass ref_id/x/y for a different pane.');
    }
    if (movedContainer && !movedWindow && params.alsoWindow !== true) {
      warningParts.push('Scrolled the nearest scrollable container only; the window was left in place to avoid split-pane/listing pages drifting away from the intended area.');
    }
    if (textChars !== null && textChars < 20 && totalTextChars > 200) {
      warningParts.push('The viewport has almost no visible text after scrolling even though the document has text. The page may be lazy-rendered or between scroll panes; use get_accessibility_tree({filter:"visible"}) or scroll with ref_id/x/y instead of assuming the page is empty.');
    }

    return {
      success: true,
      scrollY: afterWindowY,
      scrollHeight: docScrollHeight(),
      viewportHeight: window.innerHeight,
      moved: movedContainer || movedWindow,
      movedWindow,
      movedContainer: !!movedContainer,
      origin,
      ...(originEl ? { originElement: elementSummary(originEl) } : {}),
      ...(target ? {
        scrolledContainer: true,
        targetSource,
        targetElement: elementSummary(target),
        containerScrollY: containerAfter,
        containerScrollYBefore: containerBefore,
        containerScrollHeight: target.scrollHeight,
        containerClientHeight: target.clientHeight,
      } : {}),
      scrollYBefore: beforeWindowY,
      visibleTextChars: textChars,
      documentTextChars: totalTextChars,
      ...(warningParts.length ? { warning: warningParts.join(' ') } : {}),
    };
  }

  function scrollPage(params, actionDeadlineExpired = () => false) {
    try {
      return smartScrollPage(params, actionDeadlineExpired);
    } catch (e) {
     if (e?.code === 'page_feedback_pending') throw e;
      if (e?.code === 'page_feedback_pending') throw e;
      const fallback = legacyScrollPage(params || {}, actionDeadlineExpired);
      return {
        ...fallback,
        warning: `Smart scroll targeting failed (${e && e.message || e}); fell back to legacy window/container scroll.`,
      };
    }
  }

  /**
   * Extract structured data (tables, lists) from the page.
   */
  function extractData(params) {
    const type = params.type || 'tables';

    if (type === 'tables') {
      if (Array.isArray(params.columns)) {
        const tables = Array.from(document.querySelectorAll('table'));
        const hasCaption = params.caption !== undefined;
        const hasIndex = params.table_index !== undefined;
        if ((hasCaption && (typeof params.caption !== 'string' || !params.caption))
            || (hasIndex && (!Number.isSafeInteger(params.table_index) || params.table_index < 0))
            || (hasCaption && hasIndex)) {
          return { success: false, error: 'Use one exact caption or one nonnegative table_index. No complete export was captured.' };
        }
        const matches = typeof params.caption === 'string'
          ? tables.filter(table => (table.caption?.innerText || '').trim() === params.caption)
          : Number.isSafeInteger(params.table_index) && params.table_index >= 0
            ? tables.slice(params.table_index, params.table_index + 1)
            : tables.length === 1 ? tables : [];
        if (matches.length !== 1) return { success: false, error: 'Select exactly one table by its exact caption or table_index. No complete export was captured.' };
        const table = matches[0];
        const first = params.first_data_row === undefined ? 1 : params.first_data_row;
        if (!Number.isSafeInteger(first) || first < 0) return { success: false, error: 'first_data_row must be a nonnegative integer.' };
        const nativeRows = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table);
        const cellsOf = row => Array.from(row.querySelectorAll('th,td')).filter(cell => cell.closest('tr') === row)
          .map(cell => typeof cell.innerText === 'string' ? cell.innerText : cell.textContent || '');
        // Source headers remain evidence even when the caller includes row zero
        // or renames a sensitive column in its requested output schema.
        const headerRows = [];
        let headerChars = 0;
        for (const [index, row] of nativeRows.entries()) {
          if (index !== 0 && row.closest('thead')?.closest('table') !== table
              && !Array.from(row.querySelectorAll('th')).some(cell => cell.closest('tr') === row)) continue;
          const cells = cellsOf(row);
          headerChars += cells.reduce((sum, cell) => sum + cell.length, 0);
          if (headerRows.length >= 10000 || headerChars > 2000000) {
            return { success: false, error: 'The source headers exceed the complete snapshot limit. No sampled export is returned.' };
          }
          headerRows.push(cells);
        }
        const filter = params.row_filter;
        if (filter !== undefined && (!filter || typeof filter !== 'object' || Array.isArray(filter)
            || !Number.isSafeInteger(filter.column) || filter.column < 0
            || !Array.isArray(filter.equals) || filter.equals.length > 10000
            || filter.equals.some(value => typeof value !== 'string'))) {
          return { success: false, error: 'row_filter needs a column index and exact string values.' };
        }
        const selected = filter ? new Set(filter.equals) : null;
        const found = new Set();
        const rows = [];
        let chars = 0;
        for (const row of nativeRows.slice(first)) {
          const cells = cellsOf(row);
          if (selected && !selected.has(cells[filter.column])) continue;
          if (selected) found.add(cells[filter.column]);
          chars += cells.reduce((sum, cell) => sum + cell.length, 0);
          if (rows.length >= 10000 || chars > 2000000) return { success: false, error: 'The complete table exceeds the snapshot limit. Select explicit rows or fewer data; no sampled export is returned.' };
          rows.push(cells);
        }
        if (selected && [...selected].some(value => !found.has(value))) {
          return { success: false, error: 'One or more exact row_filter values were not found in the selected table. No complete export was captured.' };
        }
        if (!window.__wbAxDocumentToken) window.__wbAxDocumentToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        return { schema: 'webbrain.table-snapshot.v1', success: true,
          documentToken: window.__wbAxDocumentToken, pageUrl: location.href,
          tableIndex: tables.indexOf(table), caption: (table.caption?.innerText || '').trim(), headerRows, rows };
      }
      return Array.from(document.querySelectorAll('table')).slice(0, 10).map((table, i) => {
        const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
          Array.from(tr.querySelectorAll('th, td')).map(cell => cell.innerText.trim())
        );
        return { index: i, rows };
      });
    }

    if (type === 'headings') {
      return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
        level: parseInt(h.tagName[1]),
        text: h.innerText.trim(),
      }));
    }

    if (type === 'images') {
      return Array.from(document.querySelectorAll('img[src]')).slice(0, 50).map(img => ({
        src: img.src,
        alt: img.alt || '',
        width: img.naturalWidth,
        height: img.naturalHeight,
      }));
    }

    return { error: `Unknown data type: ${type}` };
  }

  /**
   * Wait for a selector to appear on the page.
   */
  function waitForElement(params) {
    return new Promise((resolve) => {
      const timeout = params.timeout || 5000;
      // Validate the selector up front: an invalid selector makes
      // querySelector throw SyntaxError, which would reject this promise
      // and leave the caller hanging on a response that never arrives.
      let existing;
      try {
        existing = document.querySelector(params.selector);
      } catch (e) {
        if (e?.code === 'page_feedback_pending') throw e;
        resolve({
          success: false,
          found: false,
          error: `Invalid selector "${params.selector}": ${e.message}. Use plain CSS — jQuery/Playwright extensions like :contains() or :has-text() are not supported.`,
        });
        return;
      }
      if (existing) {
        resolve({ success: true, found: true });
        return;
      }

      const observer = new MutationObserver(() => {
        if (document.querySelector(params.selector)) {
          observer.disconnect();
          resolve({ success: true, found: true });
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve({ success: true, found: false, timedOut: true });
      }, timeout);
    });
  }

  const PAGE_GATE_SELECTORS = [
    '[role="dialog"]', '[role="alertdialog"]', 'dialog[open]', '[aria-modal="true"]',
    '[class*="paywall" i]', '[id*="paywall" i]',
    '[class*="gateway" i]', '[id*="gateway" i]',
    '[class*="regiwall" i]', '[id*="regiwall" i]',
    '[class*="subscription" i]', '[id*="subscription" i]',
    '[data-testid*="paywall" i]', '[data-testid*="gateway" i]',
    '[data-testid*="subscription" i]', '[data-testid*="registration" i]',
  ];

  function gateElementIsRendered(el) {
    if (!el || !el.isConnected) return false;
    let rect;
    try {
      rect = el.getBoundingClientRect();
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false;
        if (node.getAttribute?.('aria-hidden') === 'true') return false;
      }
    } catch {
      return false;
    }
    return rect.width >= 20 && rect.height >= 20;
  }

  // What an overlay or a block in an article asks of its reader, read by a
  // model in any language from its text (the agent's page_blocker readings):
  // a subscription, registration or sign-in wall in front of the article. A
  // text nobody has read yet is no wall; it is reported for the agent to
  // read, and the agent asks again with the reading.
  const PAGE_GATE_TYPES = new Set(['subscription', 'registration', 'login']);
  // The longest text one wall reading covers; how many of a block's texts are
  // read at most; and how many texts nobody has read one page read reports at
  // most (the agent reads them and reads the page again, up to three times).
  const PAGE_GATE_TEXT_LIMIT = 600;
  const PAGE_GATE_BLOCK_CHUNKS = 30;
  const PAGE_GATE_UNREAD_BUDGET = 40;

  // At most PAGE_GATE_TEXT_LIMIT characters of a text, keyed as the readings
  // key it: spaces collapsed, and no space or half of a surrogate pair at
  // either end.
  function pageGateSlice(value) {
    return _pageReadingText(_pageReadingText(value).slice(0, PAGE_GATE_TEXT_LIMIT)
      .replace(/^[\udc00-\udfff]/, '').replace(/[\ud800-\udbff]$/, ''));
  }

  // What a text reads as: a wall's kind, 'other' when it was read as no wall
  // (or is empty), or null when nobody has read it. Within one page read only
  // the first PAGE_GATE_UNREAD_BUDGET texts nobody has read are reported to
  // the agent, the likeliest walls first; the rest wait for the next read.
  function pageGateReading(text, budget) {
    if (!text) return 'other';
    const known = _pageReading('page_blocker', text, null, { queue: false, maxLength: PAGE_GATE_TEXT_LIMIT });
    if (known) return PAGE_GATE_TYPES.has(known) ? known : 'other';
    // A text that differs only in its numbers from texts read as a wall,
    // such as a countdown's next second, is that wall: at once, and still
    // reported to be read until two texts of its shape were read as that
    // wall, so a model's reading of the text itself replaces the guess and a
    // quota that stops being a wall when its number changes reads as what it
    // is.
    const shaped = _pageBlockerWallByShape(text);
    if (shaped?.confirmed && PAGE_GATE_TYPES.has(shaped.choice)) return shaped.choice;
    const provisional = shaped && PAGE_GATE_TYPES.has(shaped.choice) ? shaped.choice : null;
    if (!budget.seen.has(text)) {
      if (budget.left <= 0) return provisional;
      budget.left -= 1;
      budget.seen.add(text);
    }
    _pageReading('page_blocker', text, null, { maxLength: PAGE_GATE_TEXT_LIMIT });
    return provisional;
  }

  // Whether an element lays its children out as blocks, so its text splits
  // into them; an element of inline text is one part however long it is.
  function pageGateHasBlockChildren(el, depth = 0) {
    for (const child of el.children) {
      let display = '';
      try { display = getComputedStyle(child).display; } catch { continue; }
      if (display === 'contents') {
        if (depth < 20 && pageGateHasBlockChildren(child, depth + 1)) return true;
        continue;
      }
      if (display && display !== 'none' && !display.startsWith('inline')) return true;
    }
    return false;
  }

  // A block's rendered text in parts, in page order: an element whose text
  // is at most PAGE_GATE_TEXT_LIMIT characters, or that holds only inline
  // text, is one part; a longer one with block children is split into them,
  // and text standing directly in it is a part held by it. Hidden elements
  // are left out. Each part keeps its first line.
  function pageGateParts(el) {
    const parts = [];
    const firstLine = value => _pageReadingText(String(value || '').split('\n').find(line => line.trim()) || '');
    const visit = (node, depth) => {
      for (const child of node.childNodes) {
        if (parts.length >= 600) return;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = _pageReadingText(child.data);
          if (text) parts.push({ text, line: text, element: node, heading: false });
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE || /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(child.tagName)) continue;
        let display = '';
        try { display = getComputedStyle(child).display; } catch { /* treat as rendered */ }
        if (display === 'none') continue;
        if (display === 'contents') {
          if (depth < 40) visit(child, depth + 1);
          continue;
        }
        if (!child.getClientRects?.().length) continue;
        const raw = String(child.innerText || '');
        const text = _pageReadingText(raw);
        if (!text) continue;
        if (text.length <= PAGE_GATE_TEXT_LIMIT || depth >= 40 || !pageGateHasBlockChildren(child)) {
          parts.push({ text, line: firstLine(raw), element: child,
            heading: child.matches?.('h1, h2, h3, h4, h5, h6, [role="heading"]') === true });
        } else {
          visit(child, depth + 1);
        }
      }
    };
    visit(el, 0);
    return parts;
  }

  // A block's parts gathered, in page order, into texts of at most
  // PAGE_GATE_TEXT_LIMIT characters, a heading starting a new one; a longer
  // part is read in pieces of that length. Each is read as a whole: a wall
  // read in it starts no earlier than the element it begins in, and its label
  // is that element's first line, none for a piece after a long part's first.
  function pageGateChunks(parts) {
    const chunks = [];
    for (const part of parts) {
      if (part.text.length > PAGE_GATE_TEXT_LIMIT) {
        for (let offset = 0; offset < part.text.length && chunks.length < 1000; offset += PAGE_GATE_TEXT_LIMIT) {
          chunks.push({ text: part.text.slice(offset, offset + PAGE_GATE_TEXT_LIMIT), element: part.element,
            line: offset ? '' : part.line, closed: true });
        }
        continue;
      }
      const last = chunks[chunks.length - 1];
      if (last && !last.closed && !part.heading && last.text.length + 1 + part.text.length <= PAGE_GATE_TEXT_LIMIT) {
        last.text += ' ' + part.text;
      } else {
        chunks.push({ text: part.text, element: part.element, line: part.line, closed: false });
      }
    }
    return chunks.map(chunk => ({ ...chunk, text: pageGateSlice(chunk.text) }));
  }

  // The wall an overlay or article block shows, or null when none of its
  // texts reads as one (a text nobody has read included). Its texts are its
  // own name and title and its chunks, read in page order up to the first
  // chunk read as a wall, at most PAGE_GATE_BLOCK_CHUNKS of them. In an
  // article the wall starts at that chunk, or at a chunk before it nobody has
  // read, since the wall's text may be there: only text read as no wall comes
  // before it. A block whose name or title reads as a wall starts at its top;
  // an overlay is the wall as a whole. The label is the wall's name or title,
  // or the first line its starting chunk begins with, and none when that
  // chunk was not read as the wall: what follows a wall's first line may be
  // the article it withholds.
  function pageGateWall(el, inline, budget) {
    const named = [...new Set([el.getAttribute('aria-label'), el.getAttribute('title')].map(pageGateSlice))].filter(Boolean);
    const namedReadings = named.map(text => pageGateReading(text, budget));
    const namedIndex = namedReadings.findIndex(reading => PAGE_GATE_TYPES.has(reading));
    const chunks = pageGateChunks(pageGateParts(el)).slice(0, PAGE_GATE_BLOCK_CHUNKS);
    let wallIndex = -1, unread = -1, wallType = null;
    for (let index = 0; index < chunks.length; index += 1) {
      const reading = pageGateReading(chunks[index].text, budget);
      if (PAGE_GATE_TYPES.has(reading)) {
        wallIndex = index;
        wallType = reading;
        break;
      }
      if (reading === null && unread < 0) unread = index;
    }
    if (wallIndex < 0 && namedIndex < 0) return null;
    const type = namedIndex >= 0 ? namedReadings[namedIndex] : wallType;
    const label = text => pageGateSlice(String(text || '').slice(0, 240));
    if (namedIndex >= 0) return { type, label: label(named[namedIndex]), element: el };
    if (!inline) return { type, label: label(chunks[wallIndex].line), element: el };
    const start = unread >= 0 && unread < wallIndex ? unread : wallIndex;
    return {
      type,
      label: start === wallIndex ? label(chunks[wallIndex].line) : '',
      element: start === 0 ? el : chunks[start].element,
    };
  }

  // Whether a block offers a control a wall would: a button, a field, a form,
  // or a link standing on its own rather than inside a paragraph.
  function pageGateOffersControl(el) {
    try {
      if (el.querySelector('button, input, select, textarea, form, [role="button"]')) return true;
      return Array.from(el.querySelectorAll('a[href]')).slice(0, 50)
        .some(link => !link.closest('p, li, blockquote, figcaption, td, dd'));
    } catch {
      return false;
    }
  }

  function pageHasArticleContext() {
    try {
      return !!(
        document.querySelector('meta[property="og:type"][content="article"]') ||
        document.querySelector('meta[name="article:published_time"]') ||
        document.querySelector('[itemtype*="Article" i]') ||
        document.querySelector('article, [role="article"]')
      );
    } catch {
      return false;
    }
  }

  function pageGatePublic(gate) {
    if (!gate) return null;
    return {
      type: gate.type,
      blocking: true,
      surface: gate.surface,
      label: gate.label,
    };
  }

  function detectPageGate() {
    const seen = new Set();
    const found = [];
    const articleContext = pageHasArticleContext();
    for (const selector of PAGE_GATE_SELECTORS) {
      let matches = [];
      try { matches = document.querySelectorAll(selector); } catch { continue; }
      for (const el of matches) {
        if (seen.has(el) || !gateElementIsRendered(el)) continue;
        seen.add(el);
        const role = String(el.getAttribute('role') || '').toLowerCase();
        let surface = (role === 'dialog' || role === 'alertdialog' || el.tagName === 'DIALOG'
          || el.getAttribute('aria-modal') === 'true') ? 'dialog' : 'inline';
        const inArticle = !!el.closest('article, [role="article"], main, [role="main"]');
        let coveringOverlay = false;
        try {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
          const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
          const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
          coveringOverlay = ['fixed', 'sticky', 'absolute'].includes(style.position) &&
            ((visibleWidth * visibleHeight) / viewportArea) >= 0.2;
        } catch { /* rendered check already supplied safe defaults */ }
        if (coveringOverlay) surface = 'dialog';
        // An overlay counts only on an article page, and a block only inside
        // the article; its text then has to read as a wall.
        if (surface === 'dialog' ? !articleContext : !inArticle) continue;
        found.push({ el, surface, inArticle, coveringOverlay, offersControl: pageGateOffersControl(el) });
      }
    }
    // Overlays are read first, then blocks that offer a control a wall would,
    // then the rest, each in page order, so the texts one page read reports go
    // to the likeliest walls.
    found.sort((a, b) => (Number(b.surface === 'dialog') - Number(a.surface === 'dialog'))
      || (Number(b.offersControl) - Number(a.offersControl))
      || (a.el === b.el ? 0 : (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)));
    const budget = { left: PAGE_GATE_UNREAD_BUDGET, seen: new Set() };
    const candidates = [];
    for (const { el, surface, inArticle, coveringOverlay } of found) {
      const wall = pageGateWall(el, surface === 'inline', budget);
      if (!wall) continue;
      const label = wall.label;
      const namedGate = /paywall|gateway|regiwall|subscription|registration/i.test([
        el.id,
        typeof el.className === 'string' ? el.className : '',
        el.getAttribute('data-testid') || '',
      ].join(' '));
      const score = (surface === 'dialog' ? 100 : 0) + (inArticle ? 40 : 0) +
        (coveringOverlay ? 30 : 0) + (namedGate ? 15 : 0) - Math.min(label.length, 2000) / 2000;
      candidates.push({ element: wall.element, type: wall.type, surface, label, score });
    }
    // An overlay that is a wall withholds the whole article. Of the walls in
    // an article, the one that starts first decides where reading stops.
    const overlays = candidates.filter(candidate => candidate.surface === 'dialog').sort((a, b) => b.score - a.score);
    if (overlays.length) return overlays[0];
    const blocks = candidates.filter(candidate => candidate.surface === 'inline');
    blocks.sort((a, b) => (a.element === b.element ? 0
      : (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)));
    return blocks[0] || null;
  }

  function renderedArticleTextBeforeGate(root, gateElement) {
    if (!root || !gateElement || !root.contains(gateElement)) return '';
    const blocks = [];
    const seenText = new Set();
    let nodes = [];
    try { nodes = root.querySelectorAll('h1, h2, h3, p, li, blockquote, figcaption'); } catch { return ''; }
    for (const node of nodes) {
      if (node === gateElement || gateElement.contains(node) || node.contains(gateElement)) continue;
      if (!(node.compareDocumentPosition(gateElement) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (!gateElementIsRendered(node) || node.closest('nav, header, footer, aside, [aria-hidden="true"]')) continue;
      const value = String(node.innerText || '').replace(/\s+/g, ' ').trim();
      if (!value || seenText.has(value)) continue;
      seenText.add(value);
      blocks.push(value);
    }
    return blocks.join('\n\n').trim();
  }

  function getVisibleLayers() {
    const selectors = [
      'header', 'nav', '[role="banner"]', '[role="navigation"]',
      '[role="toolbar"]', '[class*="toolbar" i]',
      '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
      'dialog[open]', '.modal.show', '[class*="DialogContent"]', '[class*="ModalContent"]',
      '[data-overlay]', '[class*="overlay" i]', '[class*="popover" i]', '[class*="drawer" i]',
    ].join(',');
    const layers = [];
    let candidates = [];
    try { candidates = Array.from(document.querySelectorAll(selectors)); } catch { return []; }
    const dialogSelector = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],.modal.show,[class*="DialogContent"],[class*="ModalContent"]';
    // Preserve the active dialog even when the page has many fixed nav items.
    candidates.sort((a, b) => Number(b.matches(dialogSelector)) - Number(a.matches(dialogSelector)));
    for (const el of candidates) {
      if (layers.length >= 4) break;
      try {
        if (!gateElementIsRendered(el)) continue;
        const style = getComputedStyle(el);
        if (!['fixed', 'sticky', 'absolute'].includes(style.position) && !(el.tagName === 'DIALOG' && el.open)) continue;
        const r = el.getBoundingClientRect();
        const left = Math.max(0, r.left), right = Math.min(window.innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(window.innerHeight, r.bottom);
        if (right - left < 10 || bottom - top < 10) continue;
        if (layers.some(layer => layer.element.contains(el) || el.contains(layer.element))) continue;
        const text = String(el.innerText || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ').trim().slice(0, 240);
        if (!text) continue;
        const points = [
          [(left + right) / 2, (top + bottom) / 2],
          [left + (right - left) * 0.2, top + (bottom - top) * 0.2],
          [right - (right - left) * 0.2, bottom - (bottom - top) * 0.2],
        ];
        if (!points.some(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return hit === el || el.contains(hit);
        })) continue;
        layers.push({
          element: el,
          role: (el.getAttribute('role') || el.tagName.toLowerCase()).slice(0, 80),
          text,
          position: style.position,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      } catch { /* ignore malformed or changing page surfaces */ }
    }
    return layers.map(({ element, ...layer }) => layer);
  }

  function getPageInfoFull(params) {
    // `includeChrome:true` opts out of nav/footer/aside stripping. Default
    // false because the original behaviour (full body.innerText) bloated
    // article reads with sitemap / cookie-banner / newsletter chrome and
    // truncated the actual article body off the end. Set to true when the
    // user is asking ABOUT the navigation, footer, cookie banner, etc.
    const includeChrome = !!(params && params.includeChrome);

    // Article-priority selectors in roughly increasing specificity. The
    // first selector with >300 chars of visible text wins. Standard
    // semantic tags first (article, [role="article"], itemprop), then
    // common site-builder patterns (.article-body, .post-content, etc.),
    // then layout fallbacks (main, .content).
    const ARTICLE_SELECTORS = [
      '[itemprop="articleBody"]',
      'article [class*="article-body" i]',
      'article [class*="article__content" i]',
      'article [class*="article__body" i]',
      'article [class*="story-body" i]',
      'article [class*="post-content" i]',
      'article [class*="entry-content" i]',
      '[role="article"]',
      'article',
      'main article',
      '.article-body, .article__body, .article__content',
      '.post-content, .entry-content, .story-body, .story-content',
      'main',
      '[role="main"]',
      '.content',
      '#content',
    ];

    // Inside the chosen container, prune nav/footer/aside/ads/comments
    // BEFORE measuring text length. CNN, NYT, etc. all wrap newsletter
    // signups, related-articles widgets, and ad slots inside <article>,
    // which used to push the real article body off the end of the
    // truncation window.
    const CHROME_DROP_SELECTORS = [
      'nav', 'header', 'footer', 'aside',
      '[role="navigation"]', '[role="banner"]',
      '[role="contentinfo"]', '[role="complementary"]',
      'script', 'style', 'noscript', 'iframe', 'svg',
      '[aria-hidden="true"]',
      '[class*="advertisement" i]', '[class*="ad-slot" i]',
      '[class*="ad-container" i]', '[id*="ad-" i][id*="-slot" i]',
      '[class*="newsletter" i][class*="signup" i]',
      '[class*="newsletter-promo" i]',
      '[class*="social-share" i]', '[class*="share-tools" i]',
      '[class*="related-articles" i]', '[class*="recommended" i]',
      '[class*="more-stories" i]', '[class*="paid-content" i]',
      '[class*="comments" i][class*="section" i]',
      '[class*="cookie-banner" i]', '[id*="cookie-banner" i]',
      '[class*="onetrust" i]',
    ];

    const stripChrome = root => {
      if (includeChrome || !root) return root;
      // Clone so we never mutate the live page DOM.
      let clone;
      try { clone = root.cloneNode(true); }
      catch { return root; }
      for (const sel of CHROME_DROP_SELECTORS) {
        try { clone.querySelectorAll(sel).forEach(n => n.remove()); }
        catch { /* invalid selector on some browsers — skip */ }
      }
      return clone;
    };

    // Tells the caller why this page was treated as an article. Models can
    // use this to decide "I have the article body, stop fetching more".
    let textSource = 'body';
    let isArticlePage = false;
    try {
      isArticlePage = !!(
        document.querySelector('meta[property="og:type"][content="article"]') ||
        document.querySelector('meta[name="article:published_time"]') ||
        document.querySelector('[itemtype*="Article" i]') ||
        document.querySelector('article')
      );
    } catch { /* malformed selector engines — ignore */ }

    const gate = detectPageGate();
    const pageGate = pageGatePublic(gate);

    const getText = () => {
      if (gate?.surface === 'dialog') {
        textSource = 'page-gate';
        return gate.label;
      }
      if (gate?.surface === 'inline') {
        const articleRoot = gate.element.closest('article, [role="article"], main, [role="main"]');
        textSource = 'article (pre-gate)';
        return renderedArticleTextBeforeGate(articleRoot, gate.element) || gate.label;
      }
      for (const sel of ARTICLE_SELECTORS) {
        let el;
        try { el = document.querySelector(sel); } catch { continue; }
        if (!el) continue;
        const cleaned = stripChrome(el);
        const txt = (cleaned && cleaned.innerText ? cleaned.innerText : '').trim();
        if (txt.length > 300) { textSource = sel; return txt; }
      }
      // Whole-body fallback: still strip chrome unless the caller opted in.
      const fallback = stripChrome(document.body);
      textSource = includeChrome ? 'body (raw)' : 'body (chrome-stripped)';
      return (fallback && fallback.innerText ? fallback.innerText : '').trim();
    };

    const getShadowContent = (root = document) => {
      const shadowContent = [];
      const hosts = root.querySelectorAll('*');
      hosts.forEach(el => {
        if (el.shadowRoot) {
          shadowContent.push({
            host: el.tagName.toLowerCase(),
            id: el.id || '',
            className: el.className || '',
            mode: el.shadowRoot.mode,
            text: el.shadowRoot.innerText?.trim().slice(0, 500) || '',
          });
          shadowContent.push(...getShadowContent(el.shadowRoot));
        }
      });
      return shadowContent;
    };

    const text = getText();
    const blockedAuxiliaryContent = pageGate?.blocking === true;
    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      ...(pageGate ? { pageGate } : {}),
      text,
      // Tells the model where this text came from. When `textSource` is a
      // real article selector and `isArticlePage` is true, the model can
      // assume it has the complete article body and stop fetching more
      // (the long tail of fetch_url / scroll cycles in trace 2 happened
      // because the model couldn't tell the article had ended vs. been
      // truncated). `includeChrome` reports the effective option.
      textSource,
      isArticlePage,
      includeChrome,
      visibleLayers: blockedAuxiliaryContent ? [] : getVisibleLayers(),
      media: blockedAuxiliaryContent
        ? { videoCount: 0, imageCount: 0, videos: [], images: [] }
        : getPageMediaSummary(),
      activeElement: blockedAuxiliaryContent ? null : getActiveEditableSummary(),
      links: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: _axModelName(a, a.innerText.trim().slice(0, 100)),
        href: _axModelHref(a, a.href),
      })),
      forms: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('form')).map((form, i) => ({
        id: form.id || `form-${i}`,
        action: form.action,
        inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(el => ({
          type: el.type || el.tagName.toLowerCase(),
          name: el.name,
          id: el.id,
          placeholder: el.placeholder || '',
          value: el.value || '',
        })),
      })),
      shadowDOM: blockedAuxiliaryContent ? [] : getShadowContent(),
      iframes: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('iframe')).map((iframe, i) => ({
        index: i,
        src: iframe.src,
        id: iframe.id || '',
        name: iframe.name || '',
        visible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0,
      })),
    };
  }

  function queryInteractiveFull() {
    const collected = []; // {el, rect, inShadow}
    const seen = new Set(); // dedupe nested wrappers (button > span > svg etc.)
    const modal = _findTopmostBlockingModal();

    const isUsable = (el, rect) => {
      if (_hasComposedClosest(el, '[aria-hidden="true"], [inert]')) return false;
      // Keep the agent-facing list and every indexed follow-up action inside
      // the same topmost modal/dialog boundary as the legacy collector.
      if (modal && !_isComposedAncestor(modal, el)) return false;
      // Visible and in viewport. Aggressive filtering on purpose: a global
      // header link scrolled offscreen creates noise indices that shift
      // every page and confuse models that trust index across turns.
      // Exception: form inputs may have zero dimensions if they use styled
      // wrappers (Stripe, Radix, Material). We still want to include them.
      if (rect.width < 2 || rect.height < 2) {
        if (/^(INPUT|SELECT|TEXTAREA)$/i.test(el.tagName)) {
          // Allow through — getInteractiveElementsFull will use wrapper rect
        } else {
          return false;
        }
      }
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      if (rect.right < 0 || rect.left > window.innerWidth) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (cs.pointerEvents === 'none') return false;
      // Skip elements that are descendants of an already-collected element
      // with the same approximate bounds (e.g. <button><span>X</span></button>
      // — both match selectors, only the button is useful).
      let parent = el.parentElement;
      while (parent) {
        if (seen.has(parent)) {
          const pRect = parent.getBoundingClientRect();
          if (Math.abs(pRect.left - rect.left) < 4 && Math.abs(pRect.top - rect.top) < 4) {
            return false;
          }
        }
        parent = parent.parentElement;
      }
      return true;
    };

    const pierceShadow = (root) => {
      const selectors = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
        '[onclick]', '[data-action]', 'summary', ..._siteInteractiveSelectors(),
      ];
      selectors.forEach(sel => {
        try {
          root.querySelectorAll(sel).forEach(el => {
            if (seen.has(el)) return;
            if (!_isUsableSiteInteractive(el)) return;
            let rect = el.getBoundingClientRect();
            // Use wrapper rect for zero-dimension form inputs
            if ((rect.width < 2 || rect.height < 2) && /^(INPUT|SELECT|TEXTAREA)$/i.test(el.tagName)) {
              let fb = null;
              if (el.id) { try { const lbl = document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if (lbl) { const lr = lbl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fb = lr; } } catch {} }
              if (!fb) { const wl = el.closest('label'); if (wl) { const lr = wl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fb = lr; } }
              if (!fb) { let p = el.parentElement; for (let i = 0; i < 3 && p; i++, p = p.parentElement) { const pr = p.getBoundingClientRect(); if (pr.width > 0 && pr.height > 0) { fb = pr; break; } } }
              if (fb) rect = fb;
            }
            if (!isUsable(el, rect)) return;
            seen.add(el);
            collected.push({ el, rect, inShadow: root !== document });
          });
        } catch (e) {}
      });
      // Recurse into open shadow roots.
      try {
        root.querySelectorAll('*').forEach(host => {
          if (host.shadowRoot) pierceShadow(host.shadowRoot);
        });
      } catch (e) {}
    };

    pierceShadow(document);

    // Sort by visual position (top-to-bottom, then left-to-right) so indices
    // correspond to reading order — stable enough that two get_interactive_
    // elements calls in a row on the same scrollstate produce the same
    // numbering, even if the DOM has minor reorderings.
    collected.sort((a, b) => {
      const dy = a.rect.top - b.rect.top;
      if (Math.abs(dy) > 6) return dy;
      return a.rect.left - b.rect.left;
    });

    // Upload controls are commonly CSS-hidden behind a styled drop zone. Keep
    // visible action indices stable by appending any omitted file inputs only
    // after the visual sort; their records expose selectors for upload_file.
    const appendOmittedFileInputs = (root) => {
      try {
        root.querySelectorAll('input[type="file"]').forEach(el => {
          if (seen.has(el)) return;
          seen.add(el);
          collected.push({
            el,
            rect: el.getBoundingClientRect(),
            inShadow: root !== document,
          });
        });
        root.querySelectorAll('*').forEach(host => {
          if (host.shadowRoot) appendOmittedFileInputs(host.shadowRoot);
        });
      } catch (e) {}
    };
    appendOmittedFileInputs(document);

    return collected;
  }

  function queryInteractiveForToolIndex() {
    // The agent maps get_interactive_elements to the full/CDP collector
    // above, so index-based follow-up actions (click, type_text) must
    // resolve against that same ordering. The legacy queryInteractive()
    // order is still used by the plain content handler but it is not the
    // list the agent sees.
    return queryInteractiveFull().map(c => c.el);
  }

  function _cssString(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\0/g, '\uFFFD')
      .replace(/[\n\r\f]/g, ch => `\\${ch.codePointAt(0).toString(16)} `);
  }

  function _deepSelectorMatches(selector) {
    const matches = [];
    const visit = (root) => {
      root.querySelectorAll(selector).forEach(el => matches.push(el));
      root.querySelectorAll('*').forEach(host => {
        if (host.shadowRoot) visit(host.shadowRoot);
      });
    };
    try { visit(document); } catch { return []; }
    return matches;
  }

  function _fileInputPath(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 10; node = node.parentElement) {
      let part = String(node.tagName || '').toLowerCase();
      if (!part) break;
      if (node.id) {
        try { part += `#${CSS.escape(node.id)}`; } catch {}
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(child => child.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function _uniqueFileInputSelector(el) {
    if (!(el instanceof HTMLInputElement) || el.type !== 'file') return '';
    const candidates = [];
    if (el.id) {
      try { candidates.push(`#${CSS.escape(el.id)}`); } catch {}
    }
    if (el.name) candidates.push(`input[type="file"][name="${_cssString(el.name)}"]`);
    const accept = el.getAttribute('accept');
    const acceptPart = accept == null
      ? ':not([accept])'
      : `[accept="${_cssString(accept)}"]`;
    const multiplePart = el.hasAttribute('multiple') ? '[multiple]' : ':not([multiple])';
    candidates.push(`input[type="file"]${acceptPart}${multiplePart}`);
    candidates.push(`input[type="file"]${acceptPart}`);
    const path = _fileInputPath(el);
    if (path) candidates.push(path);
    for (const selector of candidates) {
      const matches = _deepSelectorMatches(selector);
      if (matches.length === 1 && matches[0] === el) return selector;
    }
    return '';
  }

  // Internal Compact-upload discovery. This is intentionally not a model
  // tool: it returns only file inputs, and the agent replaces each selector
  // with a run-scoped opaque targetId before the result reaches the model.
  function getFileInputTargets() {
    const targets = [];
    const seen = new Set();
    const visit = (root, inShadowDOM = false) => {
      try {
        root.querySelectorAll('input').forEach(el => {
          if (!(el instanceof HTMLInputElement) || el.type !== 'file' || seen.has(el)) return;
          seen.add(el);
          const selector = _uniqueFileInputSelector(el);
          targets.push({
            tag: 'input',
            type: 'file',
            text: _siteInteractionText(el).slice(0, 100),
            id: el.id || '',
            name: el.name || '',
            accept: el.getAttribute('accept'),
            multiple: el.hasAttribute('multiple'),
            inShadowDOM,
            ...(selector ? { selector } : {}),
          });
        });
        root.querySelectorAll('*').forEach(host => {
          if (host.shadowRoot) visit(host.shadowRoot, true);
        });
      } catch {}
    };
    visit(document);
    return targets;
  }

  function getInteractiveElementsFull() {
    return queryInteractiveFull().map((c, i) => {
      const el = c.el;
      const result = {
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        role: el.getAttribute('role') || '',
        text: _axModelName(el, _siteInteractionText(el).slice(0, 100)),
        id: el.id || '',
        name: el.name || '',
        href: _axModelHref(el, el.href || ''),
        rect: { x: Math.round(c.rect.x), y: Math.round(c.rect.y), w: Math.round(c.rect.width), h: Math.round(c.rect.height) },
        inShadowDOM: c.inShadow,
      };
      if (el instanceof HTMLInputElement && el.type === 'file') {
        const selector = _uniqueFileInputSelector(el);
        result.accept = el.getAttribute('accept');
        result.multiple = el.hasAttribute('multiple');
        if (selector) result.selector = selector;
      }
      return result;
    });
  }

  // ── Dev-mode reversible page patches and targeting helpers ────────────
  // Structured element-patch state lives in the content-script world, not the
  // MV3 service worker, so a patchId remains undoable if the worker is
  // suspended and restarted while the page itself stays loaded. Navigation
  // intentionally clears the registry together with the page and its edits.
  // CSS patches use chrome.scripting.insertCSS/removeCSS in agent.js so they
  // also work on pages whose Content Security Policy rejects inline styles.
  const devPatchRegistry = new Map();
  const devTargetMarkerRegistry = new Map();
  const DEV_TARGET_MARKER_ATTR = 'data-webbrain-dev-target';
  let devPatchSequence = 0;
  let activeDevHighlightCleanup = null;

  function nextDevPatchId(kind) {
    devPatchSequence += 1;
    return `wb_${kind}_${Date.now().toString(36)}_${devPatchSequence.toString(36)}`;
  }

  function devClassList(el) {
    try { return Array.from(el.classList || []).slice(0, 30); }
    catch { return []; }
  }

  function devCssPath(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 10; node = node.parentElement) {
      let part = String(node.tagName || '').toLowerCase();
      if (!part) break;
      if (node.id) {
        part += '#' + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }
      const classes = devClassList(node).slice(0, 3);
      if (classes.length) part += '.' + classes.map(c => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function devElementSummary(el) {
    const r = el.getBoundingClientRect();
    return {
      tag: String(el.tagName || '').toLowerCase(),
      id: el.id || '',
      classes: devClassList(el),
      path: devCssPath(el),
      rect: {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
        top: Math.round(r.top), right: Math.round(r.right),
        bottom: Math.round(r.bottom), left: Math.round(r.left),
      },
    };
  }

  function resolveDevTarget(params) {
    params = params || {};
    const warnings = [];
    let target = null;
    let targetMethod = null;
    const refId = typeof params.ref_id === 'string' ? params.ref_id.trim() : '';
    const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
    const x = Number(params.x);
    const y = Number(params.y);

    if (refId) {
      if (typeof window.__wb_ax_lookup === 'function') {
        const found = window.__wb_ax_lookup(refId);
        if (found?.nodeType === 1) {
          target = found;
          targetMethod = 'ref_id';
        } else {
          warnings.push(`No element found for ref_id "${refId}".`);
        }
      } else {
        warnings.push('ref_id was provided but accessibility-tree.js is not available.');
      }
    }
    if (!target && selector) {
      try {
        const found = document.querySelector(selector);
        if (found?.nodeType === 1) {
          target = found;
          targetMethod = 'selector';
        } else {
          warnings.push(`No element matched selector "${selector}".`);
        }
      } catch (e) {
        if (e?.code === 'page_feedback_pending') throw e;
        warnings.push(`Invalid selector: ${e.message}`);
      }
    }
    if (!target && Number.isFinite(x) && Number.isFinite(y)) {
      const found = document.elementFromPoint?.(x, y);
      if (found?.nodeType === 1) {
        target = found;
        targetMethod = 'coordinates';
      } else {
        warnings.push(`No element found at coordinates (${x}, ${y}).`);
      }
    }
    if (!target) {
      return {
        success: false,
        error: 'Could not resolve a target element. Pass a current ref_id or a valid selector.',
        warnings,
      };
    }
    return { success: true, target, targetMethod, warnings };
  }

  function isDevJavascriptUrlAttribute(name, value) {
    if (!/^(href|src|xlink:href|formaction|action)$/i.test(String(name || ''))) return false;
    // HTML URL parsing ignores ASCII tabs/newlines/carriage returns in the
    // scheme, so normalize those before checking instead of allowing an
    // obfuscated `java\nscript:` value through.
    const normalizedValue = String(value ?? '').replace(/[\t\n\r]/g, '').trimStart();
    return /^javascript:/i.test(normalizedValue);
  }

  function normalizeDevPatchOperations(el, params) {
    const styles = params?.styles && typeof params.styles === 'object' && !Array.isArray(params.styles) ? params.styles : {};
    const removeStyles = Array.isArray(params?.removeStyles) ? params.removeStyles : [];
    const addClasses = Array.isArray(params?.addClasses) ? params.addClasses : [];
    const removeClasses = Array.isArray(params?.removeClasses) ? params.removeClasses : [];
    const attributes = params?.attributes && typeof params.attributes === 'object' && !Array.isArray(params.attributes) ? params.attributes : {};
    const removeAttributes = Array.isArray(params?.removeAttributes) ? params.removeAttributes : [];
    const normalizeStyleName = value => {
      const name = String(value || '').trim();
      return name.startsWith('--') ? name : name.toLowerCase();
    };
    const isHtmlElement = el?.namespaceURI === 'http://www.w3.org/1999/xhtml';
    const normalizeAttributeName = value => {
      const name = String(value || '').trim();
      return isHtmlElement ? name.toLowerCase() : name;
    };

    const styleValues = new Map();
    for (const [name, value] of Object.entries(styles)) {
      const normalized = normalizeStyleName(name);
      if (normalized) styleValues.set(normalized, value);
    }
    const stylesToRemove = new Set(removeStyles.map(normalizeStyleName).filter(Boolean));
    const classesToAdd = new Set(addClasses.map(v => String(v || '').trim()).filter(Boolean));
    const classesToRemove = new Set(removeClasses.map(v => String(v || '').trim()).filter(Boolean));
    const attributeValues = new Map();
    for (const [name, value] of Object.entries(attributes)) {
      const normalized = normalizeAttributeName(name);
      if (normalized) attributeValues.set(normalized, value);
    }
    const attributesToRemove = new Set(removeAttributes.map(normalizeAttributeName).filter(Boolean));

    const styleConflict = [...styleValues.keys()].find(name => stylesToRemove.has(name));
    if (styleConflict) {
      return { success: false, error: `patch_element: style "${styleConflict}" cannot be set and removed in the same patch.` };
    }
    const classConflict = [...classesToAdd].find(name => classesToRemove.has(name));
    if (classConflict) {
      return { success: false, error: `patch_element: class "${classConflict}" cannot be added and removed in the same patch.` };
    }
    const attributeConflict = [...attributeValues.keys()].find(name => attributesToRemove.has(name));
    if (attributeConflict) {
      return { success: false, error: `patch_element: attribute "${attributeConflict}" cannot be set and removed in the same patch.` };
    }
    return {
      success: true,
      styleValues,
      stylesToRemove,
      styleNames: [...styleValues.keys(), ...stylesToRemove],
      classesToAdd,
      classesToRemove,
      classNames: [...classesToAdd, ...classesToRemove],
      attributeValues,
      attributesToRemove,
      attributeNames: [...attributeValues.keys(), ...attributesToRemove],
    };
  }

  function patchDevElement(params) {
    const resolved = resolveDevTarget(params);
    if (!resolved.success) return resolved;
    const el = resolved.target;
    const normalized = normalizeDevPatchOperations(el, params);
    if (!normalized.success) return normalized;
    const {
      styleValues,
      styleNames,
      classesToAdd,
      classesToRemove,
      classNames,
      attributeValues,
      attributeNames,
    } = normalized;
    if (!styleNames.length && !classNames.length && !attributeNames.length) {
      return { success: false, error: 'patch_element: provide at least one style, class, or attribute change.' };
    }
    if (styleNames.length > 100 || classNames.length > 100 || attributeNames.length > 100) {
      return { success: false, error: 'patch_element: a patch may change at most 100 styles, 100 classes, and 100 attributes.' };
    }
    for (const className of classNames) {
      if (/\s/.test(className) || className.length > 200) {
        return { success: false, error: `patch_element: invalid class name "${className}".` };
      }
    }
    for (const [name, rawValue] of styleValues) {
      if (String(rawValue).length > 4000) {
        return { success: false, error: `patch_element: style value for "${name}" exceeds 4,000 characters.` };
      }
    }
    for (const name of attributeNames) {
      if (!/^[^\s"'<>/=]+$/.test(name) || name.length > 200) {
        return { success: false, error: `patch_element: invalid attribute name "${name}".` };
      }
      if (/^on/i.test(name) || /^(srcdoc)$/i.test(name)) {
        return { success: false, error: `patch_element: executable attribute "${name}" is not allowed; use execute_js only when code execution is explicitly needed.` };
      }
      const value = attributeValues.has(name) ? String(attributeValues.get(name)) : '';
      if (isDevJavascriptUrlAttribute(name, value)) {
        return { success: false, error: `patch_element: javascript: URLs are not allowed in ${name}.` };
      }
      if (value.length > 10000) {
        return { success: false, error: `patch_element: attribute value for "${name}" exceeds 10,000 characters.` };
      }
    }

    const patchId = nextDevPatchId('dom');
    const styleChanges = [];
    for (const name of styleNames) {
      const beforePresent = Array.from(el.style).includes(name);
      const before = el.style.getPropertyValue(name);
      const beforePriority = el.style.getPropertyPriority(name);
      if (styleValues.has(name)) {
        const value = String(styleValues.get(name));
        el.style.setProperty(name, value);
      } else {
        el.style.removeProperty(name);
      }
      styleChanges.push({
        name,
        before: beforePresent ? before : null,
        beforePriority,
        after: Array.from(el.style).includes(name) ? el.style.getPropertyValue(name) : null,
        afterPriority: el.style.getPropertyPriority(name),
      });
    }

    const classChanges = [];
    for (const name of classNames) {
      const before = el.classList.contains(name);
      if (classesToAdd.has(name)) el.classList.add(name);
      if (classesToRemove.has(name)) el.classList.remove(name);
      classChanges.push({ name, before, after: el.classList.contains(name) });
    }

    const attributeChanges = [];
    for (const name of attributeNames) {
      const beforePresent = el.hasAttribute(name);
      const before = beforePresent ? el.getAttribute(name) : null;
      if (attributeValues.has(name)) {
        const value = String(attributeValues.get(name));
        el.setAttribute(name, value);
      } else {
        el.removeAttribute(name);
      }
      attributeChanges.push({ name, before, after: el.hasAttribute(name) ? el.getAttribute(name) : null });
    }

    const changes = { styles: styleChanges, classes: classChanges, attributes: attributeChanges };
    devPatchRegistry.set(patchId, { kind: 'element', element: el, changes });
    return {
      success: true,
      patchId,
      targetMethod: resolved.targetMethod,
      target: devElementSummary(el),
      changes,
      warnings: resolved.warnings,
      note: 'Call revert_patch with this patchId to restore the recorded prior values.',
    };
  }

  function revertDevElementPatch(params) {
    const patchId = typeof params?.patchId === 'string' ? params.patchId.trim() : '';
    if (!patchId) return { success: false, error: 'revert_patch: `patchId` is required.' };
    const patch = devPatchRegistry.get(patchId);
    if (!patch || patch.kind !== 'element') {
      return { success: false, error: `revert_patch: element patchId "${patchId}" was not found on this page.` };
    }
    const el = patch.element;
    if (!el?.isConnected) {
      devPatchRegistry.delete(patchId);
      return { success: false, error: `revert_patch: the element for "${patchId}" is no longer in the document.` };
    }

    const conflicts = [];
    for (const change of patch.changes.styles) {
      const current = Array.from(el.style).includes(change.name) ? el.style.getPropertyValue(change.name) : null;
      if (current !== change.after) conflicts.push({ kind: 'style', name: change.name, expected: change.after, current });
      if (change.before === null) el.style.removeProperty(change.name);
      else el.style.setProperty(change.name, change.before, change.beforePriority || '');
    }
    for (const change of patch.changes.classes) {
      const current = el.classList.contains(change.name);
      if (current !== change.after) conflicts.push({ kind: 'class', name: change.name, expected: change.after, current });
      el.classList.toggle(change.name, change.before);
    }
    for (const change of patch.changes.attributes) {
      const current = el.hasAttribute(change.name) ? el.getAttribute(change.name) : null;
      if (current !== change.after) conflicts.push({ kind: 'attribute', name: change.name, expected: change.after, current });
      if (change.before === null) el.removeAttribute(change.name);
      else el.setAttribute(change.name, change.before);
    }
    devPatchRegistry.delete(patchId);
    return {
      success: true,
      patchId,
      reverted: true,
      target: devElementSummary(el),
      conflicts,
      warning: conflicts.length
        ? 'Some values changed again after this patch; revert_patch restored the original recorded values and reports those overlaps in conflicts.'
        : undefined,
    };
  }

  function devParentElement(element) {
    if (element?.parentElement) return element.parentElement;
    return element?.getRootNode?.()?.host || null;
  }

  function markDevTargets(params) {
    const resolved = resolveDevTarget(params);
    if (!resolved.success) return resolved;
    const groupId = nextDevPatchId('target');
    const includeAncestors = params?.includeAncestors !== false;
    const elements = [resolved.target];
    if (includeAncestors) {
      let parent = devParentElement(resolved.target);
      while (parent && elements.length < 6) {
        elements.push(parent);
        parent = devParentElement(parent);
      }
    }
    const records = elements.map((el, index) => {
      const marker = `${groupId}_${index}`;
      const hadAttribute = el.hasAttribute(DEV_TARGET_MARKER_ATTR);
      const previousValue = hadAttribute ? el.getAttribute(DEV_TARGET_MARKER_ATTR) : null;
      el.setAttribute(DEV_TARGET_MARKER_ATTR, marker);
      return { el, marker, hadAttribute, previousValue, relation: index === 0 ? 'target' : `ancestor_${index}` };
    });
    devTargetMarkerRegistry.set(groupId, records);
    return {
      success: true,
      groupId,
      targetMethod: resolved.targetMethod,
      targets: records.map(record => ({ marker: record.marker, relation: record.relation, ...devElementSummary(record.el) })),
      warnings: resolved.warnings,
    };
  }

  function unmarkDevTargets(params) {
    const groupId = typeof params?.groupId === 'string' ? params.groupId : '';
    const records = devTargetMarkerRegistry.get(groupId) || [];
    for (const record of records) {
      try {
        if (record.hadAttribute) record.el.setAttribute(DEV_TARGET_MARKER_ATTR, record.previousValue || '');
        else record.el.removeAttribute(DEV_TARGET_MARKER_ATTR);
      } catch {}
    }
    devTargetMarkerRegistry.delete(groupId);
    return { success: true, groupId, removed: records.length };
  }

  function highlightDevElement(params) {
    const resolved = resolveDevTarget(params);
    if (!resolved.success) return resolved;
    const el = resolved.target;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
    if (activeDevHighlightCleanup) activeDevHighlightCleanup();

    const durationMs = Math.max(250, Math.min(15000, Math.round(Number(params?.durationMs) || 2500)));
    const requestedColor = typeof params?.color === 'string' ? params.color.trim() : '';
    const color = requestedColor && globalThis.CSS?.supports?.('color', requestedColor) ? requestedColor : '#7c3aed';
    const labelText = String(params?.label || '').trim().slice(0, 100);
    const overlay = document.createElement('div');
    overlay.setAttribute('data-webbrain-dev-highlight', '');
    (window.__wbPageMonitorDecorations ??= new WeakSet()).add(overlay);
    Object.assign(overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      border: `3px solid ${color}`,
      borderRadius: '4px',
      boxSizing: 'border-box',
      boxShadow: `0 0 0 2px rgba(255,255,255,.9), 0 0 18px ${color}`,
    });
    let label = null;
    if (labelText) {
      label = document.createElement('div');
      label.textContent = labelText;
      Object.assign(label.style, {
        position: 'absolute', left: '-3px', bottom: 'calc(100% + 5px)',
        maxWidth: '320px', padding: '3px 7px', borderRadius: '4px',
        background: color, color: '#fff', font: '600 12px/1.35 system-ui, sans-serif',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      });
      overlay.appendChild(label);
    }
    (document.documentElement || document.body).appendChild(overlay);

    const update = () => {
      if (!el.isConnected || !overlay.isConnected) return;
      const r = el.getBoundingClientRect();
      overlay.style.left = `${Math.round(r.left)}px`;
      overlay.style.top = `${Math.round(r.top)}px`;
      overlay.style.width = `${Math.max(0, Math.round(r.width))}px`;
      overlay.style.height = `${Math.max(0, Math.round(r.height))}px`;
    };
    update();
    const interval = setInterval(update, 50);
    const cleanup = () => {
      clearInterval(interval);
      try { overlay.remove(); } catch {}
      if (activeDevHighlightCleanup === cleanup) activeDevHighlightCleanup = null;
    };
    activeDevHighlightCleanup = cleanup;
    setTimeout(cleanup, durationMs);
    return {
      success: true,
      targetMethod: resolved.targetMethod,
      target: devElementSummary(el),
      durationMs,
      color,
      label: labelText || null,
      warnings: resolved.warnings,
    };
  }

  function inspectElementStyles(params) {
    params = params || {};
    const warnings = [];
    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
    const maxAncestors = clamp(Math.floor(Number(params.maxAncestors) || 5), 0, 8);
    const includeAncestors = params.includeAncestors !== false;
    const includeMatchedRules = params.includeMatchedRules !== false;

    const truncate = (value, max) => {
      const s = String(value || '');
      return s.length > max ? s.slice(0, max) + '...' : s;
    };
    const classList = (el) => {
      try { return Array.from(el.classList || []).slice(0, 20); }
      catch { return []; }
    };
    const rectInfo = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y),
        top: Math.round(r.top), left: Math.round(r.left),
        width: Math.round(r.width), height: Math.round(r.height),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
      };
    };
    const cssPath = (el) => {
      const parts = [];
      for (let node = el; node && node.nodeType === 1 && parts.length < 8; node = node.parentElement) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += '#' + CSS.escape(node.id);
          parts.unshift(part);
          break;
        }
        const classes = classList(node).slice(0, 3);
        if (classes.length) part += '.' + classes.map(c => CSS.escape(c)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
        parts.unshift(part);
      }
      return parts.join(' > ');
    };
    const summarize = (el) => ({
      tag: (el.tagName || '').toLowerCase(),
      id: el.id || '',
      classes: classList(el),
      path: cssPath(el),
      inlineStyle: truncate(el.getAttribute('style') || '', 800),
      textPreview: truncate((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 160),
      rect: rectInfo(el),
    });
    const pickComputed = (el) => {
      const cs = getComputedStyle(el);
      const props = [
        'display', 'box-sizing', 'position', 'top', 'right', 'bottom', 'left',
        'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
        'overflow', 'overflow-x', 'overflow-y', 'transform',
        'gap', 'row-gap', 'column-gap',
        'justify-content', 'align-items', 'align-content', 'justify-items',
        'flex-direction', 'flex-wrap', 'grid-template-columns', 'grid-template-rows',
      ];
      const out = {};
      for (const p of props) out[p] = cs.getPropertyValue(p);
      return out;
    };

    let target = null;
    let targetMethod = null;
    const hasRefId = typeof params.ref_id === 'string' && params.ref_id;
    const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
    const x = Number(params.x);
    const y = Number(params.y);
    const hasCoordinates = Number.isFinite(x) && Number.isFinite(y);
    const hasTargetParams = !!(hasRefId || selector || hasCoordinates);
    if (hasRefId) {
      if (typeof window.__wb_ax_lookup === 'function') {
        const refTarget = window.__wb_ax_lookup(params.ref_id);
        if (refTarget && refTarget.nodeType === 1) {
          target = refTarget;
          targetMethod = 'ref_id';
        } else if (refTarget) {
          warnings.push(`ref_id "${params.ref_id}" resolved to a non-element node.`);
        } else {
          warnings.push(`No element found for ref_id "${params.ref_id}".`);
        }
      } else {
        warnings.push('ref_id was provided but accessibility-tree.js is not available.');
      }
    }
    if (!target && selector) {
      try {
        const selectorTarget = document.querySelector(selector);
        if (selectorTarget && selectorTarget.nodeType === 1) {
          target = selectorTarget;
          targetMethod = 'selector';
        } else if (selectorTarget) {
          warnings.push(`Selector "${selector}" matched a non-element node.`);
        } else {
          warnings.push(`No element matched selector "${selector}".`);
        }
      } catch (e) {
        if (e?.code === 'page_feedback_pending') throw e;
        warnings.push(`Invalid selector: ${e.message}`);
      }
    }
    if (!target && hasCoordinates) {
      const pointTarget = typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(x, y)
        : null;
      if (pointTarget && pointTarget.nodeType === 1) {
        target = pointTarget;
        targetMethod = 'coordinates';
      } else {
        warnings.push(`No element found at coordinates (${x}, ${y}).`);
      }
    }
    if (!target && hasTargetParams) {
      return {
        success: false,
        error: 'Could not resolve requested DOM element to inspect.',
        ref_id: params.ref_id || null,
        selector: params.selector || null,
        warnings,
      };
    }
    if (!target) {
      target = document.body || document.documentElement;
      targetMethod = 'body';
    }
    if (!target || target.nodeType !== 1) {
      return { success: false, error: 'Could not resolve a DOM element to inspect.' };
    }

    const matchedRules = [];
    if (includeMatchedRules) {
      const visitRules = (rules, sheetInfo) => {
        for (const rule of Array.from(rules || [])) {
          if (matchedRules.length >= 30) return;
          if (rule.type === CSSRule.STYLE_RULE) {
            let matched = false;
            try { matched = target.matches(rule.selectorText); } catch { matched = false; }
            if (matched) {
              matchedRules.push({
                selector: rule.selectorText,
                cssText: truncate(rule.style?.cssText || rule.cssText || '', 1000),
                href: sheetInfo.href,
                media: sheetInfo.media,
              });
            }
          } else if (rule.cssRules) {
            visitRules(rule.cssRules, {
              href: sheetInfo.href,
              media: rule.conditionText || sheetInfo.media || '',
            });
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets || [])) {
        try {
          visitRules(sheet.cssRules, {
            href: sheet.href || 'inline',
            media: sheet.media ? Array.from(sheet.media).join(', ') : '',
          });
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          if (warnings.length < 10) {
            warnings.push(`Could not read stylesheet ${sheet.href || 'inline'}: ${e.name || e.message}`);
          }
        }
      }
    }

    const ancestors = [];
    if (includeAncestors) {
      let node = target.parentElement;
      while (node && ancestors.length < maxAncestors) {
        ancestors.push({
          ...summarize(node),
          computed: pickComputed(node),
        });
        node = node.parentElement;
      }
    }

    return {
      success: true,
      targetMethod,
      ref_id: params.ref_id || null,
      selector: params.selector || null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      target: {
        ...summarize(target),
        computed: pickComputed(target),
      },
      ancestors,
      matchedRules,
      warnings,
      note: 'Live rendered DOM and computed CSS. Use read_page_source only when raw server-delivered HTML is needed.',
    };
  }

  const SET_FIELD_VERIFY_DELAY_MS = 80;

  // The model sees a long field value only as a shortened preview: a tree
  // line shows its first 60 characters plus "...", and the agent appends one
  // of its own cut markers to a trimmed context message, tool result, page
  // text or recovered session. Written back as the replacement, such a
  // preview deletes everything after the cut. A replacement counts as that
  // preview when it ends in an ellipsis or in one of those exact markers,
  // the text before that ending opens a clearly longer current value of the
  // same field, and the value does not itself hold that ending there (then
  // the ending is the field's own text). A bracketed "truncated" note
  // elsewhere, such as a pasted log line, is ordinary text.
  const TRUNCATED_PREVIEW_MIN_PREFIX = 20;
  const TRUNCATED_PREVIEW_MIN_HIDDEN = 10;
  // Every cut marker the runtime appends to model-visible text, exactly as
  // written there (agent.js, conversation-persistence.js, page-monitor.js,
  // completion-invariant.js, otp-email-tool.js, the PDF readers, the
  // network inspector, error-format.js and the chat and selection stores).
  // test/improver-content-truncated-replacement.mjs keeps it complete.
  const TRUNCATED_PREVIEW_MARKERS = Object.freeze([
    '[...truncated to fit context]',
    '[...truncated]',
    '[...page text truncated]',
    '[...tool data text truncated]',
    '[...research answer truncated]',
    '[...result truncated]',
    '[...body truncated]',
    '[observation truncated]',
    '[excerpt truncated]',
    '[Latest model output truncated]',
    '[truncated for the on-device generation budget]',
    '[large value truncated for session recovery]',
    '[large content truncated for session recovery]',
    '[content truncated for session recovery]',
    '[tool arguments truncated for session recovery]',
    '… [page truncated, use read_pdf with fromPage to read more]',
    '… [truncated]',
    '[truncated]',
  ]);

  function _truncatedPreviewReplacement(current, text) {
    const normalize = value => {
      let normalized = String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\ufeff]/g, '');
      try { normalized = normalized.normalize('NFKC'); } catch {}
      return normalized.replace(/\s+/g, ' ').trim();
    };
    const value = normalize(current);
    // NFKC folds "…" into "...", so one spelling covers both. Markers are
    // compared in the same form, the longest first ("… [truncated]" before
    // "[truncated]").
    const replacement = normalize(text);
    const markers = TRUNCATED_PREVIEW_MARKERS.map(normalize).sort((a, b) => b.length - a.length);
    // A tree line escapes backslashes and quotes inside value="…" (\\ and
    // \"), so a preview copied from it may still carry those escapes.
    const unescaped = replacement.replace(/\\(["\\])/g, '$1');
    for (const candidate of new Set([replacement, unescaped])) {
      const ending = markers.find(marker => candidate.endsWith(marker))
        || candidate.match(/\.{3,}$/)?.[0] || '';
      if (!ending || value.startsWith(candidate)) continue;
      const prefix = candidate.slice(0, -ending.length).trim();
      if (prefix.length < TRUNCATED_PREVIEW_MIN_PREFIX) continue;
      if (!value.startsWith(prefix) || value.length - prefix.length < TRUNCATED_PREVIEW_MIN_HIDDEN) continue;
      return { currentValueLength: String(current ?? '').length, previewLength: prefix.length };
    }
    return null;
  }

  // Checked before anything is typed into a text field that the write would
  // clear. A preview of the field's own value is refused with no dispatch.
  function _truncatedPreviewReplacementFailure(el, text) {
    if (!el || !(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return null;
    let current = '';
    try {
      current = el.isContentEditable ? _editableTextValue(el) : String(el.value ?? '');
    } catch { return null; }
    return _truncatedPreviewValueFailure(current, text);
  }

  function _truncatedPreviewValueFailure(current, text) {
    const preview = _truncatedPreviewReplacement(current, text);
    if (!preview) return null;
    return {
      success: false,
      dispatched: false,
      noDispatch: true,
      retryable: false,
      errorCode: 'truncated_value_replacement',
      currentValueLength: preview.currentValueLength,
      recoveryRequired: 'read_full_value',
      error: `Nothing was typed. This text ends with "..." or a truncation marker, and the text before it is the start of this field's current ${preview.currentValueLength}-character value, so it looks like a shortened preview of that value, not the complete new text. Replacing the field with it would delete everything after the preview. Read the field's full current value first (read_page lists form field values; a tree line shows only the start), then write the complete text, or add text with clear:false instead of replacing. Only if the user asked to shorten this field to exactly this text: clear it with an empty text first, then add the text with clear:false.`,
    };
  }

  function _contentEditableValueMatches(actual, expected) {
    const normalizeNewlines = value => String(value).replace(/\r\n?/g, '\n');
    return normalizeNewlines(actual) === normalizeNewlines(expected);
  }

  function _setFieldValueMatches(actual, previous, text, clear, normalizeNewlines = false, semanticNewlines = false) {
    const expected = clear ? text : previous + text;
    if (!normalizeNewlines) return actual === expected;
    return _contentEditableValueMatches(actual, expected);
  }

  function readProseMirrorText(el) {
    if (!el?.isContentEditable || !el.classList?.contains('ProseMirror')) return null;
    // Paragraphs are document line breaks, not innerText's visual spacing.
    // ProseMirror's final BR is a caret placeholder, not another hard break.
    const read = node => {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (node.tagName === 'BR') return node.classList?.contains('ProseMirror-trailingBreak') ? '' : '\n';
      return Array.from(node.childNodes).map(read).join('');
    };
    const children = Array.from(el.childNodes);
    if (!children.every(node => node.nodeType === 1 && node.tagName === 'P')) return null;
    return children.map(read).join('\n');
  }

  function readEmptyCaretText(el) {
    // A sole BR can be either a browser caret or an authored literal LF.
    // Generic DOM shape cannot establish which; keep its rendered value.
    // DraftJS/ProseMirror markers and exact native-clear receipts prove their
    // own empty state independently. Only a genuinely empty DOM is generic.
    return el?.isContentEditable && el.childNodes?.length === 0
      && el.innerText === '' && el.textContent === '' ? '' : null;
  }

  const _nativeChatEmptyCaretReceipts = new WeakMap();

  function _nativeChatCaretContext(el) {
    try {
      const context = window.__wb_get_native_chat_context?.(el);
      return context && ['telegram', 'whatsapp-self', 'whatsapp'].includes(context.service) ? context : null;
    } catch { return null; }
  }

  function _sameNativeChatCaretContext(before, after) {
    return !!before && !!after && before.id === after.id && before.service === after.service && before.name === after.name
      && before.root === after.root && before.transcript === after.transcript
      && before.header === after.header && before.carrier === after.carrier && before.owner === after.owner
      && before.title === after.title && before.selfMarker === after.selfMarker && before.peerIdentity === after.peerIdentity
      && before.aliasWitnessSignature === after.aliasWitnessSignature;
  }

  function _singleEditableCaretBreak(el) {
    if (!el?.isContentEditable || String(el.textContent || '') !== '') return null;
    let node = el;
    for (let depth = 0; depth < 8; depth++) {
      const children = Array.from(node.childNodes).filter(child => child.nodeType !== 8
        && !(child.nodeType === 3 && !child.nodeValue));
      if (children.length !== 1 || children[0].nodeType !== 1) return null;
      node = children[0];
      if (node.tagName === 'BR') return node;
      if (!/^(?:SPAN|DIV|P|B|STRONG|I|EM|U|S)$/.test(node.tagName)
          || node.getAttribute('contenteditable') === 'false') return null;
    }
    return null;
  }

  function isDraftJsEditor(el) {
    return !!el?.isContentEditable && (el.classList?.contains('public-DraftEditor-content')
      || Array.from(el.children || []).some(child => child.getAttribute('data-contents') === 'true'));
  }

  function isModelManagedEditor(el) {
    return !!el?.isContentEditable && (isDraftJsEditor(el)
      || ['ProseMirror', 'ql-editor', 'cke_editable', 'mce-content-body', 'cm-content']
        .some(name => el.classList?.contains(name))
      || el.getAttribute('data-slate-editor') === 'true'
      || el.getAttribute('data-lexical-editor') === 'true');
  }

  function readDraftJsText(el) {
    if (!el?.isContentEditable || !el.childNodes) return null;
    const roots = Array.from(el.childNodes);
    if (roots.length !== 1 || roots[0].nodeType !== 1 || roots[0].tagName !== 'DIV'
        || roots[0].getAttribute('data-contents') !== 'true') return null;
    let visited = 0;
    const supported = node => {
      if (++visited > 4096 || node.shadowRoot || node.hidden || String(node.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true'
          || String(node.getAttribute('contenteditable') || '').trim().toLowerCase() === 'false') return false;
      const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
      return !!style && (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility)
        && style.opacity !== '0' && style.contentVisibility !== 'hidden');
    };
    if (!supported(el) || !supported(roots[0])) return null;
    const blocks = Array.from(roots[0].childNodes);
    if (!blocks.length) return null;
    const texts = [];
    for (const block of blocks) {
      if (block.nodeType !== 1 || block.tagName !== 'DIV' || block.getAttribute('data-block') !== 'true'
          || !block.getAttribute('data-offset-key') || !supported(block)) return null;
      const children = Array.from(block.childNodes);
      const body = children[0];
      if (children.length !== 1 || body?.nodeType !== 1 || body.tagName !== 'DIV'
          || !body.classList.contains('public-DraftStyleDefault-block')
          || !body.getAttribute('data-offset-key') || !supported(body)) return null;
      const leaves = [];
      const read = (node, depth = 0) => {
        if (depth > 32 || node.nodeType !== 1 || !supported(node)) return false;
        if (node.tagName === 'BR') {
          if (node.getAttribute('data-text') !== 'true' || node.childNodes.length) return false;
          leaves.push(null); return true;
        }
        if (node.tagName !== 'SPAN') return false;
        const descendants = Array.from(node.childNodes);
        if (node.getAttribute('data-text') === 'true') {
          if (!descendants.every(child => child.nodeType === 3)) return false;
          leaves.push(descendants.map(child => child.nodeValue || '').join('')); return true;
        }
        return descendants.length > 0 && descendants.every(child => read(child, depth + 1));
      };
      if (!body.childNodes.length || !Array.from(body.childNodes).every(node => read(node))) return null;
      // DraftJS's sole data-text BR in an empty block is a caret placeholder.
      // Real document breaks are separators between blocks (or text in leaves).
      // Mixed BR/text and embeds are unsupported; keep their rendered fallback.
      const placeholders = leaves.filter(value => value === null).length;
      if (placeholders && (placeholders !== 1 || leaves.some(value => value !== null && value !== ''))) return null;
      texts.push(leaves.filter(value => value !== null).join(''));
    }
    return texts.join('\n');
  }

  const _nativeChatClearPreparations = new Map();

  function _releaseNativeChatClear(token) {
    const record = _nativeChatClearPreparations.get(token);
    if (!record) return;
    _nativeChatClearPreparations.delete(token);
    clearTimeout(record.timer);
    record.observer.disconnect();
    for (const [name, listener] of record.listeners) record.view.removeEventListener(name, listener, true);
  }

  function _prepareNativeChatClear(ref) {
    const el = window.__wb_ax_lookup?.(ref), context = _nativeChatCaretContext(el);
    if (!el?.isContentEditable || !el.isConnected || !context || !el.textContent) return { success: false };
    const doc = el.ownerDocument, root = el.getRootNode(), view = doc.defaultView;
    const url = doc.URL, documentToken = _axDocumentToken();
    const ancestors = []; for (let node = el.parentElement; node; node = node.parentElement) ancestors.push(node);
    const identityNodes = [context.header, context.carrier, context.title, context.selfMarker, context.owner]
      .filter(node => node?.nodeType === 1);
    const selection = () => root.getSelection?.() || view.getSelection();
    const rangeNow = () => { const value = selection(); return value?.rangeCount === 1 ? value.getRangeAt(0) : null; };
    const sameRange = (a, b) => !!a && !!b && a.startContainer === b.startContainer && a.startOffset === b.startOffset
      && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
    const originalBreaks = new Set(el.querySelectorAll('br'));
    const originalNodes = new Set([el]), originalText = new Map(), deletedTextNodes = new Set();
    const originalWalker = doc.createTreeWalker(el, view.NodeFilter.SHOW_ALL);
    for (let node = originalWalker.nextNode(); node; node = originalWalker.nextNode()) {
      originalNodes.add(node); if (node.nodeType === 3) originalText.set(node, node.nodeValue);
    }
    const fullySelected = () => {
      const value = rangeNow();
      if (!value || value.collapsed || !el.contains(value.startContainer) || !el.contains(value.endContainer)) return false;
      const walker = doc.createTreeWalker(el, view.NodeFilter.SHOW_ELEMENT | view.NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === 3) {
          if (value.comparePoint(node, 0) !== 0 || value.comparePoint(node, node.length) !== 0) return false;
        } else if (!node.childNodes.length) {
          const offset = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
          if (value.comparePoint(node.parentNode, offset) !== 0 || value.comparePoint(node.parentNode, offset + 1) !== 0) return false;
        }
      }
      return true;
    };
    const focused = () => (root.activeElement || doc.activeElement) === el;
    const current = () => el.isConnected && el.ownerDocument === doc && doc.defaultView === view
      && view.document === doc && el.getRootNode() === root && doc.URL === url
      && _axDocumentToken() === documentToken && window.__wb_ax_lookup?.(ref) === el && focused()
      && _sameNativeChatCaretContext(context, _nativeChatCaretContext(el));
    const selected = selection();
    if (!current() || selected?.rangeCount !== 1) return { success: false };
    const range = selected.getRangeAt(0);
    if (!fullySelected() || !el.contains(range.startContainer) || !el.contains(range.endContainer)
        || range.cloneContents().textContent !== el.textContent) return { success: false };
    const token = crypto.randomUUID();
    const record = { el, doc, view, context, current, listeners: [], selected: 0, deleted: 0, before: 0,
      inputs: 0, released: 0, invalid: false, caret: null, settledRange: null, pendingDeleteRecords: [] };
    const originalRange = range.cloneRange();
    record.selectionCurrent = () => sameRange(rangeNow(), record.settledRange);
    const relevant = mutation => !(mutation.type === 'attributes'
      && ['data-webbrain-native-target', 'data-webbrain-page-revision'].includes(mutation.attributeName))
      && (originalNodes.has(mutation.target) || mutation.target === el || el.contains(mutation.target)
        || (mutation.type === 'attributes' && ancestors.includes(mutation.target))
        || identityNodes.some(node => mutation.target === node
          || (node !== context.owner && node.contains(mutation.target)))
        || (mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes]
          .some(node => node === el || node.contains?.(el) || identityNodes.includes(node))));
    const nativeDeleteMutation = mutation => ['childList', 'characterData'].includes(mutation.type)
      && (originalNodes.has(mutation.target) || mutation.target === el || el.contains(mutation.target));
    record.observer = new view.MutationObserver(records => {
      const changes = records.filter(relevant);
      if (!changes.length) return;
      // Capture listeners in another world can yield before our trusted input
      // callback. Only that exact pending native Delete may consume this buffer.
      if (record.deleted === 1 && record.before === 1 && record.inputs === 0 && current()
          && changes.every(nativeDeleteMutation) && record.pendingDeleteRecords.length + changes.length <= 128) {
        record.pendingDeleteRecords.push(...changes);
      } else record.invalid = true;
    });
    record.observer.observe(doc.documentElement, { subtree: true, attributes: true, childList: true, characterData: true, characterDataOldValue: true });
    const drain = nativeDelete => {
      const changes = [...record.pendingDeleteRecords, ...record.observer.takeRecords()]; record.pendingDeleteRecords = [];
      for (const mutation of changes.filter(relevant)) {
        if (!nativeDelete || !nativeDeleteMutation(mutation)) { record.invalid = true; continue; }
        if (mutation.type === 'characterData') {
          if (!originalText.has(mutation.target) || mutation.oldValue !== originalText.get(mutation.target)
              || mutation.target.nodeValue !== '' || deletedTextNodes.has(mutation.target)) record.invalid = true;
          deletedTextNodes.add(mutation.target);
        } else if (!originalNodes.has(mutation.target)
            || [...mutation.removedNodes].some(node => !originalNodes.has(node))
            || [...mutation.addedNodes].some(node => node !== el.firstChild || node.nodeName !== 'BR'
              || node.attributes.length !== 0 || originalBreaks.has(node))) record.invalid = true;
      }
    };
    record.drain = drain;
    const handlers = {
      keydown(event) {
        if (!event.isTrusted || event.target !== el || !current()) { record.invalid = true; return; }
        if (/^(?:Control|Meta)(?:Left|Right)$/.test(event.code) && !record.selected && !record.deleted
            && !record.modifierCode && !event.altKey && !event.shiftKey) { record.modifierCode = event.code; return; }
        if (event.code === 'KeyA' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
            && !record.selected && !record.deleted) { record.selected++; return; }
        if (event.code === 'Delete' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
            && record.selected === 1 && !record.deleted && fullySelected()) { record.deleted++; return; }
        record.invalid = true;
      },
      keyup(event) {
        if (!event.isTrusted || event.target !== el) { record.invalid = true; return; }
        if (event.code === record.modifierCode && record.selected === 1 && !record.deleted
            && !record.modifierReleased) { record.modifierReleased = true; return; }
        if (event.code === 'KeyA' && record.selected === 1 && !record.deleted) return;
        if (event.code === 'Delete' && record.deleted === 1 && !record.released) { record.released++; return; }
        record.invalid = true;
      },
      beforeinput(event) {
        drain(false);
        if (!event.isTrusted || event.target !== el || event.inputType !== 'deleteContentForward'
            || record.selected !== 1 || record.deleted !== 1 || record.before || !current() || !fullySelected()) record.invalid = true;
        else record.before++;
      },
      input(event) {
        if (!event.isTrusted || event.target !== el || event.inputType !== 'deleteContentForward'
            || record.before !== 1 || record.inputs || !current()) { record.invalid = true; return; }
        drain(true); record.inputs++;
        const caret = _singleEditableCaretBreak(el); record.caret = originalBreaks.has(caret) ? null : caret;
        record.settledRange = rangeNow()?.cloneRange();
      },
      selectionchange() {
        const value = rangeNow();
        if (record.inputs ? !sameRange(value, record.settledRange)
          : (!record.selected && !sameRange(value, originalRange))
            || !value || !el.contains(value.startContainer) || !el.contains(value.endContainer)) record.invalid = true;
      },
      focusin(event) { if (event.target !== el) record.invalid = true; },
      focusout() { record.invalid = true; }, pointerdown() { record.invalid = true; },
      wheel() { record.invalid = true; }, paste() { record.invalid = true; }, drop() { record.invalid = true; },
    };
    for (const [name, listener] of Object.entries(handlers)) {
      // Capture above existing document listeners: their callback checkpoint
      // must not deliver this exact native deletion as an unrelated mutation.
      view.addEventListener(name, listener, true); record.listeners.push([name, listener]);
    }
    while (_nativeChatClearPreparations.size >= 8) _releaseNativeChatClear(_nativeChatClearPreparations.keys().next().value);
    record.timer = setTimeout(() => _releaseNativeChatClear(token), 5000);
    _nativeChatClearPreparations.set(token, record);
    return { success: true, token };
  }

  function _verifyNativeChatClear(ref, token) {
    const record = _nativeChatClearPreparations.get(token);
    if (!record) return { success: false };
    record.drain(false);
    const valid = !record.invalid && record.current() && window.__wb_ax_lookup?.(ref) === record.el
      && record.selected === 1 && record.deleted === 1 && record.before === 1 && record.inputs === 1
      && record.released === 1 && record.selectionCurrent() && record.caret && record.caret === _singleEditableCaretBreak(record.el);
    _releaseNativeChatClear(token);
    if (!valid) return { success: false };
    _rememberNativeChatEmptyCaret(record.el, record.context);
    return { success: _nativeChatCaretValueIsEmpty(record.el) };
  }

  function _rememberNativeChatEmptyCaret(el, context) {
    const br = _singleEditableCaretBreak(el);
    if (br && _sameNativeChatCaretContext(context, _nativeChatCaretContext(el))) {
      _nativeChatEmptyCaretReceipts.set(el, { context, br });
    }
  }

  function _nativeChatCaretValueIsEmpty(el) {
    const receipt = _nativeChatEmptyCaretReceipts.get(el);
    if (!receipt) return false;
    if (receipt.br === _singleEditableCaretBreak(el)
        && _sameNativeChatCaretContext(receipt.context, _nativeChatCaretContext(el))) return true;
    _nativeChatEmptyCaretReceipts.delete(el);
    return false;
  }

  function _editableTextValue(el) {
    const semantic = isDraftJsEditor(el) ? readDraftJsText(el) : (readProseMirrorText(el) ?? readEmptyCaretText(el));
    // Only a successful explicit native-chat delete may certify this exact
    // caret node as empty. Generic editors and authored LF/BR keep raw readback.
    return semantic !== null ? semantic : _nativeChatCaretValueIsEmpty(el) ? ''
      : (typeof el.innerText === 'string' ? el.innerText : (el.textContent || ''));
  }

  // Pick the single commit path for set_field({submit:true}). Synthetic
  // (isTrusted:false) Enter events never trigger native submission —
  // they only reach the page's own keydown listeners. A non-combobox field
  // inside a form that has requestSubmit therefore needs a native submit as
  // its only reliable commit path; comboboxes are committed by page JS
  // listeners instead, because submitting the enclosing form while a picker
  // popup is open is usually wrong.
  function _setFieldUsesNativeSubmit(isCombobox, isContentEditable, form) {
    return !isCombobox && !isContentEditable && !!form && typeof form.requestSubmit === 'function';
  }

  // The rich-text toolbar heuristic lives in one file shared by both builds
  // and by the CDP main-world probe — see
  // src/content/rich-text-toolbar-heuristic.js. Delegating keeps the scoring
  // from drifting between the dispatch routes.
  const _richTextToolbarHeuristic = () => globalThis.__wbRichTextToolbarHeuristic;

  function _visibleFieldContextNode(node) {
    return _richTextToolbarHeuristic()?.visibleFieldContextNode(node) ?? false;
  }

  function _ariaLabelledByText(el) {
    return _richTextToolbarHeuristic()?.ariaLabelledByText(el) ?? null;
  }

  function _richTextToolbarQueryAcrossOpenShadowRoots(scope, selector, limit = 200) {
    return _richTextToolbarHeuristic()?.queryAcrossOpenShadowRoots(scope, selector, limit) ?? [];
  }

  function _richTextEditorsAcrossOpenShadowRoots(scope) {
    return _richTextToolbarHeuristic()?.editorsAcrossOpenShadowRoots(scope) ?? [];
  }

  function _richTextToolbarRegionKey(regionNode) {
    return _richTextToolbarHeuristic()?.regionKey(regionNode) ?? '';
  }

  function _richTextToolbarAvailablePresetValues(el) {
    return _richTextToolbarHeuristic()?.availablePresetValues(el) ?? [];
  }

  function _richTextToolbarCandidate(el, baseMeta) {
    return _richTextToolbarHeuristic()?.candidate(el, baseMeta, {
      axRef: typeof window.__wb_ax_ref === 'function' ? window.__wb_ax_ref : null,
    }) ?? null;
  }

  function _fieldMeta(el) {
    try {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const fieldType = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : tag;
      const elId = el.id || null;
      let labelText = null;
      try {
        if (elId) {
          const escapedId = window.CSS && CSS.escape ? CSS.escape(elId) : elId.replace(/["\\]/g, '\\$&');
          const root = el.getRootNode?.() || document;
          const label = root.querySelector?.(`label[for="${escapedId}"]`)
            || (root === document ? null : document.querySelector(`label[for="${escapedId}"]`));
          if (label) labelText = (label.textContent || '').trim().slice(0, 120);
        }
        if (!labelText && el.closest) {
          const wrappingLabel = el.closest('label');
          if (wrappingLabel) labelText = (wrappingLabel.textContent || '').trim().slice(0, 120);
        }
      } catch {}
      const meta = {
        tag,
        type: fieldType,
        contentEditable: !!el.isContentEditable,
        // Locale-independent file-editor structure: CodeMirror (GitHub's
        // file editor) marks its editable lineage with stable classes that
        // survive UI translation, unlike accessible labels.
        codeMirror: (() => {
          try {
            return !!el.isContentEditable && !!el.closest?.('.cm-content, .cm-editor, .CodeMirror');
          } catch { return false; }
        })(),
        name: el.getAttribute ? el.getAttribute('name') : null,
        id: elId,
        role: el.getAttribute ? el.getAttribute('role') : null,
        autocomplete: el.getAttribute ? el.getAttribute('autocomplete') : null,
        ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
        ariaLabelledByText: _ariaLabelledByText(el),
        placeholder: el.getAttribute ? el.getAttribute('placeholder') : null,
        title: el.getAttribute ? el.getAttribute('title') : null,
        labelText,
      };
      const toolbarCandidate = _richTextToolbarCandidate(el, meta);
      if (toolbarCandidate) meta.toolbarCandidate = toolbarCandidate;
      return meta;
    } catch { return null; }
  }

  // Derive a document-unique selector for a verified field so the agent can
  // re-digest the SAME element later (e.g. pre-submit proof refresh after
  // focus moved on). Each candidate is accepted only when it resolves back
  // to exactly this element — never a hard-coded guess that could match a
  // different field. Returns null when nothing identifies it uniquely.
  function _stableFieldSelector(el) {
    try {
      if (!el || el.nodeType !== 1 || !el.isConnected) return null;
      const resolvesUniquelyToEl = (selector) => {
        try {
          if (!selector) return false;
          const matches = document.querySelectorAll(selector);
          return matches.length === 1 && matches[0] === el;
        } catch { return false; }
      };
      const quoted = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const elId = el.id || null;
      if (elId) {
        let selector = null;
        try {
          selector = (window.CSS && typeof window.CSS.escape === 'function')
            ? `#${window.CSS.escape(elId)}`
            : `#${quoted(elId)}`;
        } catch { selector = null; }
        if (selector && resolvesUniquelyToEl(selector)) return selector;
      }
      const tag = String(el.tagName || '').toLowerCase();
      const name = typeof el.getAttribute === 'function' ? el.getAttribute('name') : null;
      if (tag && name) {
        const selector = `${tag}[name="${quoted(name)}"]`;
        if (resolvesUniquelyToEl(selector)) return selector;
      }
      const ariaLabel = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null;
      if (tag && ariaLabel) {
        const selector = `${tag}[aria-label="${quoted(ariaLabel)}"]`;
        if (resolvesUniquelyToEl(selector)) return selector;
      }
      if (el.isContentEditable) {
        const selector = '[contenteditable="true"]';
        if (resolvesUniquelyToEl(selector)) return selector;
      }
      return null;
    } catch { return null; }
  }

  function _richTextToolbarContextForElement(el) {
    try {
      if (!el || !el.isConnected) return { toolbarContext: false, toolbarRegionRef: '', toolbarRegionKey: '' };
      const semanticToolbar = _composedClosestElement(el, '[role="toolbar"]');
      if (semanticToolbar) {
        let toolbarRegionRef = '';
        try { if (typeof window.__wb_ax_ref === 'function') toolbarRegionRef = window.__wb_ax_ref(semanticToolbar) || ''; } catch {}
        return {
          toolbarContext: true,
          toolbarRegionRef,
          toolbarRegionKey: _richTextToolbarRegionKey(semanticToolbar),
        };
      }
      const targetRect = el.getBoundingClientRect();
      const cx = targetRect.x + targetRect.width / 2;
      const cy = targetRect.y + targetRect.height / 2;
      let node = _composedParent(el);
      for (let depth = 0; node && depth < 6; depth++, node = _composedParent(node)) {
        for (const field of _richTextToolbarQueryAcrossOpenShadowRoots(
          node,
          'input:not([type="hidden"]),select,[contenteditable]:not([contenteditable="false"])',
          80,
        )) {
          const candidate = _fieldMeta(field)?.toolbarCandidate;
          const region = candidate?.regionRect;
          if (!region) continue;
          if (cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h) {
            return {
              toolbarContext: true,
              toolbarRegionRef: candidate.regionRef || '',
              toolbarRegionKey: candidate.regionKey || '',
            };
          }
        }
      }
      return { toolbarContext: false, toolbarRegionRef: '', toolbarRegionKey: '' };
    } catch { return { toolbarContext: false, toolbarRegionRef: '', toolbarRegionKey: '' }; }
  }

  function _deepActiveElement() {
    let active = document.activeElement;
    const seen = new Set();
    while (active && !seen.has(active)) {
      seen.add(active);
      let inner = null;
      try { inner = active.shadowRoot?.activeElement || null; } catch {}
      if (!inner || inner === active) break;
      active = inner;
    }
    return active;
  }

  const _dispatchBindings = new Map();

  function _rememberDispatchBinding(el) {
    if (!el?.isConnected) return '';
    const entropy = new Uint32Array(3);
    globalThis.crypto.getRandomValues(entropy);
    const token = `wbdb_${Date.now().toString(36)}_${Array.from(entropy, value => value.toString(36)).join('_')}`;
    const record = { el, pageUrl: location.href, timer: null };
    _dispatchBindings.set(token, record);
    record.timer = setTimeout(() => {
      if (_dispatchBindings.get(token) === record) {
        _dispatchBindings.delete(token);
      }
    }, 60000);
    return token;
  }

  function _consumeDispatchBinding(token, resolvedTarget) {
    const normalized = String(token || '');
    if (!normalized) return true;
    const expected = _dispatchBindings.get(normalized);
    _dispatchBindings.delete(normalized);
    if (expected?.timer) clearTimeout(expected.timer);
    return !!expected
      && expected.el === resolvedTarget
      && expected.el.isConnected
      && expected.pageUrl === location.href;
  }

  function _consumeFocusedDispatchBinding(params = {}) {
    const token = String(params.dispatchBinding?.token || '');
    const active = _deepActiveElement();
    if (
      !token
      || !active
      || active === document.body
      || active === document.documentElement
      || !_consumeDispatchBinding(token, active)
    ) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        retryable: true,
        error: 'The focused target changed after the rich-text toolbar safety preflight. Focus the intended field again and retry.',
      };
    }
    return { success: true, matched: true };
  }

  const _messageRecipientDispatchBindings = new Map();
  const _nativeChatPreparedDrafts = new Map();
  const _nativeTelegramReadBindings = new Map();
  const _nativeIdentityPreparationBindings = new Map();
  let _nativeTelegramReadOwner = '';

  function _setNativeTelegramReadOwner(value) {
    const owner = typeof value === 'string' && value.length <= 16000 ? value : '';
    if (owner === _nativeTelegramReadOwner) return;
    _nativeTelegramReadOwner = owner;
    for (const record of _nativeTelegramReadBindings.values()) {
      record.observer.disconnect(); clearTimeout(record.timer);
    }
    _nativeTelegramReadBindings.clear();
    for (const record of _nativeIdentityPreparationBindings.values()) {
      record.observer.disconnect(); clearTimeout(record.timer);
    }
    _nativeIdentityPreparationBindings.clear();
  }

  function _nativeTelegramReadRendered(node) {
    if (!node?.isConnected || node.ownerDocument !== document) return false;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    for (let ancestor = node, depth = 0; ancestor; ancestor = ancestor.parentElement) {
      if (++depth > 128) return false;
      const style = getComputedStyle(ancestor);
      if (ancestor.hidden || ancestor.inert || ancestor.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || ['hidden','collapse'].includes(style.visibility)
          || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
    }
    return true;
  }

  function _nativeTelegramReadControl(target) {
    const context = window.__wb_get_native_telegram_alias_preparation?.();
    if (!context || !_nativeTelegramReadRendered(target)
        || target.closest('form,[contenteditable="true"],input,textarea,select,a[href],[onclick],[data-action]')) return null;
    const nativeNodes = [context.root,context.transcript,context.composer,context.header,context.carrier,context.peerIdentity];
    if (nativeNodes.some(node => !_nativeTelegramReadRendered(node))) return null;
    const titleTarget = target === context.carrier || target === context.peerIdentity
      || (target.matches('span.i18n') && target.childElementCount === 0 && context.peerIdentity.contains(target));
    if (titleTarget && !target.closest('button,[role="button"],[role="menuitem"],[data-action],.emoji-status')) {
      return {context,target,control:context.carrier,phase:'open_profile',nodes:[...nativeNodes,target]};
    }
    const visible = selector => Array.from(document.querySelectorAll(selector)).filter(_nativeTelegramReadRendered);
    const triggers = visible('#column-left .sidebar-header .sidebar-tools-button.btn-menu-toggle.is-visible');
    const trigger = triggers.length === 1 ? triggers[0] : null;
    if (!trigger || !trigger.matches('button,[role="button"]') || trigger.matches(':disabled,[aria-disabled="true"]')) return null;
    const control = target.closest('button,[role="button"]');
    if (control === trigger && (target === trigger || (trigger.contains(target) && target.matches('span,svg,path')))) {
      // Only open a closed native tools menu; never toggle an existing menu a
      // second time as a fallback for the same prepared action.
      if (trigger.classList.contains('menu-open')) return null;
      return {context,target,control:trigger,phase:'open_menu',nodes:[...nativeNodes,trigger,target]};
    }
    const openTriggers = visible('.btn-menu-toggle.menu-open');
    const menus = visible('.btn-menu.active');
    const menu = menus.length === 1 ? menus[0] : null;
    if (openTriggers.length !== 1 || openTriggers[0] !== trigger || !menu
        || menu.parentElement !== document.body || !menu.matches('.bottom-right.was-open')
        || !control?.matches('.btn-menu-item[role="button"]') || control.parentElement !== menu
        || control.matches('[aria-disabled="true"]') || !menu.contains(target)) return null;
    const items = Array.from(menu.children).filter(node => node.matches('.btn-menu-item[role="button"]'));
    const settings = items.filter(item => {
      const icons = Array.from(item.querySelectorAll(':scope > .tgico.btn-menu-item-icon')).filter(_nativeTelegramReadRendered);
      return icons.length === 1 && icons[0].textContent === '\uea22';
    });
    // The settings glyph and the native menu identify it; a name read as
    // sending something (in any language) still refuses it.
    if (settings.length !== 1 || settings[0] !== control
        || _messageControlReading(control.getAttribute('aria-label') || control.textContent || '') === 'send') return null;
    const icon = control.querySelector(':scope > .tgico.btn-menu-item-icon');
    return {context,target,control,phase:'open_settings',nodes:[...nativeNodes,trigger,menu,control,icon,target]};
  }

  function _sameNativeTelegramReadContext(before, after) {
    return !!before && !!after && ['root','transcript','composer','header','carrier','peerIdentity','peer','alias','url','timeOrigin']
      .every(key => before[key] === after[key]);
  }

  window.__wb_get_native_telegram_alias_preparation_target = preparation => {
    try {
      if (!_sameNativeTelegramReadContext(preparation,window.__wb_get_native_telegram_alias_preparation?.())) return null;
      // This native hint chooses a read-only affordance; it never certifies
      // self identity. Ordinary aliases must inspect their current peer profile.
      const candidates = preparation.peerIdentity?.getAttribute('data-me-as-notes') === '1' ? [
        ...document.querySelectorAll('body > .btn-menu.active.bottom-right.was-open > .btn-menu-item[role="button"]'),
        ...document.querySelectorAll('#column-left .sidebar-header .sidebar-tools-button.btn-menu-toggle.is-visible'),
      ] : [preparation.carrier];
      for (const target of candidates) {
        const proof = _nativeTelegramReadControl(target);
        if (proof && _sameNativeTelegramReadContext(preparation,proof.context)) return {
          target,phase:proof.phase === 'open_settings' ? 'open_self_settings' : proof.phase,
        };
      }
      return null;
    } catch { return null; }
  };

  function _bindNativeTelegramRead(target) {
    if (!_nativeTelegramReadOwner) return null;
    const proof = _nativeTelegramReadControl(target);
    if (!proof) return null;
    while (_nativeTelegramReadBindings.size >= 8) {
      const [token, old] = _nativeTelegramReadBindings.entries().next().value;
      old.observer.disconnect();clearTimeout(old.timer);_nativeTelegramReadBindings.delete(token);
    }
    const token = 'wbtr_' + globalThis.crypto.randomUUID();
    const record = {...proof,owner:_nativeTelegramReadOwner,documentToken:_axDocumentToken(),
      humanRevision:_messageRecipientHumanRevision,expiresAt:Date.now()+30000,stale:false};
    record.isMaterial = mutation => _nativeTelegramReadMaterialMutation(record, mutation);
    record.observer = new MutationObserver(records => { if (records.some(record.isMaterial)) record.stale=true; });
    record.observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,
      attributeFilter:_nativeTelegramReadMaterialAttributes});
    record.timer=setTimeout(()=>{record.observer.disconnect();_nativeTelegramReadBindings.delete(token);},30000);
    _nativeTelegramReadBindings.set(token,record);
    return {token};
  }

  function _consumeNativeTelegramRead(params, target) {
    const token = String(params.nativeTelegramReadRepairBinding?.token || '');
    const record = _nativeTelegramReadBindings.get(token);
    if (record) { _nativeTelegramReadBindings.delete(token); clearTimeout(record.timer); }
    if (record?.observer.takeRecords().some(record.isMaterial)) record.stale=true;
    record?.observer.disconnect();
    const current = _nativeTelegramReadControl(target);
    return record && !record.stale && record.expiresAt >= Date.now()
      && record.owner === _nativeTelegramReadOwner && record.owner === params._nativeChatOwner
      && record.documentToken === _axDocumentToken() && record.humanRevision === _messageRecipientHumanRevision
      && record.target === target && current?.control === record.control && current?.phase === record.phase
      && current.nodes.length === record.nodes.length && current.nodes.every((node,index)=>node===record.nodes[index])
      && _sameNativeTelegramReadContext(record.context,current.context) ? record : null;
  }

  function _nativeTelegramReadStillCurrent(record) {
    let context = window.__wb_get_native_telegram_alias_preparation?.();
    if (!context && record) {
      const verified = window.__wb_get_native_chat_context?.(record.context.composer);
      if (verified?.service === 'telegram' && verified.alias) context = {...verified,
        composer:record.context.composer,url:location.href,timeOrigin:performance.timeOrigin};
    }
    return !!record && record.owner === _nativeTelegramReadOwner
      && record.documentToken === _axDocumentToken() && record.humanRevision === _messageRecipientHumanRevision
      && _sameNativeTelegramReadContext(record.context,context);
  }
  // Private, read-only adapter evidence captured before inference. It does not
  // replace the independent one-use recipient/dispatch token obtained later.
  const _nativeTelegramReadMaterialAttributes = ['class','style','hidden','inert','aria-hidden','data-peer-id','data-thread-id','role','type','href','onclick','data-action','data-action-id',
    'aria-disabled','aria-label','aria-labelledby','aria-describedby','aria-controls','aria-haspopup','aria-expanded','aria-selected','aria-pressed','aria-checked',
    'title','disabled','name','id','form','formaction','formmethod','formtarget','action','method','target','download','tabindex','contenteditable','readonly'];
  function _nativeTelegramReadMaterialMutation(record, mutation) {
    if (mutation.type === 'attributes') return record.nodes.some(node => mutation.target === node || mutation.target.contains(node))
      || (mutation.attributeName === 'data-peer-id' && record.context.transcript.contains(mutation.target));
    // Transcript rows may arrive or be edited during read-only preparation.
    // Their peer identity is independently rechecked; the exact transcript
    // container, editor, current header and prepared control remain pinned.
    const textPins = record.nodes.filter(node => node !== record.context.root && node !== record.context.transcript);
    if (mutation.type === 'characterData') return textPins.some(node => node.contains(mutation.target));
    if ([...mutation.removedNodes].some(node => record.nodes.some(pin => node === pin || node.contains?.(pin)))) return true;
    if (record.context.transcript.contains(mutation.target)) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        const peers = [node, ...node.querySelectorAll('[data-peer-id]')].filter(candidate => candidate.hasAttribute('data-peer-id'));
        if (peers.length > 256 || peers.some(candidate => candidate.getAttribute('data-peer-id') !== record.context.peer)) return true;
      }
    }
    if (!textPins.some(node => node === mutation.target || node.contains(mutation.target))) return false;
    const changed = [...mutation.addedNodes, ...mutation.removedNodes];
    if (record.context.composer === mutation.target || record.context.composer.contains(mutation.target)
        || record.context.peerIdentity === mutation.target || record.context.peerIdentity.contains(mutation.target)) return changed.length > 0;
    return changed.some(node => window.__wbPageMonitor?.isReadonlyPreparationDecoration?.(node) !== true);
  }
  window.__wb_get_readonly_identity_preparation = (owner, target = null, captureAuthority = null) => {
    if (!owner || window.__wbPageMonitor?.active !== true) return null;
    // Only the current pre-inference monitor capture may initialize a cold
    // private owner. A model parameter or a retained capture cannot adopt it.
    if (captureAuthority) {
      if (window.__wbPageMonitor.currentIdentityPreparationCapture?.(captureAuthority, owner) !== true) return null;
      _setNativeTelegramReadOwner(owner);
    }
    if (owner !== _nativeTelegramReadOwner) return null;
    const context = window.__wb_get_native_telegram_alias_preparation?.();
    if (!context) return null;
    target ||= window.__wb_get_native_telegram_alias_preparation_target?.(context)?.target;
    const proof = _nativeTelegramReadControl(target);
    if (!proof || !_sameNativeTelegramReadContext(context, proof.context)) return null;
    while (_nativeIdentityPreparationBindings.size >= 4) {
      const [key, old] = _nativeIdentityPreparationBindings.entries().next().value;
      old.observer.disconnect(); clearTimeout(old.timer); _nativeIdentityPreparationBindings.delete(key);
    }
    const token = 'wbip_' + globalThis.crypto.randomUUID();
    const nodes = [...new Set(proof.nodes)];
    const record = { ...proof, owner, nodes, documentToken: _axDocumentToken(),
      humanRevision: _messageRecipientHumanRevision, expiresAt: Date.now() + 120000, stale: false };
    record.isMaterial = mutation => _nativeTelegramReadMaterialMutation(record, mutation);
    record.observer = new MutationObserver(records => { if (records.some(record.isMaterial)) record.stale = true; });
    record.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: _nativeTelegramReadMaterialAttributes });
    const snapshot = Object.freeze({ schema: 'webbrain.readonly-identity-preparation/1', readonly: true, owner, token,
      documentToken: record.documentToken, phase: proof.phase, target, action: proof.control,
      scope: proof.control.parentElement, nodes: Object.freeze(nodes), identities: Object.freeze([context.peerIdentity]),
      signature: JSON.stringify([context.peer, context.alias, context.url, context.timeOrigin,
        record.documentToken, record.humanRevision, proof.phase]), allowedTools: Object.freeze(['click_ax']) });
    record.snapshot = snapshot;
    record.timer = setTimeout(() => { record.observer.disconnect(); _nativeIdentityPreparationBindings.delete(token); }, 120000);
    _nativeIdentityPreparationBindings.set(token, record);
    return snapshot;
  };
  window.__wb_readonly_identity_preparation_matches = snapshot => {
    const record = _nativeIdentityPreparationBindings.get(snapshot?.token);
    if (!record || record.snapshot !== snapshot || record.owner !== _nativeTelegramReadOwner
        || record.expiresAt < Date.now() || window.__wbPageMonitor?.active !== true) return false;
    if (record.observer.takeRecords().some(record.isMaterial)) record.stale = true;
    const current = _nativeTelegramReadControl(record.target);
    const currentNodes = [...new Set(current?.nodes || [])];
    return !record.stale && record.documentToken === _axDocumentToken()
      && record.humanRevision === _messageRecipientHumanRevision
      && current?.control === record.control && current?.phase === record.phase
      && currentNodes.length === record.nodes.length && currentNodes.every((node, index) => node === record.nodes[index])
      && _sameNativeTelegramReadContext(record.context, current.context);
  };
  const _twitterHistoryObservations = new WeakMap();

  function _settledTwitterHistory(log, messageIds = []) {
    if (!log?.isConnected) return false;
    let loading = false;
    let completionSignal = false;
    try {
      const ariaBusy = log.getAttribute('aria-busy');
      loading = ariaBusy === 'true'
        || !!log.querySelector('[aria-busy="true"],[role="progressbar"]');
      // X's explicit idle state is a direct history-completion signal. Empty
      // logs may alternatively use X's own empty-state marker.
      completionSignal = ariaBusy === 'false'
        || (!(Array.isArray(messageIds) && messageIds.length > 0)
          && !!log.querySelector('[data-testid="dm-empty-state"],[data-testid="empty_state"],[data-testid="empty-state"]'));
    } catch {}
    if (loading) {
      _twitterHistoryObservations.delete(log);
      return false;
    }
    if (completionSignal) {
      _twitterHistoryObservations.delete(log);
      return true;
    }
    // Without an explicit X completion marker, an empty history remains
    // ambiguous. A nonempty history must retain the same row identities long
    // enough to rule out an in-progress history append.
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      _twitterHistoryObservations.delete(log);
      return false;
    }
    const now = Date.now();
    const signature = Array.isArray(messageIds) ? messageIds.join('\u001f') : '';
    const prior = _twitterHistoryObservations.get(log);
    const observation = prior?.signature === signature
      ? { firstSeenAt: prior.firstSeenAt, count: prior.count + 1 }
      : { firstSeenAt: now, count: 1, signature };
    _twitterHistoryObservations.set(log, { ...observation, signature });
    // A nonempty history without an explicit idle marker can append old
    // messages. Require the same snapshot to survive two reads before using
    // it as a dispatch baseline.
    return observation.count >= 2 && now - observation.firstSeenAt >= 300;
  }

  function _messageRecipientIdentityKey(values = []) {
    return JSON.stringify(Array.from(new Set((Array.isArray(values) ? values : [])
      .map(value => {
        const legacy = typeof value === 'string' || typeof value === 'number';
        const identity = String(legacy ? value : (value?.identity ?? value?.recipient) ?? '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
        const role = String(legacy ? 'to' : value?.role || '').trim().toLowerCase();
        return identity && /^(?:to|cc|bcc)$/.test(role) ? `${role}:${identity}` : '';
      })
      .filter(Boolean))).sort());
  }

  function _messageRecipientDispatchControl(element) {
    return element?.closest?.(
      'button,[role="button"],input[type="submit"],input[type="button"],[data-action]'
    ) || element || null;
  }

  function _messageRecipientDispatchTargetsMatch(expected, actual) {
    if (!expected || !actual) return false;
    if (expected === actual) return true;
    return _messageRecipientDispatchControl(expected) === _messageRecipientDispatchControl(actual);
  }

  let _messageRecipientHumanRevision = 0;
  let _messageRecipientOwnedInputScope = null;
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'input', 'change', 'wheel', 'touchmove']) {
    document.addEventListener(type, event => {
      if (!event.isTrusted) return;
      _messageRecipientHumanRevision++;
      // Only the exact synchronous native writer owns these input events.
      // Physical keys, pointer/scroll and later input still change the fence.
      if (type === 'input' && _messageRecipientOwnedInputScope?.el === event.target)
        _messageRecipientOwnedInputScope.count++;
    }, true);
  }

  function _messageRecipientUploadTarget(selector) {
    if (window !== window.top || typeof selector !== 'string' || !selector.trim()) return null;
    try {
      const matches = [];
      const visit = root => {
        matches.push(...root.querySelectorAll(selector));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
      };
      visit(document);
      const target = matches.length === 1 ? matches[0] : null;
      return target instanceof HTMLInputElement && target.type === 'file'
        && !target.disabled && !target.matches(':disabled')
        && target.getAttribute('aria-disabled') !== 'true' && target.isConnected ? target : null;
    } catch { return null; }
  }

  function _messageRecipientUploadOwner(target, composer) {
    if (!target || !composer || target.ownerDocument !== document || composer.ownerDocument !== document) return null;
    const composerForm = _composedClosestElement(composer, 'form');
    if (target.form || target.hasAttribute('form')) {
      const modal = _findTopmostBlockingModal();
      return target.form && target.form === composerForm
        && (!modal || (_isComposedAncestor(modal, target) && _isComposedAncestor(modal, composer)))
        ? target.form : null;
    }
    // A hidden input can be a sibling of the editor. Require a local shared
    // compose container rather than treating the whole page as its owner.
    for (let owner = _composedParent(target), depth = 0; owner && depth < 8;
      owner = _composedParent(owner), depth++) {
      if (owner === document.body || owner === document.documentElement || owner === document) return null;
      if (owner.nodeType !== 1 || /^(?:MAIN|HTML|BODY)$/.test(owner.tagName)
          || owner.getAttribute('role') === 'main') continue;
      if (_isComposedAncestor(owner, composer)) {
        const modal = _findTopmostBlockingModal();
        return !modal || _isComposedAncestor(modal, owner) ? owner : null;
      }
    }
    return null;
  }

  function _messageRecipientUploadInputSignature(target) {
    return JSON.stringify(['type','accept','multiple','name','id','form','capture','webkitdirectory']
      .map(name => target?.getAttribute?.(name))
      .concat([!!target?.disabled, target?.getAttribute?.('aria-disabled'),
        target?.form?.action || '', target?.form?.method || '']));
  }

  function _messageRecipientUploadFilesSignature(target) {
    return JSON.stringify(Array.from(target?.files || []).map(file => [file.name, file.size, file.type, file.lastModified]));
  }

  function _rememberMessageRecipientDispatchBinding(composer, identities, dispatch = {}) {
    const tool = String(dispatch.tool || '');
    const actionTarget = dispatch.actionTarget || null;
    if (!composer?.isConnected || !tool || !actionTarget?.isConnected) return '';
    const identityKey = _messageRecipientIdentityKey(identities);
    if (!identityKey || identityKey === '[]') return '';
    const entropy = new Uint32Array(3);
    globalThis.crypto.getRandomValues(entropy);
    const token = `wbmr_${Date.now().toString(36)}_${Array.from(entropy, value => value.toString(36)).join('_')}`;
    const record = {
      composer,
      actionTarget,
      tool,
      args: dispatch.args && typeof dispatch.args === 'object' ? { ...dispatch.args } : {},
      adapterName: String(dispatch.adapterName || ''),
      expectedRecipients: Array.isArray(dispatch.expectedRecipients)
        ? dispatch.expectedRecipients.map(value => (
            value && typeof value === 'object'
              ? { identity: String(value.identity || ''), role: String(value.role || '') }
              : { identity: String(value || ''), role: 'to' }
          )).filter(value => value.identity && /^(?:to|cc|bcc)$/.test(value.role)).slice(0, 16)
        : [],
      supportsRecipientSets: dispatch.supportsRecipientSets === true,
      conversationRecipientEvidence: dispatch.conversationRecipientEvidence || null,
      identityKey,
      messageBody: String(dispatch.messageBody || ''),
      messageBodyBaselineCount: Number(dispatch.messageBodyBaselineCount || 0),
      nativeTelegramBaseline: dispatch.nativeChatMessageBaseline?.complete === true
        && dispatch.nativeChatMessageBaseline.coverage === 'mounted_native_id_floor'
        ? Object.freeze({ threadKey: dispatch.nativeChatMessageBaseline.threadKey,
            messageIds: Object.freeze([...dispatch.nativeChatMessageBaseline.messageIds]) }) : null,
      ...(Array.isArray(dispatch.existingMessageIds) ? { existingMessageIds: [...dispatch.existingMessageIds] } : {}),
      twitterEmptyConversationBaseline: dispatch.twitterEmptyConversationBaseline === true,
      gmailComposeFlow: dispatch.gmailComposeFlow === true,
      composerSubject: String(dispatch.composerSubject || ''),
      composerSubjectAvailable: dispatch.composerSubjectAvailable === true,
      pageUrl: location.href,
      documentToken: _axDocumentToken(),
      messageAttachment: dispatch.messageAttachment === true,
      uploadSourceKey: String(dispatch.uploadSourceKey || ''),
      uploadOwner: dispatch.messageAttachment === true ? _messageRecipientUploadOwner(actionTarget, composer) : null,
      uploadInputSignature: dispatch.messageAttachment === true ? _messageRecipientUploadInputSignature(actionTarget) : '',
      uploadFilesSignature: dispatch.messageAttachment === true ? _messageRecipientUploadFilesSignature(actionTarget) : '',
      uploadFiles: dispatch.messageAttachment === true ? Array.from(actionTarget.files || []) : [],
      humanRevision: _messageRecipientHumanRevision,
      nativeOwner: String(dispatch.nativeOwner || ''),
      nativeChatBaseline: dispatch.nativeChatMessageBaseline?.complete === true
        ? JSON.parse(JSON.stringify(dispatch.nativeChatMessageBaseline)) : null,
      timer: null,
    };
    _messageRecipientDispatchBindings.set(token, record);
    record.timer = setTimeout(() => {
      if (_messageRecipientDispatchBindings.get(token) === record) {
        _messageRecipientDispatchBindings.delete(token);
      }
    }, 60000);
    return token;
  }

  function _disposeNativeChatDraft(token) {
    const record = _nativeChatPreparedDrafts.get(token);
    if (record) { record.observer.disconnect(); clearTimeout(record.timer); }
    _nativeChatPreparedDrafts.delete(token);
  }

  // This lease witnesses an owned draft and an explicitly blocked submit
  // boundary. It never proves that typing had no page-side effect.
  // This predicate preserves an owned draft for read-only latest repair only.
  // It cannot authorize Enter or replace the full dispatch validator.
  function _nativeChatDraftLatestOnly(recipient, params, el) {
    if (!recipient || recipient.nativeOwner !== params._nativeChatOwner
        || recipient.humanRevision + (recipient.nativeDraftOwnInputs?.el === el
          ? recipient.nativeDraftOwnInputs.count : 0) !== _messageRecipientHumanRevision
        || recipient.documentToken !== _axDocumentToken() || recipient.pageUrl !== location.href
        || recipient.composer !== el || recipient.actionTarget !== el || !el?.isConnected
        || typeof params.text !== 'string' || _editableTextValue(el) !== params.text) return false;
    const native = window.__wb_get_native_chat_context?.(el);
    if (native?.service !== 'telegram' || native.latestPositionVerified !== true || native.atLatest !== false) return false;
    // Pending native status is material even when the mounted ID set is unchanged.
    if (native.transcript.querySelector(native.webA
        ? '.MessageOutgoingStatus .icon-message-pending,.MessageOutgoingStatus .icon-message-failed'
        : '.bubble.is-sending,.bubble.is-error,.bubble.is-outgoing')) return false;
    const identity = _probeMessageRecipientGuard({ tool:'observe_active_conversation', args:{},
      adapterName:recipient.adapterName,
      expectedConversationRecipientEvidence:recipient.conversationRecipientEvidence });
    const baseline = identity.nativeChatMessageBaseline, expected = recipient.nativeTelegramBaseline;
    return identity.success === true && identity.conclusive === true && identity.messageSend === false
      && _messageRecipientIdentityKey(identity.strongRecipientCandidates) === recipient.identityKey
      && identity.messageBody === recipient.messageBody
      && baseline?.coverage === 'mounted_native_id_floor' && !!expected
      && baseline.threadKey === expected.threadKey
      && JSON.stringify(baseline.messageIds) === JSON.stringify(expected.messageIds);
  }

  function _nativeChatDraftClassTokens(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    return tokens.length <= 128 ? new Set(tokens) : null;
  }

  // Only one-way cleanup of classes introduced by this exact synchronous
  // native writer is presentation. Every other class transition is material.
  function _nativeChatDraftHasMaterialMutation(record, mutations) {
    if (mutations.length > 256) return true;
    for (let index = 0; index < mutations.length; index++) {
      const mutation = mutations[index];
      if (mutation.type !== 'attributes' || mutation.attributeName !== 'class'
          || mutation.target !== record.el) return true;
      const next = mutations.slice(index + 1).find(item => item.type === 'attributes'
        && item.attributeName === 'class' && item.target === record.el);
      const before = _nativeChatDraftClassTokens(mutation.oldValue || '');
      const after = _nativeChatDraftClassTokens(next ? next.oldValue || '' : record.el.getAttribute('class') || '');
      if (!before || !after || [...after].some(token => !before.has(token))) return true;
      const retained = [...before].filter(token => after.has(token));
      if (JSON.stringify(retained) !== JSON.stringify([...after])) return true;
      const removed = [...before].filter(token => !after.has(token));
      if (removed.some(token => !record.classRemovalTokens.has(token))) return true;
      for (const token of removed) record.classRemovalTokens.delete(token);
    }
    return false;
  }

  function _nativeChatDraftCurrent(params, element = null, observeOnly = false) {
    const token = String(params._nativeChatDraftBinding?.token || '');
    const record = _nativeChatPreparedDrafts.get(token);
    if (!record) return null;
    if (_nativeChatDraftHasMaterialMutation(record, record.observer.takeRecords())) record.changed = true;
    const el = element || window.__wb_ax_lookup?.(params.ref_id || record.ref);
    if (record.changed || record.owner !== params._nativeChatOwner || !record.owner
        || record.humanRevision !== _messageRecipientHumanRevision
        || record.documentToken !== _axDocumentToken() || record.url !== location.href
        || record.el !== el || !el?.isConnected
        || (params.text !== undefined && params.text !== record.body)
        || _editableTextValue(el) !== record.body) {
      _disposeNativeChatDraft(token); return null;
    }
    if (_validateMessageRecipientDispatchBinding(record.recipient, params, el).success) return record;
    // Retain only a read-only witness while the same native Telegram viewport
    // is temporarily away from latest. Dispatch still requires full validation.
    if (observeOnly && _nativeChatDraftLatestOnly(record.recipient,
        { ...params, text:record.body }, el)) return { ...record, waitingForLatest:true };
    _disposeNativeChatDraft(token); return null;
  }

  function _rememberNativeChatDraft(params, el, recipient) {
    const native = window.__wb_get_native_chat_context?.(el);
    if (params._nativeChatDraftPreparation !== true
        || !recipient?.nativeOwner || recipient.nativeOwner !== params._nativeChatOwner
        || !recipient.nativeChatBaseline?.complete
        || !['telegram','whatsapp'].includes(native?.service)
        || !recipient.conversationRecipientEvidence?.contextNodes?.length
        || recipient.humanRevision + (recipient.nativeDraftOwnInputs?.el === el
          ? recipient.nativeDraftOwnInputs.count : 0) !== _messageRecipientHumanRevision
        || recipient.documentToken !== _axDocumentToken() || recipient.pageUrl !== location.href
        || recipient.composer !== el || recipient.actionTarget !== el || !el?.isConnected
        || typeof params.text !== 'string' || _editableTextValue(el) !== params.text
        || (!_validateMessageRecipientDispatchBinding(recipient, params, el).success
          && !_nativeChatDraftLatestOnly(recipient, params, el))) return null;
    while (_nativeChatPreparedDrafts.size >= 8) _disposeNativeChatDraft(_nativeChatPreparedDrafts.keys().next().value);
    const token = crypto.randomUUID();
    const record = { el, ref:params.ref_id, body:String(params.text), recipient,
      owner:params._nativeChatOwner, documentToken:_axDocumentToken(), url:location.href,
      humanRevision:_messageRecipientHumanRevision, changed:false, observer:null, timer:null,
      classRemovalTokens:new Set(recipient.nativeDraftOwnInputs?.classRemovalTokens || []) };
    record.observer = new MutationObserver(mutations => {
      if (_nativeChatDraftHasMaterialMutation(record, mutations)) record.changed = true;
    });
    // Scroll geometry is read again at recovery. Any material node/identity or
    // draft change, including change-and-return, retires the original lease.
    for (const node of new Set(recipient.conversationRecipientEvidence.contextNodes)) {
      record.observer.observe(node, { attributes:true, attributeOldValue:true, attributeFilter:['id','role','aria-label','aria-labelledby','aria-disabled','disabled','contenteditable','data-peer-id','data-list-key','data-testid','data-id','inert','aria-hidden','class'], childList:true, subtree:true, characterData:true });
    }
    record.observer.observe(native.transcript, { subtree:true, childList:true, characterData:true, attributes:true, attributeOldValue:true });
    _nativeChatPreparedDrafts.set(token, record);
    record.timer = setTimeout(() => _disposeNativeChatDraft(token), 60000);
    return { token };
  }

  function _consumeMessageRecipientDispatchBinding(params = {}, actualTarget = null) {
    const token = String(params.messageRecipientDispatchBinding?.token || '');
    const expected = token ? _messageRecipientDispatchBindings.get(token) : null;
    if (token) _messageRecipientDispatchBindings.delete(token);
    if (expected?.timer) clearTimeout(expected.timer);
    const validated = _validateMessageRecipientDispatchBinding(expected, params, actualTarget);
    if (validated.success === true && window.__wb_get_native_chat_context?.(expected?.composer)?.service === 'whatsapp'
        && window.__wb_prepare_native_chat_send?.(expected.composer, expected.messageBody) !== true) {
      const nativeChatReadRepair = window.__wb_native_chat_read_repair?.(expected.composer);
      return { success: false, noDispatch: true, dispatched: false, messageRecipientGuard: true,
        reasonCode: 'native_chat_baseline_unavailable',
        ...(nativeChatReadRepair ? { nativeChatReadRepair } : {}),
        error: nativeChatReadRepair?.message || 'The native WhatsApp live message tail cannot establish a send baseline. Observe the latest messages before sending.' };
    }
    return validated;
  }

  function _validateMessageRecipientDispatchBinding(expected, params = {}, actualTarget = null, afterAttachment = false) {
    let pointTarget = null;
    const pointX = Number(params.dispatchPoint?.x);
    const pointY = Number(params.dispatchPoint?.y);
    if (Number.isFinite(pointX) && Number.isFinite(pointY)) {
      try { pointTarget = document.elementFromPoint(pointX, pointY); } catch {}
    }
    const dispatchedTarget = actualTarget || pointTarget;
    if (!expected || !expected.composer?.isConnected || !expected.actionTarget?.isConnected
      || expected.pageUrl !== location.href
      || expected.documentToken !== _axDocumentToken()
      || (expected.messageAttachment && (window !== window.top
        || expected.humanRevision !== _messageRecipientHumanRevision
        || dispatchedTarget !== expected.actionTarget
        || params.uploadSourceKey !== expected.uploadSourceKey
        || _messageRecipientUploadOwner(expected.actionTarget, expected.composer) !== expected.uploadOwner
        || _messageRecipientUploadInputSignature(expected.actionTarget) !== expected.uploadInputSignature
        || (!afterAttachment && (_messageRecipientUploadFilesSignature(expected.actionTarget) !== expected.uploadFilesSignature
          || Array.from(expected.actionTarget.files || []).some((file, index) => file !== expected.uploadFiles[index])
          || expected.actionTarget.files.length !== expected.uploadFiles.length))))
      || (dispatchedTarget && !_messageRecipientDispatchTargetsMatch(expected.actionTarget, dispatchedTarget))) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        messageRecipientGuard: true,
        reasonCode: 'recipient_dispatch_binding_stale',
        error: 'Message send blocked because the verified composer changed before Enter dispatch. Re-read the active conversation and retry the send once.',
      };
    }
    const live = _probeMessageRecipientGuard({
      tool: expected.tool,
      args: expected.args,
      bindDispatch: false,
      expectedDispatchTarget: expected.actionTarget,
      expectedComposer: expected.composer,
      adapterName: expected.adapterName,
      expectedRecipients: expected.expectedRecipients,
      supportsRecipientSets: expected.supportsRecipientSets,
      uploadSourceKey: expected.uploadSourceKey,
      expectedConversationRecipientEvidence: expected.conversationRecipientEvidence,
    });
    if (live?.dispatchTargetChanged === true) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        messageRecipientGuard: true,
        reasonCode: 'recipient_dispatch_binding_stale',
        error: 'Message send blocked because the verified action target or composer changed before dispatch. Re-read the active conversation and retry the send once.',
      };
    }
    const liveIdentityKey = _messageRecipientIdentityKey(
      Array.isArray(live?.strongRecipientCandidates)
        ? live.strongRecipientCandidates
        : live?.strongIdentityCandidates,
    );
    if (expected.nativeTelegramBaseline && (live?.nativeChatMessageBaseline?.complete !== true
        || live.nativeChatMessageBaseline.coverage !== 'mounted_native_id_floor'
        || live.nativeChatMessageBaseline.threadKey !== expected.nativeTelegramBaseline.threadKey
        || JSON.stringify(live.nativeChatMessageBaseline.messageIds) !== JSON.stringify(expected.nativeTelegramBaseline.messageIds))) {
      return { success: false, noDispatch: true, dispatched: false, messageRecipientGuard: true,
        reasonCode: 'native_chat_baseline_changed_before_dispatch',
        error: 'The latest native Telegram message baseline changed after send preparation. No message was sent. Observe the current conversation before deciding whether to send; the draft may remain in the composer.' };
    }
    if (live?.success !== true || live?.conclusive !== true || live?.messageSend !== true
      || liveIdentityKey !== expected.identityKey
      || (expected.messageAttachment ? live?.messageAttachment !== true : !expected.messageBody)
      || live?.messageBody !== expected.messageBody
      || (expected.existingMessageIds
        && JSON.stringify(live?.existingMessageIds) !== JSON.stringify(expected.existingMessageIds))
      || (expected.twitterEmptyConversationBaseline === true
        && live?.twitterEmptyConversationBaseline !== true)
      || (expected.gmailComposeFlow === true && live?.gmailComposeFlow !== true)
      || (expected.composerSubjectAvailable === true
        && (live?.composerSubjectAvailable !== true || live?.composerSubject !== expected.composerSubject))) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        messageRecipientGuard: true,
        reasonCode: 'active_recipient_changed_before_dispatch',
        error: 'Message send blocked because the active conversation changed after recipient verification. The text may remain in the composer; re-read the visible header before sending.',
      };
    }
    return { success: true, matched: true };
  }

  function _attachMessageRecipientBoundUpload(params = {}, deadlineExpired = () => false) {
    const fail = (error, extra = {}) => ({ success: false, dispatched: false, noDispatch: true,
      messageRecipientGuard: true, error, ...extra });
    const target = _messageRecipientUploadTarget(params.selector);
    const expected = _messageRecipientDispatchBindings.get(String(params.messageRecipientDispatchBinding?.token || ''));
    if (!target || !expected || expected.tool !== 'upload_file' || expected.actionTarget !== target) {
      return fail('Attachment blocked because the exact verified file input is unavailable.',
        { reasonCode: 'recipient_dispatch_binding_stale' });
    }
    if (deadlineExpired()) return fail('Upload action deadline expired before attachment.', { deadlineExpired: true });
    const base64 = params.base64;
    // Match the existing Firefox upload cap and reject oversized data before
    // allocation or file assignment. These bytes come from the private source
    // resolver, never a model argument or page attribute.
    if (typeof base64 !== 'string' || base64.length > Math.ceil(25 * 1024 * 1024 / 3) * 4) {
      return fail('Recipient-bound attachment exceeds the 25MB limit or has no file data.');
    }
    let file, transfer;
    try {
      const binary = atob(base64);
      if (binary.length > 25 * 1024 * 1024) return fail('Recipient-bound attachment exceeds the 25MB limit.');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      file = new File([bytes], String(params.filename || 'attachment'),
        { type: String(params.mimeType || 'application/octet-stream') });
      transfer = new DataTransfer();
      transfer.items.add(file);
    } catch { return fail('Recipient-bound attachment data could not be decoded.'); }
    const typeCheck = globalThis.__wbFileUploadPolicy?.validateUploadFile(target.getAttribute('accept'), params);
    if (!typeCheck?.success) return typeCheck || fail('The file type validator is unavailable. Re-observe before attaching.');
    const pageGuard = params.pageFeedbackGuard;
    const monitor = window.__wbPageMonitor;
    if (pageGuard?.operationId) {
      if (typeof monitor?.activatePreparedDispatch !== 'function' || typeof monitor?.withPreparedDispatch !== 'function') {
        return fail('The page monitor is unavailable before attachment.', { pageFeedbackPending: true });
      }
      monitor.activatePreparedDispatch({ operationId: pageGuard.operationId, kind: 'input', element: target });
    }
    if (deadlineExpired()) return fail('Upload action deadline expired before attachment.', { deadlineExpired: true });
    const guard = _consumeMessageRecipientDispatchBinding(params, target);
    if (!guard.success) return guard;
    let dispatched = false;
    try {
      const attach = () => {
        monitor?.beforeLocalDispatch?.({ kind: 'input', target });
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
        if (!setter) throw new Error('Native file-input assignment is unavailable.');
        setter.call(target, transfer.files);
        const assignedFiles = [...target.files || []];
        dispatched = true;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        // An input handler may synchronously switch a conversation. Never
        // follow it with a change event against a different recipient.
        const stillBound = _validateMessageRecipientDispatchBinding(expected, params, target, true);
        if (!stillBound.success) return { ...stillBound, dispatched: true, noDispatch: false,
          outcomeUnknown: true, retryable: false };
        const currentFiles = [...target.files || []];
        if (assignedFiles.length !== currentFiles.length || assignedFiles.some((file, index) => file !== currentFiles[index])) {
          return { ...fail('The page changed the attached file during its input handler. Inspect the conversation before retrying.',
            { reasonCode: 'recipient_upload_file_changed_during_dispatch' }), dispatched: true, noDispatch: false,
            outcomeUnknown: true, retryable: false };
        }
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, dispatched: true, file: file.name,
          attached: { name: file.name, size: file.size }, verified: false,
          attachmentState: target.isConnected && target.files?.length ? 'input_attached' : 'page_consumed',
          remoteStateVerified: false };
      };
      return pageGuard?.operationId ? monitor.withPreparedDispatch(pageGuard.operationId, attach) : attach();
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      return { success: false, dispatched, noDispatch: !dispatched, outcomeUnknown: dispatched,
        retryable: !dispatched, messageRecipientGuard: true, error: error?.message || String(error) };
    }
  }

  // Above this length the per-candidate rescan below stops being worth its
  // cost. The edit still succeeds; it is reported unproven, which the callers
  // treat as "no positive proof", not as a failure.
  const RICH_TEXT_TOOLBAR_PROOF_MAX_CHARS = 65536;

  // 32-bit FNV-1a. The append proof recomputes this once per candidate
  // insertion point, so a BigInt hash made a long contenteditable an O(n*m)
  // freeze inside the page.
  function _richTextToolbarValueSignature(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
    }
    return `${text.length}:${hash.toString(16)}`;
  }

  /**
   * Prove `after` is exactly `before` with `inserted` spliced in at one point.
   * Shared by the direct-value path (which still holds `before`) and the
   * signature path (which only kept a hash of it), so the two cannot drift.
   */
  function _richTextToolbarExactInsertion(before, after, inserted, beforeSignature = null) {
    if (!inserted || after.length > RICH_TEXT_TOOLBAR_PROOF_MAX_CHARS) return false;
    const expectedLength = typeof before === 'string'
      ? before.length + inserted.length
      : (() => {
          const separator = String(beforeSignature || '').indexOf(':');
          const beforeLength = separator > 0 ? Number(beforeSignature.slice(0, separator)) : NaN;
          return Number.isInteger(beforeLength) ? beforeLength + inserted.length : NaN;
        })();
    if (after.length !== expectedLength) return false;
    const matches = candidate => (typeof before === 'string'
      ? candidate === before
      : _richTextToolbarValueSignature(candidate) === beforeSignature);
    let index = after.indexOf(inserted);
    while (index >= 0) {
      if (matches(after.slice(0, index) + after.slice(index + inserted.length))) return true;
      index = after.indexOf(inserted, index + 1);
    }
    return false;
  }

  // Chrome types type_text({clear:true}) with trusted browser input from the
  // agent, so the content handlers' truncated-preview check never runs for
  // it. The agent asks here first, for the target its dispatch will use: the
  // preflight's bound element, else the selector match, else the focused
  // element. Any target this cannot read is left to the normal path.
  // The legacy iframe_type path writes in a frame without this script; it
  // reads its marked target's value there and asks with that value.
  function _checkTruncatedReplacement(params = {}) {
    if (typeof params.currentValue === 'string') {
      return _truncatedPreviewValueFailure(params.currentValue, String(params.text ?? '')) || { success: true };
    }
    const token = String(params.dispatchBinding?.token || '');
    const record = token ? _dispatchBindings.get(token) : null;
    let el = null;
    try {
      el = record?.el
        || (params.selector ? safeIndexedQuerySelector(params.selector, params.matchIndex).element : _deepActiveElement());
    } catch { return { success: true }; }
    if (!el?.isConnected) return { success: true };
    const truncatedPreview = _truncatedPreviewReplacementFailure(el, String(params.text ?? ''));
    if (!truncatedPreview) return { success: true };
    if (record) _releaseDispatchBinding(params);
    return { ...truncatedPreview, fieldMeta: _fieldMeta(el) };
  }

  function _prepareFocusedTypeDispatch(params = {}) {
    const token = String(params.dispatchBinding?.token || '');
    const record = token ? _dispatchBindings.get(token) : null;
    const el = record?.el;
    const active = _deepActiveElement();
    const tag = String(el?.tagName || '').toUpperCase();
    const typeable = el?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
    const valid = !!record
      && !!el?.isConnected
      && record.pageUrl === location.href
      && active === el
      && typeable;
    if (!valid) {
      if (record?.timer) clearTimeout(record.timer);
      if (token) _dispatchBindings.delete(token);
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        retryable: true,
        error: 'The focused target changed after the rich-text toolbar safety preflight. Focus the intended field again and retry.',
      };
    }
    record.prepared = true;
    const rect = el.getBoundingClientRect();
    const response = {
      success: true,
      tag,
      type: String(el.getAttribute?.('type') || '').toLowerCase(),
      name: el.getAttribute?.('name') || el.id || el.getAttribute?.('aria-label') || '',
      contentEditable: el.isContentEditable === true,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
    if (tag === 'SELECT') {
      const needle = String(params.text || '').trim();
      const options = Array.from(el.options || []);
      const match = options.find(option => option.value === needle)
        || options.find(option => String(option.text || '').trim() === needle)
        || options.find(option => String(option.text || '').trim().toLowerCase().includes(needle.toLowerCase()));
      if (!match) {
        if (record.timer) clearTimeout(record.timer);
        _dispatchBindings.delete(token);
        return {
          success: false,
          dispatched: false,
          noDispatch: true,
          error: `No option matching "${needle}". Available: ${options.map(option => String(option.text || '').trim()).join(', ')}`,
        };
      }
      response.selectInfo = {
        currentIndex: el.selectedIndex,
        targetIndex: match.index,
        targetText: String(match.text || '').trim(),
        targetValue: match.value,
      };
    } else {
      const value = String(el.isContentEditable ? (el.textContent || '') : (el.value || ''));
      response.beforeSignature = _richTextToolbarValueSignature(value);
    }
    return response;
  }

  async function _verifyFocusedTypeDispatch(params = {}) {
    const token = String(params.dispatchBinding?.token || '');
    const record = token ? _dispatchBindings.get(token) : null;
    if (record?.timer) clearTimeout(record.timer);
    if (token) _dispatchBindings.delete(token);
    const el = record?.el;
    if (!record?.prepared || !el?.isConnected || record.pageUrl !== location.href) {
      return { success: true, verified: false };
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    if (!el.isConnected || record.pageUrl !== location.href) return { success: true, verified: false };
    const tag = String(el.tagName || '').toUpperCase();
    let verified = false;
    if (tag === 'SELECT') {
      const option = el.options?.[el.selectedIndex];
      verified = String(el.value || '') === String(params.targetValue || '')
        || String(option?.text || '').trim() === String(params.targetText || '');
    } else {
      const expected = String(params.text || '');
      const value = String(el.isContentEditable ? (el.textContent || '') : (el.value || ''));
      if (params.clear === true) {
        verified = value === expected;
      } else {
        verified = _richTextToolbarExactInsertion(
          null,
          value,
          expected,
          String(params.beforeSignature || ''),
        );
      }
    }
    const rect = el.getBoundingClientRect();
    return {
      success: true,
      verified,
      fieldMeta: _fieldMeta(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
  }

  function _releaseDispatchBinding(params = {}) {
    const token = String(params.dispatchBinding?.token || '');
    const record = token ? _dispatchBindings.get(token) : null;
    if (record?.timer) clearTimeout(record.timer);
    if (token) _dispatchBindings.delete(token);
    return { success: true };
  }

  async function _settledRichTextToolbarRect(el, shouldScroll) {
    if (shouldScroll) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch {
        try { el.scrollIntoView(); } catch {}
      }
    }
    let previous = el.getBoundingClientRect();
    let stableFrames = 0;
    const deadline = performance.now() + 750;
    while (stableFrames < 2 && performance.now() < deadline) {
      await new Promise(resolve => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        setTimeout(finish, 40);
        try { requestAnimationFrame(finish); } catch {}
      });
      if (!el.isConnected) return null;
      const next = el.getBoundingClientRect();
      const delta = Math.max(
        Math.abs(next.x - previous.x),
        Math.abs(next.y - previous.y),
        Math.abs(next.width - previous.width),
        Math.abs(next.height - previous.height),
      );
      stableFrames = delta <= 0.5 ? stableFrames + 1 : 0;
      previous = next;
    }
    return el.isConnected ? el.getBoundingClientRect() : null;
  }

  async function _probeRichTextToolbarRetryTarget(params = {}) {
    try {
      const toolName = String(params.toolName || '');
      const args = params.args || {};
      let el = null;
      let coordinateTarget = false;
      let selectorMatchCount = null;
      let selectorMatchIndex = null;
      if (['click_ax', 'type_ax', 'set_checked', 'set_field'].includes(toolName) && typeof args.ref_id === 'string') {
        el = typeof window.__wb_ax_lookup === 'function' ? window.__wb_ax_lookup(args.ref_id) : null;
      } else if (toolName === 'type_text') {
        // Chrome Agent routes selector-based type_text through the same CDP
        // open/closed-shadow resolver used for dispatch before reaching this
        // light-DOM fallback.
        if (args.selector) {
          const selected = safeIndexedQuerySelector(args.selector, args.matchIndex);
          el = selected.element;
          selectorMatchCount = selected.matchCount;
          selectorMatchIndex = selected.matchIndex;
        }
        else if (args.index != null) el = queryInteractiveForToolIndex()[args.index] || null;
        else {
          // Follow open shadow roots to the element browser text insertion
          // will actually target. Parent frames legitimately expose their
          // active iframe without :focus; non-frame targets must still own
          // the document's focus so stale child-frame state is ignored.
          el = _deepActiveElement();
          const tag = String(el?.tagName || '').toLowerCase();
          if (!['iframe', 'frame'].includes(tag) && el?.matches && !el.matches(':focus')) {
            return { resolved: false };
          }
        }
      } else if (toolName === 'click') {
        if (args.selector) {
          el = safeQuerySelector(args.selector);
        } else if (args.index != null) {
          el = queryInteractiveForToolIndex()[args.index] || null;
        } else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
          el = document.elementFromPoint(Number(args.x), Number(args.y));
          coordinateTarget = true;
        } else if (typeof args.text === 'string' && args.text.trim()) {
          const needle = args.text.trim().toLowerCase();
          const scope = _findTopmostModal() || document;
          const selector = 'button,a[href],input,textarea,select,[role="button"],[role="textbox"],[role="combobox"],[tabindex],label';
          const candidates = Array.from(scope.querySelectorAll(selector))
            .map(candidate => ({ candidate, text: _siteInteractionText(candidate).trim().toLowerCase() }))
            .filter(item => item.text);
          for (const match of [
            item => item.text === needle,
            item => item.text.startsWith(needle),
            item => item.text.includes(needle),
          ]) {
            const matches = candidates.filter(match);
            if (matches.length === 1) {
              el = _resolveInteractiveAncestor(matches[0].candidate);
              break;
            }
            if (matches.length > 1) break;
          }
        }
      }
      if (!el || el === document.body || el === document.documentElement || !el.isConnected) {
        return { resolved: false };
      }
      // Score before measuring. Only an escalating candidate gets annotated
      // into a screenshot, and only that needs the target centred in the
      // viewport. A click probe still scrolls, because dispatching the click
      // scrolls anyway; text entry does not, so centring the page on every
      // type_text would move it under the user purely for the guard, and on
      // an animating page would spend the settle loop's full deadline doing
      // it. Settling in place is what keeps recovery geometry comparable.
      const fieldMeta = _fieldMeta(el);
      const escalating = Number(fieldMeta?.toolbarCandidate?.score) >= 4;
      const rect = await _settledRichTextToolbarRect(
        el,
        !coordinateTarget && (escalating || toolName === 'click'),
      );
      if (!rect) return { resolved: false };
      let refId = '';
      try { if (typeof window.__wb_ax_ref === 'function') refId = window.__wb_ax_ref(el) || ''; } catch {}
      const toolbarContext = _richTextToolbarContextForElement(el);
      const probedTag = String(el.tagName || '').toLowerCase();
      const dispatchBindingToken = (toolName === 'click' || (
        toolName === 'type_text' && args.index == null
      ))
        && !['iframe', 'frame'].includes(probedTag)
        ? _rememberDispatchBinding(el)
        : '';
      return {
        resolved: true,
        refId,
        documentToken: _axDocumentToken(),
        refScopeUrl: location.href,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          pageX: Math.round(rect.x + window.scrollX),
          pageY: Math.round(rect.y + window.scrollY),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        fieldMeta,
        ...(selectorMatchCount != null ? { selectorMatchCount, selectorMatchIndex } : {}),
        ...(dispatchBindingToken ? { dispatchBinding: { token: dispatchBindingToken } } : {}),
        ...toolbarContext,
      };
    } catch {
      return { resolved: false };
    }
  }

  function _waitForRichTextToolbarFocusedChildFrame(params = {}) {
    const token = String(params.token || '');
    const focusedFrame = _deepActiveElement();
    const tag = String(focusedFrame?.tagName || '').toLowerCase();
    if (!token || !focusedFrame?.isConnected || !['iframe', 'frame'].includes(tag)) {
      return Promise.resolve({ matched: false });
    }
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(value);
      };
      const onMessage = event => {
        if (event?.data?.__webbrainFocusedFrameToken !== token) return;
        // Only the focused frame's own announcement resolves this. Another
        // frame posting the token could never make the walk select it, but
        // answering `matched: false` on its behalf would end the wait before
        // the real child replied. Ignore it and let the timeout decide.
        if (event.source !== focusedFrame.contentWindow) return;
        finish({ matched: true });
      };
      window.addEventListener('message', onMessage);
      timer = setTimeout(() => finish({ matched: false }), 750);
    });
  }

  function _announceRichTextToolbarFocusedChildFrame(params = {}) {
    const token = String(params.token || '');
    if (!token || window.parent === window) return { announced: false };
    try {
      window.parent.postMessage({ __webbrainFocusedFrameToken: token }, '*');
      return { announced: true };
    } catch {
      return { announced: false };
    }
  }

  function _blurRichTextToolbarTarget(params = {}) {
    try {
      const active = document.activeElement;
      if (!active || active === document.body || active === document.documentElement) return { success: true, blurred: false };
      const refTarget = typeof params.ref_id === 'string' && typeof window.__wb_ax_lookup === 'function'
        ? window.__wb_ax_lookup(params.ref_id)
        : null;
      if (active === refTarget || refTarget?.contains?.(active)) {
        active.blur?.();
        return { success: true, blurred: document.activeElement !== active };
      }
      return { success: true, blurred: false };
    } catch {
      return { success: false, blurred: false };
    }
  }

  // Containers the messaging apps themselves use for their messaging surface.
  // Anything inside them stays on the recipient-verification path even when no
  // composer is currently rendered.
  const _MESSAGING_SURFACE_SELECTOR = [
    '[class*="msg-"]',
    '[class*="messaging"]',
    '[id*="messaging"]',
    '[data-messaging]',
    '[data-test-messaging]',
    '[role="log"]',
  ].join(',');

  function _inMessagingSurface(el) {
    try {
      return !!el?.closest?.(_MESSAGING_SURFACE_SELECTOR);
    } catch {
      return false;
    }
  }

  // Texts of a messaging page read by a model in any language, by the agent's
  // page-text question: what activating a control does (message_control:
  // send, publish, reply, new_message, new_post, draft_tool,
  // conversation_tool, other or unclear), what a message editor's field holds
  // (message_field: to, cc, bcc, subject, body or other), whether a message's
  // label says the page's own user sent it (message_author: self or other),
  // and what a sent message's status says (message_status: delivered, sent,
  // pending or unclear). The agent hands its readings to the page with each
  // guard check and chat observation, and the recipient guard, its dispatch
  // checks and the chat observer consult them here. A text nobody has read
  // yet is kept for the agent to read; until then each check takes it the
  // cautious way: a control as one that could send, a field as holding no
  // recipient, a message as nobody's in particular, a status as not
  // delivered.
  const _PAGE_READING_CHOICES = Object.freeze({
    message_control: new Set(['send', 'publish', 'reply', 'new_message', 'new_post', 'draft_tool', 'conversation_tool',
      'other', 'unclear']),
    message_field: new Set(['to', 'cc', 'bcc', 'subject', 'body', 'other']),
    message_author: new Set(['self', 'other']),
    message_status: new Set(['delivered', 'sent', 'pending', 'unclear']),
    page_blocker: new Set(['human_check', 'subscription', 'registration', 'login', 'other']),
  });
  // Readings that name an action of the control itself, never a contact's name.
  const _MESSAGE_CONTROL_ACTIONS = new Set(['send', 'publish', 'reply', 'new_message', 'new_post',
    'draft_tool', 'conversation_tool']);
  const _pageReadings = new Map();
  const _pageReadingsUnread = new Map();
  // Readings of overlay and article-block texts that hold digits, by the
  // text with each run of digits as one '#': which wall the texts of a shape
  // were read as (up to four of them), and whether one was read as no wall
  // or as another wall. A text of a shape read only as one wall is that wall
  // for now and is still read (see pageGateReading); once two texts of the
  // shape were read so, a countdown's next number is that wall without
  // another read. A shape with any other reading carries nothing over, as a
  // quota that stops being a wall at another number.
  const _pageBlockerShapes = new Map();
  const _PAGE_BLOCKER_WALL_TYPES = new Set(['subscription', 'registration', 'login']);

  function _pageReadingText(value) {
    return String(value ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }

  function _pageReadingDigitShape(text) {
    return /\p{Nd}/u.test(text) ? text.replace(/\p{Nd}+/gu, '#') : '';
  }

  // The wall a text gets from texts read as that wall that differ from it
  // only in their numbers, { choice, confirmed }, or null.
  function _pageBlockerWallByShape(value) {
    const shape = _pageReadingDigitShape(_pageReadingText(value));
    const entry = shape ? _pageBlockerShapes.get(shape) : null;
    if (!entry || entry.mixed || !entry.walls.size || !_PAGE_BLOCKER_WALL_TYPES.has(entry.choice)) return null;
    return { choice: entry.choice, confirmed: entry.walls.size >= 2 };
  }

  // `readings` is { question: { text: choice } }.
  function _rememberPageReadings(readings) {
    if (!readings || typeof readings !== 'object' || Array.isArray(readings)) return;
    for (const [kind, texts] of Object.entries(readings).slice(0, 8)) {
      const choices = Object.hasOwn(_PAGE_READING_CHOICES, kind) ? _PAGE_READING_CHOICES[kind] : null;
      if (!choices || !texts || typeof texts !== 'object' || Array.isArray(texts)) continue;
      // An overlay's or article block's text is read up to 600 characters.
      const limit = kind === 'page_blocker' ? 600 : 400;
      for (const [value, choice] of Object.entries(texts).slice(0, 800)) {
        const text = _pageReadingText(value);
        if (!text || text.length > limit || !choices.has(choice)) continue;
        const key = `${kind}\u0000${text}`;
        _pageReadings.delete(key);
        _pageReadings.set(key, choice);
        _pageReadingsUnread.delete(key);
        const shape = kind === 'page_blocker' ? _pageReadingDigitShape(text) : '';
        if (shape) {
          const entry = _pageBlockerShapes.get(shape) || { choice: '', walls: new Set(), mixed: false };
          if (!_PAGE_BLOCKER_WALL_TYPES.has(choice) || (entry.choice && entry.choice !== choice)) entry.mixed = true;
          else {
            entry.choice = choice;
            if (entry.walls.size < 4) entry.walls.add(text);
          }
          _pageBlockerShapes.delete(shape);
          _pageBlockerShapes.set(shape, entry);
        }
      }
    }
    while (_pageReadings.size > 3200) _pageReadings.delete(_pageReadings.keys().next().value);
    while (_pageBlockerShapes.size > 800) _pageBlockerShapes.delete(_pageBlockerShapes.keys().next().value);
  }

  // The reading of one text: its choice, '' when there is no text, or null
  // when nobody has read it yet (it is then kept for the agent to read,
  // unless `queue` is false). A text longer than `maxLength` characters is
  // not read; it reads as `longText`.
  function _pageReading(kind, value, longText = null, { queue = true, maxLength = 400 } = {}) {
    const text = _pageReadingText(value);
    if (!text) return '';
    if (text.length > maxLength) return longText;
    const key = `${kind}\u0000${text}`;
    const choice = _pageReadings.get(key);
    if (choice) return choice;
    if (!queue) return null;
    _pageReadingsUnread.delete(key);
    _pageReadingsUnread.set(key, { kind, text });
    while (_pageReadingsUnread.size > 64) _pageReadingsUnread.delete(_pageReadingsUnread.keys().next().value);
    return null;
  }

  // What a control's caption reads as. A text this long is not a control's
  // name.
  function _messageControlReading(value) {
    return _pageReading('message_control', value, 'other');
  }

  // A caption read as sending something to someone, or not read yet.
  function _mayBeMessageSend(value) {
    const reading = _messageControlReading(value);
    return reading === 'send' || reading === null;
  }

  // The texts consulted unread, all of them or those of one question, taken
  // from the queue for the agent to read.
  function _takeUnreadPageTexts(kind = '') {
    const texts = [];
    for (const [key, entry] of [..._pageReadingsUnread.entries()]) {
      if (kind && entry.kind !== kind) continue;
      texts.push(entry);
      _pageReadingsUnread.delete(key);
    }
    return texts;
  }

  // The page monitor's capture of a conversation's footer actions and the chat
  // observer consult the same readings (who the conversation is depends on
  // which header controls are actions; whose a message is, on its label), so
  // they can hand over the agent's readings, look one up, and tell the agent
  // that texts were consulted unread.
  window.__wb_remember_page_readings = readings => {
    if (WEBBRAIN_GENERATION === (Number(window.__webbrain_generation) || 0)) _rememberPageReadings(readings);
  };
  window.__wb_page_reading = (kind, value) => (WEBBRAIN_GENERATION === (Number(window.__webbrain_generation) || 0)
    && Object.hasOwn(_PAGE_READING_CHOICES, kind) ? _pageReading(kind, value) : null);
  window.__wb_page_texts_unread = () => WEBBRAIN_GENERATION === (Number(window.__webbrain_generation) || 0)
    && _pageReadingsUnread.size > 0;

  // Composer utilities sit at the composer's edge, so the geometry rule would
  // otherwise treat them as potential sends: Gmail's own toolbar exposes
  // "Save & close", "Minimize", "Exit full screen (Shift for Pop-out)", plus
  // attach/formatting/discard controls. None of them can commit a message.
  // Without this a click on "Save & close" was reported as a blocked message
  // send and the task could never finish. A model reads the control's name in
  // any language (a `draft_tool` reading); an unread name is no utility.
  function _isComposerUtilityControl(el) {
    if (!el) return false;
    try {
      const label = String(
        el.getAttribute?.('aria-label')
        || el.getAttribute?.('title')
        || el.getAttribute?.('data-tooltip')
        || el.value
        || el.innerText
        || el.textContent
        || '',
      ).replace(/\s+/g, ' ').trim();
      if (label && _messageControlReading(label) === 'draft_tool') return true;
      // Icon-only controls carry their name on the icon itself (<svg
      // aria-label>, <img alt>). Every named icon must be a utility.
      if (!label) {
        const iconNames = Array.from(el.querySelectorAll?.('svg[aria-label],[role="img"][aria-label],img[alt]') || [])
          .slice(0, 4)
          .map(icon => String(icon.getAttribute('aria-label') || icon.getAttribute('alt') || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const iconReadings = iconNames.map(_messageControlReading);
        if (iconReadings.length && iconReadings.every(reading => reading === 'draft_tool')) return true;
      }
      // Formatting toolbars and pressed toggles are structural non-sends.
      const formattingScope = el.closest?.('[role="toolbar"]');
      if (formattingScope && formattingScope !== el) return true;
      if (el.hasAttribute?.('aria-pressed')) return true;
      return false;
    } catch {
      return false;
    }
  }

  // Read-only pre-dispatch probe for adapters that require a verified active
  // conversation before a message can be sent. It deliberately ignores input
  // values and ordinary page text: a searched recipient name is not proof that
  // the corresponding conversation is active.
  // Isolated-world, read-only bridge for private pre-inference footprints.
  // Only controls in the verified composer's own native footer are eligible;
  // neither runtime params nor the page's main world receive DOM references.
  window.__wb_get_message_conversation_context = target => {
    try {
      if (WEBBRAIN_GENERATION !== (Number(window.__webbrain_generation) || 0)
          || target?.nodeType !== 1 || !target.isConnected || target.ownerDocument !== document) return null;
      const footer = target.closest('footer');
      const control = target.closest('button,[role="button"],input,select,textarea,'
        + '[contenteditable="true"],[contenteditable=""],[role="textbox"]');
      const excluded = 'aside,nav,search,[role="navigation"],[role="complementary"],[role="search"],'
        + '[role="searchbox"],[role="log"],[role="listbox"],[role="menu"],'
        + '[data-message-id],[data-message-direction],[data-outgoing],article';
      if (!footer || !control || !footer.contains(control) || target.closest(excluded)
          || /^search$/i.test(control.getAttribute('type') || '')) return null;
      let context = null;
      _probeMessageRecipientGuard({ tool: 'observe_active_conversation', adapterName: 'generic-messaging', args: {} }, evidence => {
        if (evidence?.footer !== footer || evidence.composer?.closest('footer') !== footer
            || !footer.contains(target) || !evidence.pane.contains(evidence.carrier)) return null;
        context = Object.freeze({ ...evidence, name: evidence.aliases[0],
          aliases: Object.freeze([...evidence.aliases]),
          labelledByNodes: Object.freeze([...evidence.labelledByNodes]),
          contextNodes: Object.freeze([...evidence.contextNodes]) });
        return null;
      });
      return context;
    } catch { return null; }
  };

  // --- Trusted native button hover settle (read-only) ---
  // After the agent's own trusted hover, the agent samples the exact certified
  // button until its geometry is stable before the press. Sampling never
  // focuses, scrolls, dispatches or starts a monitor operation. Hit nodes are
  // compared by private isolated-world tokens, never by page data.
  const _nativeButtonHitTokens = new WeakMap();
  let _nativeButtonHitTokenSeq = 0;
  let _nativeButtonSettleWatch = null;
  const _nativeButtonPaintOnlyProperty = /^(?:color|opacity|box-shadow|text-shadow|filter|backdrop-filter|fill|fill-opacity|stroke|stroke-opacity|caret-color|accent-color|text-decoration-color|outline(?:-color|-width|-style|-offset)?|background(?:-color|-image|-position(?:-x|-y)?|-size)?|border(?:-(?:top|right|bottom|left|block-start|block-end|inline-start|inline-end))?-color)$/;

  function _nativeButtonHitToken(node) {
    if (!node) return 0;
    let value = _nativeButtonHitTokens.get(node);
    if (!value) { value = ++_nativeButtonHitTokenSeq; _nativeButtonHitTokens.set(node, value); }
    return value;
  }

  // Physical input during the settle wait belongs to the user: the agent sends
  // none. Pointer movement at the agent's own hover point (late or repeated
  // browser movement events) is not intervention.
  function _nativeButtonSettleWatchFor(session, pointer) {
    if (_nativeButtonSettleWatch?.session === session) return _nativeButtonSettleWatch;
    _nativeButtonSettleWatch?.stop();
    const types = ['pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup',
      'keydown', 'keyup', 'wheel', 'touchstart', 'touchmove', 'touchend'];
    const watch = { session, input: false };
    const onInput = event => {
      if (!event.isTrusted) return;
      if ((event.type === 'pointermove' || event.type === 'mousemove')
          && Math.abs(event.clientX - pointer.x) <= 1 && Math.abs(event.clientY - pointer.y) <= 1) return;
      watch.input = true;
    };
    for (const type of types) window.addEventListener(type, onInput, { capture: true, passive: true });
    const timer = setTimeout(() => watch.stop(), 2000);
    watch.stop = () => {
      clearTimeout(timer);
      for (const type of types) window.removeEventListener(type, onInput, true);
      if (_nativeButtonSettleWatch === watch) _nativeButtonSettleWatch = null;
    };
    _nativeButtonSettleWatch = watch;
    return watch;
  }

  // A finite running transition/animation that can still move or resize the
  // button (on it or an ancestor) means it has not settled, even when two
  // samples happen to match (a delay phase or a sub-pixel easing tail).
  // Infinite animations never settle by waiting; their geometry samples decide.
  function _nativeButtonGeometryAnimating(el) {
    let animations = [];
    try { animations = document.getAnimations(); } catch { return false; }
    return animations.some(animation => {
      try {
        const target = animation.effect?.target;
        if (animation.playState !== 'running' || !(target instanceof Element) || animation.effect.pseudoElement
            || !_isComposedAncestor(target, el)) return false;
        if (animation.effect.getComputedTiming?.().iterations === Infinity) return false;
        const properties = typeof animation.transitionProperty === 'string' ? [animation.transitionProperty]
          : (animation.effect.getKeyframes?.() || []).flatMap(frame => Object.keys(frame))
            .filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))
            .map(key => key.startsWith('--') ? key : key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`));
        return !properties.length || properties.some(property => !_nativeButtonPaintOnlyProperty.test(property));
      } catch { return true; }
    });
  }

  function _sampleTrustedNativeButton(params = {}) {
    const failure = (predicate, error, extra = {}) => ({ success: false, dispatched: false, noDispatch: true, predicate, error, ...extra });
    const { ref_id, expectedDocumentToken, expectedPageUrl, settleSession, pointer } = params;
    if (typeof ref_id !== 'string' || typeof settleSession !== 'string' || !settleSession
        || !Number.isFinite(pointer?.x) || !Number.isFinite(pointer?.y)) return failure('target_changed', 'Invalid native button sample.');
    const watch = _nativeButtonSettleWatchFor(settleSession, pointer);
    if (window.__wbPageMonitor?.active !== true) return failure('run_ended', 'The browser run ended while the native button settled. No click was sent.');
    if ((expectedDocumentToken && expectedDocumentToken !== _axDocumentToken())
        || (expectedPageUrl && expectedPageUrl !== location.href)) {
      return failure('document_changed', 'The page or route changed while the native button settled. No click was sent. Re-observe before acting.');
    }
    const el = typeof window.__wb_ax_lookup === 'function' ? window.__wb_ax_lookup(ref_id) : null;
    if (!el || !el.isConnected || el.tagName !== 'BUTTON') {
      return failure('target_changed', 'The exact native button was removed or replaced while its hover settled. No click was sent. Re-observe before acting.');
    }
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    const hit = _shadowAwareElementFromPoint(x, y);
    if (!_axFallbackVisibility(el).visible || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight
        || !hit || !_isComposedAncestor(el, hit) || _axInteractiveHitDescendant(el, hit)) {
      return failure('target_hit_changed', 'The native button became hidden, covered or ambiguous while its hover settled. No click was sent. Re-observe before clicking.');
    }
    return { success: true, dispatched: false, noDispatch: true, x, y,
      rect: [rect.left, rect.top, rect.width, rect.height],
      roundedRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      hit: _nativeButtonHitToken(hit), animating: _nativeButtonGeometryAnimating(el), userInput: watch.input === true };
  }

  function _probeMessageRecipientGuard(params = {}, receiveConversationContext = null) {
    try {
      const tool = String(params.tool || '');
      const observationOnly = tool === 'observe_active_conversation';
      const args = params.args && typeof params.args === 'object' ? params.args : {};
      const compact = (value, max = 240) => String(value ?? '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
      const normalizedIdentity = (value) => {
        const identity = compact(value, 240);
        if (!identity) return '';
        try { return identity.normalize('NFKC').toLocaleLowerCase(); } catch { return identity.toLowerCase(); }
      };
      const visible = (el) => {
        if (!el || el.nodeType !== 1 || !el.isConnected) return false;
        try {
          for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.getAttribute?.('aria-hidden') === 'true') return false;
          }
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        } catch {
          return false;
        }
      };
      const editable = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const tag = String(el.tagName || '').toLowerCase();
        const type = String(el.getAttribute?.('type') || 'text').toLowerCase();
        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        const textInput = tag === 'input'
          && !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/.test(type);
        return !!el.isContentEditable
          || tag === 'textarea'
          || textInput
          || role === 'textbox'
          || role === 'searchbox';
      };
      // Must stay identical to the agent's _workflowMessageBody: the probe
      // compares page text against a body the agent already normalized, and a
      // body whose paragraphs were collapsed must not match the requested one.
      const normalizedMessageBody = (value) => {
        let text = String(value ?? '')
          .replace(/[\u200b-\u200d\ufeff]/g, '')
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map(line => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join('\n');
        try { text = text.normalize('NFKC'); } catch {}
        return text.length <= 20000 ? text : '';
      };
      const composerMessageBody = (el) => {
        try {
          return normalizedMessageBody('value' in el ? el.value : (el.innerText || el.textContent || ''));
        } catch {
          return '';
        }
      };
      const expectedRecipientIdentities = (Array.isArray(params.expectedRecipients)
        ? params.expectedRecipients
        : [])
        .map(value => normalizedIdentity(value && typeof value === 'object' ? value.identity : value))
        .filter(Boolean);
      const outgoingMessageContainer = (el, { byLabel = true } = {}) => {
        let current = el;
        for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
          const direction = normalizedIdentity([
            current.getAttribute?.('data-message-direction'),
            current.getAttribute?.('data-direction'),
            current.getAttribute?.('data-message-author-role'),
            current.getAttribute?.('data-author-role'),
          ].filter(Boolean).join(' '));
          const booleanOutgoing = String(
            current.getAttribute?.('data-outgoing')
            || current.getAttribute?.('data-is-outgoing')
            || '',
          ).toLowerCase();
          const className = normalizedIdentity(
            typeof current.className === 'string' ? current.className : '',
          );
          // The app's own direction attributes and classes decide first; a
          // message label saying the page's own user sent it ("You sent ...")
          // is read by a model in any language.
          if (/\b(?:outgoing|sent|self|own|user|from-me)\b/.test(direction)
              || booleanOutgoing === 'true'
              || /(?:^|[-_\s])(?:outgoing|message-out|sent-message|is-sent|from-me|own-message|self-message)(?:$|[-_\s])/.test(className)
              || (byLabel && _pageReading('message_author', current.getAttribute?.('aria-label')) === 'self')) {
            return current;
          }
          if (params.adapterName === 'gmail'
              && expectedRecipientIdentities.length > 0
              && (current.hasAttribute?.('data-message-id')
                || current.hasAttribute?.('data-legacy-message-id'))) {
            let recipientNodes = [];
            try {
              recipientNodes = Array.from(current.querySelectorAll?.(
                '[email],[data-email],[data-hovercard-id]'
              ) || []);
            } catch {}
            const observedRecipients = new Set(recipientNodes.flatMap(node => [
              node.getAttribute?.('email'),
              node.getAttribute?.('data-email'),
              node.getAttribute?.('data-hovercard-id'),
            ]).map(normalizedIdentity).filter(Boolean));
            if (expectedRecipientIdentities.every(identity => observedRecipients.has(identity))) return current;
          }
        }
        return null;
      };
      const twitterConversation = params.adapterName === 'twitter'
        && /^\/i\/chat\/[^/]+\/?$/.test(location.pathname);
      const twitterLogs = twitterConversation
        ? Array.from(document.querySelectorAll('[role="log"][data-testid="dm-message-scroller"]')).filter(visible) : [];
      // Keep all mounted identities, including hidden and pending rows. A
      // virtualized row becoming visible or an old retry becoming sent must
      // never look like the message dispatched by this run.
      const twitterRows = twitterLogs.length === 1
        ? Array.from(twitterLogs[0].querySelectorAll('[data-testid^="message-"]'))
            .filter(row => /^message-(?!text-)[a-zA-Z0-9_-]{1,128}$/.test(row.getAttribute('data-testid') || ''))
        : [];
      const twitterMessageIds = twitterRows.map(row => row.getAttribute('data-testid'));
      const twitterHistorySettled = twitterLogs.length === 1
        && _settledTwitterHistory(twitterLogs[0], twitterMessageIds);
      const twitterEmptyConversationBaseline = twitterRows.length === 0 && twitterHistorySettled;
      // A mounted X log can still append older history. Empty conversations
      // need a positive X completion signal; other histories need that signal
      // or a stable row snapshot before they become dispatch baselines.
      const twitterBaselineComplete = twitterLogs.length === 1 && twitterRows.length <= 2000
        && new Set(twitterMessageIds).size === twitterMessageIds.length
        && (twitterRows.length > 0 ? twitterHistorySettled : twitterEmptyConversationBaseline);
      const matchingTwitterMessageIds = expectedBody => {
        const expected = normalizedMessageBody(expectedBody);
        if (!expected || !twitterBaselineComplete) return [];
        return twitterRows.filter(row => visible(row) && row.classList.contains('justify-end')
          && row.getAttribute('data-send-status') === 'sent')
          .filter(row => {
            const body = row.querySelector('[data-testid^="message-text-"] span[dir="auto"]');
            return visible(body) && normalizedMessageBody(body.innerText || body.textContent) === expected;
          }).map(row => row.getAttribute('data-testid'));
      };
      const matchingMessageBodyCount = (expectedBody, activeComposer = null) => {
        const expected = normalizedMessageBody(expectedBody);
        if (!expected) return 0;
        if (twitterConversation) return matchingTwitterMessageIds(expected).length;
        let candidates = [];
        try {
          candidates = Array.from(document.querySelectorAll(
            'div,span,p,li,article,[role="listitem"],[data-message-id],[data-legacy-message-id]'
          )).slice(0, 12000);
        } catch {
          return 0;
        }
        const matches = candidates.filter((el) => {
          if (!visible(el) || editable(el)) return false;
          if (activeComposer && (el === activeComposer || activeComposer.contains?.(el))) return false;
          // The app's own direction markup decides cheaply. Otherwise only a
          // labelled node holding exactly the body asks whose message it is.
          const ownByMarkup = !!outgoingMessageContainer(el, { byLabel: false });
          if (!ownByMarkup) {
            let labelled = false;
            for (let node = el, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
              if (node.hasAttribute?.('aria-label')) { labelled = true; break; }
            }
            if (!labelled) return false;
          }
          try {
            if (el.closest?.('button,[role="button"],[role="alert"],[role="status"],[aria-live],nav,[role="navigation"]')) {
              return false;
            }
          } catch {}
          if (normalizedMessageBody(el.innerText || el.textContent || '') !== expected) return false;
          return ownByMarkup || !!outgoingMessageContainer(el);
        });
        // Nested wrappers often repeat the same innerText. Count only the
        // innermost exact nodes so the before/after cardinality is stable.
        return matches.filter(el => !matches.some(other => other !== el && el.contains?.(other))).length;
      };
      const verifiedNavigationEditable = (el) => {
        if (!editable(el)) return false;
        const tag = String(el.tagName || '').toLowerCase();
        const type = String(el.getAttribute?.('type') || '').toLowerCase();
        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        if (role === 'searchbox' || (tag === 'input' && type === 'search')) return true;
        try {
          return !!el.closest?.('search,[role="search"],form[role="search"],nav,[role="navigation"]');
        } catch {
          return false;
        }
      };
      // Native Gmail search and draft fields are identified from the live DOM,
      // before a missing/AI composer can make ordinary navigation look like Send.
      const gmailComposeOf = (el) => {
        if (params.adapterName !== 'gmail' || location.protocol !== 'https:' || location.hostname !== 'mail.google.com'
            || !/^\/mail\//.test(location.pathname)) return null;
        const root = el?.closest?.('[role="dialog"]');
        const subject = root?.querySelector('input[name="subjectbox"]');
        const bodies = Array.from(root?.querySelectorAll('[role="textbox"][contenteditable="true"]') || [])
          .filter(field => visible(field) && (field.classList.contains('Am') || field.getAttribute('aria-label') === 'Message Body'));
        return visible(subject) && bodies.length === 1 ? { root, subject, body: bodies[0] } : null;
      };
      const gmailDraftKind = (el) => {
        const compose = gmailComposeOf(el);
        if (!compose || !visible(el) || !editable(el)) return '';
        if (el === compose.body) return 'body';
        if (el === compose.subject) return 'subject';
        return el.matches('input[name="to"],input[name="cc"],input[name="bcc"]')
          || (el.matches('input[role="combobox"][autocomplete="off"]')
            && /^(?:to|cc|bcc) recipients$/i.test(el.getAttribute('aria-label') || '')) ? 'recipient' : '';
      };
      const gmailSearchControl = (el) => {
        if (params.adapterName !== 'gmail' || location.protocol !== 'https:' || location.hostname !== 'mail.google.com'
            || !/^\/mail\//.test(location.pathname) || !visible(el)
            || el.closest?.('[role="dialog"],.a3s,[data-message-id]')) return false;
        const form = el.closest?.('form#aso_search_form_anchor[role="search"]');
        const field = form?.querySelector('input[name="q"][autocomplete="off"]');
        return form?.method.toLowerCase() === 'get' && el === field
          && /^(?:Ask Gmail|Search mail)$/.test(field.getAttribute('aria-label') || '');
      };
      const active = typeof _deepActiveElement === 'function' ? _deepActiveElement() : document.activeElement;

      let target = null;
      let dispatchTarget = null;
      let targetResolved = observationOnly || tool === 'press_keys';
      if (tool === 'upload_file') {
        target = _messageRecipientUploadTarget(args.selector);
        targetResolved = !!target;
      } else if (tool === 'click_ax' || tool === 'set_field') {
        const refId = String(args.ref_id || '');
        if (refId && typeof window.__wb_ax_lookup === 'function') target = window.__wb_ax_lookup(refId);
        targetResolved = !!target;
      } else if (tool === 'click') {
        // Match dispatch precedence, modal scope, candidate text and match
        // mode. A supplied selector must not approve a different text click.
        // Models routinely pass a ref_id to `click` instead of `click_ax`; the
        // probe must resolve that the same way the dispatch will, otherwise a
        // perfectly good click was reported as "could not conclusively resolve
        // the target control".
        if (typeof args.ref_id === 'string' && args.ref_id
            && typeof window.__wb_ax_lookup === 'function') {
          target = window.__wb_ax_lookup(args.ref_id);
        }
        if (!target && typeof args.text === 'string' && args.text) {
          const needle = args.text.toLowerCase();
          const scope = _findTopmostModal() || document;
          const candidates = _clickTextCandidates(scope);
          const modes = args.textMatch ? [args.textMatch] : ['exact', 'prefix', 'contains'];
          for (const mode of modes) {
            let matches = candidates.filter(({ txt }) => mode === 'exact' ? txt === needle
              : mode === 'prefix' ? txt.startsWith(needle)
                : mode === 'contains' ? txt.includes(needle) : false);
            // Dispatch prefers the sole visible-text match over an
            // attribute-derived needle on a different control, then the sole
            // interactive match over passive labels. Multiple matches of the
            // same tier must still stop at this match tier.
            if (matches.length > 1) {
              const primaryMatch = _preferredPrimaryTextClickMatch(matches);
              if (primaryMatch) matches = [primaryMatch];
              const interactiveMatches = matches.filter(({ e }) => _isInteractive(e));
              if (interactiveMatches.length === 1) matches = interactiveMatches;
              else {
                const hitTargetPool = (interactiveMatches.length > 1 ? interactiveMatches : matches)
                  .filter(({ e }) => _isEligibleTextClickTarget(e));
                if (hitTargetPool.length === 1) matches = hitTargetPool;
                else if (hitTargetPool.length > 1 && hitTargetPool.length < matches.length) {
                  matches = hitTargetPool;
                }
              }
            }
            if (matches.length === 1) target = _resolveInteractiveAncestor(matches[0].e);
            if (matches.length) break;
          }
        } else if (!target && typeof args.selector === 'string' && args.selector) {
          target = safeIndexedQuerySelector(args.selector, args.matchIndex).element;
        } else if (!target && Number.isInteger(args.index) && args.index >= 0) {
          target = queryInteractiveForToolIndex()[args.index] || null;
        } else if (!target && Number.isFinite(args.x) && Number.isFinite(args.y)) {
          target = _shadowAwareElementFromPoint(args.x, args.y);
        }
        targetResolved = !!target;
      }

      const composerCandidates = [];
      const addComposer = (el) => {
        if (editable(el) && visible(el) && !composerCandidates.includes(el)) composerCandidates.push(el);
      };
      addComposer(active);
      addComposer(target);
      try {
        for (const el of document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')) {
          addComposer(el);
        }
      } catch {}
      composerCandidates.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.bottom - ar.bottom)
          || (br.left - ar.left)
          || ((br.width * br.height) - (ar.width * ar.height));
      });
      const viewportHeight = Math.max(0, Number(window.innerHeight) || 0);
      const twitterComposers = twitterConversation
        ? composerCandidates.filter(el => el.matches('textarea[data-testid="dm-composer-textarea"]')) : [];
      const gmailComposers = composerCandidates.filter(el => gmailComposeOf(el)?.body === el);
      const gmailScopedComposer = gmailComposeOf(target)?.body || gmailComposeOf(active)?.body
        || (gmailComposers.length === 1 ? gmailComposers[0] : null);
      const layoutCandidate = gmailScopedComposer || (gmailComposers.length ? null : twitterConversation
        ? (twitterComposers.length === 1 ? twitterComposers[0] : null)
        : composerCandidates[0] || null);
      const layoutCandidateRect = layoutCandidate?.getBoundingClientRect?.();
      const independentScrollableRegion = (el, excluded) => {
        let node = el || null;
        while (node && node !== document.body) {
          try {
            const style = getComputedStyle(node);
            const overflowY = String(style.overflowY || style.overflow || '').toLowerCase();
            const scrollable = /^(auto|scroll|overlay)$/.test(overflowY)
              && Number(node.scrollHeight) > Number(node.clientHeight) + 1;
            if (scrollable && !(typeof node.contains === 'function' && node.contains(excluded))) return node;
          } catch {}
          node = node.parentElement;
        }
        return null;
      };
      const verifiedConversationSelection = (clicked, composer) => {
        if (!clicked || !composer || editable(clicked)) return false;
        const semanticRowSelector = [
          '[role="option"]',
          '[role="listitem"]',
          '[role="treeitem"]',
          '[role="tab"]',
          '[aria-selected]',
          '[aria-current]',
          '[data-conversation-id]',
          '[data-thread-id]',
          '[data-chat-id]',
        ].join(',');
        // Prefer the semantic conversation row over a nested action link. A
        // plain navigation link can itself be the row only when no stronger
        // row container exists.
        const nativeLinkedInRow = params.adapterName === 'linkedin'
          && /^\/messaging(?:\/|$)/.test(location.pathname)
          ? clicked.closest?.('li') : null;
        const nativeConversationRow = nativeLinkedInRow
          && nativeLinkedInRow.parentElement?.matches(
            'ul.msg-conversations-container__conversations-list',
          ) ? nativeLinkedInRow : null;
        const row = clicked.closest?.(semanticRowSelector)
          || nativeConversationRow
          || clicked.closest?.('a[href]')
          || null;
        if (!row || !visible(row) || editable(row)) return false;

        // Reject the entire descendant chain of a nested menu/delete/forward
        // control. Selector and AX resolution often return a span or SVG
        // inside the actual button, so checking only the leaf tag/role lets
        // the click bubble into a consequential row action.
        if (row !== clicked) {
          const nestedActionSelector = [
            'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
            '[contenteditable="true"]', '[contenteditable=""]',
            '[role="button"]', '[role="link"]', '[role="menuitem"]',
            '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
            '[role="combobox"]', '[role="textbox"]', '[aria-haspopup]',
            '[onclick]', '[data-action]',
          ].join(',');
          const nestedAction = clicked.closest?.(nestedActionSelector) || null;
          if (nestedAction && nestedAction !== row && row.contains?.(nestedAction)) return false;
        }

        if (row === nativeConversationRow) {
          const rect = clicked.getBoundingClientRect();
          const hit = _shadowAwareElementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!_isComposedAncestor(clicked, hit)) return false;
          for (let node = hit; node && node !== clicked; node = _composedParent(node)) {
            if (_isInteractive(node) || node.matches?.('label,option,summary,[contenteditable], [role=checkbox],[role=radio],[role=switch]')) return false;
          }
        }

        const role = String(row.getAttribute?.('role') || '').toLowerCase();
        const tag = String(row.tagName || '').toLowerCase();
        const hasRowSemantics = row === nativeConversationRow || /^(option|listitem|treeitem|tab)$/.test(role)
          || row.hasAttribute?.('aria-selected')
          || row.hasAttribute?.('aria-current')
          || ['data-conversation-id', 'data-thread-id', 'data-chat-id']
            .some(name => compact(row.getAttribute?.(name), 120));
        const hasNavigationHref = tag === 'a' && compact(row.getAttribute?.('href'), 500);
        if (!hasRowSemantics && !hasNavigationHref) return false;

        // Overflow is strong evidence when the rail has enough rows to scroll;
        // semantic row identity plus full separation from the composer also
        // covers short conversation lists that do not currently overflow.
        const rail = independentScrollableRegion(row, composer) || row;
        const composerRect = composer.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        // Protected chat adapters currently expose the conversation list as a
        // separate left rail. Message-history controls overlap the composer
        // column and deliberately remain inconclusive.
        return rowRect.right <= composerRect.left + 24
          && railRect.right <= composerRect.left + 64;
      };

      const verifiedLinkedInImagePreview = clicked => {
        if (params.adapterName !== 'linkedin') return false;
        const button = _composedClosestElement(clicked, 'button,[role="button"]');
        if (!button) return false;
        // Reject other controls before preview-specific style and hit probes.
        if (!_composedClosestElement(button, '[role="log"],.msg-s-message-list,.msg-s-event-listitem')) return false;
        const painted = el => {
          if (!visible(el) || !_hasVisibleBox(el)) return false;
          for (let node = el; node?.nodeType === 1; node = _composedParent(node)) {
            if (getComputedStyle(node).opacity === '0') return false;
          }
          return true;
        };
        if (!button || !painted(button) || button.disabled || button.matches(':disabled')
            || button.getAttribute('aria-disabled') === 'true'
            || (button.hasAttribute('type') && String(button.getAttribute('type')).toLowerCase() !== 'button')
            || button.form || button.hasAttribute('form') || button.hasAttribute('download')
            || /^(?:true|menu|listbox|tree|grid)$/.test(button.getAttribute('aria-haspopup') || '')
            || _composedClosestElement(button, 'form,.msg-form,[contenteditable]:not([contenteditable="false"])')) return false;
        // Attachment previews live in history, not in the composer. Proximity
        // to the composer cannot turn this verified viewer into a send; labels
        // alone cannot exempt a message commit or an unrelated image button.
        if ([button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-tooltip'), button.innerText || button.textContent]
            .map(_mayBeMessageSend).includes(true)) return false;
        const rect = button.getBoundingClientRect();
        const hit = _shadowAwareElementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        // LinkedIn localizes the preview label. Verify the attachment itself
        // at the dispatch point instead; small avatar/reaction/menu icons do
        // not prove that a button opens an image viewer.
        return _isComposedAncestor(button, hit) && Array.from(button.querySelectorAll('img[src]')).some(image => {
          const imageRect = image.getBoundingClientRect();
          return painted(image) && imageRect.width >= 64 && imageRect.height >= 64
            && _isComposedAncestor(image, hit);
        });
      };

      const classifyLinkedInNavigation = (clicked, blockingModal = null) => {
        if (params.adapterName !== 'linkedin' || !clicked) return 'none';
        const link = _composedClosestElement(clicked, 'a[href]');
        if (!link || !visible(link)) return 'none';
        // A navigation-looking descendant of a composer/action is not a
        // navigation escape hatch. Keep actual sends and modal controls on
        // the existing recipient-verification path.
        if (_composedClosestElement(clicked, 'button,[role="button"],input,select,textarea,[contenteditable]:not([contenteditable="false"]),[onclick],[data-action]')
            || _composedClosestElement(link, 'form')
            || link.hasAttribute?.('download')
            || (link.getAttribute?.('role') && link.getAttribute('role') !== 'link')) return 'blocked';
        const heuristicModalSelector = '[data-overlay],.modal.show,.modal-overlay,.overlay,'
          + '[class*="modal"][class*="open"],[class*="overlay"][class*="active"],'
          + '[class*="DialogOverlay"],[class*="ModalOverlay"]';
        const dialogContentSelector = '[class*="DialogContent"],[class*="ModalContent"]';
        const composedModal = _composedClosestElement(
          link,
          `dialog,[role="dialog"],[role="alertdialog"],${heuristicModalSelector},${dialogContentSelector}`,
        );
        const modal = composedModal
          || (blockingModal && _isComposedAncestor(blockingModal, link) ? blockingModal : null);
        const contentHasVisibleOverlaySibling = (() => {
          if (!modal?.matches?.(dialogContentSelector)) return false;
          const parent = modal.parentElement || modal.parentNode;
          if (!parent) return false;
          return Array.from(parent.children).some((sibling) => sibling !== modal
            && sibling.matches?.('[class*="DialogOverlay"],[class*="ModalOverlay"]')
            && _hasVisibleBox(sibling, 100, 100));
        })();
        const modalIsBlocking = !!modal && (
          modal === blockingModal
          || (modal.tagName === 'DIALOG' && modal.hasAttribute('open') && _isNativeBlockingDialog(modal))
          || (/^(?:dialog|alertdialog)$/.test(modal.getAttribute?.('role') || '')
            && modal.getAttribute?.('aria-modal') === 'true')
          || contentHasVisibleOverlaySibling
          || (() => {
            if (!modal.matches?.(heuristicModalSelector)) return false;
            const rect = modal.getBoundingClientRect();
            return rect.width > 100 && rect.height > 100;
          })()
        );
        const unresolved = () => modal ? 'blocked' : 'none';
        try {
          const href = String(link.getAttribute('href') || '').trim();
          if (!href || href.startsWith('#')) return unresolved();
          const destination = new URL(href, document.baseURI);
          if (!/^https?:$/.test(destination.protocol)) return unresolved();
          const isLinkedInHost = (hostname) => {
            const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
            return normalized === 'linkedin.com' || normalized.endsWith('.linkedin.com');
          };
          const linkedInDestination = isLinkedInHost(destination.hostname);
          const redirectPath = /^\/(?:safety\/go|redir\/redirect)\/?$/.test(destination.pathname);
          let verifiedExternalRedirect = false;
          if (linkedInDestination && redirectPath) {
            const redirectValue = destination.searchParams.get('url') || '';
            try {
              const redirectDestination = new URL(redirectValue);
              verifiedExternalRedirect = /^https?:$/.test(redirectDestination.protocol)
                && !isLinkedInHost(redirectDestination.hostname);
            } catch {}
          }
          if (modal) {
            const contactInfoOverlay = /^\/in\/([^/]+)\/overlay\/contact-info\/?$/.exec(location.pathname);
            const profilePath = contactInfoOverlay ? `/in/${contactInfoOverlay[1]}` : '';
            const ownsContactInfoRoute = modalIsBlocking && !!profilePath
              && _someComposedDescendant(modal, 'a[href]', (candidate) => {
                try {
                  const candidateUrl = new URL(candidate.getAttribute('href'), document.baseURI);
                  return isLinkedInHost(candidateUrl.hostname)
                    && candidateUrl.pathname.replace(/\/+$/, '') === profilePath;
                } catch {
                  return false;
                }
              });
            if (!ownsContactInfoRoute || !verifiedExternalRedirect) return 'blocked';
            return 'navigation';
          }
          if (!linkedInDestination) return 'navigation';
          if (redirectPath) return 'blocked';
          if (/^\/messaging\/(?:send|compose)\/?$/.test(destination.pathname)) return 'blocked';
          return (/^\/(?:feed|jobs|mynetwork|messaging|notifications)\/?$/.test(destination.pathname)
            || /^\/in\/[^/]+\/overlay\/contact-info\/?$/.test(destination.pathname))
            ? 'navigation'
            : 'none';
        } catch {
          return unresolved();
        }
      };

      const verifiedDiscordManagementControl = (clicked) => {
        if (params.adapterName !== 'discord'
            || !/^(?:www\.)?discord\.com$/.test(location.hostname)
            || !/^\/channels\/(?:\d+|@me)(?:\/\d+){0,2}\/?$/.test(location.pathname)) return false;
        const control = _composedClosestElement(clicked,
          'button,a[href],input,select,textarea,[role="textbox"],[role="button"],[role="menuitem"],[role="tab"],[role="treeitem"],[role="switch"],[role="radio"],[role="checkbox"]');
        if (!control || !visible(control) || control.disabled
            || control.getAttribute('aria-disabled') === 'true'
            || _composedClosestElement(control,
              'article,[role="log"],[data-message-id],[data-list-item-id^="chat-messages"]')) return false;
        const label = compact(control.getAttribute('aria-label') || control.innerText || control.textContent);
        const actionLabels = [control.getAttribute('aria-label'), control.getAttribute('title'),
          ...(!editable(control) ? [control.innerText || control.textContent, control.value] : [])];
        if (actionLabels.map(_mayBeMessageSend).includes(true)) return false;
        const modal = _findTopmostBlockingModal();
        if (modal && !_isComposedAncestor(modal, control)) return false;
        const rect = control.getBoundingClientRect();
        if (!_isComposedAncestor(control, _shadowAwareElementFromPoint(
          rect.left + rect.width / 2, rect.top + rect.height / 2))) return false;
        const dialog = _composedClosestElement(control, 'dialog,[role="dialog"],[role="alertdialog"]');
        if (dialog) {
          // Discord keeps the channel composer mounted behind its settings.
          // Only the owning management dialog is a non-message surface.
          if (dialog.querySelector('[data-message-id],[data-list-id="chat-messages"],[class*="channelTextArea"] [role="textbox"],[role="log"] article')) return false;
          const dialogId = dialog.getAttribute('id');
          const creationHeading = dialogId && Array.from(dialog.querySelectorAll('h1'))
            .some(el => visible(el) && el.id === `heading-${dialogId}`);
          const creationInputs = Array.from(dialog.querySelectorAll('input[type="text"],input:not([type])'))
            .filter(visible);
          const creationRadios = Array.from(dialog.querySelectorAll('input[type="radio"],[role="radio"]'))
            .filter(visible);
          const creation = dialog.getAttribute('data-dialog') === 'modal'
            && creationHeading && creationInputs.length === 1
            && Array.from(dialog.querySelectorAll('input[type="checkbox"],[role="switch"]')).some(visible)
            && Array.from(dialog.querySelectorAll('button[type="submit"],input[type="submit"]')).some(visible)
            && (creationRadios.length === 0 || creationRadios.length >= 2);
          const settingsNav = dialog.querySelector('nav [role="tablist"],[role="navigation"] [role="tablist"]');
          const hasSettingsTabs = !!settingsNav
            && Array.from(settingsNav.querySelectorAll('[role="tab"]')).some(visible);
          const serverSettings = dialog.getAttribute('data-layer') === 'GUILD_SETTINGS' && hasSettingsTabs;
          const channelSettings = dialog.getAttribute('data-layer') === 'CHANNEL_SETTINGS'
            && hasSettingsTabs;
          const userSettings = !!dialog.id
            && dialog.getAttribute('aria-modal') === 'true'
            && dialog.getAttribute('aria-labelledby') === `heading-${dialog.id}`
            && !!dialog.querySelector('nav [data-settings-sidebar-item="account_panel"]')
            && !!dialog.querySelector('nav [data-settings-sidebar-item="appearance_panel"]');
          if (!channelSettings && dialog.querySelector('[data-slate-editor]')) return false;
          return (creation || serverSettings || channelSettings || userSettings) && !control.hasAttribute('form');
        }
        if (editable(control) || control.form || control.hasAttribute('form')
            || _composedClosestElement(control, 'form')) return false;
        const menu = _composedClosestElement(control, '[role="menu"]');
        if (menu) {
          const menuActionIds = new Set([
            'guild-header-popout-settings',
            'guild-header-popout-create-channel',
            'guild-header-popout-create-category',
          ]);
          return menu.id === 'guild-header-popout'
            && control.getAttribute('role') === 'menuitem'
            && menuActionIds.has(control.id);
        }
        const accountSettingsPanel = _composedClosestElement(control, 'section[class*="panels"]');
        if (accountSettingsPanel?.querySelector('[class*="accountPopoutButtonWrapper"]')
            && control.matches('button:not([role])')
            && control.parentElement?.matches('[class*="buttons"]')) return true;
        const nav = _composedClosestElement(control, 'nav,[role="navigation"]');
        if (!nav) return false;
        const serverRailItem = _composedClosestElement(control, '[role="treeitem"][data-list-item-id^="guildsnav___"]');
        if (serverRailItem) {
          const guildsTree = _composedClosestElement(serverRailItem, '[role="tree"][data-list-id="guildsnav"]');
          return /^guildsnav___(?:home|\d+)$/.test(serverRailItem.getAttribute('data-list-item-id') || '')
            && !!guildsTree && _isComposedAncestor(nav, guildsTree);
        }
        if (control.matches('a[href][data-list-item-id^="private-channels-"]')) {
          try {
            const destination = new URL(control.getAttribute('href'), location.href);
            return destination.origin === location.origin && !destination.search && !destination.hash
              && !destination.username && !destination.password
              && /^\/channels\/@me(?:\/\d+)?\/?$/.test(destination.pathname);
          } catch { return false; }
        }
        const channelsList = nav?.querySelector('#channels');
        const serverHeader = nav?.querySelector('header');
        if (!channelsList || !serverHeader) return false;
        if (control.matches('a[href]')) {
          const destination = new URL(control.getAttribute('href'), location.href);
          return destination.origin === location.origin && !destination.search && !destination.hash
            && !destination.username && !destination.password
            && /^\/channels\/\d+\/\d+\/?$/.test(destination.pathname);
        }
        if (control.hasAttribute('aria-expanded') && _isComposedAncestor(serverHeader, control)) return true;
        const channelControl = /^(?:button|input)$/i.test(control.tagName)
          || control.getAttribute('role') === 'button';
        return channelControl && _isComposedAncestor(channelsList, control);
      };

      const verifiedLinkedInPostEntry = (clicked) => {
        if (params.adapterName !== 'linkedin' || !/^\/feed\/?$/.test(location.pathname)) return false;
        const button = _composedClosestElement(clicked, 'button,[role="button"]');
        if (!button || !visible(button) || button.disabled
            || button.getAttribute?.('aria-disabled') === 'true'
            || String(button.getAttribute?.('type') || 'button').toLowerCase() !== 'button'
            || button.form || button.hasAttribute?.('form')) return false;
        // The feed entry only opens a public-post composer. Do not infer this
        // from the requested text, a nearby editor, or a control inside a post,
        // conversation, or dialog: those can send or publish existing drafts.
        if (!_composedClosestElement(button, 'main,[role="main"]')
            || _composedClosestElement(button,
              'form,article,dialog,[role="dialog"],[role="alertdialog"],[role="log"],'
              + '[data-message-id],[data-thread-id],[data-conversation-id],'
              + '[contenteditable]:not([contenteditable="false"])')) return false;
        // Its names, read in any language, only open a new public post.
        const readings = [button.innerText || button.textContent, button.getAttribute?.('aria-label')]
          .map(value => compact(value)).filter(Boolean).map(_messageControlReading);
        if (!readings.length || !readings.every(reading => reading === 'new_post')) return false;
        // A shadow-root dialog may not appear in the document's modal query.
        // Require the actual painted control, descending through open roots.
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const hit = _shadowAwareElementFromPoint(x, y);
        return !!hit && _isComposedAncestor(button, hit);
      };

      const verifiedTwitterNavigation = clicked => {
        if (!twitterConversation) return false;
        const control = _composedClosestElement(clicked, 'a[href],button,[role="button"]');
        if (!control || !visible(control) || control.disabled
            || control.getAttribute('aria-disabled') === 'true'
            || _composedClosestElement(control, 'form,dialog,[role="dialog"],[role="log"],[contenteditable="true"]')
            || control.hasAttribute('form') || control.hasAttribute('download')) return false;
        if (control.matches('button[data-testid="dm-conversation-back-button"]')) {
          return String(control.getAttribute('type') || 'button').toLowerCase() === 'button';
        }
        if (!control.matches('a[href]') || control.hasAttribute('onclick') || control.hasAttribute('data-action')) return false;
        try {
          const destination = new URL(control.getAttribute('href'), location.href);
          if (!/^https?:$/.test(destination.protocol) || destination.username || destination.password
              || !/^(?:www\.)?(?:x|twitter)\.com$/.test(destination.hostname)) return false;
          const isProfile = /^\/[a-zA-Z0-9_]{1,15}\/?$/.test(destination.pathname);
          const header = control.querySelector('[data-testid="dm-conversation-username"]');
          if (header && visible(header)) return isProfile;
          return !!_composedClosestElement(control, 'nav,[role="navigation"]')
            && (isProfile || /^\/(?:home|explore|notifications|messages|i\/chat)\/?$/.test(destination.pathname));
        } catch { return false; }
      };

      const verifiedLinkedInPublicPostControl = (clicked) => {
        if (params.adapterName !== 'linkedin') return false;
        const button = _composedClosestElement(clicked, 'button,[role="button"]');
        if (!button || !visible(button) || button.disabled
            || button.getAttribute?.('aria-disabled') === 'true'
            || String(button.getAttribute?.('type') || 'button').toLowerCase() !== 'button'
            || button.form || button.hasAttribute?.('form')) return false;
        const messageScope = 'form,[role="log"],[data-message-id],[data-thread-id],[data-conversation-id],'
          + '.msg-form,.msg-overlay-conversation-bubble,.msg-convo-wrapper';
        if (_composedClosestElement(button, messageScope)) return false;
        if (compact(button.getAttribute?.('data-control-name')).toLowerCase() !== 'share.post') return false;
        // Identify the public composer itself, not merely a nearby textbox.
        // LinkedIn's dedicated compose route may render as a whole page.
        const root = _composedClosestElement(button, 'dialog,[role="dialog"],.share-box')
          || (/^\/sharing\/compose\/?$/.test(location.pathname)
            ? (_composedClosestElement(button, 'main,[role="main"]') || document.body) : null);
        if (!root) return false;
        const owned = el => visible(el) && !_composedClosestElement(el, messageScope)
          && (_composedClosestElement(el, 'dialog,[role="dialog"],.share-box') || root) === root;
        const editors = Array.from(root.querySelectorAll('[contenteditable="true"],textarea'))
          .filter(owned);
        return editors.length === 1;
      };

      // A recipient/search field can be the only focused editable while the
      // real composer is temporarily hidden. Focus alone is not compose proof.
      // Upper-page dialogs also contain search and filter fields. Exempt a
      // message-body editor from the position rule only when its own dialog
      // exposes a send control or a verified LinkedIn public-post control.
      const dialogSelector = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
      const layoutDialog = layoutCandidate?.closest?.(dialogSelector);
      // Empty Gmail drafts can have a disabled Send button. Their dedicated
      // body editor is compose evidence; a generic filter textarea is not.
      const verifiedGmailBody = params.adapterName === 'gmail'
        && layoutCandidate?.matches?.('[contenteditable="true"][role="textbox"]')
        && (layoutCandidate.getAttribute('g_editable') === 'true'
          || !!layoutDialog?.querySelector?.('input[name="subjectbox"]'));
      const layoutInComposeDialog = !!layoutDialog
        && !verifiedNavigationEditable(layoutCandidate)
        && layoutCandidate.matches?.('textarea,[contenteditable="true"],[role="textbox"]:not(input)')
        && Array.from(layoutDialog.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],[data-action]'))
          .some(control => visible(control) && control.closest(dialogSelector) === layoutDialog
            && ((_messageControlReading(control.getAttribute('aria-label') || control.value || control.innerText || control.textContent) === 'send'
                && (_isEligibleTextClickTarget(control) || verifiedGmailBody))
              || verifiedLinkedInPublicPostControl(control)));
      const nativeLayoutContext = typeof window.__wb_get_native_chat_context === 'function'
        ? window.__wb_get_native_chat_context(layoutCandidate) : null;
      if (!observationOnly && tool === 'click_ax' && targetResolved && params.bindDispatch === true
          && typeof params._nativeChatOwner === 'string' && params._nativeChatOwner === _nativeTelegramReadOwner) {
        const nativeTelegramReadRepairBinding = _bindNativeTelegramRead(target);
        if (nativeTelegramReadRepairBinding) return {success:true,messageSend:false,conclusive:true,
          nativeTelegramRepair:true,nativeTelegramReadRepairBinding,identityCandidates:[]};
      }
      const nativeWhatsappComposer = location.hostname === 'web.whatsapp.com'
        && layoutCandidate?.matches?.('[data-testid="conversation-compose-box-input"][contenteditable="true"][role="textbox"]');
      if (nativeWhatsappComposer && nativeLayoutContext?.service !== 'whatsapp-self') {
        const repair = window.__wb_get_native_whatsapp_repair?.();
        if (!observationOnly && tool === 'click_ax' && targetResolved
            && window.__wb_native_whatsapp_repair_action?.(target)) {
          return { success: true, messageSend: false, conclusive: true, composerAvailable: true,
            nativeWhatsappRepair: true, identityCandidates: [] };
        }
        if (nativeLayoutContext?.service !== 'whatsapp') {
          // No check left in this run: say so, rather than send the agent
          // after a header click that cannot help.
          const spent = !repair && window.__wb_native_whatsapp_repair_spent?.() === true;
          return { success: true, messageSend: observationOnly ? false : null, conclusive: false,
            composerAvailable: true, nativeWhatsappRepairAvailable: !!repair,
            ...(spent ? { nativeWhatsappRepairSpent: true } : {}),
            reasonCode: spent ? 'native_whatsapp_contact_check_spent' : 'native_whatsapp_contact_binding_required', identityCandidates: [],
            error: spent
              ? 'This run can no longer confirm a WhatsApp contact: its contact check belongs to the first chat it looked at, and WhatsApp\'s chat selection or that chat\'s header changed since. Nothing was sent. Report what was sent and that a message to this chat needs a new request; do not retry it in this run.'
              : 'Native WhatsApp contact identity needs a fresh guarded header click, its contact drawer phone, and closing that same drawer. No message or editor write was authorized.' };
        }
      }
      const layoutComposer = layoutCandidate
        && (gmailScopedComposer || nativeLayoutContext?.service === 'telegram' || layoutInComposeDialog
          || !viewportHeight
          || layoutCandidateRect?.bottom >= viewportHeight * 0.5)
        ? layoutCandidate
        : null;

      const singlePlainKey = tool === 'press_keys' && (args.repeat === undefined || args.repeat === 1)
        && !['keys', 'modifiers', 'ctrlKey', 'altKey', 'metaKey', 'shiftKey'].some(key => args[key] !== undefined);
      const safeComposeKey = singlePlainKey && ['Enter', 'Tab'].includes(args.key);
      const gmailSearchTarget = tool === 'press_keys' ? active : (targetResolved ? target : null);
      const gmailDraftTarget = tool === 'press_keys' ? active : (targetResolved ? target : null);
      if (!observationOnly && ['set_field', 'press_keys'].includes(tool) && gmailSearchControl(gmailSearchTarget)) {
        if (!(tool === 'press_keys' ? safeComposeKey : [undefined, false, true].includes(args.submit))) {
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        return { success: true, messageSend: false, conclusive: true, nonMessagingTarget: true,
          reasonCode: 'gmail_search_control', identityCandidates: [] };
      }
      if (!observationOnly && tool === 'press_keys' && gmailComposeOf(active) && active !== layoutComposer && !safeComposeKey) {
        return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
      }
      if (!observationOnly && ((['click', 'click_ax'].includes(tool) && gmailDraftKind(gmailDraftTarget)
          && [undefined, false].includes(args.submit))
          || (safeComposeKey && gmailDraftKind(gmailDraftTarget) === 'recipient'))) {
        return { success: true, messageSend: false, conclusive: true, nonMessagingTarget: true,
          reasonCode: 'gmail_draft_field', identityCandidates: [] };
      }
      let composer = null;
      let messageSend = null;
      const discordManagementTarget = tool === 'press_keys' && String(args.key) === 'Enter'
        ? active : (targetResolved ? target : null);
      if (!observationOnly && ['click', 'click_ax', 'set_field', 'press_keys'].includes(tool)
          && verifiedDiscordManagementControl(discordManagementTarget)) {
        return {
          success: true, messageSend: false, conclusive: true,
          nonMessagingTarget: true, reasonCode: 'non_messaging_target', identityCandidates: [],
        };
      }
      // ── Gmail: the message a composer, a Send or an attachment belongs to ──
      const gmailRecipientMode = params.adapterName === 'gmail';
      // The To, Cc or Bcc row an element names. A compose window, its
      // chips and its typed addresses below use it.
      const roleFromAttribute = (attribute, value) => {
        const text = compact(value, 120).toLowerCase();
        if (!text) return '';
        // A row's or field's label names its role in the user's language,
        // read by a model; the app's own names below do not.
        if (attribute === 'aria-label') {
          const role = _pageReading('message_field', compact(value, 120));
          return ['to', 'cc', 'bcc'].includes(role) ? role : '';
        }
        if (attribute === 'name') {
          return /^(?:to|cc|bcc)$/.test(text) ? text : '';
        }
        const tokens = text.split(/[^a-z]+/).filter(Boolean);
        if (tokens.includes('bcc')) return 'bcc';
        if (tokens.includes('cc')) return 'cc';
        if (tokens.length === 1 && tokens[0] === 'to') return 'to';
        return '';
      };
      // `structural` reads the row from Gmail's own attributes and its input
      // fields only, never from a label on another element, which page text
      // (a contact's name, a message) can fill.
      const recipientRole = (el, root = null, structural = false) => {
        let current = el;
        for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
          for (const attribute of structural ? ['data-recipient-type', 'data-type', 'name']
            : ['data-recipient-type', 'data-type', 'name', 'aria-label']) {
            const role = roleFromAttribute(attribute, current.getAttribute?.(attribute));
            if (role) return role;
          }
          if (root && current === root) break;
          try {
            const descendantRoles = new Set();
            for (const marker of current.querySelectorAll?.(structural
              ? 'input[name="to"],input[name="cc"],input[name="bcc"],input[aria-label]'
              : 'input[name="to"],input[name="cc"],input[name="bcc"],[aria-label]'
            ) || []) {
              const role = roleFromAttribute('name', marker.getAttribute?.('name'))
                || roleFromAttribute('aria-label', marker.getAttribute?.('aria-label'));
              if (role) descendantRoles.add(role);
            }
            // A nearest row containing one role marker can classify its
            // chips. A shared ancestor containing multiple rows cannot.
            if (descendantRoles.size === 1) return [...descendantRoles][0];
          } catch {}
        }
        return '';
      };
      const collectGmailRecipients = (root, editor = composer, structural = false) => {
        const collected = new Map();
        if (!root?.querySelectorAll) return collected;
        for (const el of root.querySelectorAll('[email],[data-hovercard-id],[data-email]')) {
          if (!visible(el) || editable(el)) continue;
          if (el === editor || editor?.contains?.(el)) continue;
          const email = [
            el.getAttribute?.('email'),
            el.getAttribute?.('data-email'),
            el.getAttribute?.('data-hovercard-id'),
          ].map(value => compact(value, 240)).find(value => /@/.test(value)) || '';
          if (!email) continue;
          const aliases = new Map();
          const addAlias = (val) => {
            const alias = compact(val, 240);
            const normalized = normalizedIdentity(alias);
            if (alias && normalized && !aliases.has(normalized)) aliases.set(normalized, alias);
            const angleMatch = alias.match(/^([^<@]+)<[^>]+>$/);
            if (angleMatch) {
              const nameOnly = compact(angleMatch[1], 240);
              const normName = normalizedIdentity(nameOnly);
              if (nameOnly && normName && !aliases.has(normName)) aliases.set(normName, nameOnly);
            }
          };
          for (const value of [
            email,
            el.getAttribute?.('name'),
            el.getAttribute?.('aria-label'),
            el.getAttribute?.('title'),
            el.innerText,
            el.textContent,
          ]) {
            addAlias(value);
          }
          const key = normalizedIdentity(email);
          if (!key) continue;
          const role = recipientRole(el, root, structural);
          if (!role) continue;
          const recipientKey = `${role}:${key}`;
          const prior = collected.get(recipientKey) || { identity: email, role, aliases: new Map() };
          for (const [normalized, alias] of aliases) prior.aliases.set(normalized, alias);
          collected.set(recipientKey, prior);
        }
        return collected;
      };
      // A message's header field (To, Cc, Bcc or subject) belongs to its
      // compose window and is never a message's body: Gmail's own field
      // names, or a single-line input whose label a model reads as one of
      // those fields. A message body or a Chat composer is never an input,
      // and a label (which can carry a contact's name) never exempts one.
      const gmailHeaderField = el => {
        if (el?.matches?.('[name="to"],[name="cc"],[name="bcc"],[name="subjectbox"]')) return true;
        if (String(el?.tagName || '').toUpperCase() !== 'INPUT') return false;
        const label = compact(el.getAttribute?.('aria-label'), 120);
        return !!label && ['to', 'cc', 'bcc', 'subject'].includes(_pageReading('message_field', label));
      };
      // Another message's editor than `editor`: not nested with it, not a
      // search or navigation field and not a message's header field.
      const otherMessageEditor = (other, editor) => other !== editor && !editor?.contains?.(other)
        && !other.contains?.(editor) && !verifiedNavigationEditable(other) && !gmailHeaderField(other);
      // What marks a container as holding a message's recipients, read from
      // Gmail's structure: its own row names, a chip in a row those name, or
      // an input field read as a To/Cc/Bcc row, typed into or not.
      const gmailRecipientMarkers = (root, editor) => !!root && (
        !!root.querySelector?.('[name="to"],[name="cc"],[name="bcc"]')
        || collectGmailRecipients(root, editor, true).size > 0
        || Array.from(root.querySelectorAll?.('input, textarea, [contenteditable="true"], [contenteditable=""]') || [])
          .slice(0, 40).some(field => visible(field) && field !== editor && !editor?.contains?.(field)
            && !!(roleFromAttribute('name', field.getAttribute?.('name'))
              || (String(field.tagName || '').toUpperCase() === 'INPUT'
                && roleFromAttribute('aria-label', field.getAttribute?.('aria-label'))))));
      // In Gmail a send has recipients only from its composer's own mail
      // compose window: a popup or full-screen compose is the editor's
      // dialog (else its form), marked by recipient rows, a subject or
      // Gmail's own compose body; an inline thread reply, which has neither,
      // is the nearest ancestor with recipient rows that stays inside the
      // page's main region and holds no visible window or other message
      // editor. A dialog or form without them (a chat) is none.
      const gmailComposeWindowOf = editor => {
        if (!gmailRecipientMode || !editor) return null;
        const explicit = editor.closest?.('[role="dialog"]') || editor.closest?.('form') || null;
        if (explicit) {
          return gmailRecipientMarkers(explicit, editor) || !!explicit.querySelector?.('input[name="subjectbox"]')
            || editor.getAttribute?.('g_editable') === 'true' ? explicit : null;
        }
        let current = editor.parentElement;
        for (let depth = 0; current && depth < 16; depth += 1, current = current.parentElement) {
          if (current === document.body || current === document.documentElement
              || current.matches?.('main,[role="main"]')
              || Array.from(current.querySelectorAll?.('[role="dialog"]') || []).some(visible)
              || composerCandidates.some(other => current.contains?.(other) && otherMessageEditor(other, editor))) break;
          if (gmailRecipientMarkers(current, editor)) return current;
        }
        return null;
      };
      // The composer a control (a Send, an attachment input) belongs to: the
      // one message editor in the control's nearest ancestor holding any,
      // when the control lies inside that editor's own compose window. Its
      // message, not the page's lowest editor, is what the control sends. A
      // click into an editor only focuses it; a page control that merely
      // shares a distant ancestor with one editor (a toolbar's Archive) is
      // no message's; and none, or more than one editor there, leaves the
      // pairing to the page's layout.
      const gmailControlComposer = control => {
        if (!gmailRecipientMode || !control || editable(control)) return null;
        for (let node = control; node && node !== document.documentElement; node = node.parentElement) {
          const inside = composerCandidates.filter(editor => node.contains?.(editor)
            && !verifiedNavigationEditable(editor) && !gmailHeaderField(editor));
          if (!inside.length) continue;
          const owners = inside.filter(editor => !inside.some(other => other !== editor && other.contains?.(editor)));
          if (owners.length !== 1) return null;
          return gmailComposeWindowOf(owners[0])?.contains?.(control) ? owners[0] : null;
        }
        return null;
      };
      if (tool === 'upload_file') {
        // In Gmail the attachment input's own message decides its composer.
        composer = gmailControlComposer(target) || layoutComposer;
        const uploadOwner = _messageRecipientUploadOwner(target, composer);
        const linkedInPrivateComposer = params.adapterName !== 'linkedin'
          || (/^\/messaging(?:\/|$)/.test(location.pathname)
            || !!_composedClosestElement(uploadOwner, '.msg-form,.msg-overlay-conversation-bubble,.msg-convo-wrapper'));
        const linkedInPublicComposer = params.adapterName === 'linkedin'
          && (!!_composedClosestElement(composer, '.share-box')
            || !!uploadOwner?.querySelector?.('[data-control-name="share.post"]'));
        if (!targetResolved || !composer || !String(params.uploadSourceKey || '')
            || !uploadOwner || !linkedInPrivateComposer || linkedInPublicComposer) {
          return { success: true, messageSend: null, conclusive: false,
            composerAvailable: !!composer, reasonCode: 'recipient_upload_target_unverifiable', identityCandidates: [] };
        }
        dispatchTarget = target;
        messageSend = true;
      } else if (observationOnly) {
        composer = layoutComposer;
      } else if (tool === 'press_keys') {
        if (!editable(active) || !visible(active) || !layoutComposer) {
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        if (active !== layoutComposer) {
          if (verifiedNavigationEditable(active)) {
            return { success: true, messageSend: false, conclusive: true, identityCandidates: [] };
          }
          // Editables that share the compose surface with the message body —
          // Gmail's To / Subject inputs, chip and autocomplete fields — cannot
          // send a message on their own, but Enter is how users commit an
          // autocomplete pick and Tab moves between fields. Blocking those
          // presses turned normal compose navigation into a dead end. Only a
          // key inside the composer itself can dispatch a message, and that
          // path below stays fully guarded.
          try {
            const composeScopeOf = (el) => el?.closest?.(
              'form, [role="dialog"], [role="form"], [class*="compose" i]',
            );
            const activeScope = composeScopeOf(active);
            if (activeScope && activeScope === composeScopeOf(layoutComposer)) {
              return { success: true, messageSend: false, conclusive: true, identityCandidates: [] };
            }
          } catch { /* fall through to the conservative result */ }
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        composer = layoutComposer;
        dispatchTarget = active;
        messageSend = String(args.key || '') === 'Enter';
      } else if (tool === 'set_field') {
        if (!targetResolved || !editable(target) || !visible(target)) {
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        if (!layoutComposer) {
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        if (target !== layoutComposer) {
          return verifiedNavigationEditable(target)
            ? { success: true, messageSend: false, conclusive: true, identityCandidates: [] }
            : { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        composer = layoutComposer;
        dispatchTarget = target;
        messageSend = args.submit === true;
      } else if (tool === 'click' || tool === 'click_ax') {
        if (!targetResolved || !target) {
          return {
            success: true, messageSend: null, conclusive: false,
            targetResolved: false, reasonCode: 'message_target_unresolved',
            identityCandidates: [],
          };
        }
        const control = target.closest?.('button,[role="button"],input[type="submit"],input[type="button"],[data-action]') || target;
        const modal = _findTopmostBlockingModal();
        if (!visible(control) || (modal && !_isComposedAncestor(modal, target))) {
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        if (verifiedLinkedInImagePreview(target)) {
          return { success: true, messageSend: false, conclusive: true, imagePreview: true, identityCandidates: [] };
        }
        if (verifiedTwitterNavigation(target)) {
          return { success: true, messageSend: false, conclusive: true, navigation: true, identityCandidates: [] };
        }
        if (verifiedLinkedInPostEntry(target)) {
          return { success: true, messageSend: false, conclusive: true, composerSetup: true, identityCandidates: [] };
        }
        if (verifiedLinkedInPublicPostControl(target)) {
          // Public publication still goes through the normal submission gates;
          // a private-message recipient is irrelevant to this composer.
          return { success: true, messageSend: false, conclusive: true, publicPost: true, identityCandidates: [] };
        }
        const linkedInNavigation = classifyLinkedInNavigation(target, modal);
        if (linkedInNavigation === 'navigation') {
          return { success: true, messageSend: false, conclusive: true, navigation: true, identityCandidates: [] };
        }
        if (linkedInNavigation === 'blocked') {
          return {
            success: true,
            messageSend: null,
            conclusive: false,
            navigationBlocked: true,
            identityCandidates: [],
          };
        }
        // Composer utilities (Gmail's "Save & close" / "Minimize" / "Exit full
        // screen / Pop-out", attach, formatting, discard, undo) live at the
        // composer's edge, so the geometry rule below would otherwise classify
        // them as potential sends and block them — which is how a click on
        // "Save & close" came back as a blocked message send and the task
        // could never finish. None of them can commit a message, so they are
        // proven non-sends regardless of composer presence or geometry.
        if (_isComposerUtilityControl(control)) {
          return {
            success: true,
            messageSend: false,
            conclusive: true,
            composerUtility: true,
            reasonCode: 'non_messaging_target',
            identityCandidates: [],
          };
        }
        // In Gmail the Send's own message decides its composer; elsewhere,
        // and where no one message owns it, the page's layout pairs them.
        composer = gmailControlComposer(control) || layoutComposer;
        if (!composer) {
          const actionLabel = compact(
            control.getAttribute?.('aria-label')
            || control.getAttribute?.('title')
            || control.getAttribute?.('data-tooltip')
            || control.value
            || control.innerText
            || control.textContent,
            120,
          );
          // What the control does, read from its name in any language.
          const actionReading = _messageControlReading(actionLabel);
          const composerSetup = params.adapterName === 'gmail' && actionReading === 'reply';
          // The guard exists to keep a MESSAGE from reaching the wrong
          // recipient. When the page exposes no composer at all, an ordinary
          // control (Connect, Follow, Like, a feed row, Inbox nav, a search
          // box) cannot send a message in this activation, so it is proven
          // not to be a send and must not be blocked. Only controls that can
          // still commit without a composer — one whose name reads as sending
          // something or is not read yet, a mail app's Reply/Reply all/Forward
          // opener, or anything inside the app's messaging surface — stay
          // fail-closed.
          // Known compose surfaces and unverified composer openers stay protected.
          // Ordinary feed/profile controls do not become message actions merely
          // because LinkedIn's navigation classifier has no matching route.
          const composeDialog = _composedClosestElement(control, 'dialog,[role="dialog"],[role="alertdialog"]');
          const linkedInComposeSurface = params.adapterName === 'linkedin' && (
            actionReading === 'new_post'
            || /^\/(?:messaging(?:\/|$)|sharing\/compose(?:\/|$))/.test(location.pathname)
            || !!_composedClosestElement(control, `.share-box,${_MESSAGING_SURFACE_SELECTOR}`)
            || (composeDialog && Array.from(composeDialog.querySelectorAll('[contenteditable="true"],textarea')).some(visible))
          );
          const linkedInUnverified = linkedInComposeSurface && (
            control.matches?.('button,[role="button"],input[type="submit"],input[type="button"],[data-action]') === true
            || (control.matches?.('a[href]') === true && linkedInNavigation === 'none')
          );
          const provenNonMessage = !composerSetup
            && !linkedInUnverified
            && actionReading !== 'send' && actionReading !== null
            && !_inMessagingSurface(control);
          if (provenNonMessage) {
            return {
              success: true,
              messageSend: false,
              conclusive: true,
              composerAvailable: false,
              nonMessagingTarget: true,
              reasonCode: 'non_messaging_target',
              identityCandidates: [],
            };
          }
          if (linkedInUnverified) {
            // No reasonCode: the agent maps a LinkedIn composer-less failure
            // to its own contract (message_send_classification_inconclusive,
            // retryable: false, "no message composer" guidance). Naming a
            // reason here would override that contract.
            return {
              success: true,
              messageSend: null,
              conclusive: false,
              composerAvailable: false,
              identityCandidates: [],
            };
          }
          return {
            success: true,
            messageSend: null,
            conclusive: false,
            composerAvailable: false,
            reasonCode: actionReading === 'send' ? 'message_commit_without_composer'
              : actionReading === null ? 'message_control_unread' : 'no_composer_surface',
            ...(composerSetup ? { composerSetup: true } : {}),
            identityCandidates: [],
          };
        }
        if (editable(target) && (target !== composer || twitterConversation)) {
          return { success: true, messageSend: false, conclusive: true, identityCandidates: [] };
        }
        if (verifiedConversationSelection(target, composer)) {
          return {
            success: true,
            messageSend: false,
            conclusive: true,
            conversationSelection: true,
            identityCandidates: [],
          };
        }
         dispatchTarget = target;
        const composerRect = composer.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        // Geometry: controls visually next to the composer are the message-send
        // affordance. Sending from a control that is far from the composer is
        // almost always wrong on well-behaved chat surfaces, and blocking it there
        // gives the model a precise, retryable failure instead of silently sending
        // to the wrong place. Two carpet tolerances are deliberately loose here so
        // that non-messaging apps (email, forms, social buttons) are not treated
        // as messenger controls purely by proximity — they will still end up going
        // through the generic 'inconclusive' path above, which the agent can
        // reclassify from the surrounding text on the next read.
        const sameForm = !!composer.closest?.('form') && composer.closest('form') === control.closest?.('form');
        const horizontalGap = Math.max(0, composerRect.left - controlRect.right, controlRect.left - composerRect.right);
        const verticalGap = Math.max(0, composerRect.top - controlRect.bottom, controlRect.top - composerRect.bottom);
        // Gmail can place its Gemini drafting UI between Message Body and Send.
        // Its native Send control still needs all recipient/body dispatch binding;
        // distance from the genuine body must not select the AI prompt instead.
        const nativeGmailSend = gmailComposeOf(control)?.body === composer
          && control.matches('.aoO[role="button"]')
          && /(?:^|[^\p{L}])(?:send|enviar|envoyer|invia|senden|verzenden|gönder|отправить|送信|发送|發送|보내|إرسال|ارسال)(?:[^\p{L}]|$)/iu
            .test(control.getAttribute('aria-label') || control.getAttribute('data-tooltip') || '');
        messageSend = nativeGmailSend || sameForm || (horizontalGap <= 240 && verticalGap <= 120);
        if (!messageSend) {
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
      }

      if (!composer) {
        return {
          success: false,
          messageSend: null,
          conclusive: false,
          composerAvailable: false,
          matchingOutgoingMessageCount: matchingMessageBodyCount(params.expectedMessageBody, null),
          identityCandidates: [],
          error: 'Active conversation composer could not be resolved.',
        };
      }
      if (params.expectedDispatchTarget
        && (dispatchTarget !== params.expectedDispatchTarget || composer !== params.expectedComposer)) {
        return {
          success: false,
          messageSend: null,
          conclusive: false,
          dispatchTargetChanged: true,
          identityCandidates: [],
          strongIdentityCandidates: [],
          error: 'The verified message action target or composer changed before dispatch.',
        };
      }

      const composerRect = composer.getBoundingClientRect();
      const headerBandBottom = Math.min(
        composerRect.top - 12,
        Math.min(220, Math.max(140, viewportHeight * 0.2)),
      );
      const strongIdentities = [];
      const strongRecipients = [];
      const strongSeen = new Set();
      const observedRecipientCandidates = [];
      let conversationRecipientEvidence = null;
      let nativeChatMessageBaseline = null;
      const inConversationHeaderBand = (el) => {
        if (headerBandBottom <= 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.top >= 0
          && rect.bottom <= headerBandBottom
          && rect.right >= composerRect.left
          && rect.left <= composerRect.right;
      };
      const addStrongIdentity = (el) => {
        if (!visible(el) || editable(el) || el.closest?.('input,textarea,[contenteditable="true"]')) return;
        if (!inConversationHeaderBand(el) || independentScrollableRegion(el, composer)) return;
        const text = compact(
          el.getAttribute?.('aria-label')
          || el.getAttribute?.('title')
          || el.innerText
          || el.textContent
        );
        if (!text || text.length > 120 || strongSeen.has(text)) return;
        strongSeen.add(text);
        strongIdentities.push(text);
      };

      let gmailComposeRoot = null;
      // The composer's own Gmail compose window, and whether what sends (a
      // Send, an attachment input) is that composer's own: the two share an
      // owner holding no message editor beyond this composer's own window.
      // A control the page's layout pairs with another message's composer
      // belongs to that other message.
      const gmailComposeWindow = gmailComposeWindowOf(composer);
      let gmailSendOwner = null;
      if (gmailRecipientMode && dispatchTarget && dispatchTarget !== composer && !composer.contains?.(dispatchTarget)) {
        for (let node = composer.parentElement; node; node = node.parentElement) {
          if (node.contains?.(dispatchTarget)) { gmailSendOwner = node; break; }
        }
      }
      const gmailEditorScope = composer.closest?.('[role="dialog"]') || gmailComposeWindow || composer;
      const gmailForeignSend = !!gmailSendOwner && composerCandidates.some(editor => gmailSendOwner.contains(editor)
        && !gmailEditorScope.contains?.(editor) && otherMessageEditor(editor, composer));
      const gmailMailSend = !!gmailComposeWindow && !gmailForeignSend;
      // Gmail's recipient sets come from that window alone, on any route.
      const recipientSets = gmailRecipientMode ? gmailMailSend : params.supportsRecipientSets === true;
      const nativeTelegramComposer = /^(?:web|webk|weba|webz|k)\.telegram\.org$/i.test(location.hostname)
        && composer.matches?.('.input-message-input[contenteditable="true"],#editable-message-text[contenteditable="true"][role="textbox"]');
      if (nativeLayoutContext?.service === 'whatsapp') {
        const context = nativeLayoutContext;
        const footer = composer.closest('footer');
        const contextNodes = [context.carrier, context.header, context.root, context.transcript, context.selectedRow, context.selected, context.rowTitle, footer, composer];
        if (composer !== layoutCandidate || !footer || contextNodes.some(node => !node?.isConnected)) {
          return { success: true, messageSend: observationOnly ? false : null, conclusive: false,
            composerAvailable: true, identityCandidates: [], reasonCode: 'native_whatsapp_contact_binding_required' };
        }
        conversationRecipientEvidence = { carrier: context.carrier, header: context.header, pane: context.root,
          footer, composer, labelledByNodes: [], contextNodes, aliases: [context.id, context.name],
          signature: JSON.stringify([context.id, context.name, location.href,
            contextNodes.map(node => ['data-testid','aria-selected','aria-label','hidden','inert','aria-hidden'].map(attribute => node.getAttribute(attribute)))]) };
        const nativeRows = Array.from(context.transcript.querySelectorAll('[role="row"] [data-id][data-testid^="conv-msg-"]'));
        const nativeIds = nativeRows.map(node => node.getAttribute('data-id'));
        // An own message counts as settled once a model reads its status, in
        // any language, as delivered or read; an unread status is not.
        const pendingNative = nativeRows.some(node => node.querySelector('[data-icon="tail-out"]')
          && !Array.from(node.querySelectorAll('[data-testid="msg-meta"] [aria-label]'))
            .some(status => _pageReading('message_status', status.getAttribute('aria-label')) === 'delivered'));
        nativeChatMessageBaseline = { schema: 'webbrain-native-opaque-baseline/1', threadKey: 'dom:' + context.id,
          documentEpoch: context.documentEpoch, timeOrigin: context.timeOrigin, url: context.url,
          tailId: context.id + ':' + nativeIds.at(-1),
          messageIds: nativeIds.map(id => context.id + ':' + id),
          complete: context.atLatest && nativeRows.length > 0 && nativeRows.length <= 200
            && nativeIds.every((id, index) => id && nativeRows[index].getAttribute('data-testid') === 'conv-msg-' + id)
            && new Set(nativeIds).size === nativeIds.length && !pendingNative };
        strongIdentities.push(context.id);
        strongRecipients.push({ identity: context.id, role: 'to' });
        observedRecipientCandidates.push({ identity: context.id, role: 'to', aliases: [context.id, context.name] });
      } else if (nativeTelegramComposer) {
        const context = typeof window.__wb_get_native_chat_context === 'function'
          ? window.__wb_get_native_chat_context(composer) : null;
        const modal = typeof _findTopmostBlockingModal === 'function' ? _findTopmostBlockingModal() : null;
        if (context?.service !== 'telegram' || !context.carrier || !context.header
            || (modal && (!modal.contains(composer) || !modal.contains(context.header)))) {
          return { success: true, messageSend: observationOnly ? false : null, conclusive: false,
            composerAvailable: true, identityCandidates: [], strongIdentityCandidates: [],
            error: 'The native Telegram route, header, composer and transcript do not identify one active peer.' };
        }
        if (!observationOnly && messageSend === true && context.atLatest !== true) {
          const nativeChatReadRepair = window.__wb_native_chat_read_repair?.(composer);
          return { success: true, messageSend: null, conclusive: false, composerAvailable: true,
            identityCandidates: [], strongIdentityCandidates: [], reasonCode: 'native_telegram_latest_required',
            ...(nativeChatReadRepair ? { nativeChatReadRepair } : {}),
            error: nativeChatReadRepair?.message || 'The native Telegram latest message position is not verified. Observe its latest messages before sending.' };
        }
        const footer = composer.parentElement;
        const contextNodes = new Set([context.carrier, context.header, context.root, context.transcript, context.scrollPane, context.latestMarker, footer, composer,
          ...(context.aliasWitnessNodes ? [context.peerIdentity, ...context.aliasWitnessNodes] : [])].filter(Boolean));
        for (const start of [context.carrier, composer]) {
          for (let node = start.parentElement; node && node !== context.root; node = node.parentElement) contextNodes.add(node);
        }
        const identityAttributes = ['id','role','aria-hidden','inert','data-peer-id','data-list-key'];
        conversationRecipientEvidence = { carrier: context.carrier, header: context.header, pane: context.root,
          footer, composer, labelledByNodes: [], contextNodes: [...contextNodes],
          signature: JSON.stringify([context.id, context.name, location.href,
            ...(context.aliasWitnessSignature ? [context.aliasWitnessSignature] : []),
            [...contextNodes].map(node => identityAttributes.map(attribute => node.getAttribute(attribute)))]) };
        nativeChatMessageBaseline = window.__wb_get_native_telegram_message_baseline?.(composer) || null;
        if (!observationOnly && messageSend === true && nativeChatMessageBaseline?.complete !== true) {
          return { success: true, messageSend: null, conclusive: false, composerAvailable: true,
            nativeChatMessageBaseline, identityCandidates: [], strongIdentityCandidates: [],
            reasonCode: 'native_telegram_baseline_unavailable',
            error: 'The native latest Telegram message IDs or pending statuses cannot establish a send baseline. Observe the current conversation before sending; do not repeat an uncertain send.' };
        }
        strongIdentities.push(context.id);
        strongRecipients.push({ identity: context.id, role: 'to' });
        observedRecipientCandidates.push({ identity: context.id, role: 'to', aliases: [context.id, context.name,
          ...(context.alias ? [context.alias, '@' + context.alias] : [])] });
      } else if (gmailMailSend) {
        // A send from the composer's own mail compose window: that window's
        // To, Cc and Bcc rows are its recipients.
        gmailComposeRoot = gmailComposeWindow;
        const recipients = collectGmailRecipients(gmailComposeWindow);
        // A recipient that was typed but not yet turned into a chip lives only
        // in the To/Cc/Bcc input VALUE — there is no [email] attribute to read.
        // Without this pass a compose window whose address was just typed
        // reported zero observed recipients, so the guard could neither name
        // the address nor bind a later user confirmation to what is on screen.
        const collectRecipientInputValues = (root) => {
          if (!root?.querySelectorAll) return;
          let inputs = [];
          try {
            inputs = Array.from(root.querySelectorAll(
              'input, textarea, [contenteditable="true"], [contenteditable=""]',
            )).slice(0, 40);
          } catch {
            return;
          }
          for (const input of inputs) {
            if (!visible(input)) continue;
            if (input === composer || composer?.contains?.(input)) continue;
            const role = roleFromAttribute('name', input.getAttribute?.('name'))
              || roleFromAttribute('aria-label', input.getAttribute?.('aria-label'))
              || '';
            if (!role) continue;
            const raw = String(
              'value' in input ? (input.value || '') : (input.innerText || input.textContent || ''),
            );
            if (!raw || raw.length > 2000) continue;
            for (const piece of raw.split(/[,;\n]+/)) {
              const candidate = compact(piece, 240);
              if (!candidate) continue;
              const match = candidate.match(/[^\s<>@,;]+@[^\s<>@,;.]+\.[^\s<>@,;]+/);
              if (!match) continue;
              const email = match[0];
              const key = normalizedIdentity(email);
              if (!key) continue;
              const recipientKey = `${role}:${key}`;
              const prior = recipients.get(recipientKey) || { identity: email, role, aliases: new Map() };
              prior.aliases.set(key, email);
              const display = compact(candidate.replace(/<[^>]*>/g, ''), 240);
              if (display && display !== email) {
                const normalizedDisplay = normalizedIdentity(display);
                if (normalizedDisplay && !prior.aliases.has(normalizedDisplay)) {
                  prior.aliases.set(normalizedDisplay, display);
                }
              }
              recipients.set(recipientKey, prior);
            }
          }
        };
        collectRecipientInputValues(gmailComposeWindow);
        for (const [recipientKey, recipient] of recipients) {
          const emailKey = recipientKey.slice(recipientKey.indexOf(':') + 1);
          const identity = recipient.aliases.get(emailKey) || [...recipient.aliases.values()][0] || recipient.identity || '';
          if (identity) {
            const aliasList = Array.from(new Set([identity, ...recipient.aliases.values()])).filter(Boolean);
            observedRecipientCandidates.push({ identity, role: recipient.role, aliases: aliasList });
          }
        }
        // Match the complete authorized To/CC/BCC set. Each expected identity
        // must resolve to exactly one distinct chip and no additional chip may
        // remain; duplicate display names therefore fail closed.
        const expectedRecipients = Array.isArray(params.expectedRecipients)
          ? params.expectedRecipients.map(value => {
              const legacy = typeof value === 'string' || typeof value === 'number';
              return {
                identity: compact(legacy ? value : (value?.identity ?? value?.recipient), 240),
                role: compact(legacy ? 'to' : value?.role, 12).toLowerCase(),
              };
            }).filter(value => value.identity && /^(?:to|cc|bcc)$/.test(value.role)).slice(0, 16)
          : [];
        if (expectedRecipients.length > 0 && recipients.size === expectedRecipients.length) {
          const claimed = new Set();
          const matched = [];
          for (const expected of expectedRecipients) {
            const normalizedExpected = normalizedIdentity(expected.identity);
            const candidates = [...recipients.entries()]
              .filter(([key, recipient]) => !claimed.has(key)
                && recipient.role === expected.role
                && recipient.aliases.has(normalizedExpected));
            if (!normalizedExpected || candidates.length !== 1) {
              matched.length = 0;
              break;
            }
            claimed.add(candidates[0][0]);
            matched.push(expected);
          }
          if (matched.length === recipients.size) {
            for (const recipient of matched) {
              strongSeen.add(`${recipient.role}:${recipient.identity}`);
              strongIdentities.push(recipient.identity);
              strongRecipients.push(recipient);
            }
          }
        } else if (expectedRecipients.length === 0) {
          for (const [recipientKey, recipient] of recipients) {
            const emailKey = recipientKey.slice(recipientKey.indexOf(':') + 1);
            const identity = recipient.aliases.get(emailKey) || [...recipient.aliases.values()][0] || '';
            if (identity && !strongSeen.has(recipientKey)) {
              strongSeen.add(recipientKey);
              strongIdentities.push(identity);
              strongRecipients.push({ identity, role: recipient.role });
            }
          }
        }
      } else if (gmailRecipientMode) {
        // Any other Gmail send identifies no one: a Send the page's layout
        // pairs with another message's composer, a composer in no mail
        // compose window (an inline reply whose chips name no row), or a
        // Google Chat composer. Nothing on the page then says where it goes:
        // what names a Chat cannot be told by structure from what its
        // messages, threads and pinned items show, and no address in them is
        // its recipient.
      } else if (twitterConversation) {
        const headers = Array.from(document.querySelectorAll('[data-testid="dm-conversation-username"]'))
          .filter(el => visible(el) && inConversationHeaderBand(el) && !independentScrollableRegion(el, composer));
        if (headers.length === 1) {
          const header = headers[0];
          const link = header.closest('a[href]');
          let handle = '';
          try {
            const url = new URL(link?.getAttribute('href'), location.href);
            if (/^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname)) {
              handle = url.pathname.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1] || '';
            }
          } catch {}
          if (handle) {
            const identity = '@' + handle.toLowerCase();
            strongIdentities.push(identity);
            strongRecipients.push({ identity, role: 'to' });
            observedRecipientCandidates.push({ identity, role: 'to', aliases: [identity, handle, compact(header.innerText)] });
          } else {
            // X group DM headers name the conversation instead of linking to a
            // single account. Bind the visible header to the canonical chat
            // route so a later conversation cannot inherit this authorization.
            let groupIdentity = '';
            try {
              const groupId = new URL(location.href).pathname
                .match(/^\/i\/chat\/([a-zA-Z0-9_-]{1,128})\/?$/)?.[1] || '';
              if (groupId && compact(header.innerText)) groupIdentity = `x-dm-group:${groupId}`;
            } catch {}
            if (groupIdentity) {
              strongIdentities.push(groupIdentity);
              strongRecipients.push({ identity: groupIdentity, role: 'to' });
              observedRecipientCandidates.push({
                identity: groupIdentity,
                role: 'to',
                aliases: [groupIdentity, compact(header.innerText)],
              });
            }
          }
        }
      } else {
        for (const el of document.querySelectorAll(
          '[aria-selected="true"],[aria-current]:not([aria-current="false"])'
        )) {
          // Search results and navigation rows can also be selected/current, so
          // they count only inside the narrow, non-scrollable conversation
          // header above the composer.
          addStrongIdentity(el);
          if (strongIdentities.length >= 8) break;
        }

        for (const el of document.querySelectorAll(
          'h1,h2,h3,h4,[role="heading"]'
        )) {
          addStrongIdentity(el);
          if (strongIdentities.length >= 8) break;
        }
        if (!strongIdentities.length && params.adapterName === 'generic-messaging'
            && params.supportsRecipientSets !== true) {
          // Some conversation headers expose the contact name as a button
          // rather than a heading, or (help desks, CRMs) only the contact's
          // address as a mailto link or address chip. A shared local
          // header/footer pane proves ownership; a page-wide button, a
          // sidebar name or an address in the message history proves nothing.
          try {
            const footer = composer.closest?.('footer');
            const excluded = 'aside,nav,[role="navigation"],[role="complementary"],[role="log"],[role="feed"],'
              + '[role="listbox"],[role="menu"],[role="toolbar"],[data-message-id],[data-message-direction],[data-outgoing],'
              + 'article,[role="article"]';
            if (footer && !footer.closest(excluded)) {
              for (let pane = footer.parentElement, depth = 0; pane && depth < 8
                && pane !== document.body && pane !== document.documentElement; pane = pane.parentElement, depth++) {
                if (pane.closest(excluded)) break;
                const ownedHeader = header => {
                  let branch = header;
                  for (let level = 0; level < 4; level++) {
                    const parent = branch.parentElement;
                    if (parent === pane) return true;
                    if (parent?.tagName !== 'DIV' || parent.children.length !== 1) return false;
                    branch = parent;
                  }
                  return false;
                };
                const headers = Array.from(pane.querySelectorAll('header')).filter(header => (
                  ownedHeader(header) && visible(header) && !footer.contains(header) && !header.closest(excluded)
                    && inConversationHeaderBand(header) && !independentScrollableRegion(header, composer)
                ));
                if (!headers.length) continue;
                // Stop at the closest pane with a header, including when its
                // evidence is ambiguous. A broader app header cannot rescue it.
                if (headers.length !== 1 || composerCandidates.some(editor => editor !== composer
                    && pane.contains(editor) && !composer.contains(editor) && !editor.contains(composer)
                    && !verifiedNavigationEditable(editor))) break;
                const header = headers[0];
                const modal = typeof _findTopmostBlockingModal === 'function' ? _findTopmostBlockingModal() : null;
                if (modal && (!modal.contains(composer) || !modal.contains(header))) break;
                const contacts = Array.from(header.querySelectorAll('button,[role="button"]')).filter(control => {
                  if (!visible(control) || editable(control) || control.closest('header') !== header
                      || control.closest(excluded) || control.disabled || control.getAttribute('aria-disabled') === 'true'
                      || control.form || control.hasAttribute('form') || !inConversationHeaderBand(control)
                      || independentScrollableRegion(control, composer)) return false;
                  const name = String(control.innerText || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
                  // A control whose name reads as an action (call, search, more,
                  // back, send...) in any language is not the contact.
                  const readings = [name, control.getAttribute('aria-label'), control.getAttribute('title')]
                    .filter(Boolean).map(_messageControlReading);
                  return !!name && name.length <= 120 && !readings.some(reading => _MESSAGE_CONTROL_ACTIONS.has(reading));
                });
                // Without a contact button, one address in this same owned
                // header (never the history between it and the composer) is
                // the conversation's recipient. An address in running text or
                // a notice there (a pinned message, a topic) names no one.
                const chips = contacts.length ? [] : Array.from(header.querySelectorAll(
                  '[email],[data-email],[data-hovercard-id],a[href^="mailto:" i]',
                )).filter(chip => visible(chip) && !editable(chip) && chip.closest('header') === header
                  && !chip.closest(excluded) && !chip.closest('p,blockquote,[role="note"],[role="status"],[role="alert"]')
                  && inConversationHeaderBand(chip)
                  && !independentScrollableRegion(chip, composer)).map(chip => ({ chip,
                  address: [chip.getAttribute('email'), chip.getAttribute('data-email'), chip.getAttribute('data-hovercard-id'),
                    String(chip.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0]]
                    .map(value => compact(value, 240)).find(value => String(value || '').includes('@')) || '' }))
                  .filter(({ address }) => normalizedIdentity(address));
                const chipAddresses = new Set(chips.map(({ address }) => normalizedIdentity(address)));
                if (contacts.length > 1 || (!contacts.length && chipAddresses.size !== 1)) break;
                const carrier = contacts.length ? contacts[0] : chips[0].chip;
                const name = contacts.length ? compact(carrier.innerText, 120) : chips[0].address;
                const labelledByNodes = [];
                let labelledByValid = true;
                for (const id of String(composer.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
                  const matches = composer.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`);
                  if (matches.length !== 1) { labelledByValid = false; break; }
                  labelledByNodes.push(matches[0]);
                }
                if (!labelledByValid) break;
                const identityAttributes = ['id','role','aria-label','title','aria-labelledby','aria-hidden','inert',
                  'data-recipient-id','data-conversation-id','data-thread-id','data-chat-id'];
                const contextNodes = new Set([carrier, header, pane, footer, composer]);
                for (const start of [carrier, composer]) {
                  for (let node = start.parentElement; node && node !== pane; node = node.parentElement) contextNodes.add(node);
                }
                conversationRecipientEvidence = { carrier, header, pane, footer, composer, labelledByNodes, contextNodes: [...contextNodes],
                  signature: JSON.stringify([name,
                    [...contextNodes].map(node => identityAttributes.map(attribute => node.getAttribute(attribute))),
                    ['aria-label','aria-labelledby','placeholder','title'].map(attribute => composer.getAttribute(attribute)),
                    labelledByNodes.map(node => node.textContent)]) };
                strongIdentities.push(name);
                // The composer's own label may name the destination's phone
                // number, in any language; a single number there is an alias.
                const numbers = String(composer.getAttribute('aria-label') || '').match(/\+?\d[\d ()-]{5,30}\d/g) || [];
                const phone = numbers.length === 1 ? numbers[0].trim() : '';
                const phoneDigits = phone.replace(/\D/g, '').length;
                conversationRecipientEvidence.aliases = phone && phoneDigits >= 7 && phoneDigits <= 15
                  ? [name, phone] : [name];
                break;
              }
            }
          } catch { /* An unsupported header remains unverified. */ }
        }
        for (const identity of strongIdentities) {
          const item = { identity, role: 'to', aliases: conversationRecipientEvidence?.aliases || [identity] };
          strongRecipients.push({ identity, role: 'to' });
          observedRecipientCandidates.push(item);
        }
      }

      // The isolated monitor reads this exact local proof synchronously. Its
      // closure-only callback never participates in the public message API,
      // authorizes an action, or needs the expensive message-history scan.
      if (typeof receiveConversationContext === 'function') {
        return receiveConversationContext(observationOnly && params.adapterName === 'generic-messaging'
          && params.supportsRecipientSets !== true ? conversationRecipientEvidence : null);
      }

      // ── Generic recipient discovery (every site) ────────────────────────
      // The Gmail branch above reads Google's own DOM. Every other webmail,
      // CRM, ticketing tool, and messaging app needs the same answer: who would
      // this send actually go to? Read it structurally — a recipient-labelled
      // field, or an address-bearing chip/link near the composer — instead of
      // depending on one vendor's markup. This is what makes confirm-then-send
      // work globally rather than only on Gmail.
      // In Gmail only a send from a mail compose window reads further, and
      // only inside that window: another window's typed addresses or chips
      // never name this send's recipients.
      if (observedRecipientCandidates.length === 0 && (!gmailRecipientMode || gmailMailSend)) {
        const genericMailRecipientMode = params.adapterName === 'generic-messaging'
          && params.supportsRecipientSets === true;
        // A field holds recipients when its labels and names read, in any
        // language, as the message's To, Cc or Bcc row; an email-typed field
        // is a To field on a mail page.
        const fieldRecipientRole = (el) => {
          try {
            if (/^email$/i.test(String(el.getAttribute?.('type') || ''))
                || /^email$/i.test(String(el.getAttribute?.('autocomplete') || ''))) return genericMailRecipientMode ? 'to' : '';
            const names = [
              el.labels ? Array.from(el.labels).map(label => label.innerText).join(' ') : '',
              el.getAttribute?.('aria-label'),
              el.getAttribute?.('placeholder'),
              el.getAttribute?.('name'),
              el.getAttribute?.('id'),
              el.getAttribute?.('data-testid'),
              el.getAttribute?.('autocomplete'),
            ].map(value => compact(value, 120)).filter(Boolean).join(' · ');
            const role = _pageReading('message_field', names);
            return ['to', 'cc', 'bcc'].includes(role) ? role : '';
          } catch { return ''; }
        };
        // `role` is the row a field names; an address chip names none, so it
        // keeps the row its field gave it, or To.
        const pushRecipient = (identity, extraAliases = [], role = '') => {
          const raw = compact(identity, 240);
          const normalized = raw ? normalizedIdentity(raw) : '';
          if (!normalized) return;
          const existing = observedRecipientCandidates.find(
            item => normalizedIdentity(item.identity) === normalized,
          );
          const aliases = Array.from(new Set([
            raw,
            ...extraAliases,
            ...(existing?.aliases || []),
          ].filter(Boolean)));
          const entryRole = role || existing?.role || 'to';
          const entry = { identity: raw, role: entryRole, aliases };
          if (existing) Object.assign(existing, entry);
          else observedRecipientCandidates.push(entry);
          if (!strongRecipients.some(item => normalizedIdentity(item.identity) === normalized)) {
            strongRecipients.push({ identity: raw, role: entryRole });
          }
        };
        const extractAddresses = (rawValue, role = 'to') => {
          const raw = String(rawValue || '');
          if (!raw || raw.length > 2000) return;
          for (const piece of raw.split(/[,;\n]+/)) {
            const candidate = compact(piece, 240);
            if (!candidate) continue;
            const match = candidate.match(/[^\s<>@,;]+@[^\s<>@,;.]+\.[^\s<>@,;]+/);
            if (!match) continue;
            const display = compact(candidate.replace(/<[^>]*>/g, ''), 240);
            pushRecipient(match[0], display && display !== match[0] ? [display] : [], role);
          }
        };
        try {
          for (const el of Array.from((gmailMailSend ? gmailComposeWindow : document).querySelectorAll(
            'input, textarea, [contenteditable="true"], [contenteditable=""]',
          )).slice(0, 60)) {
            if (!visible(el) || el === composer || composer?.contains?.(el)) continue;
            const role = fieldRecipientRole(el);
            if (!role) continue;
            extractAddresses('value' in el ? el.value : (el.innerText || el.textContent || ''), role);
          }
        } catch { /* structural read is best-effort */ }
        // Address chips and mailto links name the destination only on a mail
        // compose that has To/Cc/Bcc recipient sets. In a chat the same
        // markup is usually message history (a mailto link someone sent),
        // which says nothing about where this send goes; a chat still needs
        // its one header identity (above, including an address in its own
        // conversation header), so without one it stays unverified.
        if (recipientSets) {
          try {
            const chipScope = (gmailMailSend ? gmailComposeWindow
              : composer.closest?.('[role="dialog"],form,[role="main"]')) || document;
            for (const el of Array.from(chipScope.querySelectorAll(
              '[email],[data-email],[data-hovercard-id],a[href^="mailto:" i],input[type="email"]',
            )).slice(0, 40)) {
              if (!visible(el) || el === composer || composer?.contains?.(el)) continue;
              if (!genericMailRecipientMode
                  && /^email$/i.test(String(el.getAttribute?.('type') || ''))) continue;
              const mailto = String(el.getAttribute?.('href') || '')
                .replace(/^mailto:/i, '').split('?')[0];
              const address = [
                el.getAttribute?.('email'),
                el.getAttribute?.('data-email'),
                el.getAttribute?.('data-hovercard-id'),
                mailto,
                'value' in el ? el.value : '',
              ].map(value => compact(value, 240)).find(value => String(value || '').includes('@')) || '';
              if (!address) continue;
              const display = compact(el.innerText || el.textContent, 240);
              pushRecipient(address, display && display !== address ? [display] : []);
            }
          } catch { /* chip read is best-effort */ }
        }
      }

      const expectedConversation = params.expectedConversationRecipientEvidence;
      if (expectedConversation && (!conversationRecipientEvidence
          || ['carrier','header','pane','footer'].some(key => expectedConversation[key] !== conversationRecipientEvidence[key])
          || expectedConversation.signature !== conversationRecipientEvidence.signature
          || expectedConversation.contextNodes.length !== conversationRecipientEvidence.contextNodes.length
          || expectedConversation.contextNodes.some((node, index) => node !== conversationRecipientEvidence.contextNodes[index])
          || expectedConversation.labelledByNodes.length !== conversationRecipientEvidence.labelledByNodes.length
          || expectedConversation.labelledByNodes.some((node, index) => node !== conversationRecipientEvidence.labelledByNodes[index]))) {
        return { success: false, messageSend: null, conclusive: false, dispatchTargetChanged: true,
          identityCandidates: [], strongIdentityCandidates: [],
          error: 'The verified conversation header or composer destination changed before dispatch.' };
      }

      const composerText = (() => {
        try {
          if ('value' in composer) return String(composer.value || '');
          return String(composer.innerText || composer.textContent || '');
        } catch { return ''; }
      })();
      const submittedFieldBody = tool === 'set_field' && args.submit === true
        ? normalizedMessageBody(args.text)
        : '';
      const messageBody = submittedFieldBody || composerMessageBody(composer);
      const messageBodyBaselineCount = matchingMessageBodyCount(messageBody, composer);
      // Gmail's subject control keeps a locale-independent name, so the
      // reviewed subject binds without reading a localized label. Only a
      // visible field counts; a collapsed compose proves nothing.
      const composeContainer = gmailComposeRoot || composer.closest?.('[role="dialog"],form') || null;
      const subjectField = composeContainer?.querySelector?.('input[name="subjectbox"]') || null;
      const composerSubjectAvailable = !!subjectField && visible(subjectField);
      const composerSubject = composerSubjectAvailable ? compact(subjectField.value, 998) : '';
      // The provider writes "Draft saved" into the compose window's own status
      // region. Page-wide text would also match a message that quotes it.
      const composerStatusMessages = composeContainer
        ? Array.from(composeContainer.querySelectorAll?.('[aria-live],[role="status"],[role="alert"]') || [])
            .filter(visible)
            .map(el => compact(el.innerText || el.textContent, 200))
            .filter(Boolean)
            .slice(0, 6)
        : [];
      const gmailComposeFlow = gmailRecipientMode
        && !!composer.closest?.('[role="dialog"]');
      const matchingOutgoingMessageCount = matchingMessageBodyCount(
        params.expectedMessageBody,
        composer,
      );
      const messageRecipientDispatchToken = params.bindDispatch === true
        && messageSend === true
        && (tool === 'upload_file' || !!messageBody)
        && (!twitterConversation || twitterBaselineComplete)
        && (recipientSets
          ? strongRecipients.length > 0
          : strongRecipients.length === 1)
        ? _rememberMessageRecipientDispatchBinding(composer, strongRecipients, {
            tool,
            args,
            actionTarget: dispatchTarget,
            adapterName: params.adapterName,
            expectedRecipients: params.expectedRecipients,
            supportsRecipientSets: recipientSets,
            conversationRecipientEvidence,
            messageBody,
            messageBodyBaselineCount,
            nativeChatMessageBaseline,
            nativeOwner: params._nativeChatOwner,
            messageAttachment: tool === 'upload_file',
            uploadSourceKey: params.uploadSourceKey,
            ...(twitterConversation ? {
              existingMessageIds: twitterMessageIds,
              ...(twitterEmptyConversationBaseline ? { twitterEmptyConversationBaseline: true } : {}),
            } : {}),
            gmailComposeFlow,
            composerSubject,
            composerSubjectAvailable,
        })
        : '';
      let composerRef = '';
      try {
        if (typeof window.__wb_ax_ref === 'function') composerRef = window.__wb_ax_ref(composer) || '';
      } catch {}
      return {
        success: true,
        messageSend: observationOnly ? false : messageSend === true,
        conclusive: true,
        composerAvailable: true,
        // The recipient-set mode this composer actually sends with.
        ...(recipientSets ? { recipientSets: true } : {}),
        ...(nativeChatMessageBaseline ? { nativeChatMessageBaseline } : {}),
        ...(tool === 'upload_file' ? { messageAttachment: true } : {}),
        ...(composerRef ? { composerRef } : {}),
        composerEmpty: composerText.replace(/[\u200b-\u200d\ufeff]/g, '').trim() === '',
        messageBody,
        messageBodyBaselineCount,
        gmailComposeFlow,
        composerSubject,
        composerSubjectAvailable,
        composerStatusMessages,
        matchingOutgoingMessageCount,
        ...(twitterConversation && twitterBaselineComplete ? {
          existingMessageIds: twitterMessageIds,
          matchingOutgoingMessageIds: matchingTwitterMessageIds(params.expectedMessageBody),
          ...(twitterEmptyConversationBaseline ? { twitterEmptyConversationBaseline: true } : {}),
        } : {}),
        // Only recipient-specific header evidence is authoritative. Ordinary
        // message text, test-id containers, and other leaf content are never
        // returned as dispatch identities.
        identityCandidates: strongIdentities.slice(0, 16),
        strongIdentityCandidates: strongIdentities.slice(0, 16),
        strongRecipientCandidates: strongRecipients.slice(0, 16),
        observedRecipientCandidates: observedRecipientCandidates.slice(0, 16),
        ...(messageRecipientDispatchToken
          ? { messageRecipientDispatchBinding: { token: messageRecipientDispatchToken } }
          : {}),
      };
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      return {
        success: false,
        messageSend: null,
        conclusive: false,
        identityCandidates: [],
        strongIdentityCandidates: [],
        strongRecipientCandidates: [],
        observedRecipientCandidates: [],
        error: error?.message || String(error),
      };
    }
  }

  // --- Message handler ---
  // Stop finishes the owning page-feedback run (page_monitor_state
  // active:false for that run) while a compound content action may still be
  // in an asynchronous settle wait. Count those run endings so a later phase,
  // such as the submit after a field write, never runs for a stopped task.
  // A stale stop for another run leaves the current monitor active.
  // The counter lives on this isolated world's window, shared by reinjected
  // copies of this script and invisible to the page's own scripts.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === 'content' && msg.action === 'page_monitor_state' && msg.active === false
        && window.__wbPageMonitor?.active !== true) {
      window.__wbContentRunStopEpoch = (Number(window.__wbContentRunStopEpoch) || 0) + 1;
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content' || msg.action?.startsWith('page_monitor_')) return;
    // Only the newest installed copy answers. An orphaned copy from a
    // previous extension load still has a live DOM but a dead runtime
    // context — it receives this message and can never respond, which used
    // to shadow the healthy listener and turn every page tool into
    // "received no answer". Yielding here lets the current install reply.
    if (WEBBRAIN_GENERATION !== (Number(window.__webbrain_generation) || 0)) return;
    const actionDeadlineAt = Number(msg.actionDeadlineAt) || 0;
    const actionDeadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
    if (actionDeadlineExpired()) {
      sendResponse({
        success: false,
        dispatched: false,
        noDispatch: true,
        retryable: true,
        deadlineExpired: true,
        error: 'The page action deadline expired before dispatch.',
      });
      return;
    }

    const jevBinding = msg.params?._jevBinding;
    if (jevBinding && (jevBinding.documentToken !== _axDocumentToken()
        || window.__wb_jev_validate?.(jevBinding) !== true)) {
      sendResponse({ success: false, noDispatch: true, dispatched: false, staleJevTarget: true,
        error: 'The observed target or form context changed. Read the page again before acting.' });
      return;
    }
    // The agent's readings of a messaging page's texts, for the recipient
    // guard, its dispatch checks and the chat observer.
    _rememberPageReadings(msg.params?.__wbPageReadings);

    if (location.hostname === 'web.whatsapp.com'
        && ['observe_chat','probe_message_recipient_guard','click_ax'].includes(msg.action)) {
      window.__wb_update_native_chat_owner?.(msg.params?._nativeChatOwner || '', msg.params?._nativeChatPendingRestore || null);
    }
    if (location.hostname === 'web.telegram.org' && /^\/k\/?$/.test(location.pathname)
        && ['observe_chat','probe_message_recipient_guard','click_ax'].includes(msg.action)) {
      _setNativeTelegramReadOwner(msg.params?._nativeChatOwner || '');
    }

    const handlers = {
      'jev_validate_target': () => ({ success: !!jevBinding }),
      'get_page_info': () => getPageInfo(),
      'get_page_info_cdp': () => ({ ...getPageInfoFull(msg.params || {}), tableCount: document.querySelectorAll('table').length }),
      'get_interactive_elements': () => getInteractiveElements(),
      'get_interactive_elements_cdp': () => getInteractiveElementsFull(),
      'get_file_input_targets': () => getFileInputTargets(),
      'click': () => clickElement(msg.params || {}, actionDeadlineExpired),
      'consume_file_picker_guard': () => consumeFilePickerGuard(msg.params?.guardId),
      'type': () => typeText(msg.params || {}, actionDeadlineExpired),
      'probe_rich_text_toolbar_retry_target': () => _probeRichTextToolbarRetryTarget(msg.params || {}),
      'release_dispatch_binding': () => _releaseDispatchBinding(msg.params || {}),
      'consume_focused_dispatch_binding': () => _consumeFocusedDispatchBinding(msg.params || {}),
      'consume_message_recipient_dispatch_binding': () => _consumeMessageRecipientDispatchBinding(msg.params || {}),
      'attach_message_recipient_bound_upload': () => _attachMessageRecipientBoundUpload(msg.params || {}, actionDeadlineExpired),
      'check_truncated_replacement': () => _checkTruncatedReplacement(msg.params || {}),
      'prepare_focused_type_dispatch': () => _prepareFocusedTypeDispatch(msg.params || {}),
      'verify_focused_type_dispatch': () => _verifyFocusedTypeDispatch(msg.params || {}),
      'wait_for_rich_text_toolbar_focused_child_frame': () => _waitForRichTextToolbarFocusedChildFrame(msg.params || {}),
      'announce_rich_text_toolbar_focused_child_frame': () => _announceRichTextToolbarFocusedChildFrame(msg.params || {}),
      'blur_rich_text_toolbar_target': () => _blurRichTextToolbarTarget(msg.params || {}),
      // Texts consulted unread outside a guard check (the page monitor's
      // capture, a chat observation), for the agent to read.
      'take_unread_page_texts': () => ({ success: true, texts: _takeUnreadPageTexts() }),
      'probe_message_recipient_guard': () => {
        const result = _probeMessageRecipientGuard(msg.params || {});
        // Texts the guard consulted unread go back to the agent to be read.
        const unread = _takeUnreadPageTexts();
        return unread.length && result && typeof result === 'object' ? { ...result, pageTextsNeeded: unread } : result;
      },
      'observe_chat': () => {
        if (typeof window.__wb_observe_chat_dom !== 'function') {
          return { success: false, error: 'chat-observation.js not injected' };
        }
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        const probe = _probeMessageRecipientGuard({ ...params, tool: 'observe_active_conversation', args: {} });
        const observation = window.__wb_observe_chat_dom({ ...params, probe });
        const draft = _nativeChatDraftCurrent(params, null, true);
        // Texts the observation consulted unread (a message's status or label,
        // a header control's name) go back to the agent to be read.
        const unread = _takeUnreadPageTexts();
        return { ...observation, ...(draft ? (draft.waitingForLatest
          ? { _nativeChatDraftRetained:true } : { _nativeChatDraftCurrent:true }) : {}),
          ...(unread.length ? { pageTextsNeeded: unread } : {}) };
      },
      'press_keys': () => pressKeys(msg.params || {}, actionDeadlineExpired),
      'scroll': () => scrollPage(msg.params || {}, actionDeadlineExpired),
      'extract_data': () => extractData(msg.params || {}),
      'inspect_element_styles': () => inspectElementStyles(msg.params || {}),
      'patch_element': () => { window.__wbPageMonitor?.beforeLocalDispatch(); return patchDevElement(msg.params || {}); },
      'revert_patch': () => { window.__wbPageMonitor?.beforeLocalDispatch(); return revertDevElementPatch(msg.params || {}); },
      'highlight_element': () => { window.__wbPageMonitor?.beforeLocalDispatch(); return highlightDevElement(msg.params || {}); },
      // Internal bridge used by inspect_event_listeners. The temporary DOM
      // marker lets CDP resolve the exact ref_id target, including nodes in
      // open shadow roots, and is removed in a finally block by agent.js.
      'dev_mark_targets': () => markDevTargets(msg.params || {}),
      'dev_unmark_targets': () => unmarkDevTargets(msg.params || {}),
      'wait_for_element': () => waitForElement(msg.params || {}),
      'get_selection': () => ({ text: window.getSelection()?.toString() || '' }),
      'find_text': () => findText(msg.params || {}),
      // ── Completion / plan attention flash (tab title/favicon blink) ──
      'attention_flash_start': () => {
        try {
          return { success: true, started: startAttentionFlash(msg.params || {}) };
        } catch (error) {
          if (error?.code === 'page_feedback_pending') throw error;
          return { success: false, error: error?.message || String(error) };
        }
      },
      'attention_flash_stop': () => {
        try {
          stopAttentionFlash(msg.params || {});
          return { success: true };
        } catch (error) {
          if (error?.code === 'page_feedback_pending') throw error;
          return { success: false, error: error?.message || String(error) };
        }
      },
      // ── Accessibility-tree-backed reads and actions ──────────────────
      //
      // The tree is built by src/content/accessibility-tree.js (a port of
      // claudeplugin/assets/accessibility-tree.js). Output is a flat,
      // indented text representation; each line carries a stable ref_id
      // (persistent across calls as long as the element stays in the DOM).
      'get_accessibility_tree': async () => {
        try {
          if (typeof window.__generateAccessibilityTree !== 'function') {
            return { error: 'accessibility-tree.js not injected' };
          }
          const documentToken = _axDocumentToken();
          const refScopeUrl = location.href;
          const { filter, maxDepth, maxChars, ref_id, page, tree_revision } = msg.params || {};
          const gate = detectPageGate();
          if (gate) {
            const pageGate = pageGatePublic(gate);
            if (gate.surface === 'dialog') {
              if (typeof window.__generateAccessibilitySubtree === 'function') {
                const gateFilter = filter === 'interactive' ? 'interactive' : 'visible';
                const requestedDepth = Number(maxDepth);
                const requestedChars = Number(maxChars);
                const gateMaxDepth = Math.min(Number.isFinite(requestedDepth) ? Math.max(1, Math.trunc(requestedDepth)) : 8, 8);
                const gateMaxChars = Math.min(Number.isFinite(requestedChars) ? Math.max(256, Math.trunc(requestedChars)) : 3000, 5000);
                const tree = window.__generateAccessibilitySubtree(gate.element, gateFilter, gateMaxDepth, gateMaxChars, page);
                return { pageGate, ...tree, textSource: 'page-gate', documentToken, refScopeUrl };
              }
              return { pageGate, pageContent: gate.label, textSource: 'page-gate', documentToken, refScopeUrl };
            }
            const articleRoot = gate.element.closest('article, [role="article"], main, [role="main"]');
            return {
              pageGate,
              pageContent: renderedArticleTextBeforeGate(articleRoot, gate.element),
              textSource: 'article (pre-gate)',
              documentToken,
              refScopeUrl,
            };
          }
          // A complete, anchored Gmail thread read may reveal only Gmail's
          // trusted top-level collapsed messages before building page 1. This
          // keeps whole-thread reads complete in Ask as well as Act mode while
          // exposing no general-purpose click capability to Ask mode.
          const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
          const requestedDepth = maxDepth == null ? 15 : Number(maxDepth);
          let conversationAutoExpanded = false;
          if (ref_id && requestedPage === 1 && (filter || 'all') === 'all'
              && Number.isFinite(requestedDepth) && requestedDepth >= 15
              && typeof window.__wb_expand_gmail_conversation_for_read === 'function') {
            const prepared = await window.__wb_expand_gmail_conversation_for_read(ref_id);
            conversationAutoExpanded = prepared?.attempted === true && prepared?.expanded === true;
          }
          const tree = window.__generateAccessibilityTree(filter, maxDepth, maxChars, ref_id, page, tree_revision);
          const jev = window.__wb_jev_snapshot?.();
          return {
            ...tree,
            ...(jev ? { _jevSnapshot: { ...jev, documentToken, pageUrl: refScopeUrl } } : {}),
            ...(conversationAutoExpanded ? { conversationAutoExpanded: true } : {}),
            documentToken,
            refScopeUrl,
          };
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          return { error: 'Failed to build accessibility tree: ' + (e && e.message || String(e)) };
        }
      },
      'resolve_form_field_refs': () => {
        try {
          if (typeof window.__wb_ax_ref !== 'function') {
            return { success: false, error: 'accessibility-tree.js not injected' };
          }
          const selector = String(msg.params?.selector || '');
          const focused = document.activeElement;
          const form = selector
            ? document.querySelector(selector)
            : focused?.closest('form') || document.querySelector('form');
          if (!form) return { success: false, error: 'No form found on page' };
          const refs = [];
          for (const el of form.querySelectorAll('input, select, textarea')) {
            const type = String(el.type || el.tagName || '').toLowerCase();
            if (type === 'hidden' || type === 'submit') continue;
            refs.push(window.__wb_ax_ref(el));
          }
          return {
            success: true,
            refs,
            documentToken: _axDocumentToken(),
            refScopeUrl: location.href,
          };
        } catch (error) {
          if (error?.code === 'page_feedback_pending') throw error;
          return { success: false, error: error?.message || String(error) };
        }
      },
      'click_ax': () => {
        let dispatched = false;
        const failure = (error, extra = {}) => ({
          success: false,
          error,
          ...extra,
          ...(dispatched
            ? { dispatched: true }
            : { dispatched: false, noDispatch: true, fallbackAttempted: false }),
        });
        try {
          const { ref_id, expectedDocumentToken, expectedPageUrl } = msg.params || {};
          if (typeof ref_id !== 'string') return failure('ref_id (string, e.g. "ref_42") is required');
          if (typeof window.__wb_ax_lookup !== 'function') return failure('accessibility-tree.js not injected');
          const documentToken = _axDocumentToken();
          const documentChanged = !!expectedDocumentToken && expectedDocumentToken !== documentToken;
          const routeChanged = !!expectedPageUrl && expectedPageUrl !== location.href;
          if (documentChanged || routeChanged) {
            return failure(
              `ref_id ${ref_id} belongs to a previous page or route. Re-read the accessibility tree and choose a fresh ref_id before clicking.`,
              {
                staleRef: true,
                documentChanged,
                routeChanged,
                documentToken,
                refScopeUrl: location.href,
              },
            );
          }
          const el = window.__wb_ax_lookup(ref_id);
          if (!el) {
            let suggestions = [];
            try { if (typeof window.__wb_ax_suggest === 'function') suggestions = window.__wb_ax_suggest(ref_id, 6); } catch {}
            const refStr = String(ref_id);
            const looksLikeDomId = !/^ref_\d+$/.test(refStr);
            const formatNote = looksLikeDomId
              ? ` "${refStr}" is not a valid ref_id. Valid ref_ids have the form ref_N (e.g. ref_42) and appear in square brackets in get_accessibility_tree output — do not use DOM ids, CSS selectors, or placeholder words from the prompt.`
              : '';
            const hint = suggestions.length
              ? ' Nearest existing refs: ' + suggestions.map(s => `${s.ref} (${s.role}${s.name ? ' "' + s.name + '"' : ''})`).join(', ') + '.'
              : '';
            return failure(`ref_id ${ref_id} not found.${formatNote} The element may have been removed or the page replaced.${hint} Re-read the accessibility tree to get fresh ids — do NOT guess ref numbers or invent placeholders.`, { suggestions });
          }
          const disabledOwner = el.closest?.('button:disabled,input:disabled,select:disabled,textarea:disabled,[aria-disabled="true"]');
          if (disabledOwner) {
            return failure(
              `ref_id ${ref_id} is disabled and cannot be activated. Re-read the page after correcting the form or editor state; do not treat this click as submitted.`,
              {
                ref_id,
                disabled: true,
                nativeDisabled: !!disabledOwner.disabled,
                ariaDisabled: disabledOwner.getAttribute?.('aria-disabled') === 'true',
              },
            );
          }
          if (!_isFullyVisibleForInteraction(el)) {
            try { _scrollElementIntoClearView(el); } catch (error) { if (error?.code === 'page_feedback_pending') throw error; }
          }
          window.__wbPageMonitor?.beforeLocalDispatch({ preparation: true, kind: 'focus', target: el });
          try { el.focus({ preventScroll: true }); } catch {}
          const rect = el.getBoundingClientRect();
          if (!el.isConnected || rect.width < 1 || rect.height < 1) {
            return failure(
              `ref_id ${ref_id} is stale or not visibly rendered. Re-read the accessibility tree and retry with the current target ref_id.`,
              {
                ref_id,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              },
            );
          }
          // Identity only (tag:role:label) — must match agent-side
          // _clickAxActiveIdentity / _clickProgressSnapshot.active so layout
          // shift cannot turn preparatory focus into false "focus" proof.
          const preparedActive = (() => {
            try {
              const active = document.activeElement;
              if (!active || active === document.body || active === document.documentElement) return '';
              return [
                active.tagName || '',
                active.getAttribute?.('role') || '',
                active.getAttribute?.('aria-label') || active.getAttribute?.('title') || active.id || '',
              ].join(':');
            } catch {
              return '';
            }
          })();
          const fallbackStateBefore = _axFallbackState(el);
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const inputType = tag === 'input' ? String(el.type || '').toLowerCase() : '';
          const nativeCheckable = inputType === 'checkbox' || inputType === 'radio';
          const checkedBefore = nativeCheckable ? !!el.checked : null;
          const targetRole = String(el.getAttribute?.('role') || '').toLowerCase();
          const canonicalTargetName = _axCanonicalName(el);
          const targetName = canonicalTargetName || _axAccessibleName(el);
          // What the result echoes back to the model (see _axModelName).
          const modelTargetName = _axModelName(el, targetName);
          const targetContext = (() => {
            try {
              const ownText = String(targetName || el.innerText || '')
                .replace(/\s+/g, ' ').trim();
              let fallback = null;
              let node = el.parentElement;
              for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
                const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
                if (!text || text === ownText) continue;
                const headingEl = node.querySelector?.('h1,h2,h3,h4,[role="heading"]');
                const linkEl = node.querySelector?.('a[href]');
                const role = String(node.getAttribute?.('role') || '').toLowerCase();
                const nodeTag = String(node.tagName || '').toLowerCase();
                const productCard = !!node.matches?.([
                  '[data-product-id]',
                  '[data-product]',
                  '[data-testid*="product" i]',
                  '[class*="product" i]',
                  '[class*="card" i]',
                  '[class*="tile" i]',
                ].join(','));
                const context = {
                  text: text.slice(0, 240),
                  ...(text.length > 240 ? { truncated: true } : {}),
                  ...(headingEl ? { heading: String(headingEl.innerText || headingEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) } : {}),
                  ...(linkEl ? { href: String(_axModelHref(linkEl, linkEl.href || linkEl.getAttribute('href') || '')).slice(0, 500) } : {}),
                };
                if (!fallback) fallback = context;
                if (productCard || headingEl || linkEl || role === 'listitem' || nodeTag === 'li' || nodeTag === 'article') {
                  return context;
                }
              }
              return fallback;
            } catch {
              return null;
            }
          })();
          const genericTags = new Set(['body', 'div', 'span', 'section', 'main', 'article', 'nav', 'ul', 'ol', 'li']);
          const genericRoles = new Set(['', 'generic', 'group', 'list', 'listitem', 'region', 'none', 'presentation']);
          if (!canonicalTargetName && genericTags.has(tag) && genericRoles.has(targetRole) && targetContext?.truncated) {
            return failure(
              `ref_id ${ref_id} resolves to an unnamed generic element inside a broad container. Re-read the accessibility tree and choose a named row or control instead of clicking this ambiguous target.`,
              { ambiguousTarget: true, targetContext, documentToken, refScopeUrl: location.href },
            );
          }
          const fallbackStatic = _axFallbackStaticAssessment(el);
          let popupRole = '';
          let popupHasPopup = null;
          let isPopupOpener = false;
          try {
            popupRole = (el.getAttribute('role') || '').toLowerCase();
            popupHasPopup = el.getAttribute('aria-haspopup');
            isPopupOpener = popupRole === 'combobox' || !!popupHasPopup;
          } catch {}
          let anchorMeta = null;
          if (tag === 'a') {
            try {
              const href = el.getAttribute('href') || '';
              if (href) {
                const resolvedHref = el.href || new URL(href, document.baseURI || location.href).href;
                anchorMeta = {
                  href,
                  resolvedHref,
                  beforeUrl: location.href,
                  beforeScrollY: Math.round(window.scrollY || 0),
                };
                const trimmedHref = href.trim();
                const lowerHref = trimmedHref.toLowerCase();
                if (!lowerHref.startsWith('javascript:')) {
                  try {
                    const before = new URL(anchorMeta.beforeUrl);
                    const target = new URL(resolvedHref);
                    const sameDocumentBase = target.origin === before.origin &&
                      target.pathname === before.pathname &&
                      target.search === before.search;
                    const anchorTarget = target.hash || (trimmedHref.startsWith('#') && trimmedHref.length > 1 ? trimmedHref : '');
                    anchorMeta.targetUrl = target.href;
                    if (sameDocumentBase && anchorTarget && !isPopupOpener) {
                      anchorMeta.sameDocumentAnchor = true;
                      anchorMeta.anchorTarget = anchorTarget;
                    } else if (!sameDocumentBase) {
                      anchorMeta.navigates = true;
                    }
                  } catch {
                    const currentPath = (location.pathname + location.search) || '/';
                    anchorMeta.navigates = href && !href.startsWith('#') && href !== currentPath;
                  }
                }
              }
            } catch {}
          }
          if (actionDeadlineExpired()) {
            return failure(
              'The page action deadline expired before click dispatch.',
              { deadlineExpired: true, retryable: true },
            );
          }
          if (msg.params?.messageRecipientGuardRequired === true) {
            const recipientValidation = _consumeMessageRecipientDispatchBinding(msg.params, el);
            if (recipientValidation.success !== true) {
              return failure(recipientValidation.error, {
                messageDispatched: false,
                messageRecipientGuard: true,
                reasonCode: recipientValidation.reasonCode,
                ...(recipientValidation.nativeChatReadRepair ? { nativeChatReadRepair: recipientValidation.nativeChatReadRepair } : {}),
              });
            }
          }
          if (actionDeadlineExpired()) {
            return failure(
              'The page action deadline expired during recipient validation.',
              { deadlineExpired: true, retryable: true },
            );
          }
          if (msg.params?._prepareTrustedNativeButton === true) {
            // Preparation never clicks. The Agent only selects this path for a
            // model-certified, non-recipient-bound top-level native BUTTON.
            if (tag !== 'button') return msg.params._requireTrustedNativeButton === true
              ? failure('The exact target is no longer a native button.')
              : { success: true, nativeButton: false, dispatched: false, noDispatch: true };
            const visibility = _axFallbackVisibility(el);
            const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
            const hit = _shadowAwareElementFromPoint(x, y);
            if (!visibility.visible || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight
                || !hit || !_isComposedAncestor(el, hit) || _axInteractiveHitDescendant(el, hit)) {
              return failure('The native button is hidden, covered or has an ambiguous physical target. Re-observe before clicking.');
            }
            return { success: true, trustedButtonRequired: true, dispatched: false, noDispatch: true,
              // The agent compares the raw name between preparation and
              // its re-probe (an account switch changes it) and echoes only
              // the model-facing one.
              ref_id, tag, name: String(modelTargetName || '').slice(0, 160), _rawName: String(targetName || '').slice(0, 160),
              preparedActive, buttonStrongState: fallbackStateBefore.strong,
              buttonDisabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
              documentToken, refScopeUrl: location.href, x, y,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
          }
          rememberInteractionPoint(el, 'click_ax');
          const syntheticClickStartedAt = Date.now();
          if (actionDeadlineExpired()) {
            return failure(
              'The page action deadline expired before click dispatch.',
              { deadlineExpired: true, retryable: true },
            );
          }
          const syntheticClickDispatchStartedAt = performance.now();
          let nativeWhatsappRepairSnapshot = null;
          let nativeTelegramReadRecord = null;
          const filePickerGuard = withLocalPageDispatch(() => {
            if (msg.params?._nativeTelegramReadRepairRequired === true) {
              nativeTelegramReadRecord = _consumeNativeTelegramRead(msg.params,el);
              if (!nativeTelegramReadRecord || actionDeadlineExpired()) return {nativeTelegramReadBlocked:true};
            }
            nativeWhatsappRepairSnapshot = window.__wb_native_whatsapp_repair_snapshot?.(el) || null;
            window.__wb_prepare_native_chat_contact?.(el);
            dispatched = true;
            return clickWithoutNativeFilePicker(() => el.click());
          });
          const syntheticClickDispatchMs = Math.max(0, performance.now() - syntheticClickDispatchStartedAt);
          const fallbackStateAfterImmediate = _axFallbackState(el);
          if (filePickerGuard.nativeTelegramReadBlocked) return failure(
            'The native Telegram profile preparation changed. Re-observe the current chat and choose its exact native read-only control.',
            {reasonCode:'native_telegram_read_preparation_stale'});
          if (filePickerGuard.blocked) {
            return failure(
              filePickerBlockedResponse(filePickerGuard.blocked, modelTargetName || '').error,
              {
                filePickerBlocked: true,
                ...(filePickerGuard.blocked.selector ? { selector: filePickerGuard.blocked.selector } : {}),
                ref_id,
              },
            );
          }
          // If the model just clicked a text-entry element, its next call must
          // be type_ax on the same ref_id. Putting the directive in the tool
          // payload (rather than only in the system prompt) keeps it in the
          // model's recent attention window — critical for small local models.
          let isTextEntry = false;
          if (tag === 'textarea') isTextEntry = true;
          else if (tag === 'input') {
            const inputType = (el.type || 'text').toLowerCase();
            const nonText = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'color', 'range', 'hidden']);
            isTextEntry = !nonText.has(inputType);
          } else if (el.isContentEditable) isTextEntry = true;
          const buildResponse = () => {
            const checkedAfter = nativeCheckable ? !!el.checked : null;
            const resp = {
              success: true,
              method: 'click_ax',
              ...(window.__wb_native_whatsapp_repair_matches?.(nativeWhatsappRepairSnapshot)
                ? { _nativeWhatsappReadRepair: true } : {}),
              ...(_nativeTelegramReadStillCurrent(nativeTelegramReadRecord) ? {_nativeTelegramReadRepair:true} : {}),
              ref_id,
              tag,
              _preparedActive: preparedActive,
              _syntheticClickStartedAt: syntheticClickStartedAt,
              _syntheticClickDispatchMs: syntheticClickDispatchMs,
              _fallbackStateBefore: fallbackStateBefore.full,
              _fallbackStateAfterImmediate: fallbackStateAfterImmediate.full,
              _fallbackStrongStateBefore: fallbackStateBefore.strong,
              _fallbackStrongStateAfterImmediate: fallbackStateAfterImmediate.strong,
              _fallbackWeakStateBefore: fallbackStateBefore.weak,
              _fallbackWeakStateAfterImmediate: fallbackStateAfterImmediate.weak,
              _fallbackStaticBlockedReason: fallbackStatic.blockedReason,
              // A model reads this name (the agent's repeat reading).
              _fallbackName: String(_axModelName(el, fallbackStatic.name) || '').replace(/\s+/g, ' ').trim().slice(0, 200),
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              ...(targetContext ? { targetContext } : {}),
              ...(filePickerGuard.guardId ? { _filePickerGuardId: filePickerGuard.guardId } : {}),
            };
            if (nativeCheckable) {
              const desiredChecked = inputType === 'radio' ? true : !checkedBefore;
              const checkboxIdentity = _axCheckboxIdentity(el, ref_id);
              resp.checkedBefore = checkedBefore;
              resp.checkedAfter = checkedAfter;
              resp.checkedChanged = checkedBefore !== checkedAfter;
              resp.desiredChecked = desiredChecked;
              resp.checkboxIdentity = checkboxIdentity;
              resp.checkboxState = {
                identity: checkboxIdentity,
                desiredChecked,
                actualChecked: checkedAfter,
              };
              const stateMatchesDesired = checkedAfter === desiredChecked;
              if (stateMatchesDesired) {
                resp.verified = true;
                if (resp.checkedChanged) resp.observedEffects = ['checked_state'];
              } else {
                resp.success = false;
                resp.noProgress = true;
                resp.verified = false;
                resp.error = inputType === 'checkbox'
                  ? `Checkbox remained ${checkedAfter ? 'checked' : 'unchecked'} after click_ax. Do not toggle it again; use set_checked({ref_id: "${ref_id}", checked: ${desiredChecked}}) so the requested state is applied idempotently and verified.`
                  : 'Radio remained unselected after click_ax. Re-read the accessibility tree and retry the intended radio option with a fresh ref_id.';
              }
            }
            // Echo accessible name + href so the model can see exactly what
            // element it hit. This is critical when a stale ref_id points at
            // the wrong thing — e.g. a sidebar nav link that navigates away
            // from an open modal, silently destroying in-progress form state.
            try {
              if (modelTargetName) resp.name = modelTargetName;
            } catch {}
            if (tag === 'a') {
              try {
                // Model-facing forms (_axModelHref): account chrome shows
                // only where it leads.
                const href = _axModelHref(el, anchorMeta?.href || el.getAttribute('href') || '');
                const targetUrl = _axModelHref(el, anchorMeta?.targetUrl || '');
                resp.href = href;
                if (anchorMeta?.resolvedHref) resp.resolvedHref = _axModelHref(el, anchorMeta.resolvedHref);
                if (anchorMeta?.sameDocumentAnchor) {
                  const afterScrollY = Math.round(window.scrollY || 0);
                  const afterUrl = location.href;
                  resp.sameDocumentAnchor = true;
                  resp.anchorTarget = anchorMeta.anchorTarget;
                  resp.targetUrl = targetUrl;
                  resp.beforeUrl = anchorMeta.beforeUrl;
                  resp.afterUrl = afterUrl;
                  resp.beforeScrollY = anchorMeta.beforeScrollY;
                  resp.afterScrollY = afterScrollY;
                  resp.scrollChanged = Math.abs(afterScrollY - anchorMeta.beforeScrollY) > 1;
                  let afterHash = '';
                  try {
                    afterHash = new URL(afterUrl).hash;
                    resp.hashChanged = afterHash !== new URL(anchorMeta.beforeUrl).hash;
                  } catch {
                    resp.hashChanged = afterUrl !== anchorMeta.beforeUrl;
                  }
                  resp.atAnchor = afterHash === anchorMeta.anchorTarget || (anchorMeta.anchorTarget === '#' && !afterHash);
                  resp.anchorActivated = resp.hashChanged || resp.scrollChanged || resp.atAnchor;
                  resp.hint = resp.anchorActivated
                    ? `Same-page anchor click completed: URL is now ${afterUrl}, and scrollY moved from ${anchorMeta.beforeScrollY} to ${afterScrollY}. The page is already at ${anchorMeta.anchorTarget}; do not click this anchor again unless the user asks to return here.`
                    : `Same-page anchor click returned for ${anchorMeta.anchorTarget}, but URL and scroll position did not change. Re-observe the page before retrying this same anchor.`;
                } else if (anchorMeta?.navigates) {
                  resp.navigates = true;
                  resp.targetUrl = targetUrl || href;
                  resp.hint = `This <a> click is navigating to ${targetUrl || href}. If that's not what you intended, the ref_id was stale — re-read the accessibility tree to get fresh ids. Any unsaved form input on the previous page has been lost.`;
                }
              } catch {}
            }
            if (isTextEntry) {
              resp.focused = true;
              resp.next_required = 'type_ax';
              resp.hint = `This element is now focused. Your very next tool call MUST be type_ax({ref_id: "${ref_id}", text: "..."}). Do not call any other tool in between.`;
            } else if (tag === 'select') {
              resp.hint = `This is a <select>. Prefer press_keys on the focused element to choose an option: press_keys({key: "ArrowDown"}) or press_keys({key: "ArrowUp"}) moves one option per press, then press_keys({key: "Enter"}); letter keys are not supported. type_ax on a select also works via value/text match.`;
            } else if (!anchorMeta?.sameDocumentAnchor) {
              // Detect combobox / popup-opener. If this click was supposed to
              // open a listbox/menu/dialog, the popup is almost always rendered
              // via a React portal at the end of <body> — OUTSIDE this
              // element's DOM subtree. The model must re-read the FULL tree
              // (no ref_id subtree filter) to see the new options, then
              // type-filter or press arrows — NOT keep clicking this button,
              // which toggles the popup closed.
              try {
                if (isPopupOpener) {
                  resp.opened_popup_likely = true;
                  resp.hint = `This element is a combobox / popup-opener (role="${popupRole}"${popupHasPopup ? `, aria-haspopup="${popupHasPopup}"` : ''}). The popup is almost always rendered in a React portal at the end of <body>, OUTSIDE this button's subtree. Next step: call get_accessibility_tree({filter: "visible"}) — do NOT pass a ref_id (subtree filter will miss the portal). Look for a newly-appeared listbox / searchbox / menu. Then either (a) set_field({ref_id: <new search textbox ref>, text: "<query>", submit: true}), or (b) press_keys({key: "ArrowDown"}) to highlight the wanted option, then press_keys({key: "Enter"}) (press_keys sends one supported key per call; it cannot type letters). Do NOT click this same ref_id again — it will just toggle the popup closed.`;
                }
              } catch {}
            }
            return resp;
          };
          const responseDelayMs = nativeCheckable
            ? SET_FIELD_VERIFY_DELAY_MS
            : (anchorMeta?.sameDocumentAnchor ? 120 : 0);
          if (responseDelayMs > 0) {
            return new Promise((resolve) => {
              setTimeout(() => {
                try {
                  resolve(buildResponse());
                } catch (e) {
                  if (e?.code === 'page_feedback_pending') throw e;
                  resolve(failure(e && e.message || String(e)));
                }
              }, responseDelayMs);
            });
          }
          return buildResponse();
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          return failure(e && e.message || String(e));
        }
      },
      // Read-only sample of a certified native button while the agent's own
      // hover settles. It never focuses, scrolls or dispatches.
      'sample_trusted_native_button': () => _sampleTrustedNativeButton(msg.params || {}),
      'set_checked': () => {
        let dispatched = false;
        const failure = (error, extra = {}) => ({
          success: false,
          error,
          ...extra,
          ...(dispatched
            ? { dispatched: true }
            : { dispatched: false, noDispatch: true }),
        });
        const deadlineFailure = () => failure(
          dispatched
            ? 'The page action deadline expired during checkbox dispatch.'
            : 'The page action deadline expired before checkbox dispatch.',
          {
            deadlineExpired: true,
            outcomeUnknown: dispatched,
            retryable: !dispatched,
          },
        );
        try {
          if (actionDeadlineExpired()) return deadlineFailure();
          const {
            ref_id,
            checked,
            expectedDocumentToken,
            expectedPageUrl,
            probeOnly,
            markForTrustedClick,
            cleanupMarker,
          } = msg.params || {};
          if (typeof ref_id !== 'string') return failure('ref_id (string, e.g. "ref_42") is required');
          if (typeof checked !== 'boolean') return failure('checked (boolean) is required');
          if (typeof window.__wb_ax_lookup !== 'function') return failure('accessibility-tree.js not injected');
          const documentToken = _axDocumentToken();
          const documentChanged = !!expectedDocumentToken && expectedDocumentToken !== documentToken;
          const routeChanged = !!expectedPageUrl && expectedPageUrl !== location.href;
          if (documentChanged || routeChanged) {
            return failure(
              `ref_id ${ref_id} belongs to a previous page or route. Re-read the accessibility tree and choose a fresh ref_id before changing the checkbox.`,
              { staleRef: true, documentChanged, routeChanged, documentToken, refScopeUrl: location.href },
            );
          }
          let markedTarget = null;
          if (cleanupMarker) {
            try {
              const marked = removeSetCheckedMarkers(cleanupMarker);
              if (marked.length !== 1) {
                return failure(
                  `Trusted checkbox marker matched ${marked.length} controls; refusing to verify an ambiguous target. Re-read the accessibility tree and retry.`,
                  { markerConflict: true, markerMatchCount: marked.length },
                );
              }
              markedTarget = marked[0];
            } catch (error) {
              if (error?.code === 'page_feedback_pending') throw error;
              return failure(`Trusted checkbox marker cleanup failed: ${error?.message || error}`);
            }
          }
          // A same-document route update invalidates the AX registry after the
          // trusted click. The private one-shot marker still points to the
          // exact preflighted element for this verification pass.
          const el = markedTarget || window.__wb_ax_lookup(ref_id);
          if (!el) return failure(`ref_id ${ref_id} not found. Re-read the accessibility tree to get a current checkbox ref_id.`);
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const inputType = tag === 'input' ? String(el.type || '').toLowerCase() : '';
          if (inputType !== 'checkbox') {
            return failure(`set_checked only supports native input[type="checkbox"] controls; ${ref_id} resolved to ${tag || 'unknown'}${inputType ? `[type="${inputType}"]` : ''}.`);
          }
          if (actionDeadlineExpired()) return deadlineFailure();
          try { _scrollElementIntoClearView(el); } catch (error) { if (error?.code === 'page_feedback_pending') throw error; }
          if (actionDeadlineExpired()) return deadlineFailure();
          window.__wbPageMonitor?.beforeLocalDispatch({ preparation: true, kind: 'focus', target: el });
          try { el.focus({ preventScroll: true }); } catch {}
          if (actionDeadlineExpired()) return deadlineFailure();
          const rect = el.getBoundingClientRect();
          if (!el.isConnected || rect.width < 1 || rect.height < 1) {
            return failure(`ref_id ${ref_id} is stale or not visibly rendered. Re-read the accessibility tree and retry.`);
          }
          const checkedBefore = !!el.checked;
          const checkboxIdentity = _axCheckboxIdentity(el, ref_id);
          const confirmationSurfacesBefore = _axVisibleConfirmationSurfaces();
          const base = {
            method: 'set_checked',
            ref_id,
            tag,
            type: inputType,
            name: _axAccessibleName(el),
            checkboxIdentity,
            desiredChecked: checked,
            checkedBefore,
            checkedAfter: checkedBefore,
            changed: false,
            verified: checkedBefore === checked,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            selector: _axStableControlSelector(el),
            checkboxState: {
              identity: checkboxIdentity,
              desiredChecked: checked,
              actualChecked: checkedBefore,
            },
          };
          if (checkedBefore === checked) {
            return {
              success: true,
              dispatched: false,
              noDispatch: true,
              idempotent: true,
              ...base,
            };
          }
          if (probeOnly === true) {
            let marker = '';
            let trustedSelector = '';
            if (markForTrustedClick === true) {
              if (actionDeadlineExpired()) return deadlineFailure();
              const markerEntropy = new Uint32Array(3);
              globalThis.crypto.getRandomValues(markerEntropy);
              marker = `wbsc_${Date.now().toString(36)}_${Array.from(markerEntropy, value => value.toString(36)).join('_')}`;
              if (actionDeadlineExpired()) return deadlineFailure();
              el.setAttribute(SET_CHECKED_MARKER_ATTRIBUTE, marker);
              trustedSelector = setCheckedMarkerSelector(marker);
              const marked = Array.from(document.querySelectorAll(trustedSelector));
              if (marked.length !== 1 || marked[0] !== el) {
                removeSetCheckedMarkers(marker);
                return failure(
                  `Trusted checkbox marker matched ${marked.length} controls; refusing to click an ambiguous target. Re-read the accessibility tree and retry.`,
                  { markerConflict: true, markerMatchCount: marked.length },
                );
              }
              setTimeout(() => {
                try { removeSetCheckedMarkers(marker); } catch {}
              }, SET_CHECKED_MARKER_TTL_MS);
            }
            return {
              success: true,
              dispatched: false,
              noDispatch: true,
              needsTrustedClick: true,
              marker: marker || undefined,
              trustedSelector: trustedSelector || undefined,
              _confirmationSurfaces: confirmationSurfacesBefore,
              ...base,
            };
          }
          if (actionDeadlineExpired()) return deadlineFailure();
          withLocalPageDispatch(() => {
            dispatched = true;
            el.click();
          });
          if (actionDeadlineExpired()) return deadlineFailure();
          const checkedAfter = !!el.checked;
          const success = checkedAfter === checked;
          const confirmation = success
            ? null
            : _axNewConfirmationSurface(confirmationSurfacesBefore);
          return {
            ...base,
            success,
            dispatched: true,
            trusted: false,
            verified: success,
            checkedAfter,
            changed: checkedBefore !== checkedAfter,
            checkboxState: {
              identity: checkboxIdentity,
              desiredChecked: checked,
              actualChecked: checkedAfter,
            },
            ...(confirmation ? {
              confirmationRequired: true,
              recoveryRequired: 'confirmation_dialog',
              observedEffects: ['confirmation_dialog_opened'],
              confirmation,
              warning: 'A confirmation dialog opened before the checkbox could reach the requested state. Do not call set_checked again. Re-read the visible accessibility tree and choose a dialog action only when it is supported by the user request or current evidence.',
            } : success ? {} : {
              noProgress: true,
              error: `Checkbox remained ${checkedAfter ? 'checked' : 'unchecked'} after one synthetic click. This page may require trusted pointer input.`,
            }),
          };
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          return failure(e && e.message || String(e));
        }
      },
      'type_ax': async () => {
        let dispatched = false;
        const failure = (error, extra = {}) => ({
          success: false,
          error,
          ...extra,
          ...(dispatched
            ? { dispatched: true }
            : { dispatched: false, noDispatch: true }),
        });
        const deadlineFailure = () => failure(
          dispatched
            ? 'The page action deadline expired during accessibility-tree text dispatch.'
            : 'The page action deadline expired before accessibility-tree text dispatch.',
          { deadlineExpired: true, outcomeUnknown: dispatched, retryable: !dispatched },
        );
        try {
          if (actionDeadlineExpired()) return deadlineFailure();
          const { ref_id, text, clear } = msg.params || {};
          if (typeof ref_id !== 'string') return failure('ref_id (string, e.g. "ref_42") is required');
          if (typeof text !== 'string') return failure('text (string) is required');
          if (typeof window.__wb_ax_lookup !== 'function') return failure('accessibility-tree.js not injected');
          const el = window.__wb_ax_lookup(ref_id);
          if (!el) {
            let suggestions = [];
            try { if (typeof window.__wb_ax_suggest === 'function') suggestions = window.__wb_ax_suggest(ref_id, 6); } catch {}
            const refStr = String(ref_id);
            const looksLikeDomId = !/^ref_\d+$/.test(refStr);
            const formatNote = looksLikeDomId
              ? ` "${refStr}" is not a valid ref_id. Valid ref_ids have the form ref_N (e.g. ref_42) and appear in square brackets in get_accessibility_tree output — do not use DOM ids, CSS selectors, or placeholder words from the prompt.`
              : '';
            const hint = suggestions.length
              ? ' Nearest existing refs: ' + suggestions.map(s => `${s.ref} (${s.role}${s.name ? ' "' + s.name + '"' : ''})`).join(', ') + '.'
              : '';
            return failure(`ref_id ${ref_id} not found.${formatNote} The element may have been removed or the page replaced.${hint} Re-read the accessibility tree to get fresh ids — do NOT guess ref numbers or invent placeholders.`, { suggestions });
          }
          if (actionDeadlineExpired()) return deadlineFailure();
          try { _scrollElementIntoClearView(el); } catch (error) { if (error?.code === 'page_feedback_pending') throw error; }
          if (actionDeadlineExpired()) return deadlineFailure();
          try { _withTypingPreparation('focus', el, () => el.focus({ preventScroll: true })); } catch (error) { if (error?.code === 'page_feedback_pending') throw error; }
          if (actionDeadlineExpired()) return deadlineFailure();
          showAgentWorkingTarget(el, 'type_ax');
          // Capture the element's on-screen rect so the background can
          // remember where the last interaction happened (for annotated
          // verification screenshots on done).
          const typeRect = (() => {
            try {
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            } catch { return null; }
          })();
          const fieldMeta = _fieldMeta(el);
          if (isDraftJsEditor(el) && readDraftJsText(el) === null) return failure(
            'The DraftJS editor structure cannot establish its exact document text. Re-observe this editor before typing.',
            { ref_id, verified: false, fieldMeta, recoveryRequired: 'fresh_tree', retryable: false },
          );
          // Before the setter and the trusted contenteditable handoff, as in
          // set_field: a cleared field must not get only a preview of itself.
          const truncatedPreview = clear ? _truncatedPreviewReplacementFailure(el, text) : null;
          if (truncatedPreview) return { ...truncatedPreview, ref_id, rect: typeRect, fieldMeta };
          let previous = '';
          let method = '';
          let selectExpected = null;
          if (el.isContentEditable) {
            previous = _editableTextValue(el);
            if (!isModelManagedEditor(el) || (isDraftJsEditor(el) && /[\r\n]/.test(text))) {
              const native = await _insertContentEditableText(el, text, !!clear, actionDeadlineExpired);
              return { ...native, ref_id, rect: typeRect, fieldMeta };
            }
            return failure(
              'Contenteditable fields require trusted browser typing. Attempting one ref-bound Chrome typing pass.',
              {
                method: 'type_ax_contenteditable_trusted',
                ref_id,
                rect: typeRect,
                verified: false,
                fieldMeta,
                fallbackAttempted: false,
                trustedTypeRequired: true,
                _expectedValue: (clear ? '' : previous) + text,
              },
            );
          } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
            // Guard against non-typeable INPUT subtypes. These all share the
            // INPUT tagName so without this check a confused model calling
            // type_ax on, say, a checkbox would silently set the value
            // attribute — returning success while nothing actually toggled.
            // Point the model at click_ax instead.
            if (el.tagName === 'INPUT') {
              const inputType = (el.type || 'text').toLowerCase();
              const nonTypeable = new Set([
                'checkbox', 'radio', 'file', 'submit', 'button',
                'reset', 'image', 'color', 'range', 'hidden',
              ]);
              if (nonTypeable.has(inputType)) {
                return failure(`ref_id ${ref_id} is an <input type="${inputType}"> which is not text-typeable. Use click_ax to toggle/activate it instead.`);
              }
            }
            if (el.tagName === 'SELECT') {
              // Native <select>: match the requested text against options by
              // value, then by visible text (exact, then substring). A select's
              // value can't be set through the INPUT prototype setter used below
              // (Web IDL brand-check throws "Illegal invocation"), so handle it
              // here with the HTMLSelectElement setter — mirrors _typeTextInner.
              const needle = (text || '').trim();
              const byValue = Array.from(el.options).find((o) => o.value === needle);
              const byText = Array.from(el.options).find((o) => o.text.trim() === needle)
                || Array.from(el.options).find((o) => o.text.trim().toLowerCase().includes(needle.toLowerCase()));
              const match = byValue || byText;
              if (!match) {
                return failure(`No <option> matching "${text}" in select ref_id ${ref_id}.`);
              }
              if (actionDeadlineExpired()) return deadlineFailure();
              window.__wbPageMonitor?.beforeLocalDispatch();
              dispatched = true;
              const selSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
              if (selSetter) selSetter.call(el, match.value); else el.value = match.value;
              if (actionDeadlineExpired()) return deadlineFailure();
              el.dispatchEvent(new Event('input', { bubbles: true }));
              if (actionDeadlineExpired()) return deadlineFailure();
              el.dispatchEvent(new Event('change', { bubbles: true }));
              selectExpected = match.value;
              method = 'type_ax_select';
            } else {
              if (actionDeadlineExpired()) return deadlineFailure();
              window.__wbPageMonitor?.beforeLocalDispatch();
              dispatched = true;
              previous = el.value || '';
              if (clear) el.value = '';
              if (actionDeadlineExpired()) return deadlineFailure();
              // Use the native setter so React's synthetic event system picks it up.
              const proto = el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
              const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
              const setter = descriptor && descriptor.set;
              const newVal = (clear ? '' : previous) + text;
              if (setter) setter.call(el, newVal); else el.value = newVal;
              if (actionDeadlineExpired()) return deadlineFailure();
              el.dispatchEvent(new Event('input', { bubbles: true }));
              if (actionDeadlineExpired()) return deadlineFailure();
              el.dispatchEvent(new Event('change', { bubbles: true }));
              method = 'type_ax_input';
            }
          } else {
            return failure(`ref_id ${ref_id} is not a typeable element (tag=${el.tagName}). Use click_ax then type_text.`);
          }

          await new Promise(resolve => setTimeout(resolve, SET_FIELD_VERIFY_DELAY_MS));
          if (actionDeadlineExpired()) return deadlineFailure();
          if (!el.isConnected) {
            return failure(
              `ref_id ${ref_id} was replaced while the value was being typed. Re-read the accessibility tree and retry with the current field ref_id.`,
              { ref_id, verified: false, recoveryRequired: 'verify_or_restore_field', failureScope: `field-value:${ref_id}`, retryable: false, fieldMeta },
            );
          }
          if (isDraftJsEditor(el) && readDraftJsText(el) === null) return failure(
            'The DraftJS editor structure changed during typing and cannot establish its exact document text.',
            { ref_id, verified: false, fieldMeta, recoveryRequired: 'verify_or_restore_field', failureScope: `field-value:${ref_id}`, retryable: false },
          );
          const actual = el.isContentEditable ? _editableTextValue(el) : (el.value || '');
          const verified = selectExpected !== null
            ? actual === selectExpected
            : _setFieldValueMatches(actual, previous, text, !!clear, el.isContentEditable, (readProseMirrorText(el) !== null || readDraftJsText(el) !== null || readEmptyCaretText(el) !== null));
          const fallbackAttempted = false;
          if (!verified) {
            return failure(
              'The field value did not exactly match the requested text after the page settled. Repeat the original replacement text and target for readback-only recovery, or restore the editor before another write.',
              {
                method,
                ref_id,
                rect: typeRect,
                verified: false,
                actual: actual.slice(0, 200),
                fieldMeta,
                fallbackAttempted,
                ...(selectExpected === null ? { _expectedValue: (clear ? '' : previous) + text } : {}),
                recoveryRequired: 'verify_or_restore_field',
                failureScope: `field-value:${ref_id}`,
                retryable: false,
              },
            );
          }
          return {
            success: true,
            verified: true,
            method,
            ref_id,
            rect: typeRect,
            ...(selectExpected !== null ? {
              value: actual,
              ...(el.selectedOptions?.length === 1
                ? { selectedText: String(el.selectedOptions[0].textContent || '').replace(/\s+/g, ' ').trim() } : {}),
            } : {}),
            fieldMeta,
            fallbackAttempted,
          };
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          return failure(e && e.message || String(e));
        }
      },
      'set_field': async () => {
        // Captured synchronously when the action begins (see the run-stop listener).
        const runOwner = { monitored: window.__wbPageMonitor?.active === true,
          stopEpoch: Number(window.__wbContentRunStopEpoch) || 0 };
        const runStopped = () => (Number(window.__wbContentRunStopEpoch) || 0) !== runOwner.stopEpoch
          || (runOwner.monitored && window.__wbPageMonitor?.active !== true);
        let dispatched = false;
        let submissionDispatched = false;
        let submissionBlockedBeforeDispatch = false;
        let submissionBlockReason = '';
        let nativeDraftBinding = null;
        const failure = (error, extra = {}) => ({
          success: false,
          error,
          ...extra,
          ...(dispatched
            ? { dispatched: true }
            : { dispatched: false, noDispatch: true }),
        });
        const deadlineFailure = () => failure(
          dispatched
            ? (submissionDispatched
                ? 'The page action deadline expired during submission dispatch. The field or submission outcome may be incomplete.'
                : 'The page action deadline expired during field dispatch. The value may be incomplete, but no submit action was sent.')
            : 'The page action deadline expired before field dispatch.',
          {
            deadlineExpired: true,
            ...(submissionDispatched ? {} : { submitted: false }),
            outcomeUnknown: dispatched,
            retryable: !dispatched,
          },
        );
        try {
          const { ref_id, text, clear = true, submit = false } = msg.params || {};
          if (actionDeadlineExpired()) return deadlineFailure();
          if (typeof ref_id !== 'string') return failure('ref_id (string, e.g. "ref_42") is required');
          if (typeof text !== 'string') return failure('text (string) is required');
          if (typeof window.__wb_ax_lookup !== 'function') return failure('accessibility-tree.js not injected');
          const el = window.__wb_ax_lookup(ref_id);
          if (!el) {
            let suggestions = [];
            try { if (typeof window.__wb_ax_suggest === 'function') suggestions = window.__wb_ax_suggest(ref_id, 6); } catch {}
            const refStr = String(ref_id);
            const looksLikeDomId = !/^ref_\d+$/.test(refStr);
            const formatNote = looksLikeDomId
              ? ` "${refStr}" is not a valid ref_id. Valid ref_ids have the form ref_N (e.g. ref_42) and appear in square brackets in get_accessibility_tree output — do not use DOM ids, CSS selectors, or placeholder words from the prompt.`
              : '';
            const hint = suggestions.length
              ? ' Nearest existing refs: ' + suggestions.map(s => `${s.ref} (${s.role}${s.name ? ' "' + s.name + '"' : ''})`).join(', ') + '.'
              : '';
            return failure(`ref_id ${ref_id} not found.${formatNote} The element may have been removed or the page replaced.${hint} Re-read the accessibility tree to get fresh ids — do NOT guess ref numbers or invent placeholders.`, { suggestions });
          }
          if (actionDeadlineExpired()) return deadlineFailure();
          const recoveringDraft = msg.params?._nativeChatDraftBinding
            ? _nativeChatDraftCurrent(msg.params, el) : null;
          if (msg.params?._nativeChatDraftBinding && !recoveringDraft) return failure(
            'The owned draft changed before recovery. Observe the conversation and reconcile the remaining draft.',
            { reasonCode:'native_chat_draft_changed', submitted:false, submissionDispatched:false });
          const preparedRecipient = msg.params?._nativeChatDraftPreparation === true
            ? _messageRecipientDispatchBindings.get(String(msg.params?.messageRecipientDispatchBinding?.token || ''))
            : null;
          const originalRecipient = preparedRecipient
            ? { ...preparedRecipient, nativeDraftOwnInputs:{ el, count:0 } } : null;
          try { _scrollElementIntoClearView(el); } catch (error) { if (error?.code === 'page_feedback_pending') throw error; }
          if (actionDeadlineExpired()) return deadlineFailure();
          try { _withTypingPreparation('focus', el, () => el.focus({ preventScroll: true })); } catch (error) { if (error?.code === 'page_feedback_pending') throw error; }
          if (actionDeadlineExpired()) return deadlineFailure();
          showAgentWorkingTarget(el, 'set_field');
          const rect = (() => {
            try {
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            } catch { return null; }
          })();
          if (!el.isConnected || !rect || rect.w < 1 || rect.h < 1) {
            return failure(
              `ref_id ${ref_id} is stale or not visibly rendered. Re-read the accessibility tree and retry with the current field ref_id.`,
              {
                ref_id,
                rect,
              },
            );
          }
          // Guard: refuse non-typeable elements up-front so the caller gets a
          // clear error instead of a silent no-op.
          if (el.tagName === 'INPUT') {
            const inputType = (el.type || 'text').toLowerCase();
            const nonTypeable = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'color', 'range', 'hidden']);
            if (nonTypeable.has(inputType)) {
              return failure(`ref_id ${ref_id} is an <input type="${inputType}"> which is not text-typeable. Use click_ax to toggle/activate it instead.`);
            }
          } else if (!el.isContentEditable && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
            return failure(`ref_id ${ref_id} is not a text field (tag=${el.tagName}). set_field works on input/textarea/contenteditable only.`);
          }
          const fieldMeta = _fieldMeta(el);
          if (isDraftJsEditor(el) && readDraftJsText(el) === null) return failure(
            'The DraftJS editor structure cannot establish its exact document text. Re-observe this editor before typing.',
            { ref_id, verified: false, fieldMeta, recoveryRequired: 'fresh_tree', retryable: false },
          );
          // Before the setter and before the trusted contenteditable handoff:
          // a replacement that only repeats a shortened preview of this
          // field's value would erase the rest. Draft recovery writes nothing.
          const truncatedPreview = clear && !recoveringDraft
            ? _truncatedPreviewReplacementFailure(el, text) : null;
          if (truncatedPreview) return { ...truncatedPreview, ref_id, rect, fieldMeta };
          let prevValue = '';
          let pageHandledBeforeInput = false;
          let pageHandledPaste = false;
          if (recoveringDraft) {
            prevValue = _editableTextValue(el);
          } else if (el.isContentEditable) {
            prevValue = _editableTextValue(el);
            if (!isModelManagedEditor(el) || (isDraftJsEditor(el) && /[\r\n]/.test(text))) {
              const native = await _insertContentEditableText(el, text, clear, actionDeadlineExpired, originalRecipient?.nativeDraftOwnInputs);
              if (!native.success) return { ...native, ref_id, rect, fieldMeta };
              dispatched = native.dispatched === true;
              pageHandledBeforeInput = native.pageHandledBeforeInput === true;
              pageHandledPaste = native.pageHandledPaste === true;
            } else {
            return failure(
              'Contenteditable fields require trusted browser typing. Attempting one ref-bound Chrome typing pass.',
              {
                method: 'set_field_contenteditable_trusted',
                ref_id,
                rect,
                verified: false,
                fieldMeta,
                fallbackAttempted: false,
                trustedTypeRequired: true,
                _expectedValue: (clear ? '' : prevValue) + text,
              },
            );
            }
          } else {
            if (actionDeadlineExpired()) return deadlineFailure();
            window.__wbPageMonitor?.beforeLocalDispatch();
            dispatched = true;
            prevValue = el.value || '';
            const proto = el.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            const setter = descriptor && descriptor.set;
            const newVal = (clear ? '' : prevValue) + text;
            if (setter) setter.call(el, newVal); else el.value = newVal;
            if (actionDeadlineExpired()) return deadlineFailure();
            el.dispatchEvent(new Event('input', { bubbles: true }));
            if (actionDeadlineExpired()) return deadlineFailure();
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (actionDeadlineExpired()) return deadlineFailure();
          }
          // Controlled inputs can reconcile on the next task and overwrite or
          // append to the value after their input/change handlers return.
          // Let that reconciliation settle before verifying the exact result.
          await new Promise(resolve => setTimeout(resolve, SET_FIELD_VERIFY_DELAY_MS));
          if (actionDeadlineExpired()) return deadlineFailure();
          if (!el.isConnected) {
            return failure(
              `ref_id ${ref_id} was replaced while the value was being set. Re-read the accessibility tree and retry with the current field ref_id.`,
              { ref_id, verified: false, recoveryRequired: 'verify_or_restore_field', failureScope: `field-value:${ref_id}`, retryable: false },
            );
          }
          if (isDraftJsEditor(el) && readDraftJsText(el) === null) return failure(
            'The DraftJS editor structure changed during typing and cannot establish its exact document text.',
            { ref_id, verified: false, fieldMeta, recoveryRequired: 'verify_or_restore_field', failureScope: `field-value:${ref_id}`, retryable: false },
          );
          const actual = el.isContentEditable ? _editableTextValue(el) : (el.value || '');
          const verified = _setFieldValueMatches(actual, prevValue, text, clear, el.isContentEditable, (readProseMirrorText(el) !== null || readDraftJsText(el) !== null || readEmptyCaretText(el) !== null));
          const fallbackAttempted = false;
          let nativeSubmitAttempted = false;
          let submissionOutcomeUnknown = false;
          // The field write already happened; report it honestly and send no
          // submit for a run that was stopped during the settle wait.
          const stoppedBeforeSubmit = () => failure(
            'Stopped before submitting. The field value was written, but no submit was sent.',
            { cancelled: true, ref_id, rect, verified, fieldMeta, submitted: false, submissionDispatched: false,
              submissionBlockedBeforeDispatch: true, submissionBlockReason: 'run_stopped',
              outcomeUnknown: !verified, retryable: false },
          );
          if (submit && verified && runStopped()) return stoppedBeforeSubmit();
          if (submit && verified) {
            if (actionDeadlineExpired()) return deadlineFailure();
            submissionOutcomeUnknown = true;
            try {
              // Detect combobox/searchbox pattern: if the element is a searchbox,
              // has role=combobox, has aria-controls pointing to a listbox, or a
              // visible listbox is present on the page, we need ArrowDown first to
              // highlight a filtered option before Enter commits it. Bare Enter on
              // Stripe/React virtualized pickers just closes the popup without
              // selecting anything.
              const roleAttr = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
              const controls = el.getAttribute && el.getAttribute('aria-controls');
              let isCombobox = roleAttr === 'searchbox' || roleAttr === 'combobox'
                || (el.getAttribute && el.getAttribute('aria-autocomplete'))
                || (el.getAttribute && el.getAttribute('aria-expanded') === 'true');
              if (!isCombobox && controls) {
                try { if (document.getElementById(controls)) isCombobox = true; } catch {}
              }
              if (!isCombobox) {
                // Last-resort check: any visible listbox on the page?
                try {
                  const lbs = document.querySelectorAll('[role="listbox"],[role="menu"]');
                  for (const lb of lbs) {
                    const r = lb.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) { isCombobox = true; break; }
                  }
                } catch {}
              }
              const dispatchKeySequence = (key, keyCode, includeKeypress = false) => {
                const result = { dispatched: false, completedWithinDeadline: false };
                if (actionDeadlineExpired()) return result;
                const eventInit = { key, code: key, keyCode, bubbles: true, cancelable: true };
                window.__wbPageMonitor?.beforeLocalDispatch();
                result.dispatched = true;
                if (key === 'Enter') submissionDispatched = true;
                el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
                const expiredAfterKeydown = actionDeadlineExpired();
                if (!expiredAfterKeydown && includeKeypress) {
                  el.dispatchEvent(new KeyboardEvent('keypress', eventInit));
                }
                const expiredBeforeKeyup = expiredAfterKeydown || actionDeadlineExpired();
                // keyup is cleanup: always release a key whose keydown was
                // dispatched, even when a synchronous listener crossed the
                // action deadline.
                el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
                result.completedWithinDeadline = !expiredBeforeKeyup && !actionDeadlineExpired();
                return result;
              };
              const form = el.form || (el.closest && el.closest('form'));
              const usesNativeSubmit = _setFieldUsesNativeSubmit(isCombobox, el.isContentEditable, form);
              let submissionObserved = false;
              let submissionCancelled = false;
              if (recoveringDraft) {
                if (!_nativeChatDraftCurrent(msg.params, el)) return failure(
                  'The owned draft changed during action preparation. Observe it again before sending.',
                  { reasonCode:'native_chat_draft_changed', submitted:false, submissionDispatched:false });
                _disposeNativeChatDraft(msg.params._nativeChatDraftBinding.token);
              }
              if (msg.params?.messageRecipientGuardRequired === true) {
                const recipientValidation = _consumeMessageRecipientDispatchBinding(msg.params, el);
                if (recipientValidation.success !== true) {
                  submissionBlockedBeforeDispatch = true;
                  submissionBlockReason = recipientValidation.reasonCode;
                  nativeDraftBinding = !pageHandledBeforeInput
                    ? _rememberNativeChatDraft(msg.params, el, originalRecipient) : null;
                  return failure(recipientValidation.error, {
                    verified: true,
                    submitted: false,
                    messageDispatched: false,
                    submissionDispatched: false,
                    submissionOutcomeUnknown: false,
                    submissionBlockedBeforeDispatch: true,
                    submissionBlockReason,
                    draftMutationDispatched: dispatched,
                    outcomeUnknown: dispatched,
                    ...(nativeDraftBinding ? { _nativeChatDraftBinding: nativeDraftBinding } : {}),
                    messageRecipientGuard: true,
                    reasonCode: recipientValidation.reasonCode,
                    ...(recipientValidation.nativeChatReadRepair ? { nativeChatReadRepair: recipientValidation.nativeChatReadRepair } : {}),
                  });
                }
              }
              let removeSubmitObserver = () => {};
              let submitEvent = null;
              if (form && typeof form.addEventListener === 'function') {
                const onSubmit = event => {
                  submissionObserved = true;
                  submitEvent = event;
                };
                form.addEventListener('submit', onSubmit, true);
                removeSubmitObserver = () => form.removeEventListener?.('submit', onSubmit, true);
              }
              try {
                if (usesNativeSubmit) {
                  // Ordinary form controls use one native path. Dispatching a
                  // synthetic Enter first could make page code act and then
                  // make this fallback repeat the consequential action.
                  // requestSubmit performs interactive constraint validation and
                  // silently aborts on an invalid form; surface that instead of
                  // reporting a successful submission.
                  if (form.noValidate !== true && typeof form.checkValidity === 'function') {
                    if (actionDeadlineExpired()) return deadlineFailure();
                    const formIsValid = form.checkValidity();
                    if (actionDeadlineExpired()) return deadlineFailure();
                    if (!formIsValid) {
                      return failure(
                        'The form did not submit: a required field is empty or a value is invalid. Fix the field and retry with a fresh ref_id.',
                        { verified: true, submitted: false, invalid: true, ref_id, rect },
                      );
                    }
                  }
                  if (actionDeadlineExpired()) return deadlineFailure();
                  submissionDispatched = true;
                  try {
                    form.requestSubmit();
                  } catch {}
                  if (actionDeadlineExpired()) return deadlineFailure();
                } else {
                  // Comboboxes, contenteditables, and form-less widgets are
                  // committed by page-owned keyboard handlers. Never follow
                  // this path with requestSubmit: cancellation is not proof of
                  // submission, and an unobserved handler may already have acted.
                  if (isCombobox) {
                    await new Promise(r => setTimeout(r, 80));
                    if (actionDeadlineExpired()) return deadlineFailure();
                    if (runStopped()) return stoppedBeforeSubmit();
                    const arrowResult = dispatchKeySequence('ArrowDown', 40);
                    if (!arrowResult.completedWithinDeadline) return deadlineFailure();
                    await new Promise(r => setTimeout(r, 30));
                    if (actionDeadlineExpired()) return deadlineFailure();
                  }
                  // The ArrowDown above was a pre-submit key; Enter is the submit.
                  if (runStopped()) return stoppedBeforeSubmit();
                  if (actionDeadlineExpired()) return deadlineFailure();
                  const enterResult = dispatchKeySequence('Enter', 13, true);
                  submissionDispatched = enterResult.dispatched;
                  if (!enterResult.completedWithinDeadline) return deadlineFailure();
                  if (actionDeadlineExpired()) return deadlineFailure();
                }
                submissionCancelled = submitEvent?.defaultPrevented === true;
                nativeSubmitAttempted = submissionObserved && !submissionCancelled;
                submissionOutcomeUnknown = !nativeSubmitAttempted;
              } finally {
                removeSubmitObserver();
              }
            } catch (error) {
              submissionOutcomeUnknown = true;
              if (error?.code === 'page_feedback_pending' && !submissionDispatched
                  && !pageHandledBeforeInput) {
                submissionBlockedBeforeDispatch = true;
                submissionBlockReason = 'page_feedback_pending';
                nativeDraftBinding = _rememberNativeChatDraft(msg.params, el, originalRecipient);
              }
            }
          }
          if (!verified) {
            return failure(
              'The field value did not exactly match the requested text after the page settled. Repeat the original replacement text and target for readback-only recovery, or restore the editor before another write.',
              {
                method: 'set_field',
                ref_id,
                rect,
                verified: false,
                actual: actual.slice(0, 200),
                fieldMeta,
                fallbackAttempted,
                _expectedValue: (clear ? '' : prevValue) + text,
                recoveryRequired: 'verify_or_restore_field',
                failureScope: `field-value:${ref_id}`,
                retryable: false,
              },
            );
          }
          return {
            success: true,
            dispatched,
            method: 'set_field',
            ...(pageHandledBeforeInput ? { dispatched: true, pageHandledBeforeInput: true, nativeBeforeInputCancelled: true } : {}),
            ...(pageHandledPaste ? { pageHandledPaste: true } : {}),
            ref_id,
            rect,
            verified: true,
            fieldMeta,
            fallbackAttempted,
            submitted: nativeSubmitAttempted || undefined,
            outcomeUnknown: submissionOutcomeUnknown || undefined,
            ...(submit ? { submissionDispatched, submissionBlockedBeforeDispatch } : {}),
            ...(submissionBlockReason ? { submissionBlockReason } : {}),
            ...(nativeDraftBinding ? { _nativeChatDraftBinding: nativeDraftBinding } : {}),
          };
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          return failure(e && e.message || String(e));
        }
      },
      // Internal Chrome recovery helpers. The background resolves the exact
      // ref again, prepares either replacement or append selection, sends
      // trusted CDP text, then asks this content script for settled readback.
      'ax_paste_draft': async () => {
        const { ref_id, text, clear = true } = msg.params || {};
        const el = typeof ref_id === 'string' && window.__wb_ax_lookup?.(ref_id);
        if (!el?.isConnected || !isDraftJsEditor(el) || typeof text !== 'string' || !/[\r\n]/.test(text)) {
          return { success: false, verified: false, dispatched: false, noDispatch: true, retryable: false,
            error: 'The original DraftJS editor or multiline text is unavailable.' };
        }
        return { ...await _insertContentEditableText(el, text, clear, actionDeadlineExpired), ref_id };
      },
      'ax_prepare_field_for_trusted_type': () => {
        try {
          const { ref_id, selectionMode = 'all' } = msg.params || {};
          if (typeof ref_id !== 'string') return { success: false, error: 'ref_id is required' };
          if (typeof window.__wb_ax_lookup !== 'function') return { success: false, error: 'accessibility-tree.js not injected' };
          const el = window.__wb_ax_lookup(ref_id);
          if (!el || !el.isConnected) return { success: false, error: `ref_id ${ref_id} is stale` };
          const typeable = el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
          if (!typeable) return { success: false, error: `ref_id ${ref_id} is not a text field` };
          _withTypingPreparation('scroll', el, () => { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {} });
          _withTypingPreparation('focus', el, () => { try { el.focus({ preventScroll: true }); } catch {} });
          window.__wbPageMonitor?.beforeLocalDispatch({ preparation: true, kind: 'focus', target: el });
          if (el.isContentEditable) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            if (selectionMode === 'end') range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
          } else if (typeof el.select === 'function') {
            el.select();
          } else if (typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(0, String(el.value || '').length);
          }
          const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
          const isCombobox = role === 'combobox'
            || !!(el.getAttribute && el.getAttribute('aria-autocomplete'))
            || (el.getAttribute && el.getAttribute('aria-expanded') === 'true');
          const rect = el.getBoundingClientRect();
          return {
            success: true,
            ref_id,
            fieldMeta: _fieldMeta(el),
            isCombobox,
            contentEditable: !!el.isContentEditable,
            ...(isDraftJsEditor(el) ? { editorKind: 'draftjs' } : {}),
            selectionMode: el.isContentEditable && selectionMode === 'end' ? 'end' : 'all',
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
        } catch (error) {
          if (error?.code === 'page_feedback_pending') throw error;
          return { success: false, error: error && error.message || String(error) };
        }
      },
      // Private native-clear receipts do not authorize another input command.
      'ax_prepare_native_chat_clear': () => _prepareNativeChatClear(msg.params?.ref_id),
      'ax_verify_native_chat_clear': () => _verifyNativeChatClear(msg.params?.ref_id, msg.params?.token),
      'ax_release_native_chat_clear': () => { _releaseNativeChatClear(msg.params?.token); return { success: true }; },
      'ax_verify_field_value': () => {
        try {
          const { ref_id, expected, appendText } = msg.params || {};
          if (typeof ref_id !== 'string' || typeof expected !== 'string') {
            return { success: false, verified: false, error: 'ref_id and expected are required' };
          }
          if (typeof window.__wb_ax_lookup !== 'function') return { success: false, verified: false, error: 'accessibility-tree.js not injected' };
          const el = window.__wb_ax_lookup(ref_id);
          if (!el || !el.isConnected) return { success: false, verified: false, error: `ref_id ${ref_id} is stale` };
          if (isDraftJsEditor(el) && readDraftJsText(el) === null)
            return { success: false, verified: false, error: 'The DraftJS editor structure cannot establish its exact document text.' };
          const actual = el.isContentEditable ? _editableTextValue(el) : (el.value || '');
          const verifiesAppend = el.isContentEditable && typeof appendText === 'string';
          const expectedPrefix = verifiesAppend
            ? expected.slice(0, expected.length - appendText.length)
            : '';
          return {
            success: true,
            verified: verifiesAppend && !expected.endsWith(appendText)
              ? false
              : _setFieldValueMatches(
                  actual,
                  expectedPrefix,
                  verifiesAppend ? appendText : expected,
                  !verifiesAppend,
                  el.isContentEditable, (readProseMirrorText(el) !== null || readDraftJsText(el) !== null || readEmptyCaretText(el) !== null),
                ),
            actual: actual.slice(0, 200),
            fieldMeta: _fieldMeta(el),
          };
        } catch (error) {
          if (error?.code === 'page_feedback_pending') throw error;
          return { success: false, verified: false, error: error && error.message || String(error) };
        }
      },
      'field_value_digest': async () => {
        try {
          const { ref_id, selector, expected, focused } = msg.params || {};
          let el = null;
          if (typeof ref_id === 'string' && ref_id) {
            if (typeof window.__wb_ax_lookup !== 'function') {
              return { success: false, error: 'accessibility-tree.js not injected' };
            }
            el = window.__wb_ax_lookup(ref_id);
          } else if (typeof selector === 'string' && selector.trim()) {
            const queryDeep = (root) => {
              const match = root.querySelector(selector.trim());
              if (match) return match;
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let node = walker.currentNode;
              while (node) {
                if (node.shadowRoot) {
                  const nested = queryDeep(node.shadowRoot);
                  if (nested) return nested;
                }
                node = walker.nextNode();
              }
              return null;
            };
            el = queryDeep(document);
          } else if (focused === true) {
            // Focused-field proof path for selectorless type_text({text}).
            // Digests the deep active element so a verified focused write can
            // bind to live field metadata. Failures still carry the live
            // documentToken/refScopeUrl via the dispatcher scope wrap, so the
            // agent's live-scope check can use this as a document oracle.
            try {
              let active = document.activeElement;
              while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
              el = active && active !== document.body && active !== document.documentElement ? active : null;
            } catch { el = null; }
            if (!el || !el.isConnected) return { success: false, error: 'no focused editable element' };
          } else {
            return { success: false, error: 'ref_id or selector is required' };
          }
          if (!el || !el.isConnected) return { success: false, error: 'field is stale or unavailable' };
          const tag = String(el.tagName || '').toUpperCase();
          if (!(el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA')) {
            return { success: false, error: 'target is not a text field' };
          }
          if (isDraftJsEditor(el) && readDraftJsText(el) === null)
            return { success: false, verified: false, error: 'The DraftJS editor structure cannot establish its exact document text.' };
          const value = String(el.isContentEditable ? _editableTextValue(el) : (el.value || ''));
          if (!globalThis.crypto?.subtle) return { success: false, error: 'SHA-256 is unavailable' };
          const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
          const valueSha256 = [...new Uint8Array(digest)]
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');
          return {
            success: true,
            ...(typeof expected === 'string' ? {
              verified: _setFieldValueMatches(value, '', expected, true, el.isContentEditable, (readProseMirrorText(el) !== null || readDraftJsText(el) !== null || readEmptyCaretText(el) !== null)),
            } : {}),
            valueLength: value.length,
            valueSha256,
            fieldMeta: _fieldMeta(el),
            stableSelector: _stableFieldSelector(el),
          };
        } catch (error) {
          if (error?.code === 'page_feedback_pending') throw error;
          return { success: false, error: error && error.message || String(error) };
        }
      },
      'resolve_visual_target': () => {
        try {
          const x = Number(msg.params?.x);
          const y = Number(msg.params?.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { success: false, error: 'x and y must be finite numbers' };
          }
          if (typeof window.__wb_ax_resolve_visual_target !== 'function') {
            return { success: false, error: 'accessibility-tree.js not injected' };
          }
          const semanticTarget = window.__wb_ax_resolve_visual_target(x, y);
          return semanticTarget
            ? {
                success: true,
                semanticTarget,
                documentToken: _axDocumentToken(),
                refScopeUrl: location.href,
              }
            : { success: true };
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          return { success: false, error: e?.message || String(e) };
        }
      },
      // ── ref_id → on-screen rect resolver ─────────────────────────────────
      // Helper for the CDP-backed pointer tools (hover, right_click,
      // drag_drop). The agent calls this from background.js to get viewport
      // coords for a ref_id, then dispatches trusted Input events via CDP at
      // those coords. We do scrollIntoView here so the element is reachable
      // when CDP fires the pointer event ~milliseconds later. Returns the
      // same rect shape click_ax / type_ax already return; suggestions on
      // miss are identical so error messages stay consistent.
      'ax_resolve_rect': () => {
        try {
          const { ref_id, forClickFallback = false } = msg.params || {};
          const observeOnly = msg.params?.observeOnly === true && forClickFallback === true;
          if (typeof ref_id !== 'string') return { success: false, error: 'ref_id (string, e.g. "ref_42") is required' };
          if (typeof window.__wb_ax_lookup !== 'function') return { success: false, error: 'accessibility-tree.js not injected' };
          const el = window.__wb_ax_lookup(ref_id);
          if (!el) {
            let suggestions = [];
            try { if (typeof window.__wb_ax_suggest === 'function') suggestions = window.__wb_ax_suggest(ref_id, 6); } catch {}
            const refStr = String(ref_id);
            const looksLikeDomId = !/^ref_\d+$/.test(refStr);
            const formatNote = looksLikeDomId
              ? ` "${refStr}" is not a valid ref_id. Valid ref_ids have the form ref_N (e.g. ref_42) and appear in square brackets in get_accessibility_tree output — do not use DOM ids, CSS selectors, or placeholder words from the prompt.`
              : '';
            const hint = suggestions.length
              ? ' Nearest existing refs: ' + suggestions.map(s => `${s.ref} (${s.role}${s.name ? ' "' + s.name + '"' : ''})`).join(', ') + '.'
              : '';
            return { success: false, error: `ref_id ${ref_id} not found.${formatNote} The element may have been removed or the page replaced.${hint} Re-read the accessibility tree to get fresh ids.`, suggestions };
          }
          if (!observeOnly) {
            try { _scrollElementIntoClearView(el); } catch (error) { if (error?.code === 'page_feedback_pending') throw error; }
            showAgentWorkingTarget(el, 'ax_resolve_rect');
          }
          let r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const vw = window.innerWidth, vh = window.innerHeight;
          const inViewport = r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx <= vw && cy <= vh;
          const fallbackStatic = _axFallbackStaticAssessment(el);
          const {
            tag,
            role,
            name,
            isEditable,
            isNativeControl,
            isButtonLike,
            isSubmitControl,
            isDownloadControl,
            hasStatefulSemantics,
          } = fallbackStatic;
          let topmost = null;
          let effectiveCx = cx;
          let effectiveCy = cy;
          if (forClickFallback && inViewport) {
            try { topmost = document.elementFromPoint(cx, cy); } catch {}
          }
          let hitOk = !forClickFallback || (!!topmost && (
            topmost === el
            || el.contains?.(topmost)
          ));
          if (forClickFallback && inViewport && !hitOk) {
            const sampleOffsets = [
              [cx, r.top + Math.max(2, Math.min(8, r.height * 0.2))],
              [cx, r.bottom - Math.max(2, Math.min(8, r.height * 0.2))],
              [r.left + Math.max(2, Math.min(8, r.width * 0.2)), cy],
              [r.right - Math.max(2, Math.min(8, r.width * 0.2)), cy],
            ];
            for (const [sx, sy] of sampleOffsets) {
              if (sx < 0 || sy < 0 || sx > vw || sy > vh) continue;
              let sampleHit = null;
              try { sampleHit = document.elementFromPoint(sx, sy); } catch {}
              if (sampleHit && (sampleHit === el || el.contains?.(sampleHit))) {
                topmost = sampleHit;
                effectiveCx = sx;
                effectiveCy = sy;
                hitOk = true;
                break;
              }
            }
            if (!observeOnly && !hitOk && topmost) {
              try {
                const floatingBar = _floatingTopBarRect(topmost);
                const bRect = floatingBar || topmost.getBoundingClientRect();
                if (!_isAlreadyVisibleInFixedSurface(el)
                  && (floatingBar || bRect.top <= _getViewportDockedInsets(window, el).top + 10)
                  && bRect.bottom > r.top && bRect.bottom < vh * 0.45) {
                  window.scrollBy({ top: r.top - bRect.bottom - 20, behavior: 'instant' });
                  r = el.getBoundingClientRect();
                  effectiveCx = r.left + r.width / 2;
                  effectiveCy = r.top + r.height / 2;
                  topmost = document.elementFromPoint(effectiveCx, effectiveCy);
                  if (topmost && (topmost === el || el.contains?.(topmost))) {
                    hitOk = true;
                  }
                }
              } catch {}
            }
          }
          const interactiveHitDescendant = forClickFallback
            ? _axInteractiveHitDescendant(el, topmost)
            : null;
          const visibility = forClickFallback
            ? _axFallbackVisibility(el)
            : { visible: true, reason: '' };
          let fallbackBlockedReason = '';
          if (!visibility.visible) fallbackBlockedReason = visibility.reason;
          else if (!inViewport) fallbackBlockedReason = 'target is outside the viewport or has a zero-sized box';
          else if (!hitOk) fallbackBlockedReason = 'target center is covered by another element';
          else if (interactiveHitDescendant) fallbackBlockedReason = 'target center resolves to an interactive descendant that must not receive an automatic trusted click';
          else if (fallbackStatic.blockedReason) fallbackBlockedReason = fallbackStatic.blockedReason;
          if (forClickFallback && !window.__wbAxDocumentToken) {
            if (observeOnly) return { success: false, error: 'The observed target document is unavailable. Re-observe the page.' };
            window.__wbAxDocumentToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          }
          const fallbackState = forClickFallback ? _axFallbackState(el) : null;
          return {
            success: true,
            ref_id,
            tag,
            role,
            // hover echoes this name, and a model reads it before a repeat
            // click (see _axModelName).
            name: _axModelName(el, name),
            x: Math.round(effectiveCx),
            y: Math.round(effectiveCy),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            inViewport,
            ...(forClickFallback ? {
              documentToken: window.__wbAxDocumentToken,
              hitOk,
              topmostTag: topmost?.tagName ? topmost.tagName.toLowerCase() : '',
              interactiveDescendantTag: interactiveHitDescendant?.tagName
                ? interactiveHitDescendant.tagName.toLowerCase()
                : undefined,
              interactiveDescendantRole: interactiveHitDescendant?.getAttribute?.('role') || undefined,
              fallbackEligible: !fallbackBlockedReason,
              fallbackBlockedReason: fallbackBlockedReason || undefined,
              // fallbackState remains a strong-only compatibility alias.
              fallbackState: fallbackState.strong,
              fallbackStrongState: fallbackState.strong,
              fallbackWeakState: fallbackState.weak,
              ...(observeOnly ? { refScopeUrl: location.href,
                fallbackNativeButtonDisabled: tag === 'button'
                  ? !!el.disabled || el.getAttribute('aria-disabled') === 'true' : null } : {}),
              isComputedVisible: visibility.visible,
              isEditable,
              isNativeControl,
              isButtonLike,
              isSubmitControl,
              isDownloadControl,
              hasStatefulSemantics,
            } : {}),
          };
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          return { success: false, error: e && e.message || String(e) };
        }
      },
      // Resolve TWO ref_ids in a single round-trip and measure both
      // rects in the SAME post-scroll viewport snapshot. drag_drop needs
      // this because the previous "resolve-source, then resolve-dest,
      // then re-resolve-source" dance scrolled the viewport back to
      // source after dest was measured — invalidating the dest coords.
      // Doing both scrolls then both measurements here means both
      // x/y pairs are in the same coordinate frame the CDP drag will
      // dispatch into.
      'ax_resolve_two_rects': () => {
        try {
          const { fromRefId, toRefId } = msg.params || {};
          if (typeof fromRefId !== 'string' || typeof toRefId !== 'string') {
            return { success: false, error: 'fromRefId and toRefId (both strings, e.g. "ref_42") are required' };
          }
          if (typeof window.__wb_ax_lookup !== 'function') {
            return { success: false, error: 'accessibility-tree.js not injected' };
          }
          const fromEl = window.__wb_ax_lookup(fromRefId);
          const toEl = window.__wb_ax_lookup(toRefId);
          if (!fromEl) return { success: false, error: `fromRefId ${fromRefId} not found` };
          if (!toEl) return { success: false, error: `toRefId ${toRefId} not found` };

          // Scroll source first, then destination. After both scrolls the
          // viewport is settled at the dest-centered position; measuring
          // BOTH rects against that frame is what drag_drop wants.
          // Source may end up partly off-screen if the two are far
          // apart vertically — flagged via inViewport on the return.
          window.__wbPageMonitor?.beforeLocalDispatch({ kind: 'scroll', target: fromEl });
          try { fromEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          window.__wbPageMonitor?.beforeLocalDispatch({ kind: 'scroll', target: toEl });
          try { toEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          showAgentWorkingTarget(toEl, 'ax_resolve_two_rects');

          const fr = fromEl.getBoundingClientRect();
          const tr = toEl.getBoundingClientRect();
          const vw = window.innerWidth, vh = window.innerHeight;

          const measure = (el, r, refId) => {
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const inViewport = r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx <= vw && cy <= vh;
            let name = '';
            try {
              name = _axModelName(el, (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')))
                || (el.innerText && el.innerText.trim().slice(0, 80))
                || '');
            } catch {}
            return {
              ref_id: refId,
              tag: el.tagName ? el.tagName.toLowerCase() : '',
              name,
              x: Math.round(cx),
              y: Math.round(cy),
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              inViewport,
            };
          };
          return {
            success: true,
            from: measure(fromEl, fr, fromRefId),
            to: measure(toEl, tr, toRefId),
          };
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          return { success: false, error: e && e.message || String(e) };
        }
      },
      // ── wait_for_stable ──────────────────────────────────────────────────
      // Resolve when N consecutive milliseconds pass with no DOM mutations
      // AND no in-flight fetch/XHR. wait_for_element answers "did X appear";
      // this answers "is the page done shuffling". Common use: right after
      // navigate / set_field({submit:true}) before reading the tree, so the
      // model doesn't grab a half-rendered DOM. Network idle is best-effort
      // — we wrap fetch + XMLHttpRequest in window once per page; we don't
      // see WebSocket frames or chunked SSE. That's fine: the MutationObserver
      // is the load-bearing signal, network-idle is a tightener.
      // CROSS-WORLD NOTE: page JavaScript runs in the MAIN world; this
      // content script runs in an ISOLATED world that has its own copies
      // of `window.fetch` and `XMLHttpRequest.prototype.send`. Patching
      // those copies here (the previous implementation) observed nothing
      // — the page calls the MAIN-world fetch we can't reach directly.
      // To get real network visibility we inject a <script> element with
      // text patches that run in the page's own world. The injected
      // counter publishes its value to
      // `document.documentElement.dataset.__wbInflight`, which crosses
      // the world boundary via the shared DOM. We read it from here.
      //
      // STRICT-CSP FALLBACK: pages with `script-src 'self'` (no inline)
      // refuse the injected <script>. We detect the failure (the dataset
      // attribute never gets set) and degrade gracefully: the response
      // includes `networkObserved: false`, the netIdle gate is bypassed,
      // and stability is decided on MutationObserver alone. Honest
      // failure beats a fake "idle" signal.
      'wait_for_stable': () => {
        return new Promise((resolve) => {
          const params = msg.params || {};
          const timeout = Math.max(200, Math.min(20000, Number(params.timeout) || 5000));
          const quietMs = Math.max(100, Math.min(3000, Number(params.quietMs) || 500));
          const checkNetwork = params.checkNetwork !== false; // default on
          let mutationCount = 0;
          let networkObserved = false;

          // Install the MAIN-world counter once per page (per isolated-
          // world realm — re-injection is a no-op).
          if (checkNetwork && !window.__wbNetCounterAttempted) {
            window.__wbNetCounterAttempted = true;
            try {
              const script = document.createElement('script');
              script.textContent = `(() => {
                if (window.__wbNetIdleInstalled) return;
                window.__wbNetIdleInstalled = true;
                let inFlight = 0;
                const root = document.documentElement;
                const publish = () => {
                  try { root.dataset.__wbInflight = String(inFlight); } catch (_) {}
                };
                publish();
                const origFetch = window.fetch;
                if (typeof origFetch === 'function') {
                  window.fetch = function() {
                    inFlight++; publish();
                    return origFetch.apply(this, arguments).finally(() => {
                      inFlight = Math.max(0, inFlight - 1); publish();
                    });
                  };
                }
                const XHR = window.XMLHttpRequest;
                if (XHR && XHR.prototype && XHR.prototype.send) {
                  const origSend = XHR.prototype.send;
                  XHR.prototype.send = function() {
                    inFlight++; publish();
                    const done = () => { inFlight = Math.max(0, inFlight - 1); publish(); };
                    this.addEventListener('loadend', done, { once: true });
                    return origSend.apply(this, arguments);
                  };
                }
              })();`;
              (document.head || document.documentElement).appendChild(script);
              script.remove();
            } catch { /* CSP or DOM unavailability — networkObserved stays false */ }
          }

          // Read the MAIN-world counter via the shared DOM attribute.
          // Returns null when the inject failed (CSP) or hasn't run yet.
          const readInflight = () => {
            try {
              const v = document.documentElement.dataset.__wbInflight;
              if (v == null) return null;
              const n = parseInt(v, 10);
              return Number.isFinite(n) ? n : null;
            } catch { return null; }
          };
          if (checkNetwork) {
            networkObserved = readInflight() !== null;
          }

          const startedAt = Date.now();
          let quietStart = Date.now();
          const observer = new MutationObserver((records) => {
            mutationCount += records.length;
            quietStart = Date.now();
          });
          try {
            observer.observe(document.documentElement || document.body, {
              childList: true, subtree: true, attributes: true, characterData: true,
            });
          } catch {
            resolve({ success: true, stable: true, elapsedMs: 0, reason: 'observer-failed' });
            return;
          }

          const interval = setInterval(() => {
            const now = Date.now();
            const quiet = now - quietStart;
            const elapsed = now - startedAt;
            // Re-check observation status each tick — the injected
            // script may have started reporting after a delay on a
            // slow-parsing page.
            if (checkNetwork && !networkObserved) {
              networkObserved = readInflight() !== null;
            }
            const inFlight = networkObserved ? (readInflight() | 0) : 0;
            const netIdle = !checkNetwork || !networkObserved || inFlight === 0;
            if (quiet >= quietMs && netIdle) {
              clearInterval(interval);
              observer.disconnect();
              resolve({
                success: true,
                stable: true,
                elapsedMs: elapsed,
                quietMs: quiet,
                mutations: mutationCount,
                inFlightAtExit: networkObserved ? inFlight : null,
                networkObserved,
              });
            } else if (elapsed >= timeout) {
              clearInterval(interval);
              observer.disconnect();
              resolve({
                success: true,
                stable: false,
                timedOut: true,
                elapsedMs: elapsed,
                mutations: mutationCount,
                inFlightAtExit: networkObserved ? inFlight : null,
                networkObserved,
                hint: networkObserved
                  ? 'Page never went quiet within the timeout. The page may be polling, animating, or streaming — proceed and read the tree anyway, or pass a longer timeout.'
                  : 'Network activity could not be observed on this page (the in-page <script> inject was blocked, likely by a strict Content Security Policy). Stability was judged on DOM mutations alone, and that never settled. Proceed cautiously.',
              });
            }
          }, 100);
        });
      },
    };

    const handler = handlers[msg.action];
    if (!handler) {
      sendResponse({ error: `Unknown action: ${msg.action}` });
      return;
    }

    // Readback probes double as live document-identity oracles: the agent
    // uses their token to tell a same-document route change (keep text
    // guards) from a full navigation no AX scope ever observed (drop stale
    // debt). Attach on every return path, including failures.
    const withLiveDocumentScope = (value) => {
      finishPageAction();
      if ((msg.action === 'field_value_digest' || msg.action === 'ax_verify_field_value')
          && value && typeof value === 'object') {
        try {
          if (!value.documentToken) value.documentToken = _axDocumentToken();
          if (!value.refScopeUrl) value.refScopeUrl = location.href;
        } catch { /* identity is best-effort; never break the response */ }
      }
      // Overlay and article-block texts the page-gate check consulted unread
      // go back to the agent to be read; it asks again with the readings.
      if (['get_page_info', 'get_page_info_cdp', 'get_accessibility_tree'].includes(msg.action)
          && value && typeof value === 'object') {
        const unread = _takeUnreadPageTexts('page_blocker');
        if (unread.length) {
          value.pageTextsNeeded = [...(Array.isArray(value.pageTextsNeeded) ? value.pageTextsNeeded : []), ...unread];
        }
      }
      return value;
    };

    let result;
    let finishPageAction = () => {};
    try {
      finishPageAction = window.__wbPageMonitor?.beginContentAction(msg.action, msg.params || {}) || finishPageAction;
      result = handler();
    } catch (err) {
      // A synchronous throw used to escape the listener without calling
      // sendResponse, so the caller saw an undefined response and reported
      // "<tool> returned no result." with no diagnosis. Always answer.
      sendResponse(withLiveDocumentScope({
        success: false,
        ...(err?.code === 'page_feedback_pending' ? { dispatched: err.dispatched === true, noDispatch: err.dispatched !== true, pageFeedbackPending: true, outcomeUnknown: err.dispatched === true, ...(err.pagePreparationVeto ? { preparationVeto: err.pagePreparationVeto } : {}) } : {}),
        error: `${msg.action} failed: ${err?.message || String(err)}`,
      }));
      return;
    }
    if (result instanceof Promise) {
      // Always settle sendResponse — a rejecting handler (e.g. a throwing
      // DOM API) must not leave the caller's await hanging forever.
      result.then(
        (value) => sendResponse(withLiveDocumentScope(value)),
        (err) => sendResponse(withLiveDocumentScope({
          success: false,
          ...(err?.code === 'page_feedback_pending' ? { dispatched: err.dispatched === true, noDispatch: err.dispatched !== true, pageFeedbackPending: true, outcomeUnknown: err.dispatched === true, ...(err.pagePreparationVeto ? { preparationVeto: err.pagePreparationVeto } : {}) } : {}),
          error: `${msg.action} failed: ${err?.message || String(err)}`,
        })),
      );
      return true; // async
    }
    if (result === undefined || result === null) {
      // A handler that answers with nothing is a bug, not an empty result:
      // surface it so the caller can distinguish a real failure from a
      // silently closed response channel.
      sendResponse(withLiveDocumentScope({
        success: false,
        noResult: true,
        error: `${msg.action} returned no result (handler produced no payload).`,
      }));
      return;
    }
    sendResponse(withLiveDocumentScope(result));
  });

  // ─── Tab attention flash ────────────────────────────────────────────
  // When a run finishes or a plan needs review on a tab the user has left,
  // the background asks this page to blink its title and favicon so the tab
  // can be found at a glance. With many tabs open the strip only shows the
  // favicon, so the favicon itself alternates between the site's own icons
  // and an alert icon — swapping the site's <link> hrefs outright,
  // because an appended icon link loses to favicons the page injects later.
  // Completion blinking stops when the tab becomes visible. Plans and
  // clarifications remain marked until resolved. Every flash also stops
  // after ATTENTION_FLASH_TIMEOUT_MS or on an explicit stop message.
  //
  // Declared at the end of this closure (function declarations hoist, so the
  // message handlers above can call them) — code above this point is sliced
  // and evaluated standalone by tests.
  // Blink persists for minutes rather than seconds so background alerts are
  // not missed. Completion clears when shown; pending input clears when its
  // owner resolves it, with this timeout as a final cleanup fallback.
  const ATTENTION_FLASH_INTERVAL_MS = 700;
  const ATTENTION_FLASH_TIMEOUT_MS = 300000;
  const ATTENTION_FLASH_MARKER = '\u{1F514} ';
  const ATTENTION_FLASH_INPUT_MARKER = '\u26A0\uFE0F ';
  let attentionFlashMarker = ATTENTION_FLASH_MARKER;
  let attentionFlashId = null;
  let attentionFlashTimer = null;
  let attentionFlashTimeout = null;
  let attentionFlashOnVisible = null;
  // Exact title string this flash last wrote — ownership marker. Stripping
  // by prefix alone would eat a page's own title that legitimately starts
  // with the same alert character.
  let attentionFlashOwnTitle = null;
  // Favicon blink state. Every icon <link> present when the flash started is
  // remembered with its original href; the alert data URL replaces it each
  // marked tick and originals are handed back during quiet ticks — unless
  // the page swapped in its own new icon meanwhile, which then becomes the
  // baseline we hand back at stop instead.
  let attentionFlashAlertUrl = null;
  let attentionFlashIconLinks = null;
  let attentionFlashFallbackEl = null;

  function attentionFlashBuildAlertIcon() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = '52px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(attentionFlashMarker.trim(), 32, 36);
      }
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  function attentionFlashStripMarker(title) {
    const text = String(title ?? '');
    return text.startsWith(attentionFlashMarker)
      ? text.slice(attentionFlashMarker.length)
      : text;
  }

  function attentionFlashCaptureIcons() {
    try {
      attentionFlashIconLinks = [];
      // Substring match on purpose: GitHub declares "alternate icon",
      // others use "shortcut icon"/"apple-touch-icon" — exact-value
      // selectors miss real-world rel spellings.
      for (const el of document.querySelectorAll('link[rel*="icon" i]')) {
        attentionFlashIconLinks.push({ el, href: el.getAttribute('href') });
      }
      // Pages declaring no icon link get a temporary one instead — browsers
      // prefer the last-declared favicon, so dropping it at stop restores
      // the original without touching site elements.
      if (!attentionFlashIconLinks.length && !attentionFlashFallbackEl) {
        attentionFlashFallbackEl = document.createElement('link');
        attentionFlashFallbackEl.setAttribute('rel', 'icon');
        attentionFlashFallbackEl.setAttribute('data-webbrain-attention', '1');
        (document.head || document.documentElement).appendChild(attentionFlashFallbackEl);
      }
    } catch {
      attentionFlashIconLinks = [];
      attentionFlashFallbackEl = null;
    }
  }

  function attentionFlashToggleFavicon(show) {
    if (!attentionFlashAlertUrl) return;
    try {
      // Dynamic sites (e.g. GitHub's pjax) replace their favicon <link>
      // nodes outright; re-anchor before writing so we never blink at
      // detached elements.
      if (attentionFlashIconLinks?.some(entry => !entry.el.isConnected)) {
        attentionFlashCaptureIcons();
      }
      for (const entry of attentionFlashIconLinks || []) {
        if (show) {
          // Overwrite unconditionally during the marked phase: sites like
          // GitHub rewrite these hrefs themselves, so a strict ownership
          // guard would silently stop blinking forever.
          entry.el.setAttribute('href', attentionFlashAlertUrl);
        } else {
          const current = entry.el.getAttribute('href');
          if (current === attentionFlashAlertUrl) {
            if (entry.href == null) entry.el.removeAttribute('href');
            else entry.el.setAttribute('href', entry.href);
          } else {
            // The page swapped in its own new icon mid-flash — adopt it as
            // the baseline we will eventually hand back.
            entry.href = current;
          }
        }
      }
      if (attentionFlashFallbackEl) {
        if (show) attentionFlashFallbackEl.setAttribute('href', attentionFlashAlertUrl);
        else attentionFlashFallbackEl.removeAttribute('href');
      }
    } catch { /* favicon swap is best-effort */ }
  }

  function stopAttentionFlash(params = {}) {
    // A delayed cancellation belongs only to the alert that requested it.
    // Internal stops omit the ID and always clear the current flash.
    if (params?.attentionId != null && String(params.attentionId) !== attentionFlashId) return;
    attentionFlashId = null;
    if (attentionFlashTimer) {
      clearInterval(attentionFlashTimer);
      attentionFlashTimer = null;
    }
    if (attentionFlashTimeout) {
      clearTimeout(attentionFlashTimeout);
      attentionFlashTimeout = null;
    }
    if (attentionFlashOnVisible) {
      document.removeEventListener('visibilitychange', attentionFlashOnVisible);
      attentionFlashOnVisible = null;
    }
    // Only undo our own write. If the page replaced the title since we last
    // touched it, leave its value completely untouched.
    if (attentionFlashOwnTitle != null && document.title === attentionFlashOwnTitle) {
      document.title = attentionFlashStripMarker(document.title);
    }
    attentionFlashOwnTitle = null;
    // Restore favicon links still holding exactly what we wrote; anything
    // the page rewrote itself is left untouched.
    if (attentionFlashIconLinks && attentionFlashAlertUrl) {
      for (const entry of attentionFlashIconLinks) {
        try {
          if (entry.el.getAttribute('href') === attentionFlashAlertUrl) {
            if (entry.href == null) entry.el.removeAttribute('href');
            else entry.el.setAttribute('href', entry.href);
          }
        } catch { /* best-effort */ }
      }
    }
    attentionFlashIconLinks = null;
    if (attentionFlashFallbackEl) {
      attentionFlashFallbackEl.remove();
      attentionFlashFallbackEl = null;
    }
    attentionFlashAlertUrl = null;
  }

  function startAttentionFlash(params = {}) {
    if (typeof document === 'undefined') return false;
    stopAttentionFlash();
    // Restore the previous flash with its own marker before changing reason.
    const pendingInput = params?.reason === 'plan_review' || params?.reason === 'clarify';
    attentionFlashMarker = pendingInput ? ATTENTION_FLASH_INPUT_MARKER : ATTENTION_FLASH_MARKER;
    // Input requests must identify their tab even while visible, including
    // the selected tab in another window. Their owner clears the exact alert
    // when answered; merely looking at the page does not resolve the request.
    if (!pendingInput && document.visibilityState === 'visible') return false;
    attentionFlashId = params?.attentionId == null ? null : String(params.attentionId);
    if (!pendingInput) {
      attentionFlashOnVisible = () => {
        if (document.visibilityState === 'visible') stopAttentionFlash();
      };
      document.addEventListener('visibilitychange', attentionFlashOnVisible);
    }
    attentionFlashAlertUrl = attentionFlashBuildAlertIcon();
    if (attentionFlashAlertUrl) attentionFlashCaptureIcons();
    // Chrome throttles hidden-tab timers hard (once per minute after ~5
    // minutes) and Memory Saver may freeze the tab outright, so the phase
    // is derived from wall-clock time instead of a boolean flip: however
    // sparse or late the wake-ups land, each one shows the correct side of
    // the blink and the alert is on immediately at start.
    const attentionFlashEpoch = Date.now();
    const applyAttentionTick = () => {
      const flashing = Math.floor((Date.now() - attentionFlashEpoch) / ATTENTION_FLASH_INTERVAL_MS) % 2 === 0;
      // Derive each toggle from the live title so changes the site makes
      // while backgrounded survive the flash. A previous marker is only
      // stripped when the current title is still exactly what we wrote.
      const base = document.title === attentionFlashOwnTitle
        ? attentionFlashStripMarker(document.title)
        : String(document.title ?? '');
      // Only the marked phase is extension-owned — during the quiet phase
      // the title belongs to the page even though we just wrote it, so it
      // must never be stripped on stop.
      attentionFlashOwnTitle = flashing ? `${attentionFlashMarker}${base}` : null;
      document.title = flashing ? attentionFlashOwnTitle : base;
      // The favicon blinks with the title: the alert icon replaces the
      // site's own icons during the marked phase and they return during the
      // quiet one — with many tabs open the favicon is all that shows.
      attentionFlashToggleFavicon(flashing);
    };
    applyAttentionTick();
    attentionFlashTimer = setInterval(applyAttentionTick, ATTENTION_FLASH_INTERVAL_MS);
    attentionFlashTimeout = setTimeout(stopAttentionFlash, ATTENTION_FLASH_TIMEOUT_MS);
    return true;
  }
})();
