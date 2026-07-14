/**
 * WebBrain Content Script
 * Injected into every page — handles page reading and DOM actions.
 */

(() => {
  // Prevent double-injection
  if (window.__webbrain_injected) return;
  window.__webbrain_injected = true;

  const RECORDING_DOUBLE_ESCAPE_MS = 1400;
  let recordingEscapeAt = 0;
  let recordingActive = false;

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
      return !!src;
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
    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      text: getPageText(),
      media: getPageMediaSummary(),
      activeElement: getActiveEditableSummary(),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: a.innerText.trim().slice(0, 100),
        href: a.href,
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
  // "interactive element" on a page. `getInteractiveElements`,
  // `clickElement({index})` and `typeText({index})` MUST all go through
  // `queryInteractive()` so that index N means the same element in all
  // three code paths. Historically they used three different selector
  // lists, which caused the "missing inputs" / "clicked the wrong thing"
  // bug on complex pages (shadow DOM, overlays, rich editors).
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

  function isVisiblyInteractive(el) {
    if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') return false;
    // aria-hidden / inert subtrees are non-interactive for assistive tech
    // and should be for us too.
    if (el.closest('[aria-hidden="true"], [inert]')) return false;

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
  function _findTopmostModal() {
    // 1. Native <dialog open>
    const dialogs = document.querySelectorAll('dialog[open]');
    if (dialogs.length > 0) return dialogs[dialogs.length - 1]; // last = topmost

    // 2. ARIA modal
    const ariaModals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    for (let i = ariaModals.length - 1; i >= 0; i--) {
      const r = ariaModals[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return ariaModals[i];
    }

    // 3. Visible role="dialog"
    const roleDialogs = document.querySelectorAll('[role="dialog"]');
    for (let i = roleDialogs.length - 1; i >= 0; i--) {
      const r = roleDialogs[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return roleDialogs[i];
    }

    // 4. Common overlay patterns — look for large, high-z-index containers
    // that cover most of the viewport. These often contain forms/modals on
    // sites like Stripe, GitHub, AWS, etc.
    const candidates = document.querySelectorAll(
      '[data-overlay], [data-state="open"][role="dialog"], ' +
      '.modal.show, .modal-overlay, .overlay, [class*="modal"][class*="open"], ' +
      '[class*="overlay"][class*="active"], [class*="DialogOverlay"], ' +
      '[class*="ModalOverlay"]'
    );
    for (let i = candidates.length - 1; i >= 0; i--) {
      const r = candidates[i].getBoundingClientRect();
      if (r.width > 100 && r.height > 100) return candidates[i];
    }

    return null;
  }

  function queryInteractive() {
    const all = document.querySelectorAll(INTERACTIVE_SELECTORS.join(', '));
    const modal = _findTopmostModal();
    const out = [];
    for (const el of all) {
      if (!isVisiblyInteractive(el)) continue;
      // If a modal is open, only include elements that are inside it.
      // This prevents the agent from seeing (and accidentally clicking)
      // elements behind the overlay — the #1 cause of "clicked Export
      // instead of filling the form" on sites like Stripe.
      if (modal && !modal.contains(el)) continue;
      out.push(el);
    }
    return out;
  }

  window.__wb_resolve_click_target_for_submit_probe = function resolveClickTargetForSubmitProbe(params = {}) {
    if (params?.index == null) return null;
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0) return null;
    return queryInteractive()[index] || null;
  };

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
        text: (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim().slice(0, 100),
        id: el.id || '',
        name: el.name || '',
        href: el.href || '',
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
      const text = (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim().slice(0, 80);
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

  let _lastClickIdent = null;

  /**
   * Click an element by selector or coordinates.
   */
  function clickElement(params) {
    let el;
    if (params.selector && /:contains\(|:has-text\(/.test(params.selector)) {
      return {
        success: false,
        error: 'Invalid selector: ":contains()" and ":has-text()" are jQuery/Playwright extensions, not valid CSS. Use click({text: "..."}) instead.',
      };
    }
    if (params.text) {
      const needle = params.text.toLowerCase();
      const explicit = params.textMatch || '';
      // Include inputs/select/textarea so we can match by placeholder, value, or aria-label
      const sels = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), textarea, select, input[type="button"], input[type="submit"], summary, label, [onclick], [data-action]';
      // Modal scoping: if a topmost modal/dialog is open, restrict the search
      // to elements inside it. Without this, click({text: "Create"}) can land
      // on a background button (GitHub's "Create new tag" dialog over the
      // dimmed "Publish release" — both contain the same verb). This mirrors
      // what queryInteractive() already does for index-based clicks.
      const _modalRoot = _findTopmostModal();
      const _scope = _modalRoot || document;
      const all = Array.from(_scope.querySelectorAll(sels));
      const normalized = all.map(e => ({
        e,
        txt: (e.innerText || e.value || e.placeholder || e.ariaLabel || '').trim().toLowerCase(),
      })).filter(x => !!x.txt);

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
        if (mode === 'contains') return normalized.filter(x => x.txt.includes(needle));
        return [];
      }

      const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
      if (explicit && !['exact', 'prefix', 'contains'].includes(explicit)) {
        return { success: false, error: `Invalid textMatch "${explicit}". Use exact, prefix, or contains.` };
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
            inp.scrollIntoView({ block: 'center', inline: 'center' });
            inp.focus();
            el = inp;
            break;
          }
        }
      }

      if (!el && matches.length === 0) {
        // Auto-scroll retry: scroll down up to 3 times to find elements below the fold.
        // Still respect modal scoping — scrollable dialogs exist.
        for (let scrollAttempt = 0; scrollAttempt < 3 && matches.length === 0; scrollAttempt++) {
          window.scrollBy(0, Math.round(window.innerHeight * 0.7));
          const _retryScope = _findTopmostModal() || document;
          const allRetry = Array.from(_retryScope.querySelectorAll(sels));
          const normRetry = allRetry.map(e => ({
            e,
            txt: (e.innerText || e.value || e.placeholder || e.ariaLabel || '').trim().toLowerCase(),
          })).filter(x => !!x.txt);
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
                inp.scrollIntoView({ block: 'center', inline: 'center' });
                inp.focus();
                el = inp;
                break;
              }
            }
            if (el) break;
          }
        }
        if (!el && matches.length === 0) {
          const _noteModal = _modalRoot ? ' (search was scoped to the open modal/dialog; if the target is outside it, dismiss or complete the dialog first)' : '';
          return { success: false, error: `No clickable element found for text "${params.text}" (also tried scrolling down)${_noteModal}` };
        }
      }
      if (!el && matches.length > 1) {
        // Prefer interactive elements over passive children (label, span, etc.)
        const interactiveMatches = matches.filter(m => _isInteractive(m.e));
        if (interactiveMatches.length === 1) {
          matches = interactiveMatches;
        } else {
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
              text: m.txt.slice(0, 80),
              cx, cy,
              rect,
              ancestor,
            };
          });
          const _scopeNote = _modalRoot ? ' (search was scoped to the open modal/dialog)' : '';
          return {
            success: false,
            error: `Ambiguous text match for "${params.text}" (mode=${usedMode}, matches=${matches.length})${_scopeNote}. ${candidates.length} candidates returned with cx/cy (precomputed click center, in CSS pixels) and ancestor context. Pick one and call click({x: candidate.cx, y: candidate.cy}) — no arithmetic needed. Use the ancestor field to disambiguate (e.g. an alertdialog's Cancel vs a form's Cancel sit in different containers). Do NOT retry click({text: "${params.text}"}) — it will fail the same way.`,
            candidates,
          };
        }
      }
      if (!el) {
        let resolved = matches[0].e;
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
          if (target) { target.focus(); resolved = target; }
        }
        el = _resolveInteractiveAncestor(resolved);
      }
    } else if (params.selector) {
      el = safeQuerySelector(params.selector);
    } else if (params.index != null) {
      // Must use the SAME traversal as getInteractiveElements so the
      // index the agent saw is the index we resolve.
      const interactive = queryInteractive();
      el = interactive[params.index];
      if (!el) return _staleIndexError(params.index, interactive);
    } else if (params.x != null && params.y != null) {
      el = document.elementFromPoint(params.x, params.y);
    }

    if (!el) return { success: false, error: 'Element not found' };
    const targetIsSubmitControl = _isSubmitControl(el);

    // ── Auto-select: if click text matches a <select> option, select it ──
    if (params.text) {
      const needle = params.text.trim();
      const lc = needle.toLowerCase();
      const allSels = document.querySelectorAll('select');
      for (const sel of allSels) {
        const opts = Array.from(sel.options);
        const match = opts.find(o => o.text.trim() === needle)
          || opts.find(o => o.text.trim().toLowerCase() === lc)
          || opts.find(o => o.value === needle)
          || opts.find(o => o.value.toLowerCase() === lc);
        if (match && sel.selectedIndex !== match.index) {
          sel.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(sel, match.value);
          else sel.value = match.value;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, method: 'auto-select', selectedText: match.text.trim(), selectedValue: match.value };
        }
      }
    }

    // <select> intercept: clicking opens a native OS dropdown that cannot be
    // controlled programmatically. Return error so the model uses type_text.
    // Do NOT scrollIntoView (hidden selects inside modals scroll to wrong position).
    if (el instanceof HTMLSelectElement) {
      el.focus();
      const options = Array.from(el.options).map(o => o.text.trim());
      return {
        success: false,
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
        nearbySel.focus();
        const options = Array.from(nearbySel.options).map(o => o.text.trim());
        return {
          success: false,
          tag: 'SELECT',
          text: nearbySel.options[nearbySel.selectedIndex]?.text?.trim() || '',
          error: `CANNOT CLICK — a <select> dropdown is near this element (current: "${nearbySel.options[nearbySel.selectedIndex]?.text?.trim() || ''}"). The dropdown is now focused. Use type_text({text: "option name"}) to change the value. Available options: ${options.join(', ')}`,
        };
      }
    }

    // Do NOT scrollIntoView on SELECT elements (hidden selects in modals cause scroll jumps)
    if (el.tagName !== 'SELECT') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        const r = el.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth) {
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          const topmost = document.elementFromPoint(cx, cy);
          if (topmost && topmost !== el && !el.contains(topmost) && !topmost.contains(el)) {
            // Another element is painted on top. Give the model actionable
            // info (what's blocking, where, what to do) instead of silently
            // clicking the wrong thing.
            let blockerInfo = topmost.tagName.toLowerCase();
            const role = topmost.getAttribute && topmost.getAttribute('role');
            if (role) blockerInfo += `[role=${role}]`;
            const txt = (topmost.innerText || topmost.getAttribute?.('aria-label') || '').trim().slice(0, 60);
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
              error: `Click blocked: an overlay is covering the target. Topmost element at (${cx}, ${cy}) is <${blockerInfo}>${blockerContainer}, not your target <${el.tagName.toLowerCase()}>. Dismiss the overlay (press Escape, click its close button, or complete the modal flow) before retrying. If you're sure you want to force the click, use click({x: ${cx}, y: ${cy}}) — that will hit whatever's on top.`,
              occluded: true,
              occludedBy: { tag: topmost.tagName.toLowerCase(), text: txt, cx, cy },
            };
          }
        }
      } catch {}
    }

    const clickedRect = rememberInteractionPoint(el, 'click');
    el.click();

    // Post-click SELECT detection: the click may have activated a <select>
    // via a label, wrapper, or overlapping element. Return error, not success.
    const postActive = document.activeElement;
    if (!targetIsSubmitControl && postActive && postActive !== el && postActive instanceof HTMLSelectElement) {
      postActive.blur();
      postActive.focus(); // close native popup, keep focus
      const postOpts = Array.from(postActive.options).map(o => o.text.trim());
      return {
        success: false,
        tag: 'SELECT',
        text: postActive.options[postActive.selectedIndex]?.text?.trim() || '',
        error: `CANNOT CLICK — a <select> dropdown was activated by this click (current: "${postActive.options[postActive.selectedIndex]?.text?.trim() || ''}"). The dropdown is now focused. Use type_text({text: "option name"}) to change the value. Available options: ${postOpts.join(', ')}`,
      };
    }

    // Stale click detection: warn if the same element is clicked again.
    // Skip for editable targets — re-clicking a text field / contenteditable
    // is legitimate (positions cursor / re-focuses) and "no page change" is
    // the expected outcome there, not a failure signal.
    const isEditableTarget = el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    const ident = `${el.tagName}|${(el.innerText || '').slice(0, 50)}|${location.href}`;
    let warning;
    if (_lastClickIdent === ident && !isEditableTarget) {
      warning = 'Same element clicked again with no page change. Try click({x, y}) with coordinates from a screenshot, or click({index: N}) from get_interactive_elements.';
    }
    _lastClickIdent = ident;
    return {
      success: true,
      tag: el.tagName,
      text: el.innerText?.slice(0, 50),
      ...(clickedRect ? { rect: clickedRect } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  let _lastTypeFieldIdent = null;

  /**
   * Type text into an input/textarea.
   */
  let _deasciifier = null;
  function _loadDeasciifier() {
    if (_deasciifier) return Promise.resolve();
    return fetch(chrome.runtime.getURL('vendor/turkish-deasciifier-patterns.json'))
      .then(r => r.json())
      .then(patterns => { _deasciifier = _buildDeasciifier(patterns); });
  }

  function _buildDeasciifier(patternList) {
    const charAlist = { c:'ç',C:'Ç',g:'ğ',G:'Ğ',i:'ı',I:'İ',o:'ö',O:'Ö',s:'ş',S:'Ş',u:'ü',U:'Ü' };
    const asciifyTbl = {};
    for (const k in charAlist) asciifyTbl[charAlist[k]] = k;
    const downTbl = {}, upTbl = {};
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      downTbl[ch] = ch; downTbl[ch.toUpperCase()] = ch;
      upTbl[ch] = ch; upTbl[ch.toUpperCase()] = ch;
    }
    for (const k in charAlist) {
      downTbl[charAlist[k]] = k.toLowerCase();
      upTbl[charAlist[k]] = k.toUpperCase();
    }
    upTbl['i'] = 'i'; upTbl['I'] = 'I'; upTbl['İ'] = 'i'; upTbl['ı'] = 'I';
    const toggleTbl = {};
    for (const k in charAlist) { toggleTbl[k] = charAlist[k]; toggleTbl[charAlist[k]] = k; }
    const CTX = 10;
    function setCharAt(s, i, c) { return s.substring(0, i) + c + s.substring(i + 1); }
    function getContext(text, pos) {
      let s = ' '.repeat(2 * CTX + 1);
      s = setCharAt(s, CTX, 'X');
      let i = CTX + 1, idx = pos + 1, space = false;
      while (i < s.length && !space && idx < text.length) {
        const x = downTbl[text.charAt(idx)];
        if (!x) { if (space) i++; else space = true; }
        else { s = setCharAt(s, i, x); space = false; }
        i++; idx++;
      }
      s = s.substring(0, i);
      i = CTX - 1; idx = pos - 1; space = false;
      while (i >= 0 && idx >= 0) {
        const x = upTbl[text.charAt(idx)];
        if (!x) { if (space) i--; else space = true; }
        else { s = setCharAt(s, i, x); space = false; }
        i--; idx--;
      }
      return s;
    }
    function matchPattern(text, pos, dlist) {
      let rank = dlist.length * 2;
      const str = getContext(text, pos);
      let start = 0;
      while (start <= CTX) {
        let end = CTX + 1;
        while (end <= str.length) {
          const r = dlist[str.substring(start, end)];
          if (r !== undefined && Math.abs(r) < Math.abs(rank)) rank = r;
          end++;
        }
        start++;
      }
      return rank > 0;
    }
    function needsCorrection(text, pos) {
      const ch = text.charAt(pos);
      const tr = asciifyTbl[ch] || ch;
      const pl = patternList[tr.toLowerCase()];
      const m = pl && matchPattern(text, pos, pl);
      if (tr === 'I') return (ch === tr) ? !m : m;
      return (ch === tr) ? m : !m;
    }
    return {
      deasciify(text) {
        if (!text) return text;
        for (let i = 0; i < text.length; i++) {
          if (needsCorrection(text, i)) {
            const alt = toggleTbl[text.charAt(i)];
            if (alt) text = setCharAt(text, i, alt);
          }
        }
        return text;
      }
    };
  }

  function _applyLangTransform(text, lang) {
    if (lang === 'tr-deasciify' && _deasciifier) return _deasciifier.deasciify(text);
    return text;
  }

  function typeText(params) {
    if (params.lang === 'tr-deasciify') {
      return _loadDeasciifier().then(() => {
        params.text = _applyLangTransform(params.text, params.lang);
        return _typeTextInner(params);
      }).catch(e => ({ success: false, error: e.message }));
    }
    return _typeTextInner(params);
  }

  function _typeTextInner(params) {
    let el;
    if (params.selector) {
      el = safeQuerySelector(params.selector);
    } else if (params.index != null) {
      // Same index space as getInteractiveElements / clickElement.
      const interactive = queryInteractive();
      el = interactive[params.index];
      if (!el) return _staleIndexError(params.index, interactive);
    } else {
      // Fallback path: type into the currently focused element. Used when
      // CDP isn't available or as the secondary path. Usually unreached on
      // chrome because agent.js routes type_text → cdpClient first.
      el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return { success: false, error: 'No editable element is currently focused. Click the target input/textarea first, then call type_text again with no selector.' };
      }
      // Verify it's actually editable
      const editable = el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
      if (!editable) {
        return {
          success: false,
          error: `Focused element <${el.tagName.toLowerCase()}> is not an editable field. Click the target input/textarea first, then call type_text again.`,
        };
      }
    }

    if (!el) return { success: false, error: 'Element not found' };

    // Guard: only INPUT, TEXTAREA, SELECT, and contenteditable are typeable.
    // Calling HTMLInputElement's native value setter on anything else throws
    // "Illegal invocation" because the setter requires `this` to be an input.
    const isTypeable = el.isContentEditable
      || el instanceof HTMLInputElement
      || el instanceof HTMLTextAreaElement
      || el instanceof HTMLSelectElement;
    if (!isTypeable) {
      const tag = (el.tagName || '').toLowerCase();
      return {
        success: false,
        error: `Cannot type into <${tag}> — it is not an editable field. If you wanted to activate it, use click instead. If the real target is a nearby input, click the input first, then call type_text({text: "..."}) with no selector.`,
      };
    }

    el.focus();
    showAgentWorkingTarget(el, 'type_text');

    if (el.isContentEditable) {
      if (params.clear) el.textContent = '';
      el.textContent += params.text;
      // beforeinput → input → change, so frameworks (React, Lexical,
      // ProseMirror) actually see a trusted-looking edit.
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: params.text }));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: params.text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'contenteditable', value: el.textContent.slice(0, 100) };
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
        return { success: false, error: `No <option> matching "${params.text}" in select.` };
      }
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, match.value);
      else el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'select', value: el.value };
    }

    if (params.clear) {
      el.value = '';
    }

    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, (params.clear ? '' : (el.value || '')) + params.text);
    } else {
      el.value = (params.clear ? '' : (el.value || '')) + params.text;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Duplicate-field detection
    const fieldIdent = `${el.tagName}|${el.name || el.id || ''}|${params.selector || 'focused'}`;
    let typeWarning;
    if (_lastTypeFieldIdent === fieldIdent) {
      typeWarning = 'You typed into the same field twice in a row. If you intended to fill a DIFFERENT field, click it first before calling type_text.';
    }
    _lastTypeFieldIdent = fieldIdent;

    return { success: true, value: (el.value || '').slice(0, 100), ...(typeWarning ? { warning: typeWarning } : {}) };
  }

  /**
   * Press supported keyboard keys.
   */
  function pressKeys(params) {
    const key = params?.key;
    const repeatRaw = Number(params?.repeat ?? 1);
    const repeat = Math.max(1, Math.min(3, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 1));
    const SUPPORTED_KEYS = ['Escape', 'Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (!SUPPORTED_KEYS.includes(key)) {
      return { success: false, error: `Unsupported key "${key}". Supported keys: ${SUPPORTED_KEYS.join(', ')}.` };
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
    }[key];
    const target = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement
      : document;

    const moveTabFocus = () => {
      const focusables = Array.from(document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (focusables.length === 0) return;
      const active = document.activeElement;
      const currentIndex = focusables.indexOf(active);
      const nextIndex = (currentIndex + 1 + focusables.length) % focusables.length;
      try { focusables[nextIndex].focus(); } catch (e) {}
    };

    for (let i = 0; i < repeat; i++) {
      const down = new KeyboardEvent('keydown', {
        key,
        code: keyMeta.code,
        keyCode: keyMeta.keyCode,
        which: keyMeta.keyCode,
        bubbles: true,
        cancelable: true,
      });
      const up = new KeyboardEvent('keyup', {
        key,
        code: keyMeta.code,
        keyCode: keyMeta.keyCode,
        which: keyMeta.keyCode,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(down);
      document.dispatchEvent(down);
      target.dispatchEvent(up);
      document.dispatchEvent(up);
      if (key === 'Tab') moveTabFocus();
    }

    return { success: true, key, repeat, method: 'keyboardevent', focusedTag: document.activeElement?.tagName || null };
  }

  /**
   * Scroll the page.
   */
  function legacyScrollPage(params) {
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
      if (direction === 'down') target.scrollBy(0, amount);
      else if (direction === 'up') target.scrollBy(0, -amount);
      else if (direction === 'top') target.scrollTo(0, 0);
      else if (direction === 'bottom') target.scrollTo(0, target.scrollHeight);
    }

    // Always also scroll the window in case both are needed (some pages have
    // both window and container scrolling).
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

  function smartScrollPage(params) {
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
        text: (el.innerText || el.getAttribute?.('aria-label') || '').trim().slice(0, 80),
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
      scrollElementInstant(target, direction, amount);
      containerAfter = target.scrollTop;
    }

    const movedContainer = target && Math.abs((containerAfter || 0) - (containerBefore || 0)) > 0.5;
    const shouldScrollWindow = params.alsoWindow === true || !movedContainer;
    if (shouldScrollWindow && windowCanMove) {
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

  function scrollPage(params) {
    try {
      return smartScrollPage(params);
    } catch (e) {
      const fallback = legacyScrollPage(params || {});
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
      const existing = document.querySelector(params.selector);
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

    const getText = () => {
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
    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
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
      media: getPageMediaSummary(),
      activeElement: getActiveEditableSummary(),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: a.innerText.trim().slice(0, 100),
        href: a.href,
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
      shadowDOM: getShadowContent(),
      iframes: Array.from(document.querySelectorAll('iframe')).map((iframe, i) => ({
        index: i,
        src: iframe.src,
        id: iframe.id || '',
        name: iframe.name || '',
        visible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0,
      })),
    };
  }

  function getInteractiveElementsFull() {
    const collected = []; // {el, rect, inShadow}
    const seen = new Set(); // dedupe nested wrappers (button > span > svg etc.)

    const isUsable = (el, rect) => {
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
        '[onclick]', '[data-action]', 'summary',
      ];
      selectors.forEach(sel => {
        try {
          root.querySelectorAll(sel).forEach(el => {
            if (seen.has(el)) return;
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

    return collected.map((c, i) => {
      const el = c.el;
      return {
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        role: el.getAttribute('role') || '',
        text: (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim().slice(0, 100),
        id: el.id || '',
        name: el.name || '',
        href: el.href || '',
        rect: { x: Math.round(c.rect.x), y: Math.round(c.rect.y), w: Math.round(c.rect.width), h: Math.round(c.rect.height) },
        inShadowDOM: c.inShadow,
      };
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

  // --- Message handler ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content') return;

    const handlers = {
      'get_page_info': () => getPageInfo(),
      'get_page_info_cdp': () => getPageInfoFull(msg.params || {}),
      'get_interactive_elements': () => getInteractiveElements(),
      'get_interactive_elements_cdp': () => getInteractiveElementsFull(),
      'click': () => clickElement(msg.params || {}),
      'type': () => typeText(msg.params || {}),
      'press_keys': () => pressKeys(msg.params || {}),
      'scroll': () => scrollPage(msg.params || {}),
      'extract_data': () => extractData(msg.params || {}),
      'inspect_element_styles': () => inspectElementStyles(msg.params || {}),
      'patch_element': () => patchDevElement(msg.params || {}),
      'revert_patch': () => revertDevElementPatch(msg.params || {}),
      'highlight_element': () => highlightDevElement(msg.params || {}),
      // Internal bridge used by inspect_event_listeners. The temporary DOM
      // marker lets CDP resolve the exact ref_id target, including nodes in
      // open shadow roots, and is removed in a finally block by agent.js.
      'dev_mark_targets': () => markDevTargets(msg.params || {}),
      'dev_unmark_targets': () => unmarkDevTargets(msg.params || {}),
      'wait_for_element': () => waitForElement(msg.params || {}),
      'get_selection': () => ({ text: window.getSelection()?.toString() || '' }),
      // ── Accessibility-tree-backed reads and actions ──────────────────
      //
      // The tree is built by src/content/accessibility-tree.js (a port of
      // claudeplugin/assets/accessibility-tree.js). Output is a flat,
      // indented text representation; each line carries a stable ref_id
      // (persistent across calls as long as the element stays in the DOM).
      'get_accessibility_tree': () => {
        try {
          if (typeof window.__generateAccessibilityTree !== 'function') {
            return { error: 'accessibility-tree.js not injected' };
          }
          const { filter, maxDepth, maxChars, ref_id, page } = msg.params || {};
          return window.__generateAccessibilityTree(filter, maxDepth, maxChars, ref_id, page);
        } catch (e) {
          return { error: 'Failed to build accessibility tree: ' + (e && e.message || String(e)) };
        }
      },
      'click_ax': () => {
        try {
          const { ref_id } = msg.params || {};
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
            return { success: false, error: `ref_id ${ref_id} not found.${formatNote} The element may have been removed or the page replaced.${hint} Re-read the accessibility tree to get fresh ids — do NOT guess ref numbers or invent placeholders.`, suggestions };
          }
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { el.focus({ preventScroll: true }); } catch {}
          const rect = el.getBoundingClientRect();
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
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
          rememberInteractionPoint(el, 'click_ax');
          el.click();
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
            const resp = {
              success: true,
              method: 'click_ax',
              ref_id,
              tag,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            };
            // Echo accessible name + href so the model can see exactly what
            // element it hit. This is critical when a stale ref_id points at
            // the wrong thing — e.g. a sidebar nav link that navigates away
            // from an open modal, silently destroying in-progress form state.
            try {
              const accName = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')))
                || (el.innerText && el.innerText.trim().slice(0, 80))
                || '';
              if (accName) resp.name = accName;
            } catch {}
            if (tag === 'a') {
              try {
                const href = anchorMeta?.href || el.getAttribute('href') || '';
                resp.href = href;
                if (anchorMeta?.resolvedHref) resp.resolvedHref = anchorMeta.resolvedHref;
                if (anchorMeta?.sameDocumentAnchor) {
                  const afterScrollY = Math.round(window.scrollY || 0);
                  const afterUrl = location.href;
                  resp.sameDocumentAnchor = true;
                  resp.anchorTarget = anchorMeta.anchorTarget;
                  resp.targetUrl = anchorMeta.targetUrl;
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
                  resp.targetUrl = anchorMeta.targetUrl || href;
                  resp.hint = `This <a> click is navigating to ${anchorMeta.targetUrl || href}. If that's not what you intended, the ref_id was stale — re-read the accessibility tree to get fresh ids. Any unsaved form input on the previous page has been lost.`;
                }
              } catch {}
            }
            if (isTextEntry) {
              resp.focused = true;
              resp.next_required = 'type_ax';
              resp.hint = `This element is now focused. Your very next tool call MUST be type_ax({ref_id: "${ref_id}", text: "..."}). Do not call any other tool in between.`;
            } else if (tag === 'select') {
              resp.hint = `This is a <select>. Prefer press_keys on the focused element to choose an option (e.g. type the first letters of the desired option, or ArrowDown + Enter). type_ax on a select also works via value/text match.`;
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
                  resp.hint = `This element is a combobox / popup-opener (role="${popupRole}"${popupHasPopup ? `, aria-haspopup="${popupHasPopup}"` : ''}). The popup is almost always rendered in a React portal at the end of <body>, OUTSIDE this button's subtree. Next step: call get_accessibility_tree({filter: "visible"}) — do NOT pass a ref_id (subtree filter will miss the portal). Look for a newly-appeared listbox / searchbox / menu. Then either (a) set_field({ref_id: <new search textbox ref>, text: "<query>", submit: true}), or (b) press_keys(["<first letter>"]) then press_keys(["Enter"]). Do NOT click this same ref_id again — it will just toggle the popup closed.`;
                }
              } catch {}
            }
            return resp;
          };
          if (anchorMeta?.sameDocumentAnchor) {
            return new Promise((resolve) => {
              setTimeout(() => {
                try {
                  resolve(buildResponse());
                } catch (e) {
                  resolve({ success: false, error: e && e.message || String(e) });
                }
              }, 120);
            });
          }
          return buildResponse();
        } catch (e) {
          return { success: false, error: e && e.message || String(e) };
        }
      },
      'type_ax': () => {
        if (msg.params?.lang === 'tr-deasciify') {
          return _loadDeasciifier().then(() => {
            msg.params.text = _applyLangTransform(msg.params.text, msg.params.lang);
            delete msg.params.lang;
            return handlers['type_ax']();
          }).catch(e => ({ success: false, error: e.message }));
        }
        try {
          const { ref_id, text, clear } = msg.params || {};
          if (typeof ref_id !== 'string') return { success: false, error: 'ref_id (string, e.g. "ref_42") is required' };
          if (typeof text !== 'string') return { success: false, error: 'text (string) is required' };
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
            return { success: false, error: `ref_id ${ref_id} not found.${formatNote} The element may have been removed or the page replaced.${hint} Re-read the accessibility tree to get fresh ids — do NOT guess ref numbers or invent placeholders.`, suggestions };
          }
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { el.focus({ preventScroll: true }); } catch {}
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
          if (el.isContentEditable) {
            if (clear) {
              try {
                const sel = window.getSelection();
                const r = document.createRange();
                r.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(r);
                document.execCommand('delete');
              } catch {}
            }
            try { document.execCommand('insertText', false, text); } catch {
              el.textContent = (clear ? '' : (el.textContent || '')) + text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return { success: true, method: 'type_ax_contenteditable', ref_id, rect: typeRect };
          }
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
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
                return {
                  success: false,
                  error: `ref_id ${ref_id} is an <input type="${inputType}"> which is not text-typeable. Use click_ax to toggle/activate it instead.`,
                };
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
                return { success: false, error: `No <option> matching "${text}" in select ref_id ${ref_id}.` };
              }
              const selSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
              if (selSetter) selSetter.call(el, match.value); else el.value = match.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { success: true, method: 'type_ax_select', ref_id, value: el.value, rect: typeRect };
            }
            if (clear) el.value = '';
            // Use the native setter so React's synthetic event system picks it up.
            const proto = el.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            const setter = descriptor && descriptor.set;
            const newVal = (clear ? '' : (el.value || '')) + text;
            if (setter) setter.call(el, newVal); else el.value = newVal;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true, method: 'type_ax_input', ref_id, rect: typeRect };
          }
          return { success: false, error: `ref_id ${ref_id} is not a typeable element (tag=${el.tagName}). Use click_ax then type_text.` };
        } catch (e) {
          return { success: false, error: e && e.message || String(e) };
        }
      },
      'set_field': async () => {
        try {
          if (msg.params?.lang === 'tr-deasciify') {
            await _loadDeasciifier();
            msg.params.text = _applyLangTransform(msg.params.text, msg.params.lang);
            delete msg.params.lang;
          }
          const { ref_id, text, clear = true, submit = false } = msg.params || {};
          if (typeof ref_id !== 'string') return { success: false, error: 'ref_id (string, e.g. "ref_42") is required' };
          if (typeof text !== 'string') return { success: false, error: 'text (string) is required' };
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
            return { success: false, error: `ref_id ${ref_id} not found.${formatNote} The element may have been removed or the page replaced.${hint} Re-read the accessibility tree to get fresh ids — do NOT guess ref numbers or invent placeholders.`, suggestions };
          }
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { el.focus({ preventScroll: true }); } catch {}
          showAgentWorkingTarget(el, 'set_field');
          const rect = (() => {
            try {
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            } catch { return null; }
          })();
          // Guard: refuse non-typeable elements up-front so the caller gets a
          // clear error instead of a silent no-op.
          if (el.tagName === 'INPUT') {
            const inputType = (el.type || 'text').toLowerCase();
            const nonTypeable = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'color', 'range', 'hidden']);
            if (nonTypeable.has(inputType)) {
              return { success: false, error: `ref_id ${ref_id} is an <input type="${inputType}"> which is not text-typeable. Use click_ax to toggle/activate it instead.` };
            }
          } else if (!el.isContentEditable && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
            return { success: false, error: `ref_id ${ref_id} is not a text field (tag=${el.tagName}). set_field works on input/textarea/contenteditable only.` };
          }
          let prevValue = '';
          if (el.isContentEditable) {
            prevValue = el.textContent || '';
            if (clear) {
              try {
                const sel = window.getSelection();
                const r = document.createRange();
                r.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(r);
                document.execCommand('delete');
              } catch {}
            }
            try { document.execCommand('insertText', false, text); } catch {
              el.textContent = (clear ? '' : prevValue) + text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } else {
            prevValue = el.value || '';
            const proto = el.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            const setter = descriptor && descriptor.set;
            const newVal = (clear ? '' : prevValue) + text;
            if (setter) setter.call(el, newVal); else el.value = newVal;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          // Verify: read back the value and confirm it contains what we typed.
          const actual = el.isContentEditable ? (el.textContent || '') : (el.value || '');
          const verified = actual.includes(text);

          // Collect field attributes for credential-field detection. The
          // detector itself lives in src/agent/credential-fields.js (pure
          // ESM, runs background-side) so the regex has one home and is
          // node-testable. We just ship the facts.
          const fieldMeta = (() => {
            try {
              const tag = el.tagName ? el.tagName.toLowerCase() : '';
              const fieldType = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : tag;
              const elId = el.id || null;
              let labelText = null;
              try {
                if (elId) {
                  const lbl = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(elId) : elId.replace(/"/g, '\\"')) + '"]');
                  if (lbl) labelText = (lbl.textContent || '').trim().slice(0, 120);
                }
                if (!labelText && el.closest) {
                  const wrap = el.closest('label');
                  if (wrap) labelText = (wrap.textContent || '').trim().slice(0, 120);
                }
              } catch {}
              return {
                tag,
                type: fieldType,
                name: el.getAttribute ? el.getAttribute('name') : null,
                id: elId,
                autocomplete: el.getAttribute ? el.getAttribute('autocomplete') : null,
                ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
                placeholder: el.getAttribute ? el.getAttribute('placeholder') : null,
                labelText,
              };
            } catch { return null; }
          })();
          if (submit) {
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
              const dispatchKey = (type, key, keyCode) => {
                el.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode, bubbles: true, cancelable: true }));
              };
              if (isCombobox) {
                // Give the listbox a tick to filter, then highlight the first
                // option with ArrowDown, then commit with Enter.
                await new Promise(r => setTimeout(r, 80));
                dispatchKey('keydown', 'ArrowDown', 40);
                dispatchKey('keyup', 'ArrowDown', 40);
                await new Promise(r => setTimeout(r, 30));
              }
              dispatchKey('keydown', 'Enter', 13);
              dispatchKey('keypress', 'Enter', 13);
              dispatchKey('keyup', 'Enter', 13);
              // Form submission: only fall back to requestSubmit for non-combobox
              // inputs. Submitting a form while a combobox popup is open is
              // usually wrong and can prematurely post the enclosing form.
              if (!isCombobox) {
                const form = el.form || (el.closest && el.closest('form'));
                if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
              }
            } catch {}
          }
          return {
            success: true,
            method: 'set_field',
            ref_id,
            rect,
            verified,
            actual: verified ? undefined : actual.slice(0, 200),
            fieldMeta,
          };
        } catch (e) {
          return { success: false, error: e && e.message || String(e) };
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
          const { ref_id } = msg.params || {};
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
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          showAgentWorkingTarget(el, 'ax_resolve_rect');
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const vw = window.innerWidth, vh = window.innerHeight;
          const inViewport = r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx <= vw && cy <= vh;
          let name = '';
          try {
            name = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')))
              || (el.innerText && el.innerText.trim().slice(0, 80))
              || '';
          } catch {}
          return {
            success: true,
            ref_id,
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            name,
            x: Math.round(cx),
            y: Math.round(cy),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            inViewport,
          };
        } catch (e) {
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
          try { fromEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
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
              name = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')))
                || (el.innerText && el.innerText.trim().slice(0, 80))
                || '';
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

    const result = handler();
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true; // async
    }
    sendResponse(result);
  });
})();
