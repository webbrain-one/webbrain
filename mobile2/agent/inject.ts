/**
 * PAGE_SCRIPT — runs inside every WebView page (via
 * `injectedJavaScriptBeforeContentLoaded`). Provides:
 *
 *   1. `window.__generateAccessibilityTree(...)` — the same AX-tree builder
 *      used by the Chrome and Firefox extensions, ported verbatim.
 *      See src/chrome/src/content/accessibility-tree.js for the source of
 *      truth — this file mirrors it. KEEP IN SYNC when that file changes.
 *
 *   2. `window.__wb_ax_lookup(ref_id)` and `__wb_ax_suggest(...)` — used by
 *      the click/type handlers below.
 *
 *   3. `window.__wbHandle({id, method, params})` — the RPC dispatcher called
 *      from the React Native side via `injectJavaScript`. Each handler posts
 *      a `{id, ok, result|error}` JSON message back through
 *      `window.ReactNativeWebView.postMessage`.
 *
 * Methods exposed via __wbHandle:
 *   - get_accessibility_tree({filter, maxDepth, maxChars, ref_id})
 *   - click_ax({ref_id})
 *   - type_ax({ref_id, text, clear})
 *   - get_page_meta()                   → {url, title}
 *
 * The script is wrapped in a guard so re-injection on subsequent loads is
 * a no-op. Navigations replay the script before content loads, but a SPA
 * route change keeps the same window — the guard prevents double-install.
 */
