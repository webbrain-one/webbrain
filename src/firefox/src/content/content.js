/**
 * WebBrain Content Script
 * Injected into every page — handles page reading and DOM actions.
 */

(() => {
  // Prevent double-injection
  if (window.__webbrain_injected) return;
  window.__webbrain_injected = true;

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

  function pageGateType(text) {
    const value = String(text || '').toLowerCase();
    if (/\bsubscribe\b|\bsubscription\b|subscriber[- ]only|unlimited access|unlock (?:this|the) article|start (?:your )?(?:free )?trial/.test(value)) return 'subscription';
    if (/create (?:a )?(?:free )?account|register to (?:continue|read)|sign up to (?:continue|read)/.test(value)) return 'registration';
    if (/(?:log|sign) in to (?:continue|read)|already have an account|create (?:a )?(?:free )?account or log in/.test(value)) return 'login';
    return 'unknown';
  }

  function pageGateHasAccessLanguage(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!value) return false;
    return /(?:(?:subscribe|subscription).{0,48}(?:continue|read|access|article|options|required|unlock)|subscriber[- ]only|unlimited access|unlock (?:this|the) article|start (?:your )?(?:free )?trial|create (?:a )?(?:free )?account|register to (?:continue|read)|sign up to (?:continue|read)|(?:log|sign) in to (?:continue|read)|continue reading (?:with|by)|to continue reading|already have an account)/.test(value);
  }

  function pageGateHasInlineBlockingLanguage(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!value) return false;
    return /(?:to continue reading|continue reading (?:with|by)|subscriber[- ]only|(?:subscribe|subscription required|register|sign up|log in|sign in|create (?:a )?(?:free )?account).{0,64}(?:continue reading|read (?:this |the )?(?:full )?(?:article|story)|unlock (?:this|the) (?:article|story)|access (?:this|the) (?:article|story)))/.test(value);
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

  function boundedPageGateLabel(el, rawLabel) {
    const options = [];
    let boundaryElement = null;
    for (const value of [el.getAttribute('aria-label'), el.getAttribute('title')]) {
      const normalized = String(value || '').replace(/\s+/g, ' ').trim();
      if (pageGateHasAccessLanguage(normalized)) options.push(normalized);
    }
    let descendants = [];
    try { descendants = el.querySelectorAll('h1, h2, h3, p, button, a, label, [role="heading"]'); } catch {}
    for (const node of Array.from(descendants).slice(0, 80)) {
      if (!gateElementIsRendered(node)) continue;
      const normalized = String(node.innerText || '').replace(/\s+/g, ' ').trim();
      if (normalized.length <= 600 && pageGateHasAccessLanguage(normalized)) {
        boundaryElement ||= node;
        options.push(normalized);
      }
    }
    options.sort((a, b) => a.length - b.length);
    if (options[0]) return { label: options[0].slice(0, 240), boundaryElement };
    const accessStart = rawLabel.search(/\b(?:subscribe|subscription|subscriber|unlock|register|sign up|log in|sign in|create an? account|continue reading)\b/i);
    return {
      label: rawLabel.slice(Math.max(0, accessStart), Math.max(0, accessStart) + 240),
      boundaryElement,
    };
  }

  function pageGatePublic(gate) {
    if (!gate) return null;
    return { type: gate.type, blocking: true, surface: gate.surface, label: gate.label };
  }

  function detectPageGate() {
    const seen = new Set();
    const candidates = [];
    const articleContext = pageHasArticleContext();
    for (const selector of PAGE_GATE_SELECTORS) {
      let matches = [];
      try { matches = document.querySelectorAll(selector); } catch { continue; }
      for (const el of matches) {
        if (seen.has(el) || !gateElementIsRendered(el)) continue;
        seen.add(el);
        const rawLabel = String(el.innerText || '').replace(/\s+/g, ' ').trim();
        const role = String(el.getAttribute('role') || '').toLowerCase();
        let surface = (role === 'dialog' || role === 'alertdialog' || el.tagName === 'DIALOG' || el.getAttribute('aria-modal') === 'true') ? 'dialog' : 'inline';
        const inArticle = !!el.closest('article, [role="article"], main, [role="main"]');
        let coveringOverlay = false;
        try {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
          const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
          const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
          coveringOverlay = ['fixed', 'sticky', 'absolute'].includes(style.position) && ((visibleWidth * visibleHeight) / viewportArea) >= 0.2;
        } catch {}
        if (coveringOverlay) surface = 'dialog';
        if (surface === 'dialog') {
          if (!articleContext || !pageGateHasAccessLanguage(rawLabel)) continue;
        } else {
          if (!inArticle || !pageGateHasInlineBlockingLanguage(rawLabel)) continue;
        }
        const gateText = boundedPageGateLabel(el, rawLabel);
        const label = gateText.label;
        const namedGate = /paywall|gateway|regiwall|subscription|registration/i.test([el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('data-testid') || ''].join(' '));
        const score = (surface === 'dialog' ? 100 : 0) + (inArticle ? 40 : 0) + (coveringOverlay ? 30 : 0) + (namedGate ? 15 : 0) - Math.min(label.length, 2000) / 2000;
        candidates.push({
          element: surface === 'inline' ? (gateText.boundaryElement || el) : el,
          type: pageGateType(rawLabel),
          surface,
          label: label.slice(0, 240),
          score,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
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

    const gate = detectPageGate();
    const pageGate = pageGatePublic(gate);
    if (gate?.surface === 'dialog') {
      return { text: gate.label, textSource: 'page-gate', isArticlePage, pageGate };
    }
    if (gate?.surface === 'inline') {
      const articleRoot = gate.element.closest('article, [role="article"], main, [role="main"]');
      return {
        text: renderedArticleTextBeforeGate(articleRoot, gate.element) || gate.label,
        textSource: 'article (pre-gate)',
        isArticlePage,
        pageGate,
      };
    }

    for (const sel of ARTICLE_SELECTORS) {
      let el;
      try { el = document.querySelector(sel); } catch { continue; }
      if (!el) continue;
      const cleaned = stripChrome(el);
      const txt = (cleaned && cleaned.innerText ? cleaned.innerText : '').trim();
      if (txt.length > 300) {
        textSource = sel;
        return { text: txt, textSource, isArticlePage, ...(pageGate ? { pageGate } : {}) };
      }
    }
    const fallback = stripChrome(document.body);
    textSource = includeChrome ? 'body (raw)' : 'body (chrome-stripped)';
    const text = (fallback && fallback.innerText ? fallback.innerText : '').trim();
    return { text, textSource, isArticlePage, ...(pageGate ? { pageGate } : {}) };
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
    const blockedAuxiliaryContent = t.pageGate?.blocking === true;
    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      ...(t.pageGate ? { pageGate: t.pageGate } : {}),
      text: t.text,
      textSource: t.textSource,
      isArticlePage: t.isArticlePage,
      includeChrome: !!(params && params.includeChrome),
      media: blockedAuxiliaryContent
        ? { videoCount: 0, imageCount: 0, videos: [], images: [] }
        : getPageMediaSummary(),
      activeElement: blockedAuxiliaryContent ? null : getActiveEditableSummary(),
      links: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: a.innerText.trim().slice(0, 100),
        href: a.href,
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
    };
  }

  function getPageInfoFull(params) {
    const t = getPageText(params || {});
    const blockedAuxiliaryContent = t.pageGate?.blocking === true;
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
      ...(t.pageGate ? { pageGate: t.pageGate } : {}),
      text: t.text,
      textSource: t.textSource,
      isArticlePage: t.isArticlePage,
      includeChrome: !!(params && params.includeChrome),
      media: blockedAuxiliaryContent
        ? { videoCount: 0, imageCount: 0, videos: [], images: [] }
        : getPageMediaSummary(),
      activeElement: blockedAuxiliaryContent ? null : getActiveEditableSummary(),
      links: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: a.innerText.trim().slice(0, 100),
        href: a.href,
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
    return (el?.innerText || el?.value || el?.placeholder || el?.title || el?.ariaLabel || '').trim();
  }

  function _isSiteInteractive(el) {
    try {
      return !!window.__wbSiteInteractions?.isInteractive?.(el);
    } catch {
      return false;
    }
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

  function _isFullyVisibleForInteraction(el) {
    try {
      if (!el?.isConnected) return false;
      const view = el.ownerDocument?.defaultView || window;
      const rect = el.getBoundingClientRect();
      if (
        rect.width < 1
        || rect.height < 1
        || rect.left < 0
        || rect.top < 0
        || rect.right > view.innerWidth
        || rect.bottom > view.innerHeight
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
      if (!node) return null;
      try {
        if (node !== overlay && node.matches?.(selector) && _hasVisibleBox(node, 20, 20)) return node;
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
          const interactive = candidates[i].querySelector?.(INTERACTIVE_SELECTORS.join(', '));
          if (!interactive) continue;
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
    const all = document.querySelectorAll([...INTERACTIVE_SELECTORS, ..._siteInteractiveSelectors()].join(', '));
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
        text: _siteInteractionText(el).slice(0, 100),
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
        '[onclick]', '[data-action]', 'summary', ..._siteInteractiveSelectors(),
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
    // Firefox's agent maps get_interactive_elements to the full/CDP-like
    // collector below, so index-based follow-up actions must resolve against
    // that same ordering. The legacy queryInteractive() order is still used
    // by the plain content handler but it is not the list the agent sees.
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

  window.__wb_resolve_click_target_for_submit_probe = function resolveClickTargetForSubmitProbe(params = {}) {
    if (params?.index == null) return null;
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0) return null;
    return queryInteractiveForToolIndex()[index] || null;
  };

  function getInteractiveElementsFull() {
    return queryInteractiveFull().map((c, i) => {
      const el = c.el;
      const result = {
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        role: el.getAttribute('role') || '',
        text: _siteInteractionText(el).slice(0, 100),
        id: el.id || '',
        name: el.name || '',
        href: el.href || '',
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
      const text = _siteInteractionText(el).slice(0, 80);
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
   * Run one synthetic agent click while suppressing any immediate or deferred
   * <input type=file>.click() it triggers. upload_file attaches a downloaded
   * file directly (or presents WebBrain's own picker when no downloadId is
   * available); clicking the page control first only opens a stale OS dialog.
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
    // If nothing was observed, stop content-side observation but leave the
    // page-world programmatic click/showPicker guard active until its own
    // short TTL. This suppresses longer debounces without blocking the tool
    // response or intercepting a user's direct native input click.
    state.cleanupPageShowPickerGuard?.(!!state.blocked);
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
      ? `Call upload_file({selector: ${JSON.stringify(selector)}, downloadId: N}) directly; it attaches the downloaded file without opening an OS dialog. If there is no downloadId, call upload_file({selector: ${JSON.stringify(selector)}}) to use WebBrain's own picker.`
      : 'Re-inspect the page to find an exact, unique <input type=file> selector, then call upload_file directly. Do not use a generic input[type="file"] selector when the page has multiple file inputs.';
    return {
      success: false,
      dispatched: true,
      filePickerBlocked: true,
      ...(selector ? { selector } : {}),
      error: `Blocked a native file chooser${label ? ` opened by "${label}"` : ''}. ${guidance}`,
    };
  }

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
    // Reject jQuery/Playwright selectors with a clear error.
    if (params.selector && /:contains\(|:has-text\(/.test(params.selector)) {
      return {
        success: false,
        dispatched: false,
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
      const sels = [
        'a', 'button', '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
        '[role="option"]', '[role="menuitemradio"]', '[role="menuitemcheckbox"]', '[role="treeitem"]',
        'input:not([type="hidden"])', 'textarea', 'select', 'input[type="button"]',
        'input[type="submit"]', 'summary', 'label', '[onclick]', '[data-action]',
        ..._siteInteractiveSelectors(),
      ].join(', ');
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
      const _normTxt = (el) => {
        const siteText = _isSiteInteractive(el) ? _siteInteractionText(el) : '';
        return (siteText || el.innerText || (_valIsLabel(el) ? el.value : '') || el.placeholder || el.ariaLabel || '').trim().toLowerCase();
      };
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
            inp.focus();
            el = inp;
            textResolvedExact = (needle === ltxt);
            break;
          }
        }
      }

      if (!el && matches.length === 0) {
        // Auto-scroll retry: scroll down up to 3 times to find elements below the fold.
        // Still respect modal scoping — we scroll the page but search inside
        // the modal (scrollable modals re-reveal off-screen dialog content).
        for (let scrollAttempt = 0; scrollAttempt < 3 && matches.length === 0; scrollAttempt++) {
          if (actionDeadlineExpired()) return deadlineFailure();
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
                if (actionDeadlineExpired()) return deadlineFailure();
                inp.scrollIntoView({ block: 'center', inline: 'center' });
                if (actionDeadlineExpired()) return deadlineFailure();
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
          // Widened fallback: contenteditable editors + ARIA roles + [tabindex].
          // Honor modal scoping here too.
          const _fbScope = _findTopmostModal() || document;
          const fbSels = '[contenteditable="true"],[contenteditable=""],[role="option"],[role="listbox"],[role="combobox"],[role="textbox"],[role="switch"],[role="checkbox"],[role="radio"],[tabindex]:not([tabindex="-1"])';
          // Last-resort scan also pierces open shadow roots: sites like
          // LinkedIn render entire dialogs inside one (the interop shell),
          // where querySelectorAll on the document is blind.
          const _fbCollectDeep = (sel) => {
            const out = [];
            const scan = (root, depth) => {
              try { out.push(...root.querySelectorAll(sel)); } catch(err) {}
              if (depth > 4) return;
              let els;
              try { els = root.querySelectorAll('*'); } catch(err) { return; }
              for (const host of els) { if (host.shadowRoot) scan(host.shadowRoot, depth + 1); }
            };
            scan(_fbScope, 0);
            return out;
          };
          const fbAll = _fbCollectDeep(fbSels).filter(e => {
            try {
              const r = e.getBoundingClientRect();
              if (r.width < 1 || r.height < 1) return false;
              const s = window.getComputedStyle(e);
              if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
              return true;
            } catch(err) { return false; }
          });
          // Quill/ProseMirror-style editors show their placeholder via
          // data-placeholder / aria-placeholder (CSS pseudo-element), not
          // text content — match those too.
          const fbNorm = fbAll.map(e => ({
            e,
            txt: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || e.getAttribute('aria-placeholder') || '').trim().toLowerCase(),
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
              textResolvedExact = (m === 'exact');
              break;
            }
          }
          if (!el) {
            const _noteModal = _modalRoot ? ' (search was scoped to the open modal/dialog; if the target is outside it, dismiss or complete the dialog first)' : '';
            return { success: false, dispatched: false, error: `No clickable element found for text "${params.text}" (also tried scrolling down and widening to contenteditable/[role=*]/[tabindex])${_noteModal}` };
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
            dispatched: false,
            failureScope: `ambiguous-click:${String(params.text || '').trim().toLowerCase()}`,
            error: `Ambiguous text match for "${params.text}" (mode=${usedMode}, matches=${matches.length})${_scopeNote}. ${candidates.length} candidates returned with cx/cy (precomputed click center, in CSS pixels) and ancestor context. Pick one and call click({x: candidate.cx, y: candidate.cy, coordinate_space: "css"}) — no arithmetic needed. Use the ancestor field to disambiguate (e.g. an alertdialog's Cancel vs a form's Cancel sit in different containers). Do NOT retry click({text: "${params.text}"}) — it will fail the same way.`,
            candidates,
          };
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
            target.focus();
            resolved = target;
          }
        }
        el = _resolveInteractiveAncestor(resolved);
      }
    } else if (params.selector) {
      el = safeIndexedQuerySelector(params.selector, params.matchIndex).element;
    } else if (params.index != null) {
      const interactive = queryInteractiveForToolIndex();
      el = interactive[params.index];
      if (!el) return { ..._staleIndexError(params.index, interactive), dispatched: false };
    } else if (params.x != null && params.y != null) {
      el = document.elementFromPoint(params.x, params.y);
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
        sel.focus();
        if (actionDeadlineExpired()) return deadlineFailure();
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
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
              dispatched: false,
              error: `Click blocked: an overlay is covering the target. Topmost element at (${cx}, ${cy}) is <${blockerInfo}>${blockerContainer}, not your target <${el.tagName.toLowerCase()}>. Dismiss the overlay (press Escape, click its close button, or complete the modal flow) before retrying. If you're sure you want to force the click, use click({x: ${cx}, y: ${cy}, coordinate_space: "css"}) — that will hit whatever's on top.`,
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

    if (actionDeadlineExpired()) return deadlineFailure();
    if (params?.messageRecipientGuardRequired === true) {
      const recipientValidation = _consumeMessageRecipientDispatchBinding(params, el);
      if (recipientValidation.success !== true) return recipientValidation;
      if (actionDeadlineExpired()) return deadlineFailure();
    }
    if (actionDeadlineExpired()) return deadlineFailure();
    const clickedRect = rememberInteractionPoint(el, 'click');
    if (actionDeadlineExpired()) return deadlineFailure();
    dispatched = true;
    const filePickerGuard = clickWithoutNativeFilePicker(() => el.click());
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
    if (_isTypeableElement(postActive)) {
      _rememberEditableTarget(postActive);
    } else if (_isTypeableElement(el) && _isShadowHostForTarget(postActive, el)) {
      _rememberEditableTarget(el);
    } else if (!_isMeaningfulFocus(postActive) && _isTypeableElement(el)) {
      if (actionDeadlineExpired()) return deadlineFailure();
      _focusElement(el);
      _rememberEditableTarget(el);
    } else if (_isMeaningfulFocus(postActive)) {
      _lastEditableTarget = null;
    }

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
    const isEditableTarget = _isTypeableElement(el);
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

  function typeText(params, actionDeadlineExpired = () => false) {
    return _typeTextInner(params, actionDeadlineExpired);
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
      const interactive = queryInteractiveForToolIndex();
      el = interactive[params.index];
      if (!el) {
        const stale = _staleIndexError(params.index, interactive);
        return noDispatchFailure(stale.error, stale);
      }
    } else {
      // No selector and no index → type into the currently focused element.
      // Most reliable for click-then-type flows on forms with weird selectors.
      el = _deepActiveElement();
      if (!el || el === document.body || el === document.documentElement) {
        el = _recentEditableTarget();
      }
      if (!el || el === document.body || el === document.documentElement) {
        return noDispatchFailure('No editable element is currently focused. Click the target input/textarea first, then call type_text again with no selector.');
      }
      // Verify it's actually editable
      const editable = _isTypeableElement(el);
      if (!editable) {
        const recentEditable = _recentEditableTarget();
        if (recentEditable && _isShadowHostForTarget(el, recentEditable)) {
          el = recentEditable;
        } else {
          _lastEditableTarget = null;
          return noDispatchFailure(`Focused element <${el.tagName.toLowerCase()}> is not an editable field. Click the target input/textarea first, then call type_text again.`);
        }
      }
    }

    if (!el) return noDispatchFailure('Element not found');

    if (!_consumeDispatchBinding(params.dispatchBinding?.token, el)) {
      return noDispatchFailure(
        'The selector target changed after the rich-text toolbar safety preflight. Re-read the page and retry.',
        { retryable: true },
      );
    }

    if (!_isTypeableElement(el)) {
      const tag = (el.tagName || '').toLowerCase();
      return noDispatchFailure(`Cannot type into <${tag}> — it is not an editable field. If you wanted to activate it, use click instead. If the real target is a nearby input, click the input first, then call type_text({text: "..."}) with no selector.`);
    }

    if (actionDeadlineExpired()) return deadlineFailure();
    el.focus();
    if (actionDeadlineExpired()) return deadlineFailure();
    showAgentWorkingTarget(el, 'type_text');
    const beforeValue = String(el.isContentEditable ? (el.textContent || '') : (el.value || ''));
    const routeHrefBeforeType = location.href;

    // contenteditable path (Notion, Google Docs comments, Lexical,
    // ProseMirror, Slate, Draft — all need the beforeinput → input →
    // change sequence with a real inputType, or their internal state
    // won't update).
    if (el.isContentEditable) {
      if (actionDeadlineExpired()) return deadlineFailure();
      dispatched = true;
      if (params.clear) el.textContent = '';
      if (actionDeadlineExpired()) return deadlineFailure();
      el.textContent += params.text;
      if (actionDeadlineExpired()) return deadlineFailure();
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: params.text }));
      if (actionDeadlineExpired()) return deadlineFailure();
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: params.text }));
      if (actionDeadlineExpired()) return deadlineFailure();
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const verified = await verifyValue(el, typedText, params.clear === true, beforeValue);
      if (actionDeadlineExpired()) return deadlineFailure();
      return { success: true, ...(verified === true ? { verified: true } : {}), method: 'contenteditable', value: el.textContent.slice(0, 100) };
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
        return noDispatchFailure(`No <option> matching "${params.text}" in select.`);
      }
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (actionDeadlineExpired()) return deadlineFailure();
      dispatched = true;
      if (nativeSetter) nativeSetter.call(el, match.value);
      else el.value = match.value;
      if (actionDeadlineExpired()) return deadlineFailure();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (actionDeadlineExpired()) return deadlineFailure();
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 30));
      if (actionDeadlineExpired()) return deadlineFailure();
      return { success: true, ...(el.isConnected && el.value === match.value ? { verified: true } : {}), method: 'select', value: el.value };
    }

    if (params.clear) {
      if (actionDeadlineExpired()) return deadlineFailure();
      dispatched = true;
      el.value = '';
    }

    // Use input events for React/Vue compatibility
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (actionDeadlineExpired()) return deadlineFailure();
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

    return { success: true, ...(verified === true ? { verified: true } : {}), value: (el.value || '').slice(0, 100), ...(typeWarning ? { warning: typeWarning } : {}) };
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
      ';': { code: 'Semicolon', keyCode: 59 },
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
      dispatched = true;
      target.dispatchEvent(down);
      // A keydown listener may run across the deadline. Always release the
      // synthetic key before returning the partial-dispatch timeout so pages
      // that track held keys are not left in a stuck state.
      const expiredAfterKeydown = actionDeadlineExpired();
      target.dispatchEvent(up);
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
      if (actionDeadlineExpired()) return deadlineFailure();
      dispatched = true;
      if (direction === 'down') target.scrollBy(0, amount);
      else if (direction === 'up') target.scrollBy(0, -amount);
      else if (direction === 'top') target.scrollTo(0, 0);
      else if (direction === 'bottom') target.scrollTo(0, target.scrollHeight);
    }
    if (actionDeadlineExpired()) return deadlineFailure();

    // Always also scroll the window in case both are needed.
    if (actionDeadlineExpired()) return deadlineFailure();
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
      if (actionDeadlineExpired()) return deadlineFailure();
      dispatched = true;
      scrollElementInstant(target, direction, amount);
      containerAfter = target.scrollTop;
    }
    if (actionDeadlineExpired()) return deadlineFailure();

    const movedContainer = target && Math.abs((containerAfter || 0) - (containerBefore || 0)) > 0.5;
    const shouldScrollWindow = params.alsoWindow === true || !movedContainer;
    if (shouldScrollWindow && windowCanMove) {
      if (actionDeadlineExpired()) return deadlineFailure();
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

  const SET_FIELD_VERIFY_DELAY_MS = 80;

  function _setFieldValueMatches(actual, previous, text, clear, normalizeNewlines = false) {
    const expected = clear ? text : previous + text;
    if (!normalizeNewlines) return actual === expected;
    const normalize = value => String(value).replace(/\r\n?/g, '\n');
    return normalize(actual) === normalize(expected);
  }

  function _editableTextValue(el) {
    return typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
  }

  // Synthetic (isTrusted:false) Enter events never trigger native submission —
  // they only reach the page's own keydown listeners. A non-combobox field
  // inside a form that has requestSubmit therefore needs a native submit as
  // its only reliable commit path; comboboxes are committed by page JS
  // listeners instead, because submitting the enclosing form while a picker
  // popup is open is usually wrong.
  function _setFieldUsesNativeSubmit(isCombobox, isContentEditable, form) {
    return !isCombobox && !isContentEditable && !!form && typeof form.requestSubmit === 'function';
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
          const escapedId = window.CSS && CSS.escape
            ? CSS.escape(elId)
            : elId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

  async function _retryFieldWithExecCommand(el, expected, actionDeadlineExpired = () => false) {
    try {
      if (actionDeadlineExpired()) return false;
      el.focus({ preventScroll: true });
      if (actionDeadlineExpired()) return false;
      if (el.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (typeof el.select === 'function') {
        if (actionDeadlineExpired()) return false;
        el.select();
      } else if (typeof el.setSelectionRange === 'function') {
        if (actionDeadlineExpired()) return false;
        el.setSelectionRange(0, String(el.value || '').length);
      }
      if (actionDeadlineExpired()) return false;
      const inserted = document.execCommand('insertText', false, expected);
      if (actionDeadlineExpired()) return false;
      if (!inserted) {
        if (el.isContentEditable) {
          el.textContent = expected;
        } else {
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (actionDeadlineExpired()) return false;
          if (setter) setter.call(el, expected); else el.value = expected;
        }
        if (actionDeadlineExpired()) return false;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (actionDeadlineExpired()) return false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, SET_FIELD_VERIFY_DELAY_MS));
      return !actionDeadlineExpired();
    } catch { return false; }
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
      identityKey,
      messageBody: String(dispatch.messageBody || ''),
      messageBodyBaselineCount: Number(dispatch.messageBodyBaselineCount || 0),
      gmailComposeFlow: dispatch.gmailComposeFlow === true,
      composerSubject: String(dispatch.composerSubject || ''),
      composerSubjectAvailable: dispatch.composerSubjectAvailable === true,
      pageUrl: location.href,
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

  function _consumeMessageRecipientDispatchBinding(params = {}, actualTarget = null) {
    const token = String(params.messageRecipientDispatchBinding?.token || '');
    const expected = token ? _messageRecipientDispatchBindings.get(token) : null;
    if (token) _messageRecipientDispatchBindings.delete(token);
    if (expected?.timer) clearTimeout(expected.timer);
    let pointTarget = null;
    const pointX = Number(params.dispatchPoint?.x);
    const pointY = Number(params.dispatchPoint?.y);
    if (Number.isFinite(pointX) && Number.isFinite(pointY)) {
      try { pointTarget = document.elementFromPoint(pointX, pointY); } catch {}
    }
    const dispatchedTarget = actualTarget || pointTarget;
    if (!expected || !expected.composer?.isConnected || !expected.actionTarget?.isConnected
      || expected.pageUrl !== location.href
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
    if (live?.success !== true || live?.conclusive !== true || live?.messageSend !== true
      || liveIdentityKey !== expected.identityKey
      || !expected.messageBody
      || live?.messageBody !== expected.messageBody
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
        if (args.selector) {
          const selected = safeIndexedQuerySelector(args.selector, args.matchIndex);
          el = selected.element;
          selectorMatchCount = selected.matchCount;
          selectorMatchIndex = selected.matchIndex;
        }
        else if (args.index != null) el = queryInteractiveForToolIndex()[args.index] || null;
        else {
          // Follow open shadow roots and mirror typeText's recent-target
          // recovery. Parent frames legitimately expose their active iframe
          // without :focus; non-frame targets must still own document focus
          // so stale child-frame state is ignored.
          el = _deepActiveElement();
          if (!_isTypeableElement(el)) {
            const recentEditable = _recentEditableTarget();
            const focusHost = document.activeElement;
            if (recentEditable && _isShadowHostForTarget(focusHost, recentEditable)) {
              el = recentEditable;
            }
          }
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

  // Read-only pre-dispatch probe for adapters that require a verified active
  // conversation before a message can be sent. It deliberately ignores input
  // values and ordinary page text: a searched recipient name is not proof that
  // the corresponding conversation is active.
  function _probeMessageRecipientGuard(params = {}) {
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
      const outgoingMessageContainer = (el) => {
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
          const ariaLabel = normalizedIdentity(current.getAttribute?.('aria-label'));
          if (/\b(?:outgoing|sent|self|own|user|from-me)\b/.test(direction)
              || booleanOutgoing === 'true'
              || /(?:^|[-_\s])(?:outgoing|message-out|sent-message|is-sent|from-me|own-message|self-message)(?:$|[-_\s])/.test(className)
              || /^(?:you(?:\s+sent\b|[:,])|outgoing message\b|sent by you\b)/.test(ariaLabel)) {
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
      const matchingMessageBodyCount = (expectedBody, activeComposer = null) => {
        const expected = normalizedMessageBody(expectedBody);
        if (!expected) return 0;
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
          if (!outgoingMessageContainer(el)) return false;
          try {
            if (el.closest?.('button,[role="button"],[role="alert"],[role="status"],[aria-live],nav,[role="navigation"]')) {
              return false;
            }
          } catch {}
          return normalizedMessageBody(el.innerText || el.textContent || '') === expected;
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
      const active = typeof _deepActiveElement === 'function' ? _deepActiveElement() : document.activeElement;

      let target = null;
      let dispatchTarget = null;
      let targetResolved = observationOnly || tool === 'press_keys';
      if (tool === 'click_ax' || tool === 'set_field') {
        const refId = String(args.ref_id || '');
        if (refId && typeof window.__wb_ax_lookup === 'function') target = window.__wb_ax_lookup(refId);
        targetResolved = !!target;
      } else if (tool === 'click') {
        if (typeof args.selector === 'string' && args.selector) {
          try { target = document.querySelector(args.selector); } catch {}
        } else if (Number.isInteger(args.index) && args.index >= 0) {
          target = queryInteractiveForToolIndex()[args.index] || null;
        } else if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
          target = document.elementFromPoint(args.x, args.y);
        } else if (typeof args.text === 'string' && args.text.trim()) {
          const needle = compact(args.text).toLocaleLowerCase();
          const matches = Array.from(document.querySelectorAll(
            'button,[role="button"],input[type="submit"],input[type="button"],[data-action]'
          )).filter((el) => compact(
            el.innerText || el.value || el.getAttribute?.('aria-label') || el.getAttribute?.('title')
          ).toLocaleLowerCase() === needle);
          if (matches.length === 1) target = matches[0];
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
      const layoutCandidate = composerCandidates[0] || null;
      const layoutCandidateRect = layoutCandidate?.getBoundingClientRect?.();
      // A recipient/search field can be the only focused editable while the
      // real composer is temporarily hidden. Never promote an upper-page
      // editable into the message composer merely because it is focused.
      const layoutComposer = layoutCandidate
        && (!viewportHeight || layoutCandidateRect?.bottom >= viewportHeight * 0.5)
        ? layoutCandidate
        : null;

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
        const row = clicked.closest?.(semanticRowSelector)
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

        const role = String(row.getAttribute?.('role') || '').toLowerCase();
        const tag = String(row.tagName || '').toLowerCase();
        const hasRowSemantics = /^(option|listitem|treeitem|tab)$/.test(role)
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

      let composer = null;
      let messageSend = null;
      if (observationOnly) {
        composer = layoutComposer;
      } else if (tool === 'press_keys') {
        if (!editable(active) || !visible(active) || !layoutComposer) {
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        if (active !== layoutComposer) {
          return verifiedNavigationEditable(active)
            ? { success: true, messageSend: false, conclusive: true, identityCandidates: [] }
            : { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
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
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        const control = target.closest?.('button,[role="button"],input[type="submit"],input[type="button"],[data-action]') || target;
        if (!visible(control)) {
          return { success: true, messageSend: null, conclusive: false, identityCandidates: [] };
        }
        composer = layoutComposer;
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
          const composerSetup = params.adapterName === 'gmail'
            && /^(?:reply|reply all|forward)$/i.test(actionLabel);
          return {
            success: true,
            messageSend: null,
            conclusive: false,
            composerAvailable: false,
            ...(composerSetup ? { composerSetup: true } : {}),
            identityCandidates: [],
          };
        }
        if (editable(target) && target !== composer) {
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
        const horizontalGap = Math.max(0, composerRect.left - controlRect.right, controlRect.left - composerRect.right);
        const verticalGap = Math.max(0, composerRect.top - controlRect.bottom, controlRect.top - composerRect.bottom);
        const sameForm = !!composer.closest?.('form') && composer.closest('form') === control.closest?.('form');
        // Framework chat controls are often clickable divs rather than native
        // buttons, and a nearby control can send an attachment even when the
        // text composer is empty. Geometry must therefore win over tag shape.
        messageSend = sameForm || (horizontalGap <= 240 && verticalGap <= 120);
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
      const gmailRecipientMode = params.adapterName === 'gmail';
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
      if (gmailRecipientMode) {
        const recipientRole = (el, root = null) => {
          const roleFromAttribute = (attribute, value) => {
            const text = compact(value, 120).toLowerCase();
            if (!text) return '';
            if (attribute === 'aria-label') {
              if (/^(?:bcc|blind\s+carbon\s+copy)(?:$|\s*[:,-]\s*)/.test(text)) return 'bcc';
              if (/^(?:cc|carbon\s+copy)(?:$|\s*[:,-]\s*)/.test(text)) return 'cc';
              if (/^to(?:$|\s*[:,-]\s*)/.test(text)) return 'to';
              return '';
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
          let current = el;
          for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
            for (const attribute of ['data-recipient-type', 'data-type', 'name', 'aria-label']) {
              const role = roleFromAttribute(attribute, current.getAttribute?.(attribute));
              if (role) return role;
            }
            if (root && current === root) break;
            try {
              const descendantRoles = new Set();
              for (const marker of current.querySelectorAll?.(
                'input[name="to"],input[name="cc"],input[name="bcc"],[aria-label]'
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
        const collectGmailRecipients = (root) => {
          const collected = new Map();
          if (!root?.querySelectorAll) return collected;
          for (const el of root.querySelectorAll('[email],[data-hovercard-id],[data-email]')) {
            if (!visible(el) || editable(el)) continue;
            if (el === composer || composer.contains?.(el)) continue;
            const email = [
              el.getAttribute?.('email'),
              el.getAttribute?.('data-email'),
              el.getAttribute?.('data-hovercard-id'),
            ].map(value => compact(value, 240)).find(value => /@/.test(value)) || '';
            if (!email) continue;
            const aliases = new Map();
            for (const value of [
              email,
              el.getAttribute?.('name'),
              el.getAttribute?.('aria-label'),
              el.getAttribute?.('title'),
              el.innerText,
              el.textContent,
            ]) {
              const alias = compact(value, 240);
              const normalized = normalizedIdentity(alias);
              if (alias && normalized && !aliases.has(normalized)) aliases.set(normalized, alias);
            }
            const key = normalizedIdentity(email);
            if (!key) continue;
            const role = recipientRole(el, root);
            if (!role) continue;
            const recipientKey = `${role}:${key}`;
            const prior = collected.get(recipientKey) || { identity: email, role, aliases: new Map() };
            for (const [normalized, alias] of aliases) prior.aliases.set(normalized, alias);
            collected.set(recipientKey, prior);
          }
          return collected;
        };
        // Dialog/popup compose keeps its form root. Inline thread replies are
        // not inside [role=dialog] or form; use the nearest ancestor that
        // already contains role-qualified To/Cc/Bcc chips so thread hovercards
        // without a recipient role cannot pin a send.
        const composeRoot = (() => {
          const explicit = composer.closest?.('[role="dialog"],form') || null;
          if (explicit) return explicit;
          let current = composer.parentElement;
          for (let depth = 0; current && depth < 16; depth += 1, current = current.parentElement) {
            if (current === document.body || current === document.documentElement) break;
            if (collectGmailRecipients(current).size > 0) return current;
          }
          return null;
        })();
        gmailComposeRoot = composeRoot;
        const recipients = collectGmailRecipients(composeRoot);
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
        for (const identity of strongIdentities) strongRecipients.push({ identity, role: 'to' });
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
        && !!messageBody
        && (params.supportsRecipientSets === true
          ? strongRecipients.length > 0
          : strongRecipients.length === 1)
        ? _rememberMessageRecipientDispatchBinding(composer, strongRecipients, {
            tool,
            args,
            actionTarget: dispatchTarget,
            adapterName: params.adapterName,
            expectedRecipients: params.expectedRecipients,
            supportsRecipientSets: params.supportsRecipientSets,
            messageBody,
            messageBodyBaselineCount,
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
        ...(composerRef ? { composerRef } : {}),
        composerEmpty: composerText.replace(/[\u200b-\u200d\ufeff]/g, '').trim() === '',
        messageBody,
        messageBodyBaselineCount,
        gmailComposeFlow,
        composerSubject,
        composerSubjectAvailable,
        composerStatusMessages,
        matchingOutgoingMessageCount,
        // Only recipient-specific header evidence is authoritative. Ordinary
        // message text, test-id containers, and other leaf content are never
        // returned as dispatch identities.
        identityCandidates: strongIdentities.slice(0, 16),
        strongIdentityCandidates: strongIdentities.slice(0, 16),
        strongRecipientCandidates: strongRecipients.slice(0, 16),
        ...(messageRecipientDispatchToken
          ? { messageRecipientDispatchBinding: { token: messageRecipientDispatchToken } }
          : {}),
      };
    } catch (error) {
      return { success: false, messageSend: null, conclusive: false, identityCandidates: [], error: error?.message || String(error) };
    }
  }

  // --- Message handler ---
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content') return;
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

    const handlers = {
      'get_page_info': () => getPageInfo(msg.params || {}),
      'get_page_info_cdp': () => getPageInfoFull(msg.params || {}),
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
      'wait_for_rich_text_toolbar_focused_child_frame': () => _waitForRichTextToolbarFocusedChildFrame(msg.params || {}),
      'announce_rich_text_toolbar_focused_child_frame': () => _announceRichTextToolbarFocusedChildFrame(msg.params || {}),
      'blur_rich_text_toolbar_target': () => _blurRichTextToolbarTarget(msg.params || {}),
      'probe_message_recipient_guard': () => _probeMessageRecipientGuard(msg.params || {}),
      'observe_chat': () => {
        if (typeof window.__wb_observe_chat_dom !== 'function') {
          return { success: false, error: 'chat-observation.js not injected' };
        }
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        const probe = _probeMessageRecipientGuard({ ...params, tool: 'observe_active_conversation', args: {} });
        return window.__wb_observe_chat_dom({ ...params, probe });
      },
      'press_keys': () => pressKeys(msg.params || {}, actionDeadlineExpired),
      'scroll': () => scrollPage(msg.params || {}, actionDeadlineExpired),
      'extract_data': () => extractData(msg.params || {}),
      'inspect_element_styles': () => inspectElementStyles(msg.params || {}),
      'wait_for_element': () => waitForElement(msg.params || {}),
      'get_selection': () => ({ text: window.getSelection()?.toString() || '' }),
      'find_text': () => findText(msg.params || {}),
      // ── Completion attention flash (tab title/favicon blink) ─────────
      'attention_flash_start': () => {
        try {
          return { success: true, started: startAttentionFlash() };
        } catch (error) {
          return { success: false, error: error?.message || String(error) };
        }
      },
      'attention_flash_stop': () => {
        try {
          stopAttentionFlash();
          return { success: true };
        } catch (error) {
          return { success: false, error: error?.message || String(error) };
        }
      },
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
        let dispatched = false;
        try {
          const fn = new Function(msg.params.code);
          dispatched = true;
          return { success: true, dispatched: true, result: fn() };
        } catch (e) {
          const errMsg = (e && e.message) || String(e);
          const isCspBlock =
            (e && e.name === 'EvalError') ||
            /unsafe-eval|Content Security Policy/i.test(errMsg);
          if (isCspBlock) {
            return {
              success: false,
              dispatched,
              cspBlocked: true,
              error:
                'execute_js is blocked by the extension\'s Content Security Policy — `new Function()` requires `unsafe-eval`. This is unexpected on Firefox (the manifest grants `unsafe-eval`) — the policy may have been changed. Use the finite tools instead: get_accessibility_tree (read the page), click_ax / type_ax / set_field (interact via ref_id), scroll, navigate, get_selection, iframe_read / iframe_click / iframe_type.',
            };
          }
          return { success: false, dispatched, error: errMsg };
        }
      },
      'get_shadow_dom': () => getShadowDOM(),
      'get_frames': () => getFrames(),
      // ── Accessibility-tree handlers (ported from Chrome v3.6.8) ───────
      // These rely on accessibility-tree.js being loaded first; manifest
      // content_scripts puts it before content.js so window.__wb_ax_lookup
      // and window.__generateAccessibilityTree are defined by the time the
      // first message arrives.
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
          return {
            ...window.__generateAccessibilityTree(filter, maxDepth, maxChars, ref_id, page, tree_revision),
            ...(conversationAutoExpanded ? { conversationAutoExpanded: true } : {}),
            documentToken,
            refScopeUrl,
          };
        } catch (e) {
          return { error: 'Failed to build accessibility tree: ' + (e && e.message || String(e)) };
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
          return { success: false, error: e?.message || String(e) };
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
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const inputType = tag === 'input' ? String(el.type || '').toLowerCase() : '';
          const nativeCheckable = inputType === 'checkbox' || inputType === 'radio';
          const checkedBefore = nativeCheckable ? !!el.checked : null;
          const targetRole = String(el.getAttribute?.('role') || '').toLowerCase();
          const canonicalTargetName = _axCanonicalName(el);
          const targetName = canonicalTargetName || _axAccessibleName(el);
          if (!_isFullyVisibleForInteraction(el)) {
            try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          }
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
                  ...(linkEl ? { href: String(linkEl.href || linkEl.getAttribute('href') || '').slice(0, 500) } : {}),
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
              });
            }
          }
          if (actionDeadlineExpired()) {
            return failure(
              'The page action deadline expired during recipient validation.',
              { deadlineExpired: true, retryable: true },
            );
          }
          rememberInteractionPoint(el, 'click_ax');
          if (actionDeadlineExpired()) {
            return failure(
              'The page action deadline expired before click dispatch.',
              { deadlineExpired: true, retryable: true },
            );
          }
          dispatched = true;
          const filePickerGuard = clickWithoutNativeFilePicker(() => el.click());
          if (filePickerGuard.blocked) {
            return failure(
              filePickerBlockedResponse(filePickerGuard.blocked, targetName || '').error,
              {
                filePickerBlocked: true,
                ...(filePickerGuard.blocked.selector ? { selector: filePickerGuard.blocked.selector } : {}),
                ref_id,
              },
            );
          }
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
              ref_id,
              tag,
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
            try {
              if (targetName) resp.name = targetName;
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
          const responseDelayMs = nativeCheckable
            ? SET_FIELD_VERIFY_DELAY_MS
            : (anchorMeta?.sameDocumentAnchor ? 120 : 0);
          if (responseDelayMs > 0) {
            return new Promise((resolve) => {
              setTimeout(() => {
                try {
                  resolve(buildResponse());
                } catch (e) {
                  resolve(failure(e && e.message || String(e)));
                }
              }, responseDelayMs);
            });
          }
          return buildResponse();
        } catch (e) {
          return failure(e && e.message || String(e));
        }
      },
      'set_checked': async () => {
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
          const { ref_id, checked, expectedDocumentToken, expectedPageUrl } = msg.params || {};
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
          const el = window.__wb_ax_lookup(ref_id);
          if (!el) return failure(`ref_id ${ref_id} not found. Re-read the accessibility tree to get a current checkbox ref_id.`);
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const inputType = tag === 'input' ? String(el.type || '').toLowerCase() : '';
          if (inputType !== 'checkbox') {
            return failure(`set_checked only supports native input[type="checkbox"] controls; ${ref_id} resolved to ${tag || 'unknown'}${inputType ? `[type="${inputType}"]` : ''}.`);
          }
          if (actionDeadlineExpired()) return deadlineFailure();
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          if (actionDeadlineExpired()) return deadlineFailure();
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
              trusted: false,
              ...base,
            };
          }
          if (actionDeadlineExpired()) return deadlineFailure();
          dispatched = true;
          el.click();
          if (actionDeadlineExpired()) return deadlineFailure();
          await new Promise(resolve => setTimeout(resolve, SET_FIELD_VERIFY_DELAY_MS));
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
              error: `Checkbox remained ${checkedAfter ? 'checked' : 'unchecked'} after one synthetic click. Firefox cannot synthesize trusted pointer input for page content.`,
            }),
          };
        } catch (e) {
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
            return failure(`ref_id ${ref_id} not found. Re-read the accessibility tree to get fresh ids.`, { suggestions });
          }
          if (actionDeadlineExpired()) return deadlineFailure();
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          if (actionDeadlineExpired()) return deadlineFailure();
          try { el.focus({ preventScroll: true }); } catch {}
          if (actionDeadlineExpired()) return deadlineFailure();
          showAgentWorkingTarget(el, 'type_ax');
          const typeRect = (() => {
            try {
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            } catch { return null; }
          })();
          const fieldMeta = _fieldMeta(el);
          let previous = '';
          let method = '';
          let selectExpected = null;
          if (el.isContentEditable) {
            if (actionDeadlineExpired()) return deadlineFailure();
            dispatched = true;
            previous = _editableTextValue(el);
            if (clear) {
              try {
                const sel = window.getSelection();
                const r = document.createRange();
                r.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(r);
                if (actionDeadlineExpired()) return deadlineFailure();
                document.execCommand('delete');
              } catch {}
            }
            if (actionDeadlineExpired()) return deadlineFailure();
            try { document.execCommand('insertText', false, text); } catch {
              if (actionDeadlineExpired()) return deadlineFailure();
              el.textContent = (clear ? '' : previous) + text;
              if (actionDeadlineExpired()) return deadlineFailure();
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            method = 'type_ax_contenteditable';
          } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
            if (el.tagName === 'INPUT') {
              const inputType = (el.type || 'text').toLowerCase();
              const nonTypeable = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'color', 'range', 'hidden']);
              if (nonTypeable.has(inputType)) {
                return failure(`ref_id ${ref_id} is an <input type="${inputType}"> which is not text-typeable. Use click_ax to toggle/activate it instead.`);
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
                return failure(`No <option> matching "${text}" in select ref_id ${ref_id}.`);
              }
              if (actionDeadlineExpired()) return deadlineFailure();
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
              dispatched = true;
              previous = el.value || '';
              if (clear) el.value = '';
              if (actionDeadlineExpired()) return deadlineFailure();
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
              { ref_id, verified: false, recoveryRequired: 'fresh_tree', failureScope: `field-value:${ref_id}`, retryable: false, fieldMeta },
            );
          }
          let actual = el.isContentEditable ? _editableTextValue(el) : (el.value || '');
          let verified = selectExpected !== null
            ? actual === selectExpected
            : _setFieldValueMatches(actual, previous, text, !!clear, el.isContentEditable);
          let fallbackAttempted = false;
          if (!verified && selectExpected === null) {
            if (actionDeadlineExpired()) return deadlineFailure();
            fallbackAttempted = await _retryFieldWithExecCommand(
              el,
              clear ? text : previous + text,
              actionDeadlineExpired,
            );
            if (actionDeadlineExpired()) return deadlineFailure();
            actual = el.isContentEditable ? _editableTextValue(el) : (el.value || '');
            verified = _setFieldValueMatches(actual, previous, text, !!clear, el.isContentEditable);
          }
          if (!verified) {
            return failure(
              'The field value did not exactly match the requested text after the page settled. Re-read the field and retry with a fresh ref_id.',
              {
                method,
                ref_id,
                rect: typeRect,
                verified: false,
                actual: actual.slice(0, 200),
                fieldMeta,
                fallbackAttempted,
                recoveryRequired: 'fresh_tree',
                failureScope: `field-value:${ref_id}`,
                retryable: false,
              },
            );
          }
          return {
            success: true,
            verified: true,
            method: fallbackAttempted ? 'type_ax_execcommand_fallback' : method,
            ref_id,
            rect: typeRect,
            ...(selectExpected !== null ? { value: actual } : {}),
            fieldMeta,
            fallbackAttempted,
          };
        } catch (e) {
          return failure(e && e.message || String(e));
        }
      },
      'set_field': async () => {
        let dispatched = false;
        let submissionDispatched = false;
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
          if (!el) return failure(`ref_id ${ref_id} not found. Re-read the accessibility tree.`);
          if (actionDeadlineExpired()) return deadlineFailure();
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          if (actionDeadlineExpired()) return deadlineFailure();
          try { el.focus({ preventScroll: true }); } catch {}
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
          if (el.tagName === 'INPUT') {
            const inputType = (el.type || 'text').toLowerCase();
            const nonTypeable = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'color', 'range', 'hidden']);
            if (nonTypeable.has(inputType)) {
              return failure(`ref_id ${ref_id} is an <input type="${inputType}"> which is not text-typeable. Use click_ax to toggle/activate it instead.`);
            }
          } else if (!el.isContentEditable && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
            return failure(`ref_id ${ref_id} is not a text field (tag=${el.tagName}). set_field works on input/textarea/contenteditable only.`);
          }
          let prevValue = '';
          if (actionDeadlineExpired()) return deadlineFailure();
          dispatched = true;
          if (el.isContentEditable) {
            prevValue = _editableTextValue(el);
            if (clear) {
              try {
                if (actionDeadlineExpired()) return deadlineFailure();
                const sel = window.getSelection();
                const r = document.createRange();
                r.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(r);
                if (actionDeadlineExpired()) return deadlineFailure();
                document.execCommand('delete');
                if (actionDeadlineExpired()) return deadlineFailure();
              } catch {}
            }
            try {
              if (actionDeadlineExpired()) return deadlineFailure();
              document.execCommand('insertText', false, text);
              if (actionDeadlineExpired()) return deadlineFailure();
            } catch {
              if (actionDeadlineExpired()) return deadlineFailure();
              el.textContent = (clear ? '' : prevValue) + text;
              if (actionDeadlineExpired()) return deadlineFailure();
              el.dispatchEvent(new Event('input', { bubbles: true }));
              if (actionDeadlineExpired()) return deadlineFailure();
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
            if (actionDeadlineExpired()) return deadlineFailure();
            el.dispatchEvent(new Event('input', { bubbles: true }));
            if (actionDeadlineExpired()) return deadlineFailure();
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (actionDeadlineExpired()) return deadlineFailure();
          }
          // Controlled inputs may reconcile after their event handlers return.
          // Verify only after that turn, and require the complete expected
          // value rather than accepting a matching substring.
          await new Promise(resolve => setTimeout(resolve, SET_FIELD_VERIFY_DELAY_MS));
          if (actionDeadlineExpired()) return deadlineFailure();
          if (!el.isConnected) {
            return failure(
              `ref_id ${ref_id} was replaced while the value was being set. Re-read the accessibility tree and retry with the current field ref_id.`,
              {
                ref_id,
                verified: false,
                recoveryRequired: 'fresh_tree',
                failureScope: `field-value:${ref_id}`,
                retryable: false,
              },
            );
          }
          const fieldMeta = _fieldMeta(el);
          let actual = el.isContentEditable ? _editableTextValue(el) : (el.value || '');
          let verified = _setFieldValueMatches(actual, prevValue, text, clear, el.isContentEditable);
          let fallbackAttempted = false;
          let nativeSubmitAttempted = false;
          let submissionOutcomeUnknown = false;
          if (!verified) {
            fallbackAttempted = true;
            await _retryFieldWithExecCommand(
              el,
              (clear ? '' : prevValue) + text,
              actionDeadlineExpired,
            );
            if (actionDeadlineExpired()) return deadlineFailure();
            actual = el.isContentEditable ? _editableTextValue(el) : (el.value || '');
            verified = _setFieldValueMatches(actual, prevValue, text, clear, el.isContentEditable);
          }

          if (submit && verified) {
            if (actionDeadlineExpired()) return deadlineFailure();
            submissionOutcomeUnknown = true;
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
              const dispatchKeySequence = (key, keyCode, includeKeypress = false) => {
                const result = { dispatched: false, completedWithinDeadline: false };
                if (actionDeadlineExpired()) return result;
                const eventInit = { key, code: key, keyCode, bubbles: true, cancelable: true };
                result.dispatched = true;
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
              if (msg.params?.messageRecipientGuardRequired === true) {
                const recipientValidation = _consumeMessageRecipientDispatchBinding(msg.params, el);
                if (recipientValidation.success !== true) {
                  return failure(recipientValidation.error, {
                    verified: true,
                    submitted: false,
                    messageDispatched: false,
                    messageRecipientGuard: true,
                    reasonCode: recipientValidation.reasonCode,
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
                    const arrowResult = dispatchKeySequence('ArrowDown', 40);
                    if (!arrowResult.completedWithinDeadline) return deadlineFailure();
                    await new Promise(r => setTimeout(r, 30));
                    if (actionDeadlineExpired()) return deadlineFailure();
                  }
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
            } catch {
              submissionOutcomeUnknown = true;
            }
          }
          if (!verified) {
            return failure(
              'The field value did not exactly match the requested text after the page settled. Re-read the field and retry with a fresh ref_id.',
              {
                method: 'set_field',
                ref_id,
                rect,
                verified: false,
                actual: actual.slice(0, 200),
                fieldMeta,
                fallbackAttempted,
                recoveryRequired: 'fresh_tree',
                failureScope: `field-value:${ref_id}`,
                retryable: false,
              },
            );
          }
          return {
            success: true,
            method: 'set_field',
            ref_id,
            rect,
            verified: true,
            fieldMeta,
            fallbackAttempted,
            submitted: nativeSubmitAttempted || undefined,
            outcomeUnknown: submissionOutcomeUnknown || undefined,
          };
        } catch (e) {
          return failure(e && e.message || String(e));
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
        let dispatched = false;
        const deadlineFailure = () => ({
          success: false,
          dispatched,
          ...(dispatched
            ? { outcomeUnknown: true, retryable: false }
            : { noDispatch: true, outcomeUnknown: false, retryable: true }),
          deadlineExpired: true,
          error: dispatched
            ? 'The page action deadline expired during hover dispatch.'
            : 'The page action deadline expired before hover dispatch.',
        });
        try {
          if (actionDeadlineExpired()) return deadlineFailure();
          const { ref_id } = msg.params || {};
          if (typeof ref_id !== 'string') return { success: false, error: 'ref_id (string, e.g. "ref_42") is required' };
          if (typeof window.__wb_ax_lookup !== 'function') return { success: false, error: 'accessibility-tree.js not injected' };
          const el = window.__wb_ax_lookup(ref_id);
          if (!el) {
            let suggestions = [];
            try { if (typeof window.__wb_ax_suggest === 'function') suggestions = window.__wb_ax_suggest(ref_id, 6); } catch {}
            return { success: false, error: `ref_id ${ref_id} not found.`, suggestions };
          }
          if (actionDeadlineExpired()) return deadlineFailure();
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          if (actionDeadlineExpired()) return deadlineFailure();
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const eventInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
          const dispatchHover = (EventType, type) => {
            if (actionDeadlineExpired()) return false;
            dispatched = true;
            el.dispatchEvent(new EventType(type, eventInit));
            return !actionDeadlineExpired();
          };
          try {
            // Order matches the browser's real sequence so listeners that
            // chain (pointer → mouse) see what they expect.
            if (!dispatchHover(PointerEvent, 'pointerover')) return deadlineFailure();
            if (!dispatchHover(PointerEvent, 'pointerenter')) return deadlineFailure();
            if (!dispatchHover(MouseEvent, 'mouseover')) return deadlineFailure();
            if (!dispatchHover(MouseEvent, 'mouseenter')) return deadlineFailure();
            if (!dispatchHover(MouseEvent, 'mousemove')) return deadlineFailure();
          } catch {
            // PointerEvent unavailable on very old Firefox — MouseEvent alone.
            try {
              if (!dispatchHover(MouseEvent, 'mouseover')) return deadlineFailure();
              if (!dispatchHover(MouseEvent, 'mouseenter')) return deadlineFailure();
              if (!dispatchHover(MouseEvent, 'mousemove')) return deadlineFailure();
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
        let dispatched = false;
        let pointerDown = false;
        let mouseDown = false;
        let dragStarted = false;
        const deadlineFailure = () => ({
          success: false,
          dispatched,
          ...(dispatched
            ? { outcomeUnknown: true, retryable: false }
            : { noDispatch: true, outcomeUnknown: false, retryable: true }),
          deadlineExpired: true,
          error: dispatched
            ? 'The page action deadline expired during drag dispatch.'
            : 'The page action deadline expired before drag dispatch.',
        });
        try {
          if (actionDeadlineExpired()) return deadlineFailure();
          const { fromRefId, toRefId, steps: stepsRaw } = msg.params || {};
          if (typeof fromRefId !== 'string' || typeof toRefId !== 'string') {
            return { success: false, error: 'drag_drop: fromRefId and toRefId (both strings, e.g. "ref_42") are required' };
          }
          if (typeof window.__wb_ax_lookup !== 'function') return { success: false, error: 'accessibility-tree.js not injected' };
          const from = window.__wb_ax_lookup(fromRefId);
          const to = window.__wb_ax_lookup(toRefId);
          if (!from) return { success: false, error: `drag_drop: fromRefId ${fromRefId} not found.` };
          if (!to) return { success: false, error: `drag_drop: toRefId ${toRefId} not found.` };
          if (actionDeadlineExpired()) return deadlineFailure();
          try { from.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          if (actionDeadlineExpired()) return deadlineFailure();
          const fr = from.getBoundingClientRect();
          const x1 = fr.left + fr.width / 2;
          const y1 = fr.top + fr.height / 2;
          try { to.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          if (actionDeadlineExpired()) return deadlineFailure();
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
            if (actionDeadlineExpired()) return false;
            const ev = mk(type, x, y, target);
            if (ev) {
              dispatched = true;
              try { target.dispatchEvent(ev); } catch {}
            }
            return true;
          };
          const dispatchCleanup = (type, x, y, target) => {
            const ev = mk(type, x, y, target);
            if (!ev) return;
            dispatched = true;
            try { target.dispatchEvent(ev); } catch {}
          };
          const deadlineWithCleanup = () => {
            // Release any synthetic gesture that already started. Cleanup
            // events intentionally bypass the expired deadline so the page is
            // not left with a held pointer, mouse button, or active drag.
            if (dragStarted) {
              dragStarted = false;
              dispatchCleanup('dragend', x2, y2, from);
            }
            if (pointerDown) {
              pointerDown = false;
              dispatchCleanup('pointerup', x2, y2, to);
            }
            if (mouseDown) {
              mouseDown = false;
              dispatchCleanup('mouseup', x2, y2, to);
            }
            return deadlineFailure();
          };
          // Pointer + mouse + drag sequence on source.
          if (!dispatch('pointerdown', sx1, sy1, from)) return deadlineWithCleanup();
          pointerDown = true;
          if (!dispatch('mousedown', sx1, sy1, from)) return deadlineWithCleanup();
          mouseDown = true;
          if (!dispatch('dragstart', sx1, sy1, from)) return deadlineWithCleanup();
          dragStarted = true;
          // Intermediate waypoints — fire pointermove/mousemove/dragover at
          // both source and destination so library code that listens at
          // either end sees movement.
          for (let i = 1; i <= stepsN; i++) {
            const t = i / stepsN;
            const ix = Math.round(sx1 + (x2 - sx1) * t);
            const iy = Math.round(sy1 + (y2 - sy1) * t);
            const overTarget = document.elementFromPoint(ix, iy) || to;
            if (!dispatch('drag', ix, iy, from)) return deadlineWithCleanup();
            if (!dispatch('pointermove', ix, iy, overTarget)) return deadlineWithCleanup();
            if (!dispatch('mousemove', ix, iy, overTarget)) return deadlineWithCleanup();
            if (!dispatch('dragenter', ix, iy, overTarget)) return deadlineWithCleanup();
            if (!dispatch('dragover', ix, iy, overTarget)) return deadlineWithCleanup();
          }
          // Drop sequence on destination.
          if (!dispatch('drop', x2, y2, to)) return deadlineWithCleanup();
          if (!dispatch('dragend', x2, y2, from)) return deadlineWithCleanup();
          dragStarted = false;
          if (!dispatch('pointerup', x2, y2, to)) return deadlineWithCleanup();
          pointerDown = false;
          if (!dispatch('mouseup', x2, y2, to)) return deadlineWithCleanup();
          mouseDown = false;
          if (actionDeadlineExpired()) return deadlineFailure();
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
      // Always settle sendResponse — a rejecting handler (e.g. a throwing
      // DOM API) must not leave the caller's await hanging forever.
      result.then(sendResponse, (err) => {
        sendResponse({ success: false, error: `${msg.action} failed: ${err?.message || String(err)}` });
      });
      return true; // async
    }
    sendResponse(result);
  });

  // ─── Tab attention flash ────────────────────────────────────────────
  // When a run finishes on a tab the user has navigated away from, the side
  // panel asks this page to blink its title and favicon so the finished tab
  // can be found at a glance. With many tabs open the strip only shows the
  // favicon, so the favicon itself alternates between the site's own icons
  // and a bell alert icon — swapping the site's <link> hrefs outright,
  // because an appended icon link loses to favicons the page injects later.
  // Blinking stops when the tab becomes visible, after
  // ATTENTION_FLASH_TIMEOUT_MS, or on an explicit stop message.
  //
  // Declared at the end of this closure (function declarations hoist, so the
  // message handlers above can call them) — code above this point is sliced
  // and evaluated standalone by tests.
  // Blink persists for minutes rather than seconds: the user is by
  // definition looking elsewhere while it runs, and it stops the moment the
  // tab becomes visible anyway. A short window is how completions get
  // missed entirely.
  const ATTENTION_FLASH_INTERVAL_MS = 700;
  const ATTENTION_FLASH_TIMEOUT_MS = 300000;
  const ATTENTION_FLASH_MARKER = '\u{1F514} ';
  let attentionFlashTimer = null;
  let attentionFlashTimeout = null;
  let attentionFlashOnVisible = null;
  // Exact title string this flash last wrote — ownership marker. Stripping
  // by prefix alone would eat a page's own title that legitimately starts
  // with the same bell character.
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
        ctx.fillText(ATTENTION_FLASH_MARKER.trim(), 32, 36);
      }
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  function attentionFlashStripMarker(title) {
    const text = String(title ?? '');
    return text.startsWith(ATTENTION_FLASH_MARKER)
      ? text.slice(ATTENTION_FLASH_MARKER.length)
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

  function stopAttentionFlash() {
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

  function startAttentionFlash() {
    if (typeof document === 'undefined') return false;
    stopAttentionFlash();
    // Already looking at the page — nothing to draw attention to.
    if (document.visibilityState === 'visible') return false;
    attentionFlashOnVisible = () => {
      if (document.visibilityState === 'visible') stopAttentionFlash();
    };
    document.addEventListener('visibilitychange', attentionFlashOnVisible);
    attentionFlashAlertUrl = attentionFlashBuildAlertIcon();
    if (attentionFlashAlertUrl) attentionFlashCaptureIcons();
    // Chrome throttles hidden-tab timers hard (once per minute after ~5
    // minutes) and Memory Saver may freeze the tab outright, so the phase
    // is derived from wall-clock time instead of a boolean flip: however
    // sparse or late the wake-ups land, each one shows the correct side of
    // the blink and the bell is on immediately at start.
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
      attentionFlashOwnTitle = flashing ? `${ATTENTION_FLASH_MARKER}${base}` : null;
      document.title = flashing ? attentionFlashOwnTitle : base;
      // The favicon blinks with the title: the bell alert icon replaces the
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
