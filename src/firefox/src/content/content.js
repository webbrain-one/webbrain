/**
 * WebBrain Content Script
 * Injected into every page — handles page reading and DOM actions.
 */

(() => {
  // Prevent double-injection
  if (window.__webbrain_injected) return;
  window.__webbrain_injected = true;

  /**
   * Extract readable text content from the page.
   *
   * Returns `{text, textSource, isArticlePage}`. `text` is the article
   * body (or fallback). `textSource` is the CSS selector that matched.
   * `isArticlePage` is true when the page self-declares as an article
   * via og:type, schema.org, or <article>. The model uses both flags
   * to decide whether the article body is complete (and stop chasing
   * more content via fetch_url / scroll / a11y-tree).
   *
   * Pass `{includeChrome:true}` to skip nav/header/footer/aside/ad-slot
   * stripping inside the chosen container — e.g. when the user is asking
   * ABOUT the nav, footer, cookie banner, etc.
   */
  function getPageText(opts) {
    const includeChrome = !!(opts && opts.includeChrome);

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

    const CHROME_DROP_SELECTORS = [
      'nav', 'header', 'footer', 'aside',
      '[role="navigation"]', '[role="banner"]',
      '[role="contentinfo"]', '[role="complementary"]',
      'script', 'style', 'noscript', 'iframe', 'svg',
      '[aria-hidden="true"]',
      '[class*="advertisement" i]', '[class*="ad-slot" i]',
      '[class*="ad-container" i]',
      '[class*="newsletter" i][class*="signup" i]',
      '[class*="newsletter-promo" i]',
      '[class*="social-share" i]', '[class*="share-tools" i]',
      '[class*="related-articles" i]', '[class*="recommended" i]',
      '[class*="more-stories" i]', '[class*="paid-content" i]',
      '[class*="cookie-banner" i]', '[id*="cookie-banner" i]',
      '[class*="onetrust" i]',
    ];

    const stripChrome = root => {
      if (includeChrome || !root) return root;
      let clone;
      try { clone = root.cloneNode(true); }
      catch { return root; }
      for (const sel of CHROME_DROP_SELECTORS) {
        try { clone.querySelectorAll(sel).forEach(n => n.remove()); }
        catch { /* invalid selector — skip */ }
      }
      return clone;
    };

    let textSource = 'body';
    let isArticlePage = false;
    try {
      isArticlePage = !!(
        document.querySelector('meta[property="og:type"][content="article"]') ||
        document.querySelector('meta[name="article:published_time"]') ||
        document.querySelector('[itemtype*="Article" i]') ||
        document.querySelector('article')
      );
    } catch { /* malformed selector engines */ }

    for (const sel of ARTICLE_SELECTORS) {
      let el;
      try { el = document.querySelector(sel); } catch { continue; }
      if (!el) continue;
      const cleaned = stripChrome(el);
      const txt = (cleaned && cleaned.innerText ? cleaned.innerText : '').trim();
      if (txt.length > 300) {
        textSource = sel;
        return { text: txt, textSource, isArticlePage };
      }
    }
    const fallback = stripChrome(document.body);
    textSource = includeChrome ? 'body (raw)' : 'body (chrome-stripped)';
    const text = (fallback && fallback.innerText ? fallback.innerText : '').trim();
    return { text, textSource, isArticlePage };
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
  function getPageInfo(params) {
    const t = getPageText(params || {});
    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      text: t.text,
      textSource: t.textSource,
      isArticlePage: t.isArticlePage,
      includeChrome: !!(params && params.includeChrome),
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

  function getPageInfoFull(params) {
    const t = getPageText(params || {});
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

    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      text: t.text,
      textSource: t.textSource,
      isArticlePage: t.isArticlePage,
      includeChrome: !!(params && params.includeChrome),
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

  // ---------------------------------------------------------------------
  // Interactive-element discovery — single source of truth for
  // getInteractiveElements / click({index}) / type_text({index}). Kept
  // in lockstep with src/chrome/src/content/content.js (and the CDP
  // mirror in src/chrome/src/cdp/cdp-client.js). See that file for
  // rationale.
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

  function _composedParent(node) {
    if (!node) return null;
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

  function _isComposedAncestor(ancestor, node) {
    let cur = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = _composedParent(cur);
    }
    return false;
  }

  function _hasComposedClosest(el, selector) {
    let cur = el;
    while (cur) {
      try {
        if (cur.nodeType === Node.ELEMENT_NODE && cur.matches(selector)) return true;
      } catch {}
      cur = _composedParent(cur);
    }
    return false;
  }

  function isVisiblyInteractive(el) {
    if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') return false;
    if (_hasComposedClosest(el, '[aria-hidden="true"], [inert]')) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity === '0' && el.tagName !== 'SELECT') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    // Styled-wrapper pattern: real input is 0x0 but a visible label or
    // wrapper makes it reachable.
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
   * Detect the topmost modal/overlay/dialog on the page. Returns the modal
   * container element, or null if no overlay is detected.
   */
  function _findTopmostModal(opts = {}) {
    const includeNonModalDialogs = opts.includeNonModalDialogs !== false;
    const dialogs = document.querySelectorAll('dialog[open]');
    for (let i = dialogs.length - 1; i >= 0; i--) {
      if (includeNonModalDialogs || _isNativeBlockingDialog(dialogs[i])) return dialogs[i];
    }

    const ariaModals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    for (let i = ariaModals.length - 1; i >= 0; i--) {
      const r = ariaModals[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return ariaModals[i];
    }

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
        if (!includeNonModalDialogs) {
          const dialogContent = _findDialogContentForOverlay(candidates[i]);
          if (dialogContent) return dialogContent;
        }
        return candidates[i];
      }
    }

    return null;
  }

  function _findTopmostBlockingModal() {
    return _findTopmostModal({ includeNonModalDialogs: false });
  }

  function queryInteractive() {
    const all = document.querySelectorAll(INTERACTIVE_SELECTORS.join(', '));
    const modal = _findTopmostBlockingModal();
    const out = [];
    for (const el of all) {
      if (!isVisiblyInteractive(el)) continue;
      if (modal && !_isComposedAncestor(modal, el)) continue;
      out.push(el);
    }
    return out;
  }

  /** Find the visible label associated with a form element. */
  function _getFieldLabel(el) {
    if (el.id) {
      try {
        const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl) return lbl.innerText.trim().slice(0, 50);
      } catch {}
    }
    const parent = el.closest('label');
    if (parent) {
      const t = parent.innerText.trim().slice(0, 50);
      if (t && t !== (el.value || '').trim()) return t;
    }
    if (el.ariaLabel) return el.ariaLabel.trim().slice(0, 50);
    if (el.getAttribute('aria-labelledby')) {
      const lbl = document.getElementById(el.getAttribute('aria-labelledby'));
      if (lbl) return lbl.innerText.trim().slice(0, 50);
    }
    const prev = el.previousElementSibling;
    if (prev && /^(LABEL|SPAN|DIV)$/i.test(prev.tagName)) {
      const t = prev.innerText.trim().slice(0, 50);
      if (t && t.length < 50) return t;
    }
    return '';
  }

  /**
   * Get a simplified DOM snapshot for the agent.
   */
  function getInteractiveElements() {
    return queryInteractive().map((el, index) => {
      let rect = el.getBoundingClientRect();
      // If element has zero dimensions (hidden input in styled wrapper),
      // use the visible label or wrapper rect instead.
      if (rect.width === 0 || rect.height === 0) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          let fallbackRect = null;
          if (el.id) {
            try {
              const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (lbl) { const lr = lbl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fallbackRect = lr; }
            } catch {}
          }
          if (!fallbackRect) {
            const wl = el.closest('label');
            if (wl) { const lr = wl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fallbackRect = lr; }
          }
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
      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
        const label = _getFieldLabel(el);
        if (label) entry.label = label;
      }
      if (el.tagName === 'SELECT') {
        entry.hint = 'Use type_text({index: ' + index + ', text: "option"}) to change this dropdown';
        entry.options = Array.from(el.options).map(o => o.text.trim()).slice(0, 10);
      }
      return entry;
    });
  }

  function queryInteractiveFull() {
    const collected = [];
    const seen = new Set();
    const modal = _findTopmostBlockingModal();

    const isUsable = (el, rect) => {
      if (_hasComposedClosest(el, '[aria-hidden="true"], [inert]')) return false;
      if (modal && !_isComposedAncestor(modal, el)) return false;
      if (rect.width < 2 || rect.height < 2) return false;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      if (rect.right < 0 || rect.left > window.innerWidth) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (cs.pointerEvents === 'none') return false;
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
            const rect = el.getBoundingClientRect();
            if (!isUsable(el, rect)) return;
            seen.add(el);
            collected.push({ el, rect, inShadow: root !== document });
          });
        } catch (e) {}
      });
      try {
        root.querySelectorAll('*').forEach(host => {
          if (host.shadowRoot) pierceShadow(host.shadowRoot);
        });
      } catch (e) {}
    };

    pierceShadow(document);

    collected.sort((a, b) => {
      const dy = a.rect.top - b.rect.top;
      if (Math.abs(dy) > 6) return dy;
      return a.rect.left - b.rect.left;
    });

    return collected;
  }

  function queryInteractiveForToolIndex() {
    // Firefox's agent maps get_interactive_elements to the full/CDP-like
    // collector below, so index-based follow-up actions must resolve against
    // that same ordering. The legacy queryInteractive() order is still used
    // by the plain content handler but it is not the list the agent sees.
    return queryInteractiveFull().map(c => c.el);
  }

  window.__wb_resolve_click_target_for_submit_probe = function resolveClickTargetForSubmitProbe(params = {}) {
    if (params?.index == null) return null;
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0) return null;
    return queryInteractiveForToolIndex()[index] || null;
  };

  function getInteractiveElementsFull() {
    return queryInteractiveFull().map((c, i) => {
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
    if (selector.startsWith('#') && !/[\s>+~,\[\]\.:]/.test(selector.slice(1).replace(/\\:/g, ''))) {
      const rawId = selector.slice(1).replace(/\\:/g, ':');
      try {
        const byId = document.getElementById(rawId);
        if (byId) return byId;
      } catch {}
      try { return document.querySelector(`[id="${rawId.replace(/"/g, '\\"')}"]`); } catch {}
    }
    try {
      const escaped = selector.replace(/(^|[^\\]):/g, '$1\\:');
      return document.querySelector(escaped);
    } catch {}
    return null;
  }

  let _lastClickIdent = null;
  let _lastEditableTarget = null;

  const _NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'color', 'range', 'hidden']);

  function _isTextTypeableInput(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    const inputType = (el.type || el.getAttribute('type') || 'text').toLowerCase();
    return !_NON_TEXT_INPUT_TYPES.has(inputType);
  }

  function _isDisabledEditable(el) {
    return !!(el && (
      el.disabled ||
      el.getAttribute?.('aria-disabled') === 'true' ||
      el.matches?.(':disabled')
    ));
  }

  function _isTypeableElement(el) {
    if (!el || _isDisabledEditable(el)) return false;
    return !!(el && (
      el.isContentEditable ||
      _isTextTypeableInput(el) ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ));
  }

  function _isMeaningfulFocus(el) {
    return !!(el && el !== document.body && el !== document.documentElement);
  }

  function _isShadowHostForTarget(host, target) {
    if (!_isMeaningfulFocus(host) || !target || typeof ShadowRoot === 'undefined') return false;
    let root = target.getRootNode?.();
    while (root instanceof ShadowRoot) {
      if (root.host === host) return true;
      root = root.host?.getRootNode?.();
    }
    return false;
  }

  function _isFocusableElement(el) {
    if (!el || typeof el.focus !== 'function') return false;
    if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') return false;
    if (el.isContentEditable) return true;
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/i.test(el.tagName || '')) return true;
    const tabIndexAttr = el.getAttribute?.('tabindex');
    if (tabIndexAttr == null) return false;
    const tabIndex = Number(tabIndexAttr);
    return Number.isFinite(tabIndex) && tabIndex >= 0;
  }

  function _focusElement(el) {
    try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch {} }
  }

  function _rememberEditableTarget(el) {
    if (!_isTypeableElement(el)) return;
    _lastEditableTarget = {
      el,
      href: location.href,
      ts: Date.now(),
    };
  }

  function _recentEditableTarget() {
    if (!_lastEditableTarget) return null;
    const { el, href, ts } = _lastEditableTarget;
    if (!el || !el.isConnected || href !== location.href) return null;
    if (Date.now() - ts > 30000) return null;
    if (!_isTypeableElement(el) || !isVisiblyInteractive(el)) return null;
    return el;
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

  function _hitTestMatchesTarget(target, topmost) {
    if (!target || !topmost) return false;
    if (target === topmost) return true;
    try {
      if (target.contains(topmost) || topmost.contains(target)) return true;
    } catch {}
    return _isComposedAncestor(target, topmost) || _isComposedAncestor(topmost, target);
  }

  /**
   * Click an element by selector or coordinates.
   */
  function clickElement(params) {
    let el;
    // Reject jQuery/Playwright selectors with a clear error.
    if (params.selector && /:contains\(|:has-text\(/.test(params.selector)) {
      return {
        success: false,
        error: 'Invalid selector: ":contains()" and ":has-text()" are jQuery/Playwright extensions, not valid CSS. Use click({text: "..."}) to click by visible text instead.',
      };
    }
    // Text-based: find the first interactive element whose text contains the
    // given string, case-insensitive. Prefer exact match, then prefix, then
    // substring.
    if (params.text) {
      const needle = params.text.toLowerCase();
      const explicit = params.textMatch || '';
      // Include inputs/select/textarea so we can match by placeholder, value, or aria-label
      const sels = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"], input:not([type="hidden"]), textarea, select, input[type="button"], input[type="submit"], summary, label, [onclick], [data-action]';
      // Modal scoping: if a topmost modal/dialog is open, restrict the search
      // to elements inside it. Prevents the classic failure where the model
      // types "Publish release" and the resolver clicks the dimmed Publish
      // button behind the "Create new tag" dialog instead of the dialog's
      // Create button. The modal dismissal itself (backdrop click) is still
      // reachable via coordinate clicks.
      const _modalRoot = _findTopmostModal();
      const _scope = _modalRoot || document;
      // Candidate filter: listbox/menu option roles are often kept mounted but
      // hidden while a custom select is collapsed or virtualized (Radix/MUI/
      // React-Select). Drop hidden ones so click({text}) can't match — and
      // falsely "succeed" on — an invisible option; the open-listbox fallback
      // still surfaces them when the control is actually open. Shared by the
      // primary pass AND the auto-scroll retry below so they can't diverge.
      const _keepCandidate = (el) => {
        const role = (el.getAttribute && el.getAttribute('role')) || '';
        if (role !== 'option' && role !== 'menuitemradio' && role !== 'menuitemcheckbox' && role !== 'treeitem') return true;
        try {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const s = window.getComputedStyle(el);
          if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
          if (el.closest('[aria-hidden="true"],[hidden]')) return false;
          return true;
        } catch (e) { return false; }
      };
      // A text field's `value` is content the user typed, NOT a click label.
      // Matching on it makes click({text}) resolve to the field you just filled
      // (e.g. a combobox/filter box whose value now equals the needle) instead
      // of the menu option bearing the same text — the "click succeeds but
      // nothing happens, model loops forever" bug. Only treat `value` as a label
      // for button-like inputs; non-input elements with .value (<select>) keep it.
      const _valIsLabel = (el) => {
        if (el.tagName === 'TEXTAREA') return false;
        if (el.tagName !== 'INPUT') return true;
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        return t === 'button' || t === 'submit' || t === 'reset';
      };
      const _normTxt = (el) => (el.innerText || (_valIsLabel(el) ? el.value : '') || el.placeholder || el.ariaLabel || '').trim().toLowerCase();
      const all = Array.from(_scope.querySelectorAll(sels)).filter(_keepCandidate);
      const normalized = all.map(e => ({ e, txt: _normTxt(e) })).filter(x => !!x.txt);

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
        // Still respect modal scoping — we scroll the page but search inside
        // the modal (scrollable modals re-reveal off-screen dialog content).
        for (let scrollAttempt = 0; scrollAttempt < 3 && matches.length === 0; scrollAttempt++) {
          window.scrollBy(0, Math.round(window.innerHeight * 0.7));
          // Re-query after scroll. Re-resolve the modal root in case the
          // dialog opened/closed during scroll.
          const _retryScope = _findTopmostModal() || document;
          const allRetry = Array.from(_retryScope.querySelectorAll(sels)).filter(_keepCandidate);
          const normRetry = allRetry.map(e => ({ e, txt: _normTxt(e) })).filter(x => !!x.txt);
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
          // Widened fallback: contenteditable editors + ARIA roles + [tabindex].
          // Honor modal scoping here too.
          const _fbScope = _findTopmostModal() || document;
          const fbSels = '[contenteditable="true"],[contenteditable=""],[role="option"],[role="listbox"],[role="combobox"],[role="textbox"],[role="switch"],[role="checkbox"],[role="radio"],[tabindex]:not([tabindex="-1"])';
          const fbAll = Array.from(_fbScope.querySelectorAll(fbSels)).filter(e => {
            try {
              const r = e.getBoundingClientRect();
              if (r.width < 1 || r.height < 1) return false;
              const s = window.getComputedStyle(e);
              if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
              return true;
            } catch(err) { return false; }
          });
          const fbNorm = fbAll.map(e => ({
            e,
            txt: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim().toLowerCase(),
          })).filter(x => !!x.txt);
          for (const m of modes) {
            const found = fbNorm.filter(x =>
              m === 'exact' ? x.txt === needle :
              m === 'prefix' ? x.txt.startsWith(needle) :
              x.txt.includes(needle)
            );
            if (found.length >= 1) {
              found[0].e.scrollIntoView({ block: 'center', inline: 'center' });
              el = found[0].e;
              break;
            }
          }
          if (!el) {
            const _noteModal = _modalRoot ? ' (search was scoped to the open modal/dialog; if the target is outside it, dismiss or complete the dialog first)' : '';
            return { success: false, error: `No clickable element found for text "${params.text}" (also tried scrolling down and widening to contenteditable/[role=*]/[tabindex])${_noteModal}` };
          }
        }
      }
      if (!el && matches.length > 1) {
        // Prefer interactive elements over passive children (label, span, etc.)
        const interactiveMatches = matches.filter(m => _isInteractive(m.e));
        if (interactiveMatches.length === 1) {
          matches = interactiveMatches;
        } else {
          // Build rich candidates: position (rect), tag, role, surrounding
          // context (closest landmark/dialog/button text), and precomputed
          // click centers. When the same text appears twice, the model needs
          // rects to pick by location, not just the same string twice.
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
      const interactive = queryInteractiveForToolIndex();
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
    // the cover instead. Refuse so the model dismisses the cover first.
    // Skip for x,y clicks (the model chose the point on purpose) and for
    // SELECT (already handled).
    if (el.tagName !== 'SELECT' && params.x == null && params.y == null) {
      try {
        const r = el.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth) {
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          const topmost = _shadowAwareElementFromPoint(cx, cy);
          if (topmost && !_hitTestMatchesTarget(el, topmost)) {
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

    if (_isTypeableElement(el)) {
      _focusElement(el);
      _rememberEditableTarget(el);
    } else {
      _lastEditableTarget = null;
      if (_isFocusableElement(el)) _focusElement(el);
    }

    const clickedRect = rememberInteractionPoint(el, 'click');
    el.click();

    // Post-click SELECT detection: the click may have activated a <select>
    // via a label, wrapper, or overlapping element. Return error, not success.
    const postActive = document.activeElement;
    if (_isTypeableElement(postActive)) {
      _rememberEditableTarget(postActive);
    } else if (_isTypeableElement(el) && _isShadowHostForTarget(postActive, el)) {
      _rememberEditableTarget(el);
    } else if (!_isMeaningfulFocus(postActive) && _isTypeableElement(el)) {
      _focusElement(el);
      _rememberEditableTarget(el);
    } else if (_isMeaningfulFocus(postActive)) {
      _lastEditableTarget = null;
    }

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
    const isEditableTarget = _isTypeableElement(el);
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

  let _deasciifier = null;
  function _loadDeasciifier() {
    if (_deasciifier) return Promise.resolve();
    return fetch(browser.runtime.getURL('vendor/turkish-deasciifier-patterns.json'))
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
      const interactive = queryInteractiveForToolIndex();
      el = interactive[params.index];
      if (!el) return _staleIndexError(params.index, interactive);
    } else {
      // No selector and no index → type into the currently focused element.
      // Most reliable for click-then-type flows on forms with weird selectors.
      el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        el = _recentEditableTarget();
      }
      if (!el || el === document.body || el === document.documentElement) {
        return { success: false, error: 'No editable element is currently focused. Click the target input/textarea first, then call type_text again with no selector.' };
      }
      // Verify it's actually editable
      const editable = _isTypeableElement(el);
      if (!editable) {
        const recentEditable = _recentEditableTarget();
        if (recentEditable && _isShadowHostForTarget(el, recentEditable)) {
          el = recentEditable;
        } else {
          _lastEditableTarget = null;
          return {
            success: false,
            error: `Focused element <${el.tagName.toLowerCase()}> is not an editable field. Click the target input/textarea first, then call type_text again.`,
          };
        }
      }
    }

    if (!el) return { success: false, error: 'Element not found' };

    if (!_isTypeableElement(el)) {
      const tag = (el.tagName || '').toLowerCase();
      return {
        success: false,
        error: `Cannot type into <${tag}> — it is not an editable field. If you wanted to activate it, use click instead. If the real target is a nearby input, click the input first, then call type_text({text: "..."}) with no selector.`,
      };
    }

    el.focus();
    showAgentWorkingTarget(el, 'type_text');

    // contenteditable path (Notion, Google Docs comments, Lexical,
    // ProseMirror, Slate, Draft — all need the beforeinput → input →
    // change sequence with a real inputType, or their internal state
    // won't update).
    if (el.isContentEditable) {
      if (params.clear) el.textContent = '';
      el.textContent += params.text;
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: params.text }));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: params.text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'contenteditable', value: el.textContent.slice(0, 100) };
    }

    // <select>: match by value or option text.
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

    // Use input events for React/Vue compatibility
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

    // NOTE: Firefox has no `debugger`/CDP permission (see ARCHITECTURE.md's
    // "No trusted keyboard events" row), so this is the only press_keys
    // implementation on this platform and it always dispatches untrusted
    // (isTrusted: false) KeyboardEvents. That's sufficient for JS keydown
    // listeners (most custom widgets) but arrow keys may not step native
    // controls (e.g. <input type="range">) on sites that only respond to
    // trusted input, same caveat that already applies to Escape/Tab/Enter.
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
    // to also accept overflow:hidden panes (see the comment there). The
    // unconditional window scroll near the end runs regardless.
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

    // Always also scroll the window in case both are needed.
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

  function getShadowDOM() {
    const collect = (root = document) => {
      const hosts = root.querySelectorAll('*');
      const result = [];
      hosts.forEach(el => {
        if (el.shadowRoot) {
          result.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            className: el.className || '',
            mode: el.shadowRoot.mode,
            text: el.shadowRoot.innerText?.trim().slice(0, 200) || '',
          });
          result.push(...collect(el.shadowRoot));
        }
      });
      return result;
    };
    return { success: true, shadowHosts: collect() };
  }

  function getFrames() {
    return {
      success: true,
      frames: Array.from(document.querySelectorAll('iframe')).map((iframe, i) => ({
        index: i,
        src: iframe.src,
        id: iframe.id || '',
        name: iframe.name || '',
        visible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0,
      })),
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
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content') return;

    const handlers = {
      'get_page_info': () => getPageInfo(msg.params || {}),
      'get_page_info_cdp': () => getPageInfoFull(msg.params || {}),
      'get_interactive_elements': () => getInteractiveElements(),
      'get_interactive_elements_cdp': () => getInteractiveElementsFull(),
      'click': () => clickElement(msg.params || {}),
      'type': () => typeText(msg.params || {}),
      'press_keys': () => pressKeys(msg.params || {}),
      'scroll': () => scrollPage(msg.params || {}),
      'extract_data': () => extractData(msg.params || {}),
      'inspect_element_styles': () => inspectElementStyles(msg.params || {}),
      'wait_for_element': () => waitForElement(msg.params || {}),
      'get_selection': () => ({ text: window.getSelection()?.toString() || '' }),
      // execute_js — model-supplied JS body, evaluated in the content
      // script's isolated world via `new Function()`.
      //
      // CSP NOTE (Firefox-specific): `new Function()` requires
      // `'unsafe-eval'` in the extension's CSP. Firefox MV2 permits us
      // to opt in to that, and the firefox manifest does — so this
      // handler works on every host regardless of the host page's CSP.
      // (Page CSP doesn't reach the isolated content-script world for
      // eval purposes; the extension's own CSP governs.)
      //
      // The same code path on Chrome MV3 can NOT grant unsafe-eval —
      // MV3's minimum-policy enforcement is strict, the extension fails
      // to install if you try. So Chrome's identical handler returns a
      // `cspBlocked: true` error and points the agent at finite-verb
      // tools instead. We keep the same shape here: if the eval throws
      // a CSP-flavoured error (which shouldn't happen on Firefox today
      // but is possible if the policy ever tightens), report it
      // identically so the cross-browser surface stays consistent.
      'execute_js': () => {
        try {
          const fn = new Function(msg.params.code);
          return { success: true, result: fn() };
        } catch (e) {
          const errMsg = (e && e.message) || String(e);
          const isCspBlock =
            (e && e.name === 'EvalError') ||
            /unsafe-eval|Content Security Policy/i.test(errMsg);
          if (isCspBlock) {
            return {
              success: false,
              cspBlocked: true,
              error:
                'execute_js is blocked by the extension\'s Content Security Policy — `new Function()` requires `unsafe-eval`. This is unexpected on Firefox (the manifest grants `unsafe-eval`) — the policy may have been changed. Use the finite tools instead: get_accessibility_tree (read the page), click_ax / type_ax / set_field (interact via ref_id), scroll, navigate, get_selection, iframe_read / iframe_click / iframe_type.',
            };
          }
          return { success: false, error: errMsg };
        }
      },
      'get_shadow_dom': () => getShadowDOM(),
      'get_frames': () => getFrames(),
      // ── Accessibility-tree handlers (ported from Chrome v3.6.8) ───────
      // These rely on accessibility-tree.js being loaded first; manifest
      // content_scripts puts it before content.js so window.__wb_ax_lookup
      // and window.__generateAccessibilityTree are defined by the time the
      // first message arrives.
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
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { el.focus({ preventScroll: true }); } catch {}
          const rect = el.getBoundingClientRect();
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
              try {
                if (isPopupOpener) {
                  resp.opened_popup_likely = true;
                  resp.hint = `This element is a combobox / popup-opener (role="${popupRole}"${popupHasPopup ? `, aria-haspopup="${popupHasPopup}"` : ''}). The popup is almost always rendered in a portal at the end of <body>, OUTSIDE this button's subtree. Next step: call get_accessibility_tree({filter: "visible"}) — do NOT pass a ref_id (subtree filter will miss the portal). Look for a newly-appeared listbox / searchbox / menu. Then either (a) set_field({ref_id: <new search textbox ref>, text: "<query>", submit: true}), or (b) press_keys(["<first letter>"]) then press_keys(["Enter"]). Do NOT click this same ref_id again — it will just toggle the popup closed.`;
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
            return { success: false, error: `ref_id ${ref_id} not found. Re-read the accessibility tree to get fresh ids.`, suggestions };
          }
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { el.focus({ preventScroll: true }); } catch {}
          showAgentWorkingTarget(el, 'type_ax');
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
            if (el.tagName === 'INPUT') {
              const inputType = (el.type || 'text').toLowerCase();
              const nonTypeable = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'color', 'range', 'hidden']);
              if (nonTypeable.has(inputType)) {
                return { success: false, error: `ref_id ${ref_id} is an <input type="${inputType}"> which is not text-typeable. Use click_ax to toggle/activate it instead.` };
              }
            }
            if (el.tagName === 'SELECT') {
              // Native <select>: match the requested text against options by
              // value, then by visible text (exact, then substring). A select's
              // value can't be set through the INPUT prototype setter used below
              // (Web IDL brand-check throws "Illegal invocation"), so handle it
              // here with the HTMLSelectElement setter.
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
          if (!el) return { success: false, error: `ref_id ${ref_id} not found. Re-read the accessibility tree.` };
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { el.focus({ preventScroll: true }); } catch {}
          showAgentWorkingTarget(el, 'set_field');
          const rect = (() => {
            try {
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            } catch { return null; }
          })();
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
              const roleAttr = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
              const controls = el.getAttribute && el.getAttribute('aria-controls');
              let isCombobox = roleAttr === 'searchbox' || roleAttr === 'combobox'
                || (el.getAttribute && el.getAttribute('aria-autocomplete'))
                || (el.getAttribute && el.getAttribute('aria-expanded') === 'true');
              if (!isCombobox && controls) {
                try { if (document.getElementById(controls)) isCombobox = true; } catch {}
              }
              if (!isCombobox) {
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
                await new Promise(r => setTimeout(r, 80));
                dispatchKey('keydown', 'ArrowDown', 40);
                dispatchKey('keyup', 'ArrowDown', 40);
                await new Promise(r => setTimeout(r, 30));
              }
              dispatchKey('keydown', 'Enter', 13);
              dispatchKey('keypress', 'Enter', 13);
              dispatchKey('keyup', 'Enter', 13);
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
      // ── hover ──────────────────────────────────────────────────────────────
      // Firefox MV2 has no CDP. We dispatch synthetic mouseenter/mouseover/
      // pointerenter/pointerover events with bubbles=true so frameworks see
      // the right sequence. These are isTrusted=false, so sites that gate
      // their reveal-on-hover handler on event.isTrusted (rare but real) will
      // not respond — there's no way around that without browser-level
      // automation APIs. For the common case (CSS :hover doesn't apply since
      // we can't synthesize the OS cursor, but mouseenter/mouseover handlers
      // fire and trigger React/Vue state changes) this is enough.
      'hover': () => {
        try {
          const { ref_id } = msg.params || {};
          if (typeof ref_id !== 'string') return { success: false, error: 'ref_id (string, e.g. "ref_42") is required' };
          if (typeof window.__wb_ax_lookup !== 'function') return { success: false, error: 'accessibility-tree.js not injected' };
          const el = window.__wb_ax_lookup(ref_id);
          if (!el) {
            let suggestions = [];
            try { if (typeof window.__wb_ax_suggest === 'function') suggestions = window.__wb_ax_suggest(ref_id, 6); } catch {}
            return { success: false, error: `ref_id ${ref_id} not found.`, suggestions };
          }
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const eventInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
          try {
            // Order matches the browser's real sequence so listeners that
            // chain (pointer → mouse) see what they expect.
            el.dispatchEvent(new PointerEvent('pointerover', eventInit));
            el.dispatchEvent(new PointerEvent('pointerenter', eventInit));
            el.dispatchEvent(new MouseEvent('mouseover', eventInit));
            el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
            el.dispatchEvent(new MouseEvent('mousemove', eventInit));
          } catch {
            // PointerEvent unavailable on very old Firefox — MouseEvent alone.
            try {
              el.dispatchEvent(new MouseEvent('mouseover', eventInit));
              el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
              el.dispatchEvent(new MouseEvent('mousemove', eventInit));
            } catch {}
          }
          return {
            success: true,
            method: 'synthetic-hover',
            ref_id,
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            note: 'Synthetic hover (Firefox has no CDP). isTrusted=false — sites that gate hover-reveal on event.isTrusted will not respond. Re-read the tree to confirm a menu/tooltip appeared.',
          };
        } catch (e) {
          return { success: false, error: e && e.message || String(e) };
        }
      },
      // ── drag_drop ──────────────────────────────────────────────────────────
      // Firefox synthetic implementation. We dispatch the full pointer +
      // HTML5 drag-and-drop event chain with a constructed DataTransfer so
      // BOTH custom pointer-event drag handlers (Trello-style) AND HTML5
      // dnd handlers (file-drop, ordering libs that use dragstart/dragover/
      // drop) see something. isTrusted=false applies — same caveat as hover.
      // For sites that work, this is enough. For sites that don't, the user
      // should switch to Chrome (where CDP delivers trusted events).
      'drag_drop': () => {
        try {
          const { fromRefId, toRefId, steps: stepsRaw } = msg.params || {};
          if (typeof fromRefId !== 'string' || typeof toRefId !== 'string') {
            return { success: false, error: 'drag_drop: fromRefId and toRefId (both strings, e.g. "ref_42") are required' };
          }
          if (typeof window.__wb_ax_lookup !== 'function') return { success: false, error: 'accessibility-tree.js not injected' };
          const from = window.__wb_ax_lookup(fromRefId);
          const to = window.__wb_ax_lookup(toRefId);
          if (!from) return { success: false, error: `drag_drop: fromRefId ${fromRefId} not found.` };
          if (!to) return { success: false, error: `drag_drop: toRefId ${toRefId} not found.` };
          try { from.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          const fr = from.getBoundingClientRect();
          const x1 = fr.left + fr.width / 2;
          const y1 = fr.top + fr.height / 2;
          try { to.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          // Re-measure source AFTER destination scroll — viewport may have
          // shifted. Same precaution Chrome takes.
          const fr2 = from.getBoundingClientRect();
          const sx1 = fr2.left + fr2.width / 2;
          const sy1 = fr2.top + fr2.height / 2;
          const tr = to.getBoundingClientRect();
          const x2 = tr.left + tr.width / 2;
          const y2 = tr.top + tr.height / 2;
          const stepsN = Math.max(2, Math.min(40, Math.floor(Number(stepsRaw) || 10)));
          // Construct a DataTransfer so HTML5 dnd handlers see one.
          // Firefox supports `new DataTransfer()`.
          let dt;
          try { dt = new DataTransfer(); } catch { dt = null; }
          const mk = (type, x, y, target) => {
            const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
            if (dt && /^drag/.test(type)) init.dataTransfer = dt;
            try {
              if (/^pointer/.test(type)) return new PointerEvent(type, init);
              if (/^drag/.test(type)) return new DragEvent(type, init);
              return new MouseEvent(type, init);
            } catch { return null; }
          };
          const dispatch = (type, x, y, target) => {
            const ev = mk(type, x, y, target);
            if (ev) try { target.dispatchEvent(ev); } catch {}
          };
          // Pointer + mouse + drag sequence on source.
          dispatch('pointerdown', sx1, sy1, from);
          dispatch('mousedown', sx1, sy1, from);
          dispatch('dragstart', sx1, sy1, from);
          // Intermediate waypoints — fire pointermove/mousemove/dragover at
          // both source and destination so library code that listens at
          // either end sees movement.
          for (let i = 1; i <= stepsN; i++) {
            const t = i / stepsN;
            const ix = Math.round(sx1 + (x2 - sx1) * t);
            const iy = Math.round(sy1 + (y2 - sy1) * t);
            const overTarget = document.elementFromPoint(ix, iy) || to;
            dispatch('drag', ix, iy, from);
            dispatch('pointermove', ix, iy, overTarget);
            dispatch('mousemove', ix, iy, overTarget);
            dispatch('dragenter', ix, iy, overTarget);
            dispatch('dragover', ix, iy, overTarget);
          }
          // Drop sequence on destination.
          dispatch('drop', x2, y2, to);
          dispatch('dragend', x2, y2, from);
          dispatch('pointerup', x2, y2, to);
          dispatch('mouseup', x2, y2, to);
          return {
            success: true,
            method: 'synthetic-drag',
            from: { ref_id: fromRefId, x: sx1, y: sy1 },
            to: { ref_id: toRefId, x: x2, y: y2 },
            steps: stepsN,
            note: 'Synthetic drag (Firefox has no CDP). isTrusted=false — some sites with strict event verification will not respond. Re-read the tree to confirm the order/position changed. If nothing moved, the site needs Chrome (CDP-trusted) drag.',
          };
        } catch (e) {
          return { success: false, error: e && e.message || String(e) };
        }
      },
      // ── wait_for_stable ────────────────────────────────────────────────────
      // CROSS-WORLD NOTE: Firefox content scripts (like Chrome) run in a
      // separate JS compartment from the page. Patching `window.fetch` /
      // `XMLHttpRequest.prototype.send` here observes nothing because the
      // page's calls happen in the page's own world. Same fix as Chrome:
      // inject a <script> with text patches, publish the in-flight count
      // via `document.documentElement.dataset.__wbInflight` (shared DOM
      // crosses the world boundary), read from here. Page CSP can refuse
      // the inline-script inject — when that happens we fall back to
      // MutationObserver-only stability and flag `networkObserved: false`.
      'wait_for_stable': () => {
        return new Promise((resolve) => {
          const params = msg.params || {};
          const timeout = Math.max(200, Math.min(20000, Number(params.timeout) || 5000));
          const quietMs = Math.max(100, Math.min(3000, Number(params.quietMs) || 500));
          const checkNetwork = params.checkNetwork !== false;
          let mutationCount = 0;
          let networkObserved = false;

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
            } catch {}
          }

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
            if (checkNetwork && !networkObserved) {
              networkObserved = readInflight() !== null;
            }
            const inFlight = networkObserved ? (readInflight() | 0) : 0;
            const netIdle = !checkNetwork || !networkObserved || inFlight === 0;
            if (quiet >= quietMs && netIdle) {
              clearInterval(interval);
              observer.disconnect();
              resolve({
                success: true, stable: true,
                elapsedMs: elapsed, quietMs: quiet, mutations: mutationCount,
                inFlightAtExit: networkObserved ? inFlight : null,
                networkObserved,
              });
            } else if (elapsed >= timeout) {
              clearInterval(interval);
              observer.disconnect();
              resolve({
                success: true, stable: false, timedOut: true,
                elapsedMs: elapsed, mutations: mutationCount,
                inFlightAtExit: networkObserved ? inFlight : null,
                networkObserved,
                hint: networkObserved
                  ? 'Page never went quiet within the timeout. Proceed and read the tree anyway, or pass a longer timeout.'
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
