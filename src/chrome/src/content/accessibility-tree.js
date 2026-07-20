/**
 * WebBrain — in-page accessibility tree builder.
 *
 * This is a port of the approach used by Claude for Chrome
 * (claudeplugin/assets/accessibility-tree.js). The original ships minified;
 * this is a clean re-implementation of the same algorithm.
 *
 * Key properties (match Claude's behaviour):
 *
 * 1. OUTPUT IS A FLAT INDENTED TEXT STRING, not a JSON tree. Each kept node
 *    becomes one line:
 *
 *        button "Sign in" [ref_42] type="submit"
 *          option "United States" [ref_43] (selected)
 *        link "Pricing" [ref_44] href="/pricing"
 *
 *    Indentation is 1 space per tree-depth level (depth increases for kept
 *    ancestors; skipped ancestors don't bump depth, so the tree visually
 *    flattens generic containers).
 *
 * 2. ref_id IS STABLE ACROSS CALLS. ref_ids live in window.__wbElementMap as
 *    WeakRefs, so an element keeps its `ref_N` identifier for as long as it
 *    remains in the DOM. Between calls we sweep entries whose deref() is
 *    gone, so the map doesn't grow unbounded.
 *
 * 3. Parameters:
 *      filter:  'all' | 'visible' | 'interactive' (default 'all')
 *      maxDepth: number of tree levels to descend (default 15)
 *      maxChars: hard cap on total output length
 *      refId:   if set, build the subtree rooted at that previously-seen
 *               element instead of document.body. Enables follow-up reads
 *               like "read the subtree under the nav I already identified".
 *
 * 4. Node keep-criteria (in 'visible' or 'interactive' filter):
 *      a) element passes the filter's visibility / interactivity check, AND
 *      b) EITHER is interactive, OR is a landmark/heading, OR has a computed
 *         accessible name, OR has a non-generic, non-image role.
 *
 *    Skipped nodes still contribute their children to the output (children
 *    are emitted at the parent's depth, so generic wrappers collapse).
 *
 * 5. Additional exports used by click_ax / type_ax:
 *      window.__wb_ax_lookup(refId) → Element | null
 *      window.__wb_ax_ref(element) → stable refId
 *      window.__wb_ax_release(refId) → void (optional cleanup)
 *      window.__wb_ax_name(element) → the same accessible name used by the tree
 */