export const PAGE_SCRIPT = String.raw`
(function(){
  if (window.__wb_page_script_installed) return;
  window.__wb_page_script_installed = true;

  // ─── AX TREE (port of src/chrome/src/content/accessibility-tree.js) ───
  (() => {
    if (window.__wb_ax_installed) return;
    window.__wb_ax_installed = true;

    if (!window.__wbElementMap) window.__wbElementMap = Object.create(null);
    if (typeof window.__wbRefCounter !== 'number') window.__wbRefCounter = 0;

    const MAX_NAME_LEN = 100;

    const TAG_ROLES = {
      a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
      h1: 'heading', h2: 'heading', h3: 'heading',
      h4: 'heading', h5: 'heading', h6: 'heading',
      img: 'image', nav: 'navigation', main: 'main',
      header: 'banner', footer: 'contentinfo', section: 'region',
      article: 'article', aside: 'complementary', form: 'form',
      table: 'table', ul: 'list', ol: 'list', li: 'listitem', label: 'label',
    };

    function getRole(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
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

    function getAccessibleName(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const opt = el.querySelector('option[selected]') || (el.options && el.options[el.selectedIndex]);
        if (opt && opt.textContent && opt.textContent.trim()) return opt.textContent.trim();
      }
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
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
          const byFor = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (byFor && byFor.textContent && byFor.textContent.trim()) return byFor.textContent.trim();
        } catch {}
      }
      if (tag === 'input') {
        const t = (el.getAttribute('type') || '').toLowerCase();
        const valAttr = el.getAttribute('value');
        if ((t === 'submit' || t === 'button' || t === 'reset') && valAttr && valAttr.trim()) return valAttr.trim();
      }
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
      if (tag === 'img') return '';
      const roleAttr = (el.getAttribute('role') || '').toLowerCase();
      const LABEL_FROM_DESCENDANTS_ROLES = new Set([
        'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
        'tab', 'treeitem', 'row', 'gridcell', 'cell', 'listitem',
      ]);
      if (LABEL_FROM_DESCENDANTS_ROLES.has(roleAttr) || tag === 'li') {
        const s = (el.innerText || el.textContent || '').trim();
        if (s) return s.length > MAX_NAME_LEN ? s.substring(0, MAX_NAME_LEN) + '...' : s;
      }
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

    const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']);
    const LANDMARK_TAGS = new Set(['h1','h2','h3','h4','h5','h6','nav','main','header','footer','section','article','aside']);

    function isInteractive(el) {
      const tag = el.tagName.toLowerCase();
      if (INTERACTIVE_TAGS.has(tag)) return true;
      if (el.getAttribute('onclick') !== null) return true;
      if (el.getAttribute('tabindex') !== null) return true;
      const role = el.getAttribute('role');
      if (role === 'button' || role === 'link') return true;
      if (el.getAttribute('contenteditable') === 'true') return true;
      return false;
    }
    function isLandmark(el) {
      if (LANDMARK_TAGS.has(el.tagName.toLowerCase())) return true;
      return el.getAttribute('role') !== null;
    }

    const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript']);
    const USEFUL_NON_INTERACTIVE_ROLES = new Set([
      'dialog','alertdialog','alert','status','listbox','menu','menubar',
      'tablist','radiogroup','option','menuitem','menuitemcheckbox',
      'menuitemradio','tab','combobox','textbox','searchbox','heading',
      'form','main','navigation','banner','contentinfo','region',
      'complementary','progressbar','slider','spinbutton',
    ]);

    function shouldInclude(el, opts) {
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return false;
      if (opts.filter !== 'all' && el.getAttribute('aria-hidden') === 'true') return false;
      if (opts.filter !== 'all' && !isVisible(el)) return false;
      if (opts.filter !== 'all' && !opts.refId) {
        if (!isInViewport(el)) return false;
      }
      if (opts.filter === 'interactive') return isInteractive(el);
      const role = getRole(el);
      if (opts.filter === 'visible') {
        if (isInteractive(el)) return true;
        if (/^h[1-6]$/.test(tag)) return true;
        if (USEFUL_NON_INTERACTIVE_ROLES.has(role)) return true;
        return false;
      }
      if (isInteractive(el)) return true;
      if (isLandmark(el)) return true;
      if (getAccessibleName(el).length > 0) return true;
      return role !== null && role !== 'generic' && role !== 'image';
    }

    function getOrMintRef(el) {
      for (const key in window.__wbElementMap) {
        if (window.__wbElementMap[key].deref() === el) return key;
      }
      const key = 'ref_' + (++window.__wbRefCounter);
      window.__wbElementMap[key] = new WeakRef(el);
      return key;
    }
    function sweepDeadRefs() {
      for (const key in window.__wbElementMap) {
        if (!window.__wbElementMap[key].deref()) delete window.__wbElementMap[key];
      }
    }

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
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        const inputType = (el.getAttribute('type') || 'text').toLowerCase();
        const skipValueTypes = new Set(['submit','button','reset','file','checkbox','radio','image','hidden','color','range','password']);
        if (!skipValueTypes.has(inputType)) {
          const v = (el.value == null ? '' : String(el.value));
          if (v && v !== name) {
            const trimmed = v.length > 60 ? v.substring(0, 60) + '...' : v;
            line += ' value="' + trimmed.replace(/"/g, '\\"') + '"';
          }
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
      if (opt.value && opt.value !== rawName) line += ' value="' + opt.value.replace(/"/g, '\\"') + '"';
      return line;
    }

    function walk(el, depth, opts, lines) {
      if (depth > opts.maxDepth) return;
      if (!el || !el.tagName) return;
      if (depth > 0 && opts._skipOverlaySet && opts._skipOverlaySet.has(el)) return;
      const included = shouldInclude(el, opts) || (opts.refId != null && depth === 0);
      if (included) {
        lines.push(formatLine(el, depth));
        if (el.tagName.toLowerCase() === 'select' && el.options) {
          for (const opt of el.options) lines.push(formatOption(opt, depth + 1));
        }
      }
      if (el.children && depth < opts.maxDepth) {
        const nextDepth = included ? depth + 1 : depth;
        for (const child of el.children) walk(child, nextDepth, opts, lines);
      }
    }

    function generateAccessibilityTree(filter, maxDepth, maxChars, refId) {
      try {
        const effFilter = filter || 'all';
        const defaultDepth = effFilter === 'all' ? 15 : 10;
        const defaultChars = effFilter === 'visible' ? 3000
                            : effFilter === 'interactive' ? 3500
                            : null;
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
          if (!weak) return { error: 'Element with ref_id ' + refId + ' not found.', pageContent: '', viewport };
          const el = weak.deref();
          if (!el) {
            delete window.__wbElementMap[refId];
            return { error: 'Element with ref_id ' + refId + ' no longer exists.', pageContent: '', viewport };
          }
          walk(el, 0, opts, lines);
        } else if (document.body) {
          const overlaySelectors = [
            '[role=listbox]','[role=menu]','[role=dialog]','[role=alertdialog]',
            '[aria-modal="true"]','[role=combobox][aria-expanded="true"]','dialog[open]',
          ];
          const overlayEls = [];
          const seen = new WeakSet();
          try {
            for (const sel of overlaySelectors) {
              const nodes = document.querySelectorAll(sel);
              for (const n of nodes) {
                if (seen.has(n)) continue;
                if (!n.isConnected) continue;
                let ancIsOverlay = false;
                for (let p = n.parentElement; p; p = p.parentElement) {
                  if (seen.has(p)) { ancIsOverlay = true; break; }
                }
                if (ancIsOverlay) continue;
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
            for (const n of overlayEls) walk(n, 0, opts, lines);
            lines.push('[/open overlays]');
            opts._skipOverlaySet = seen;
          }
          walk(document.body, 0, opts, lines);
        }
        sweepDeadRefs();
        const output = lines.join('\n');
        if (effMaxChars != null && output.length > effMaxChars) {
          if (filter && filter !== 'all' && maxChars == null) {
            let truncated = output.slice(0, effMaxChars);
            const lastNl = truncated.lastIndexOf('\n');
            if (lastNl > 0) truncated = truncated.slice(0, lastNl);
            const omitted = lines.length - truncated.split('\n').length;
            truncated += '\n[tree truncated: ' + omitted + ' more nodes omitted]';
            return { pageContent: truncated, viewport, truncated: true };
          }
          return { error: 'Output exceeds ' + effMaxChars + ' chars.', pageContent: '', viewport };
        }
        return { pageContent: output, viewport };
      } catch (e) {
        return {
          error: 'Error generating accessibility tree: ' + (e && e.message || 'Unknown'),
          pageContent: '',
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      }
    }

    function lookup(refId) {
      const weak = window.__wbElementMap[refId];
      if (!weak) return null;
      const el = weak.deref();
      if (!el) { delete window.__wbElementMap[refId]; return null; }
      return el;
    }

    function suggestNearRefs(requestedRefId, limit) {
      const cap = typeof limit === 'number' ? limit : 6;
      const m = /^ref_(\d+)$/.exec(String(requestedRefId || ''));
      const targetNum = m ? parseInt(m[1], 10) : null;
      const live = [];
      for (const key in window.__wbElementMap) {
        const weak = window.__wbElementMap[key];
        const el = weak && weak.deref();
        if (!el) continue;
        try { if (!el.isConnected || !isVisible(el)) continue; } catch { continue; }
        const km = /^ref_(\d+)$/.exec(key);
        const n = km ? parseInt(km[1], 10) : 0;
        live.push({ ref: key, n, role: getRole(el), name: getAccessibleName(el) || '', interactive: isInteractive(el) });
      }
      if (targetNum != null) {
        live.sort((a, b) => {
          if (a.interactive !== b.interactive) return a.interactive ? -1 : 1;
          return Math.abs(a.n - targetNum) - Math.abs(b.n - targetNum);
        });
      } else {
        live.sort((a, b) => {
          const aN = a.name ? 1 : 0, bN = b.name ? 1 : 0;
          if (aN !== bN) return bN - aN;
          if (a.interactive !== b.interactive) return a.interactive ? -1 : 1;
          return b.n - a.n;
        });
      }
      return live.slice(0, cap).map(x => ({
        ref: x.ref, role: x.role,
        name: x.name.length > 40 ? x.name.slice(0, 40) + '…' : x.name,
        interactive: x.interactive,
      }));
    }

    window.__generateAccessibilityTree = generateAccessibilityTree;
    window.__wb_ax_lookup = lookup;
    window.__wb_ax_suggest = suggestNearRefs;
  })();

  // ─── RPC dispatcher ──────────────────────────────────────────────────
  function reply(id, ok, payload) {
    try {
      const msg = ok ? { id: id, ok: true, result: payload } : { id: id, ok: false, error: String(payload) };
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    } catch (e) {
      try {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ id: id, ok: false, error: String(e && e.message || e) }));
      } catch {}
    }
  }

  function clickHandler(p) {
    const ref_id = p && p.ref_id;
    if (typeof ref_id !== 'string') return { success: false, error: 'ref_id (string) required' };
    if (typeof window.__wb_ax_lookup !== 'function') return { success: false, error: 'AX tree not ready' };
    const el = window.__wb_ax_lookup(ref_id);
    if (!el) {
      let suggestions = [];
      try { if (typeof window.__wb_ax_suggest === 'function') suggestions = window.__wb_ax_suggest(ref_id, 6); } catch {}
      return { success: false, error: 'ref_id ' + ref_id + ' not found. Re-read the accessibility tree.', suggestions: suggestions };
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    try { el.focus({ preventScroll: true }); } catch {}
    const r = el.getBoundingClientRect();
    el.click();
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    let isTextEntry = false;
    if (tag === 'textarea') isTextEntry = true;
    else if (tag === 'input') {
      const inputType = (el.type || 'text').toLowerCase();
      const nonText = new Set(['checkbox','radio','file','submit','button','reset','image','color','range','hidden']);
      isTextEntry = !nonText.has(inputType);
    } else if (el.isContentEditable) isTextEntry = true;
    const resp = {
      success: true, method: 'click_ax', ref_id: ref_id, tag: tag,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href) resp.href = href;
    }
    if (isTextEntry) {
      resp.focused = true;
      resp.next_required = 'type_ax';
      resp.hint = 'Element is now focused. Next call MUST be type_ax({ref_id: "' + ref_id + '", text: "..."}).';
    }
    return resp;
  }

  function typeHandler(p) {
    const ref_id = p && p.ref_id;
    const text = p && p.text;
    const clear = !!(p && p.clear);
    if (typeof ref_id !== 'string') return { success: false, error: 'ref_id (string) required' };
    if (typeof text !== 'string') return { success: false, error: 'text (string) required' };
    if (typeof window.__wb_ax_lookup !== 'function') return { success: false, error: 'AX tree not ready' };
    const el = window.__wb_ax_lookup(ref_id);
    if (!el) return { success: false, error: 'ref_id ' + ref_id + ' not found.' };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    try { el.focus({ preventScroll: true }); } catch {}
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
      return { success: true, method: 'type_ax_contenteditable', ref_id: ref_id };
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.tagName === 'INPUT') {
        const inputType = (el.type || 'text').toLowerCase();
        const nonTypeable = new Set(['checkbox','radio','file','submit','button','reset','image','color','range','hidden']);
        if (nonTypeable.has(inputType)) {
          return { success: false, error: 'Input type ' + inputType + ' is not text-typeable. Use click_ax instead.' };
        }
      }
      if (clear) el.value = '';
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = desc && desc.set;
      const newVal = (clear ? '' : (el.value || '')) + text;
      if (setter) setter.call(el, newVal); else el.value = newVal;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'type_ax_input', ref_id: ref_id };
    }
    return { success: false, error: 'Element is not typeable (tag=' + el.tagName + ').' };
  }

  function pageMetaHandler() {
    return {
      url: window.location.href,
      title: document.title || '',
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  window.__wbHandle = function(msg) {
    const id = msg && msg.id;
    const method = msg && msg.method;
    const params = (msg && msg.params) || {};
    try {
      if (method === 'get_accessibility_tree') {
        const r = window.__generateAccessibilityTree(params.filter, params.maxDepth, params.maxChars, params.ref_id);
        return reply(id, true, r);
      }
      if (method === 'click_ax') return reply(id, true, clickHandler(params));
      if (method === 'type_ax')  return reply(id, true, typeHandler(params));
      if (method === 'get_page_meta') return reply(id, true, pageMetaHandler());
      return reply(id, false, 'Unknown method: ' + method);
    } catch (e) {
      reply(id, false, e && e.message || String(e));
    }
  };
})();
true;
`;