(() => {
  if (window.__wb_ax_installed) return;
  window.__wb_ax_installed = true;

  // ── Persistent ref_id registry ──────────────────────────────────────────
  if (!window.__wbElementMap) window.__wbElementMap = Object.create(null);
  if (typeof window.__wbRefCounter !== 'number') window.__wbRefCounter = 0;

  function mintRefScopeId() {
    try {
      const words = new Uint32Array(2);
      globalThis.crypto.getRandomValues(words);
      const value = (BigInt(words[0]) << 32n) | BigInt(words[1]);
      return (value % 1000000000000n).toString().padStart(12, '0');
    } catch {
      const fallback = `${Date.now()}${Math.random().toString().slice(2)}`.replace(/\D/g, '');
      return fallback.slice(-12).padStart(12, '0');
    }
  }

  function ensureRefScope() {
    const pageUrl = String(location.href || '');
    const scope = window.__wbAxRefScope;
    if (!scope || scope.pageUrl !== pageUrl || !/^\d{12}$/.test(scope.id)) {
      // A full navigation gets a fresh isolated world automatically. Reset on
      // SPA route changes too so an old ref can never resolve to a new route's
      // element with the same local traversal number.
      window.__wbElementMap = Object.create(null);
      window.__wbRefCounter = 0;
      window.__wbAxRefScope = { pageUrl, id: mintRefScopeId() };
    }
    return window.__wbAxRefScope;
  }

  function refOrdinal(refId) {
    const scope = ensureRefScope();
    const prefix = `ref_${scope.id}`;
    const value = String(refId || '');
    if (!value.startsWith(prefix)) return null;
    const suffix = value.slice(prefix.length);
    return /^\d+$/.test(suffix) ? Number(suffix) : null;
  }

  const MAX_NAME_LEN = 100;

  // ── Role inference (matches Claude's mapping) ───────────────────────────
  const TAG_ROLES = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'image',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    section: 'region',
    article: 'article',
    aside: 'complementary',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    label: 'label',
  };

  function isEditableRoot(el) {
    if (!el || !el.getAttribute) return false;
    const attr = el.getAttribute('contenteditable');
    if (attr !== null) {
      const normalized = String(attr).trim().toLowerCase();
      if (normalized === '' || normalized === 'true' || normalized === 'plaintext-only') return true;
      if (normalized === 'false') return false;
    }
    // isContentEditable includes inherited editability. Only surface the
    // outer editing host so every nested span is not emitted as a textbox.
    return el.isContentEditable === true && el.parentElement?.isContentEditable !== true;
  }

  // Some high-traffic media sites render their primary actions as plain
  // div/span wrappers with delegated Vue event handlers. They are genuinely
  // clickable, but expose none of the native/ARIA signals used below. Keep
  // this list intentionally narrow and hostname-scoped so generic page
  // containers are not promoted to buttons elsewhere.
  const SITE_INTERACTION_RULES = {
    bilibili: [
      ['.video-like', '点赞'],
      ['.video-coin', '投币'],
      ['.video-fav', '收藏'],
      ['.video-share', '分享'],
      ['.follow-btn', '关注'],
      ['.bpx-player-follow', '关注'],
      ['.reply-box-send', '发布评论'],
    ],
    xiaohongshu: [
      ['.like-wrapper', '点赞'],
      ['.collect-wrapper', '收藏'],
      ['.chat-wrapper', '评论'],
      ['.share-wrapper', '分享'],
      ['.follow-wrapper', '关注'],
      ['.follow-btn', '关注'],
      ['.follow-button', '关注'],
      ['.send-btn', '发布评论'],
      ['.publish-btn', '发布'],
      ['.publish-button', '发布'],
    ],
  };

  function currentSiteInteractionConfig() {
    const hostname = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
    const onHost = (domain) => hostname === domain || hostname.endsWith(`.${domain}`);
    if (onHost('bilibili.com')) return { key: 'bilibili', rules: SITE_INTERACTION_RULES.bilibili };
    if (onHost('xiaohongshu.com')) return { key: 'xiaohongshu', rules: SITE_INTERACTION_RULES.xiaohongshu };
    return { key: '', rules: [] };
  }

  function getSiteInteractionDescriptor(el) {
    if (!el || typeof el.matches !== 'function') return null;
    for (const [selector, label] of currentSiteInteractionConfig().rules) {
      try {
        if (!el.matches(selector)) continue;
      } catch {
        continue;
      }
      const explicit = String(
        el.getAttribute('aria-label') || el.getAttribute('title') || ''
      ).replace(/\s+/g, ' ').trim();
      const rendered = String(el.innerText || el.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 80);
      const name = explicit || (
        rendered && rendered.includes(label) ? rendered
          : rendered ? `${label} ${rendered}` : label
      );
      return { selector, label, name };
    }
    return null;
  }

  window.__wbSiteInteractions = Object.freeze({
    selectors: () => currentSiteInteractionConfig().rules.map(([selector]) => selector),
    describe: getSiteInteractionDescriptor,
    isInteractive: (el) => !!getSiteInteractionDescriptor(el),
    shouldPierceShadowRoots: () => currentSiteInteractionConfig().key === 'bilibili',
  });

  function getRole(el) {
    if (getSiteInteractionDescriptor(el)) return 'button';
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (isEditableRoot(el)) return 'textbox';
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = el.getAttribute('type');
      if (t === 'submit' || t === 'button' || t === 'file') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return TAG_ROLES[tag] || 'generic';
  }

  const NESTED_ACTION_SELECTOR = [
    'a', 'button', 'input', 'select', 'textarea', 'details', 'summary',
    '[onclick]', '[tabindex]', '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="searchbox"]', '[role="combobox"]', '[role="option"]',
    '[role="menuitem"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
  ].join(',');

  function rectsOverlap(a, b) {
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }

  function getVisibleDescendantText(root) {
    const rootRect = root.getBoundingClientRect();
    const parts = [];
    const visit = (parent) => {
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = String(child.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) parts.push(text);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.getAttribute('aria-hidden') === 'true') continue;
        if (!isVisible(child) || !isInViewport(child)) continue;
        if (!rectsOverlap(rootRect, child.getBoundingClientRect())) continue;
        visit(child);
      }
    };
    visit(root);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function getFocusableGenericDescendantName(el) {
    if (getRole(el) !== 'generic' || !el.hasAttribute('tabindex')) return '';
    if (isEditableRoot(el)) return '';
    try {
      if (!isVisible(el) || el.querySelector(NESTED_ACTION_SELECTOR)) return '';
      // Inspect each descendant instead of using innerText: browsers include
      // opacity:0 and offscreen content in innerText, which would leak hidden
      // picker state (or hidden prompt text) into a visible token/chip label.
      const text = getVisibleDescendantText(el);
      if (!text || text.length > MAX_NAME_LEN) return '';
      return text;
    } catch {
      return '';
    }
  }

  // ── Accessible name (matches Claude's priority order) ───────────────────
  function getAccessibleName(el) {
    const tag = el.tagName.toLowerCase();

    const siteInteraction = getSiteInteractionDescriptor(el);
    if (siteInteraction) return siteInteraction.name;

    // <select> — prefer the currently selected option's label.
    if (tag === 'select') {
      const opt = el.querySelector('option[selected]') || (el.options && el.options[el.selectedIndex]);
      if (opt && opt.textContent && opt.textContent.trim()) {
        return opt.textContent.trim();
      }
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    // aria-labelledby: look up the referenced element(s) and concatenate
    // their text. Common on Stripe / design-system-heavy apps where the
    // visible label lives in a sibling element.
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby && labelledby.trim()) {
      try {
        const ids = labelledby.trim().split(/\s+/);
        const parts = [];
        for (const id of ids) {
          const ref = document.getElementById(id);
          if (ref) {
            const t = (ref.innerText || ref.textContent || '').trim();
            if (t) parts.push(t);
          }
        }
        const joined = parts.join(' ').trim();
        if (joined) return joined.length > MAX_NAME_LEN ? joined.substring(0, MAX_NAME_LEN) + '...' : joined;
      } catch (e) {}
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();

    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();

    if (el.id) {
      try {
        const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (byFor && byFor.textContent && byFor.textContent.trim()) {
          return byFor.textContent.trim();
        }
      } catch {}
    }

    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      const valAttr = el.getAttribute('value');
      // Only submit/button/reset use the value as the accessible name — those
      // are clickable buttons where the value IS the label. For text-like
      // inputs we must NOT return el.value, because then a `<input type="text"
      // value="1">` renders in the tree as `textbox "1"`, which looks to the
      // model like a button labeled "1" rather than a text field currently
      // holding "1". formatLine emits the current value separately as a
      // `value="..."` attribute.
      if ((t === 'submit' || t === 'button' || t === 'reset')
          && valAttr && valAttr.trim()) return valAttr.trim();
    }

    // Button/link/summary: prefer direct text children, but fall back to the
    // full innerText when the visible label is buried in nested spans/svgs
    // (common in Stripe/Radix/headless-UI — e.g. a "month(s)" picker trigger
    // wraps its text in <span><span>month(s)</span></span>).
    if (tag === 'button' || tag === 'a' || tag === 'summary') {
      let text = '';
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
      }
      if (text.trim()) return text.trim();
      const deep = (el.innerText || el.textContent || '').trim();
      if (deep) return deep.length > MAX_NAME_LEN ? deep.substring(0, MAX_NAME_LEN) + '...' : deep;
    }

    if (/^h[1-6]$/.test(tag)) {
      const s = el.textContent;
      if (s && s.trim()) return s.trim().substring(0, MAX_NAME_LEN);
    }

    // Images without alt get no name (alt was already handled above).
    if (tag === 'img') return '';

    // For list/menu items and similar pickable nodes, the visible label is
    // almost always inside nested markup (Stripe wraps currency option
    // labels in child spans — "direct text children only" returns empty,
    // which left the model staring at `option [ref_187]` with no clue what
    // currency it was). Use innerText for these roles so the model sees the
    // actual labels.
    const roleAttr = (el.getAttribute('role') || '').toLowerCase();
    const LABEL_FROM_DESCENDANTS_ROLES = new Set([
      'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
      'tab', 'treeitem', 'row', 'gridcell', 'cell', 'listitem',
    ]);
    if (LABEL_FROM_DESCENDANTS_ROLES.has(roleAttr) || tag === 'li') {
      const s = (el.innerText || el.textContent || '').trim();
      if (s) return s.length > MAX_NAME_LEN ? s.substring(0, MAX_NAME_LEN) + '...' : s;
    }

    // Tokenized inputs often replace their real textbox/combobox with a
    // focusable generic wrapper once a value is selected. Gmail recipient
    // chips are one example: the visible contact label lives in a nested
    // span while the actual "To recipients" input becomes 0x0. Preserve the
    // short visible label only for leaf-like wrappers so large composite
    // containers do not absorb all of their descendants' text.
    const focusableGenericName = getFocusableGenericDescendantName(el);
    if (focusableGenericName) return focusableGenericName;

    // Form fields without an explicit label (aria-label, aria-labelledby,
    // placeholder, title, <label for>) often sit next to a small text node or
    // sibling like "Every" / "Price" / "Quantity". Look at the immediate
    // previous sibling (and its parent's preceding text/label) for a short
    // label — without this, Stripe's "Every [1] month(s)" custom-interval
    // input renders as a bare textbox and the model can't tell what it's for.
    if (tag === 'input' || tag === 'textarea' || tag === 'select'
        || roleAttr === 'textbox' || roleAttr === 'searchbox'
        || roleAttr === 'spinbutton' || roleAttr === 'combobox') {
      try {
        const tryText = (node) => {
          if (!node) return '';
          if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').trim();
          if (node.nodeType === Node.ELEMENT_NODE) {
            const t = (node.innerText || node.textContent || '').trim();
            if (t && t.length <= 60) return t;
          }
          return '';
        };
        let sib = el.previousSibling;
        for (let i = 0; i < 4 && sib; i++, sib = sib.previousSibling) {
          const t = tryText(sib);
          if (t) return t.length > MAX_NAME_LEN ? t.substring(0, MAX_NAME_LEN) + '...' : t;
        }
        // Parent-level previous sibling: handles layouts like
        // <div>Every</div><div><input/></div>.
        const parent = el.parentElement;
        if (parent) {
          let psib = parent.previousSibling;
          for (let i = 0; i < 3 && psib; i++, psib = psib.previousSibling) {
            const t = tryText(psib);
            if (t) return t.length > MAX_NAME_LEN ? t.substring(0, MAX_NAME_LEN) + '...' : t;
          }
        }
      } catch {}
    }

    // Fallback: direct text children only, at least 3 chars.
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    if (text.trim() && text.trim().length >= 3) {
      const v = text.trim();
      return v.length > MAX_NAME_LEN ? v.substring(0, MAX_NAME_LEN) + '...' : v;
    }
    return '';
  }

  // ── Visibility ──────────────────────────────────────────────────────────
  function isVisible(el) {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden') return false;
    if (cs.opacity === '0') return false;
    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
    return true;
  }

  function isInViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
  }

  // ── Interactivity / landmark checks ─────────────────────────────────────
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']);
  const LANDMARK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside']);

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (getSiteInteractionDescriptor(el)) return true;
    if (el.getAttribute('onclick') !== null) return true;
    if (el.getAttribute('tabindex') !== null) return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    if (isEditableRoot(el)) return true;
    return false;
  }

  function isLandmark(el) {
    if (LANDMARK_TAGS.has(el.tagName.toLowerCase())) return true;
    return el.getAttribute('role') !== null;
  }

  // ── Skip tags ──────────────────────────────────────────────────────────
  const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript']);

  // Roles worth keeping in 'visible' filter even when non-interactive.
  // A dialog/listbox/menu is important structural context; a generic span
  // with an accessible name usually isn't.
  const USEFUL_NON_INTERACTIVE_ROLES = new Set([
    'dialog', 'alertdialog', 'alert', 'status',
    'listbox', 'menu', 'menubar', 'tablist', 'radiogroup',
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
    'combobox', 'textbox', 'searchbox',
    'heading', 'form', 'main', 'navigation', 'banner', 'contentinfo', 'region', 'complementary',
    'progressbar', 'slider', 'spinbutton',
  ]);

  /**
   * Should this element be INCLUDED in the output? (Its children are still
   * walked regardless — they bubble up to the parent's depth if this node
   * is skipped.)
   */
  function shouldInclude(el, opts) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return false;

    if (opts.filter !== 'all' && el.getAttribute('aria-hidden') === 'true') return false;
    if (opts.filter !== 'all' && !isVisible(el)) return false;

    // The 'visible' default restricts to in-viewport elements, UNLESS we're
    // anchored at a specific refId (then we want the whole subtree).
    if (opts.filter !== 'all' && !opts.refId) {
      if (!isInViewport(el)) return false;
    }

    if (opts.filter === 'interactive') return isInteractive(el);

    const role = getRole(el);

    if (opts.filter === 'visible') {
      // Tight mode for agent consumption: only keep nodes the model can
      // actually ACT on or needs as structural context. Plain spans/divs
      // with an accessible name were the main bloat source on complex
      // apps (Stripe, Notion, etc.) and are almost never the right click
      // target — the interactive ancestor is.
      if (isInteractive(el)) return true;
      if (/^h[1-6]$/.test(el.tagName.toLowerCase())) return true;
      if (USEFUL_NON_INTERACTIVE_ROLES.has(role)) return true;
      return false;
    }

    // opts.filter === 'all' — keep the older, more generous behavior.
    if (isInteractive(el)) return true;
    if (isLandmark(el)) return true;
    if (getAccessibleName(el).length > 0) return true;
    return role !== null && role !== 'generic' && role !== 'image';
  }

  // ── Ref_id management ───────────────────────────────────────────────────
  //
  // Elements keep the same ref_id across calls on one document route. The
  // numeric scope prefix changes across documents and SPA routes, so a local
  // ref counter restart can never alias a target from an older page.
  function getOrMintRef(el) {
    const prefix = `ref_${ensureRefScope().id}`;
    for (const key in window.__wbElementMap) {
      if (window.__wbElementMap[key].deref() === el) return key;
    }
    const key = prefix + (++window.__wbRefCounter);
    window.__wbElementMap[key] = new WeakRef(el);
    return key;
  }

  function sweepDeadRefs() {
    for (const key in window.__wbElementMap) {
      if (!window.__wbElementMap[key].deref()) {
        delete window.__wbElementMap[key];
      }
    }
  }

  // ── Line formatting ────────────────────────────────────────────────────
  function formatLine(el, depth) {
    const role = getRole(el);
    let name = getAccessibleName(el);
    const ref = getOrMintRef(el);

    let line = ' '.repeat(depth) + role;
    if (name) {
      name = name.replace(/\s+/g, ' ').substring(0, MAX_NAME_LEN).replace(/"/g, '\\"');
      line += ' "' + name + '"';
    }
    line += ' [' + ref + ']';

    const href = el.getAttribute('href');
    if (href) line += ' href="' + href + '"';
    const type = el.getAttribute('type');
    if (type) line += ' type="' + type + '"';
    const ph = el.getAttribute('placeholder');
    if (ph) line += ' placeholder="' + ph + '"';

    // Checkbox/radio state is an action-critical value, not decorative
    // metadata. Without it the model has to infer state from a focus ring or
    // screenshot and can accidentally toggle a control back off.
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input'
      ? (el.getAttribute('type') || 'text').toLowerCase()
      : '';
    if (inputType === 'checkbox' || inputType === 'radio') {
      line += ` checked=${el.checked ? 'true' : 'false'}`;
    } else {
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (['checkbox', 'radio', 'switch'].includes(role) || el.hasAttribute('aria-checked')) {
        const ariaChecked = el.getAttribute('aria-checked');
        if (ariaChecked != null) line += ` checked=${ariaChecked}`;
      }
    }

    // Surface the current value for text-like inputs/textareas so the model
    // can see what's already filled in. Skipped for submit/button/reset/file
    // (value is the label there), checkboxes/radios, and when the value
    // already matches the rendered name.
    if (tag === 'input' || tag === 'textarea') {
      const inputType = (el.getAttribute('type') || 'text').toLowerCase();
      const skipValueTypes = new Set(['submit', 'button', 'reset', 'file', 'checkbox', 'radio', 'image', 'hidden', 'color', 'range', 'password']);
      if (!skipValueTypes.has(inputType)) {
        const v = (el.value == null ? '' : String(el.value));
        if (v && v !== name) {
          const trimmed = v.length > 60 ? v.substring(0, 60) + '...' : v;
          line += ' value="' + trimmed.replace(/"/g, '\\"') + '"';
        }
      }
    } else if (isEditableRoot(el)) {
      const v = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (v && v !== name) {
        const trimmed = v.length > 60 ? v.substring(0, 60) + '...' : v;
        line += ' value="' + trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      }
    }

    return line;
  }

  function formatOption(opt, depth) {
    const ref = getOrMintRef(opt);
    const rawName = opt.textContent ? opt.textContent.trim() : '';
    const name = rawName.replace(/\s+/g, ' ').substring(0, MAX_NAME_LEN).replace(/"/g, '\\"');
    let line = ' '.repeat(depth) + 'option';
    if (name) line += ' "' + name + '"';
    line += ' [' + ref + ']';
    if (opt.selected) line += ' (selected)';
    if (opt.value && opt.value !== rawName) {
      line += ' value="' + opt.value.replace(/"/g, '\\"') + '"';
    }
    return line;
  }

  // ── Walker ─────────────────────────────────────────────────────────────
  function walk(el, depth, opts, lines) {
    if (depth > opts.maxDepth) return;
    if (!el || !el.tagName) return;

    // Skip nodes already emitted in the priority/action prelude.
    if (depth > 0 && opts._skipPrioritySet && opts._skipPrioritySet.has(el)) return;

    // Skip nodes already emitted in the hoisted-overlay prelude. depth>0
    // guard ensures we still enter the overlay itself when it's the
    // explicit walk root.
    if (depth > 0 && opts._skipOverlaySet && opts._skipOverlaySet.has(el)) return;

    // An element anchored via refId is always included at depth 0, even if
    // it wouldn't normally pass the include filter.
    const included = shouldInclude(el, opts) || (opts.refId != null && depth === 0);

    if (included) {
      lines.push(formatLine(el, depth));

      if (el.tagName.toLowerCase() === 'select' && el.options) {
        for (const opt of el.options) {
          lines.push(formatOption(opt, depth + 1));
        }
      }
    }

    if (el.children && depth < opts.maxDepth) {
      const nextDepth = included ? depth + 1 : depth;
      for (const child of el.children) {
        walk(child, nextDepth, opts, lines);
      }
      // Bilibili's current comment system is a hierarchy of open custom-
      // element shadow roots. Traverse it here so the comment editor and
      // Publish/Reply buttons receive the same stable ref_ids as light DOM.
      if (window.__wbSiteInteractions.shouldPierceShadowRoots() && el.shadowRoot) {
        for (const child of el.shadowRoot.children || []) {
          walk(child, nextDepth, opts, lines);
        }
      }
    }
  }

  // ── Public: build the tree ──────────────────────────────────────────────
  function isTextEntrySurface(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      return !new Set(['submit', 'button', 'reset', 'file', 'checkbox', 'radio', 'image', 'hidden', 'color', 'range']).has(type);
    }
    if (role === 'textbox' || role === 'searchbox') return true;
    if (isEditableRoot(el)) return true;
    return false;
  }

  function isLikelySubmitSurface(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (tag !== 'button' && tag !== 'input' && role !== 'button') return false;
    const name = (getAccessibleName(el) || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'submit' || /\b(send|submit|post|reply)\b/.test(`${name} ${aria}`);
  }

  function isPriorityActionSurface(el) {
    if (!el || !el.tagName || !el.isConnected) return false;
    try {
      if (!isVisible(el) || !isInViewport(el)) return false;
    } catch (e) {
      return false;
    }
    return isTextEntrySurface(el) || isLikelySubmitSurface(el);
  }

  function hasCollectedAncestor(el, collected) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (collected.has(p)) return true;
    }
    return false;
  }

  function collectPriorityActionSurfaces() {
    const collected = new WeakSet();
    const out = [];
    const add = (el) => {
      if (!isPriorityActionSurface(el)) return;
      if (collected.has(el) || hasCollectedAncestor(el, collected)) return;
      collected.add(el);
      out.push(el);
    };

    try {
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) add(active);
    } catch (e) {}

    const selectors = [
      'textarea',
      'input',
      '[contenteditable]:not([contenteditable="false"])',
      '[role="textbox"]',
      '[role="searchbox"]',
      'button',
      '[role="button"]',
      'input[type="submit"]',
      'input[type="button"]',
    ];
    try {
      for (const el of document.querySelectorAll(selectors.join(','))) {
        add(el);
        if (out.length >= 20) break;
      }
    } catch (e) {}

    return { elements: out, set: collected };
  }

  function sliceTreePage(output, lines, chunkSize, page) {
    const safePage = Math.max(1, Math.floor(Number(page) || 1));
    const chunks = [];
    let current = [];
    let currentLen = 0;
    let startNode = 0;
    let charStart = 0;
    let cursor = 0;

    for (const line of lines) {
      const addLen = line.length + (current.length ? 1 : 0);
      if (current.length && currentLen + addLen > chunkSize) {
        const text = current.join('\n');
        chunks.push({
          text,
          startNode,
          endNode: startNode + current.length,
          charStart,
          charEnd: charStart + text.length,
        });
        cursor = charStart + text.length + 1;
        startNode += current.length;
        charStart = cursor;
        current = [line];
        currentLen = line.length;
      } else {
        current.push(line);
        currentLen += addLen;
      }
    }
    if (current.length || !chunks.length) {
      const text = current.join('\n');
      chunks.push({
        text,
        startNode,
        endNode: startNode + current.length,
        charStart,
        charEnd: charStart + text.length,
      });
    }

    const chunk = chunks[safePage - 1];
    if (!chunk) {
      return {
        pageContent: `[tree page ${safePage}: no content at this page. The rendered tree is ${output.length} chars; request an earlier page.]`,
        truncated: false,
        hasMore: false,
        page: safePage,
        totalChars: output.length,
        chunkStart: output.length,
        chunkEnd: output.length,
      };
    }

    let pageContent = chunk.text;
    const hasMore = safePage < chunks.length;
    const omittedBefore = chunk.startNode;
    const omittedAfter = Math.max(0, lines.length - chunk.endNode);

    if (safePage > 1) {
      pageContent = `[tree page ${safePage}; ${omittedBefore} earlier nodes omitted]\n${pageContent}`;
    }
    if (hasMore) {
      pageContent += `\n[tree truncated: ${omittedAfter} more nodes omitted to stay under ${chunkSize} chars. Before scrolling to find a visible control, call get_accessibility_tree({filter:"visible", page:${safePage + 1}}) for the next chunk.]`;
    }

    return {
      pageContent,
      truncated: hasMore,
      hasMore,
      page: safePage,
      nextPage: hasMore ? safePage + 1 : undefined,
      totalChars: output.length,
      chunkStart: chunk.charStart,
      chunkEnd: chunk.charEnd,
    };
  }

  function generateAccessibilityTree(filter, maxDepth, maxChars, refId, page) {
    try {
      ensureRefScope();
      const effFilter = filter || 'all';
      // Tighter defaults for the 'visible' / 'interactive' modes so small
      // models don't drown in 18K-token Stripe trees. Callers can still
      // override by passing explicit values.
      const defaultDepth = effFilter === 'all' ? 15 : 10;
      const defaultChars = effFilter === 'visible' ? 3000
                          : effFilter === 'interactive' ? 3500
                          : null; // 'all' has no default cap (explicit only)
      const opts = {
        filter: effFilter,
        maxDepth: maxDepth != null ? maxDepth : defaultDepth,
        refId: refId || null,
      };
      const effMaxChars = maxChars != null ? maxChars : defaultChars;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const lines = [];

      if (refId) {
        const weak = window.__wbElementMap[refId];
        if (!weak) {
          return {
            error: `Element with ref_id '${refId}' not found. It may have been removed from the page. Call get_accessibility_tree without ref_id to get the current page state.`,
            pageContent: '',
            viewport,
          };
        }
        const el = weak.deref();
        if (!el) {
          delete window.__wbElementMap[refId];
          return {
            error: `Element with ref_id '${refId}' no longer exists. It may have been removed from the page. Call get_accessibility_tree without ref_id to get the current page state.`,
            pageContent: '',
            viewport,
          };
        }
        walk(el, 0, opts, lines);
      } else if (document.body) {
        // Hoist "overlay" surfaces (open listboxes, menus, dialogs,
        // alertdialogs, expanded comboboxes, aria-modal containers) to the
        // TOP of the tree output. Portals often render these as children of
        // <body> positioned AFTER lots of base page content, which means a
        // DOM-order walk under soft-truncation commonly misses them entirely.
        // Without this, the model can't see the currency picker, timezone
        // picker, confirmation dialog, etc. that just opened in response to
        // its last click. Emitting them first guarantees they survive any
        // later truncation.
        const overlaySelectors = [
          '[role=listbox]',
          '[role=menu]',
          '[role=dialog]',
          '[role=alertdialog]',
          '[aria-modal="true"]',
          '[role=combobox][aria-expanded="true"]',
          'dialog[open]',
        ];
        const overlayEls = [];
        const seen = new WeakSet();
        try {
          for (const sel of overlaySelectors) {
            const nodes = document.querySelectorAll(sel);
            for (const n of nodes) {
              if (seen.has(n)) continue;
              if (!n.isConnected) continue;
              // Skip if ancestor already collected — avoids emitting a
              // nested listbox twice when its ancestor dialog is also hit.
              let ancIsOverlay = false;
              for (let p = n.parentElement; p; p = p.parentElement) {
                if (seen.has(p)) { ancIsOverlay = true; break; }
              }
              if (ancIsOverlay) continue;
              // Quick visibility gate — don't emit hidden overlay shells.
              try {
                const r = n.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) continue;
                const s = window.getComputedStyle(n);
                if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) continue;
              } catch (e) { continue; }
              seen.add(n);
              overlayEls.push(n);
            }
          }
        } catch (e) {}
        if (overlayEls.length) {
          lines.push('[open overlays — rendered first so they survive truncation]');
          for (const n of overlayEls) {
            walk(n, 0, opts, lines);
          }
          lines.push('[/open overlays]');
          opts._skipOverlaySet = seen;
        }
        if (effFilter === 'visible') {
          const priority = collectPriorityActionSurfaces();
          if (priority.elements.length) {
            lines.push('[priority action surfaces - editable/focused/submit controls rendered first]');
            for (const n of priority.elements) {
              lines.push(formatLine(n, 0));
            }
            lines.push('[/priority action surfaces]');
            opts._skipPrioritySet = priority.set;
          }
        }
        walk(document.body, 0, opts, lines);
      }

      sweepDeadRefs();

      const output = lines.join('\n');
      if (effMaxChars != null && page != null && Math.floor(Number(page) || 1) > 1) {
        return { ...sliceTreePage(output, lines, effMaxChars, page), viewport };
      }
      // For 'visible' / 'interactive', truncate gracefully on overflow —
      // small models prefer a partial tree to a hard error. For 'all'
      // with an explicit maxChars (caller opted in), we used to return a
      // hard error + empty pageContent, which wasted a round-trip every
      // time. Now we degrade in two steps:
      //   1. Slice the first effMaxChars worth of nodes and return that,
      //      with `autoDegraded:true` + `truncated:true` + `hasMore:true`
      //      so the caller knows to either accept the slice or call again
      //      with a smaller maxDepth / a refId anchor.
      //   2. Only return a hard error when even the first page would be
      //      empty (chunkSize too small).
      if (effMaxChars != null && output.length > effMaxChars) {
        if (filter && filter !== 'all' && maxChars == null) {
          return { ...sliceTreePage(output, lines, effMaxChars, page), viewport };
        }
        const sliced = sliceTreePage(output, lines, effMaxChars, page);
        if (sliced.pageContent && !sliced.pageContent.startsWith('[tree page')) {
          let hint = `Tree was ${output.length} chars; auto-sliced to fit ${effMaxChars}. `;
          if (sliced.hasMore) {
            hint += `Call again with page:${sliced.nextPage} for the next slice, OR pass a smaller maxDepth (e.g. ${Math.max(3, (opts.maxDepth || 15) - 5)}) or a refId to anchor on a specific subtree.`;
          }
          return {
            ...sliced,
            viewport,
            autoDegraded: true,
            notice: hint,
          };
        }
        let hint = `Output exceeds ${effMaxChars} character limit (${output.length} characters). `;
        if (refId) {
          hint += 'The specified element has too much content. Try a smaller maxDepth or a more specific child element.';
        } else if (maxDepth !== undefined) {
          hint += 'Try a smaller maxDepth or use refId to focus on a specific element.';
        } else {
          hint += 'Try a maxDepth (e.g., maxDepth: 5) or use refId to focus on a specific element.';
        }
        return { error: hint, pageContent: '', viewport };
      }

      return { pageContent: output, viewport };
    } catch (e) {
      return {
        error: 'Error generating accessibility tree: ' + (e && e.message || 'Unknown error'),
        pageContent: '',
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    }
  }

  // ── Public: lookup by ref_id (used by click_ax / type_ax) ──────────────
  function lookup(refId) {
    if (refOrdinal(refId) == null) return null;
    const weak = window.__wbElementMap[refId];
    if (!weak) return null;
    const el = weak.deref();
    if (!el || !el.isConnected) {
      delete window.__wbElementMap[refId];
      return null;
    }
    return el;
  }

  // ── Public: suggest nearby refs when the model asks for a bogus one ─────
  //
  // When a tool call fails with "ref_id not found", we want to give the model
  // back an actionable hint: what refs DO exist near the one it asked for?
  //
  // Strategy:
  //  • Parse the numeric suffix of the requested ref (e.g. "ref_11" → 11).
  //  • Sort all currently-live refs by |refNum - target| ascending.
  //  • Return up to `limit` refs with their role + accessible name.
  //  • If the model asked for a plausibly-typed ref (text field), promote
  //    interactive text-entry refs to the top of the suggestions.
  function suggestNearRefs(requestedRefId, limit) {
    const cap = typeof limit === 'number' ? limit : 6;
    const targetNum = refOrdinal(requestedRefId);
    const live = [];
    for (const key in window.__wbElementMap) {
      const weak = window.__wbElementMap[key];
      const el = weak && weak.deref();
      if (!el) continue;
      try {
        if (!el.isConnected) continue;
        if (!isVisible(el)) continue;
      } catch { continue; }
      const n = refOrdinal(key) || 0;
      const role = getRole(el);
      const name = getAccessibleName(el) || '';
      const interactive = isInteractive(el);
      live.push({ ref: key, n, role, name, interactive });
    }
    // Ranking strategy depends on what the model asked for:
    //
    //  • If the request is a well-formed ref_N: sort by numeric distance to
    //    N (interactive ties first). This points the model at nearby refs
    //    that actually exist — useful when it hallucinated ref_11 right
    //    beside ref_10/ref_12.
    //
    //  • If the request is bogus (DOM id, placeholder word, garbage): sort
    //    by ref-number DESCENDING, preferring refs that have an accessible
    //    name. The highest-numbered live refs are the most recently minted
    //    by the tree walker — almost always the newly-appeared listbox /
    //    dialog / options the model actually wants to reach.
    if (targetNum != null) {
      live.sort((a, b) => {
        if (a.interactive !== b.interactive) return a.interactive ? -1 : 1;
        return Math.abs(a.n - targetNum) - Math.abs(b.n - targetNum);
      });
    } else {
      live.sort((a, b) => {
        const aNamed = a.name ? 1 : 0;
        const bNamed = b.name ? 1 : 0;
        if (aNamed !== bNamed) return bNamed - aNamed;          // named first
        if (a.interactive !== b.interactive) return a.interactive ? -1 : 1;
        return b.n - a.n;                                        // newest first
      });
    }
    return live.slice(0, cap).map(x => ({
      ref: x.ref,
      role: x.role,
      name: x.name.length > 40 ? x.name.slice(0, 40) + '…' : x.name,
      interactive: x.interactive,
    }));
  }

  function generateAccessibilitySubtree(rootElement, filter, maxDepth, maxChars, page) {
    if (!rootElement || rootElement.nodeType !== 1 || !rootElement.isConnected) {
      return {
        error: 'Accessibility subtree root is no longer available.',
        pageContent: '',
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    }
    return generateAccessibilityTree(filter, maxDepth, maxChars, getOrMintRef(rootElement), page);
  }

  window.__generateAccessibilityTree = generateAccessibilityTree;
  window.__generateAccessibilitySubtree = generateAccessibilitySubtree;
  window.__wb_ax_lookup = lookup;
  window.__wb_ax_ref = getOrMintRef;
  window.__wb_ax_name = getAccessibleName;
  window.__wb_ax_suggest = suggestNearRefs;
})();
