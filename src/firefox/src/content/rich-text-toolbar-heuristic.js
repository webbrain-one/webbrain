/**
 * Rich-text formatting-toolbar heuristic — the single source of truth.
 *
 * Decides whether an element the agent is about to edit is a formatting
 * control (font size/family, style preset, color, link) belonging to a
 * rich-text editor's toolbar, rather than the editor body itself. The
 * background pairs this structural verdict with a target-annotated screenshot
 * before it changes any tool result.
 *
 * This lived in three places — chrome content.js, firefox content.js, and an
 * inlined Runtime.callFunctionOn string in cdp-client.js — with nothing
 * catching divergence, so the same element could score differently depending
 * on whether dispatch went through CDP or the content script. It is one file
 * now:
 *
 *   - Content scripts load it before content.js (manifest content_scripts)
 *     and call it through globalThis.__wbRichTextToolbarHeuristic.
 *   - cdp-client.js fetches this file's source and captures the resulting API
 *     in a function-local binding inside the page's main world.
 *
 * Because the main world has no access to the content script's isolated-world
 * ref registry, ref minting is injected by the caller (`axRef`) rather than
 * read from a global. When it is absent the candidate still scores; it simply
 * carries no refs, and blocking falls back to regionKey.
 *
 * The password-field facts the sign-in password check reads (passwordFieldFacts)
 * live here for the same reason: content.js and the CDP probe once counted a
 * form's fields with two copies of the same code, which had to be aligned.
 *
 * Keep this file free of content.js internals — it must stay evaluable on its
 * own in a bare page context.
 */
var __wbRichTextToolbarHeuristic = (() => {

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

  function _isComposedAncestor(ancestor, node) {
    let cur = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = _composedParent(cur);
    }
    return false;
  }

  function _composedClosestElement(el, selector) {
    let cur = el;
    while (cur) {
      try {
        if (cur.nodeType === 1 && cur.matches(selector)) return cur;
      } catch {}
      cur = _composedParent(cur);
    }
    return null;
  }

  function _hasComposedClosest(el, selector) {
    return !!_composedClosestElement(el, selector);
  }

  // Ref minting is per-call: the content script passes window.__wb_ax_ref,
  // the CDP main-world path has no registry and passes nothing.
  let _axRef = null;

  function _visibleFieldContextNode(node) {
    try {
      if (!node || !node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    } catch { return false; }
  }

  function _ariaLabelledByText(el) {
    try {
      const ids = String(el?.getAttribute?.('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return null;
      const root = el?.getRootNode?.() || document;
      const findById = id => {
        try {
          if (typeof root.getElementById === 'function') {
            const local = root.getElementById(id);
            if (local) return local;
          }
        } catch {}
        try {
          const escaped = globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
          const local = root.querySelector?.(`#${escaped}`);
          if (local) return local;
        } catch {}
        try { return root === document ? null : document.getElementById(id); } catch { return null; }
      };
      const text = ids
        .map(findById)
        .filter(Boolean)
        .map(node => String(node.textContent || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text ? text.slice(0, 120) : null;
    } catch { return null; }
  }

  function _richTextToolbarQueryAcrossOpenShadowRoots(scope, selector, limit = 200) {
    const matches = [];
    const roots = [scope];
    const seenRoots = new Set();
    let scannedHosts = 0;
    while (roots.length && seenRoots.size < 128 && matches.length < limit && scannedHosts < 5000) {
      const root = roots.shift();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      try {
        for (const match of root.querySelectorAll?.(selector) || []) {
          if (!matches.includes(match)) matches.push(match);
          if (matches.length >= limit) break;
        }
        for (const host of root.querySelectorAll?.('*') || []) {
          scannedHosts += 1;
          if (host.shadowRoot && !seenRoots.has(host.shadowRoot)) roots.push(host.shadowRoot);
          if (scannedHosts >= 5000) break;
        }
      } catch {}
    }
    return matches;
  }

  function _richTextEditorsAcrossOpenShadowRoots(scope) {
    return _richTextToolbarQueryAcrossOpenShadowRoots(
      scope,
      'textarea,[contenteditable]:not([contenteditable="false"]),iframe,frame',
    );
  }

  function _richTextToolbarRegionKey(regionNode) {
    try {
      if (!regionNode?.isConnected) return '';
      const rect = regionNode.getBoundingClientRect();
      return [
        'rtb',
        String(regionNode.tagName || '').toLowerCase(),
        Math.round(rect.x + window.scrollX),
        Math.round(rect.y + window.scrollY),
        Math.round(rect.width),
        Math.round(rect.height),
      ].join(':');
    } catch { return ''; }
  }

  function _associatedRichTextEditor(regionNode) {
    try {
      if (!regionNode?.isConnected) return null;
      const regionRect = regionNode.getBoundingClientRect();
      const candidates = [];
      let scope = _composedParent(regionNode);
      for (let depth = 0; scope && depth < 5; depth += 1, scope = _composedParent(scope)) {
        for (const editor of _richTextEditorsAcrossOpenShadowRoots(scope)) {
          const editorTag = String(editor.tagName || '').toLowerCase();
          const iframeBacked = editorTag === 'iframe' || editorTag === 'frame';
          if (
            editor === regionNode
            || _isComposedAncestor(regionNode, editor)
            || _hasComposedClosest(editor, '[role="toolbar"]')
            || !_visibleFieldContextNode(editor)
          ) continue;
          const rect = editor.getBoundingClientRect();
          if (iframeBacked && (rect.width < 160 || rect.height < 80)) continue;
          const overlap = Math.max(0, Math.min(regionRect.right, rect.right) - Math.max(regionRect.left, rect.left));
          const horizontalPenalty = overlap > 0
            ? 0
            : Math.min(Math.abs(rect.left - regionRect.right), Math.abs(regionRect.left - rect.right));
          const verticalPenalty = rect.top >= regionRect.bottom - 8
            ? Math.max(0, rect.top - regionRect.bottom)
            : 500 + Math.abs(rect.bottom - regionRect.top);
          candidates.push({ editor, rect, score: (depth * 250) + verticalPenalty + horizontalPenalty });
        }
        if (candidates.length) break;
      }
      candidates.sort((a, b) => a.score - b.score);
      const best = candidates[0];
      if (!best) return null;
      const second = candidates[1];
      if (second && Math.abs(second.score - best.score) < 12) return null;
      let ref = '';
      try { if (_axRef) ref = _axRef(best.editor) || ''; } catch {}
      // The CDP main-world path cannot mint refs. Identity + geometry still
      // describe the editor well enough for recovery, so proceed without one.
      if (!ref && _axRef) return null;
      return {
        ref,
        rect: {
          x: Math.round(best.rect.x),
          y: Math.round(best.rect.y),
          w: Math.round(best.rect.width),
          h: Math.round(best.rect.height),
        },
        identity: {
          tag: String(best.editor.tagName || '').toLowerCase(),
          id: best.editor.id || null,
          name: best.editor.getAttribute?.('name') || null,
          role: best.editor.getAttribute?.('role') || null,
          pageX: Math.round(best.rect.x + window.scrollX),
          pageY: Math.round(best.rect.y + window.scrollY),
          w: Math.round(best.rect.width),
          h: Math.round(best.rect.height),
        },
      };
    } catch { return null; }
  }

  // Rich-text editors often expose formatting widgets as ordinary textboxes
  // in the accessibility tree (font size/family/style presets). Report a
  // language- and site-neutral *candidate* here; the background combines this
  // structural evidence with a target-annotated screenshot before changing
  // the tool result. Ordinary labels suppress weak standalone candidates;
  // recognized formatting labels may participate in dense clusters, while
  // explicit [role=toolbar] ancestry remains authoritative.
  function _richTextToolbarAvailablePresetValues(el) {
    try {
      const values = [];
      const seen = new Set();
      const add = raw => {
        const value = String(raw || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 80);
        const key = value.toLowerCase();
        if (!value || seen.has(key) || values.length >= 40) return;
        seen.add(key);
        values.push(value);
      };
      add(el.value);
      if (el.isContentEditable) add(el.textContent);

      const roots = [];
      if (el.tagName === 'SELECT') roots.push(el);
      if (el.list) roots.push(el.list);
      const elementRoot = el.getRootNode?.() || document;
      for (const id of `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`.trim().split(/\s+/)) {
        if (!id) continue;
        const root = elementRoot.getElementById?.(id) || document.getElementById(id);
        if (root && !roots.includes(root)) roots.push(root);
      }
      const comboRoot = el.closest?.('[role="combobox"],[role="listbox"]') || null;
      if (comboRoot && comboRoot !== el && !roots.includes(comboRoot)) roots.push(comboRoot);

      for (const root of roots.slice(0, 6)) {
        const options = [];
        if (root.matches?.('option,[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"]')) options.push(root);
        options.push(...Array.from(root.querySelectorAll?.('option,[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"]') || []));
        for (const option of options.slice(0, 40)) {
          add(option.value);
          add(option.getAttribute?.('data-value'));
          add(option.textContent);
        }
      }
      return values;
    } catch { return []; }
  }

  function _richTextToolbarCandidate(el, baseMeta) {
    try {
      if (!el) return null;
      const inputControl = el.tagName === 'INPUT';
      const inputType = inputControl ? (el.type || 'text').toLowerCase() : '';
      const supportedInput = inputControl && ['text', 'search', 'number', 'url'].includes(inputType);
      const selectControl = el.tagName === 'SELECT';
      const editableControl = el.isContentEditable === true;
      if (!supportedInput && !selectControl && !editableControl) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;

      const unlabeled = ![
        baseMeta?.ariaLabel,
        baseMeta?.ariaLabelledByText,
        baseMeta?.placeholder,
        baseMeta?.title,
        baseMeta?.labelText,
      ].some(value => String(value || '').trim());
      const formattingDescriptor = [
        baseMeta?.ariaLabel,
        baseMeta?.ariaLabelledByText,
        baseMeta?.placeholder,
        baseMeta?.title,
        baseMeta?.labelText,
        baseMeta?.id,
        baseMeta?.name,
      ].map(value => String(value || '').normalize('NFKC').toLowerCase()).join(' ');
      const formattingLabel = [
        'font', 'typeface', 'typograph', 'text size', 'text-size', 'text_size',
        'paragraph style', 'heading level', 'line height', 'letter spacing', 'zoom',
        'text color', 'font color', 'foreground color', 'background color', 'highlight color',
        'text colour', 'font colour', 'foreground colour', 'background colour', 'highlight colour',
        'link', 'hyperlink',
        'yazı tipi', 'police', 'schrift', 'fuente', 'fonte', 'carattere',
        'フォント', '字体', '字體', '글꼴', 'шрифт',
      ].some(token => formattingDescriptor.includes(token));
      const ordinaryFilterLabel = [
        'search', 'filter', 'find', 'query', 'lookup',
        'arama', 'filtre', 'recherche', 'filtrer', 'suche', 'suchen',
        'buscar', 'filtro', 'pesquisa', 'cerca',
        '検索', '搜索', '筛选', '篩選', '검색', 'поиск', 'фильтр',
      ].some(token => formattingDescriptor.includes(token));
      const semanticToolbar = _composedClosestElement(el, '[role="toolbar"]');
      const editableRole = String(baseMeta?.role || '').toLowerCase();
      const editableFormattingWidget = formattingLabel && (
        semanticToolbar || ['combobox', 'listbox', 'spinbutton'].includes(editableRole)
      );
      if (editableControl && !editableFormattingWidget) return null;

      const compact = rect.height <= 32 && rect.width <= 220;
      const value = String(editableControl ? (el.textContent || '') : (el.value || '')).trim();
      const numericPreset = value.length > 0
        && value.length <= 16
        && /^-?\d+(?:[.,]\d+)?(?:px|pt|em|rem|%)?$/i.test(value);
      const searchLike = inputType === 'search' || String(baseMeta?.role || '').toLowerCase() === 'searchbox';
      if (searchLike) return null;
      if (!unlabeled && !formattingLabel && ordinaryFilterLabel) return null;
      if (!unlabeled && !semanticToolbar && !formattingLabel) return null;
      const interactiveSelector = [
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'button',
        '[role="button"]',
        '[role="combobox"]',
        '[role="textbox"]',
        '[role="searchbox"]',
        '[role="listbox"]',
        '[role="menuitem"]',
        '[contenteditable]:not([contenteditable="false"])',
        '[tabindex]',
      ].join(',');

      let cluster = null;
      let guardCluster = null;
      let node = _composedParent(el);
      for (let depth = 1; node && depth <= 6; depth++, node = _composedParent(node)) {
        if (['FORM', 'BODY', 'HTML'].includes(String(node.tagName || '').toUpperCase())) break;
        if (!_visibleFieldContextNode(node)) continue;
        const region = node.getBoundingClientRect();
        if (region.height > 160 || region.width < rect.width) continue;
        const controls = _richTextToolbarQueryAcrossOpenShadowRoots(node, interactiveSelector, 41)
          .filter(candidate => candidate === el || (!candidate.isContentEditable && _visibleFieldContextNode(candidate)));
        if (!controls.includes(el)) controls.unshift(el);
        if (controls.length < 2 || controls.length > 40) continue;
        const area = region.width * region.height;
        const entry = { node, controls, region, area };
        if (!cluster || area < cluster.area) cluster = entry;
        // Component toolbars without role="toolbar" often wrap an input in a
        // tiny 40px sub-container while the adjacent Body/Heading control is a
        // generic div. Keep the smallest cluster for scoring, but widen the
        // recovery region only when the compact row has a definite associated
        // editor. This keeps ordinary one-row forms out of the blocked scope.
        if (
          controls.length >= 3
          && region.height <= 96
          && (!guardCluster || region.width > guardCluster.region.width)
        ) {
          const associatedEditor = _associatedRichTextEditor(node);
          if (associatedEditor) guardCluster = { ...entry, associatedEditor };
        }
      }

      const reasons = [];
      let score = 0;
      reasons.push(unlabeled ? 'unlabelled_text_control' : 'labelled_toolbar_control');
      if (unlabeled) score += 1;
      if (formattingLabel) { reasons.push('formatting_control_label'); score += 1; }
      if (compact) { reasons.push('compact_control'); score += 1; }
      if (numericPreset) { reasons.push('numeric_preset_value'); score += 2; }
      if (cluster) { reasons.push('dense_control_cluster'); score += 2; }
      if (semanticToolbar) { reasons.push('semantic_toolbar'); score += 4; }
      if (score < 4) return null;

      const directParent = _composedParent(el);
      const safeDirectParent = directParent
        && !['FORM', 'BODY', 'HTML'].includes(String(directParent.tagName || '').toUpperCase())
        ? directParent
        : null;
      const regionNode = semanticToolbar || guardCluster?.node || cluster?.node || safeDirectParent || el;
      const region = regionNode.getBoundingClientRect();
      const related = _richTextToolbarQueryAcrossOpenShadowRoots(regionNode, interactiveSelector, 30)
        .filter(candidate => !candidate.isContentEditable && _visibleFieldContextNode(candidate))
        .slice(0, 30);
      const compactTextLeaves = _richTextToolbarQueryAcrossOpenShadowRoots(regionNode, '*', 200)
        .filter(candidate => {
          if (candidate.children?.length || _hasComposedClosest(candidate, '[contenteditable]:not([contenteditable="false"])')) return false;
          const text = String(candidate.textContent || '').trim();
          if (!text || text.length > 60 || !_visibleFieldContextNode(candidate)) return false;
          const candidateRect = candidate.getBoundingClientRect();
          return candidateRect.height <= 48;
        })
        .slice(0, 30);
      for (const leaf of compactTextLeaves) {
        let candidate = leaf;
        for (let depth = 0; candidate && candidate !== regionNode && depth < 3; depth++, candidate = _composedParent(candidate)) {
          if (!_hasComposedClosest(candidate, '[contenteditable]:not([contenteditable="false"])') && !related.includes(candidate)) related.push(candidate);
        }
      }
      if (!related.includes(el)) related.unshift(el);
      const relatedRefs = [];
      let regionRef = '';
      if (_axRef) {
        try { regionRef = _axRef(regionNode) || ''; } catch {}
        for (const candidate of related.slice(0, 30)) {
          try {
            const ref = _axRef(candidate);
            if (ref && !relatedRefs.includes(ref)) relatedRefs.push(ref);
          } catch {}
        }
      }
      const associatedEditor = guardCluster?.node === regionNode
        ? guardCluster.associatedEditor
        : _associatedRichTextEditor(regionNode);
      // A formatting affordance the control declares itself, or an ARIA
      // toolbar that demonstrably belongs to an editor. [role=toolbar] alone
      // is not evidence of a rich-text editor: ordinary app toolbars hold
      // labelled rename, filter and date fields, and ancestry by itself used
      // to clear both this guard and the +4 escalation score. Blocking prose
      // in one of those costs a whole run, because the obligation refuses
      // done(success) until a corrected editor-body edit that will never come
      // discharges it. Selects go through here now too; supportedInput never
      // covered them. Proximity to an editor is deliberately not sufficient
      // on its own, or every compact field in a cluster beside a composer
      // would escalate.
      const formattingEvidence = formattingLabel || numericPreset;
      const editorBackedToolbar = !!semanticToolbar && !!associatedEditor;
      if (!formattingEvidence && !editorBackedToolbar) {
        return null;
      }

      return {
        score,
        reasons,
        availablePresetValues: _richTextToolbarAvailablePresetValues(el),
        regionRect: {
          x: Math.round(region.x),
          y: Math.round(region.y),
          w: Math.round(region.width),
          h: Math.round(region.height),
        },
        regionRef,
        regionKey: _richTextToolbarRegionKey(regionNode),
        relatedRefs,
        associatedEditorRef: associatedEditor?.ref || '',
        associatedEditorRect: associatedEditor?.rect || null,
        associatedEditorIdentity: associatedEditor?.identity || null,
      };
    } catch { return null; }
  }

  // Password-field facts. content.js _fieldMeta and the Chrome CDP selector
  // probe both report these for an <input type=password> by calling this one
  // function, so the two routes cannot disagree (the agent's sign-in password
  // check, credential-fields.js passwordFieldPurpose, reads them):
  //
  //   - passwordFields: the visible password fields of the field's form,
  //   - usernameFields: the fields of that form that name an account,
  //   - formSubmitText: the text of the form's first visible submit control,
  //   - buttonTexts: the texts of the visible buttons of that form, nearest
  //     first.
  //
  // A field's form is its form owner or, for a field in a web component's
  // shadow root (which has none), the nearest <form> around it across shadow
  // boundaries. A field in no form has the form-less part of its document,
  // across open shadow roots, so a component sign-in reads the same as a
  // plain one. A form without a visible button of its own (one submitted from
  // a dialog footer) reads the form-less buttons of its document too.
  const _PASSWORD_FACT_QUERY_LIMIT = 1000;
  const _PASSWORD_FACT_BUTTON_TEXTS = 8;
  const _BUTTON_LIKE_SELECTOR = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], [type="submit"]';
  // What a visible field that names the account says: user, login, email,
  // account, identifier, a phone or mobile number, a customer, member or
  // client number, the same words in other languages, or "ID".
  const _ACCOUNT_FIELD_RE = /user|log[-_\s]?[io]n|e-?mail|account|identifier|phone|mobile|customer|member|client|number|nummer|num[eé]ro|n[uú]mero|benutzer|kennung|utilisateur|identifiant|courriel|usuario|correo|celular|m[oó]vil|utente|cellulare|gebruiker|kullan[ıi]c[ıi]|e-?posta|t[eé]l[eé]fon|kimlik|müşteri|логин|почт|телефон|пользовател|użytkownik|ユーザー|メール|電話|用户|账号|帳號|邮箱|手机|아이디|이메일|사용자|휴대폰/iu;
  const _ACCOUNT_ID_RE = /\bID\b/;
  // A hidden input that carries the account of a sign-in's password step
  // (username, login, login_hint, email, identifier, account_name), not a
  // generic id such as user_id or flow.
  const _HIDDEN_ACCOUNT_FIELD_RE = /(?:^|[^a-z])(?:user[-_]?name|login(?:[-_]?(?:name|hint|id))?|loginfmt|e-?mail(?:[-_]?address)?|identifier|account[-_]?name)(?:[^a-z]|$)/i;

  function _shadowHost(node) {
    const root = node?.getRootNode?.();
    return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root.host : null;
  }

  // The form a control belongs to: its form owner, or the nearest <form>
  // around it across shadow boundaries; null for none.
  function _passwordFactForm(node) {
    try {
      if (node.form && node.form.nodeType === 1) return node.form;
    } catch {}
    return _composedClosestElement(_composedParent(node), 'form');
  }

  function _passwordFactVisible(node) {
    try { return node.getClientRects().length > 0; } catch { return false; }
  }

  function _passwordFactText(value, max = 120) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function _namesAccount(field) {
    if (field.tagName !== 'INPUT') return false;
    const type = String(field.type || 'text').toLowerCase();
    const attr = name => _passwordFactText(field.getAttribute?.(name));
    if (type === 'hidden') {
      return [attr('name'), field.id].some(value => _HIDDEN_ACCOUNT_FIELD_RE.test(String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2')));
    }
    if (!['text', 'email', 'tel', 'number'].includes(type)) return false;
    if (type === 'email' || type === 'tel') return true;
    const autocomplete = attr('autocomplete').toLowerCase().split(' ');
    if (['username', 'email', 'tel', 'tel-national', 'tel-local'].some(token => autocomplete.includes(token))) return true;
    const host = _shadowHost(field);
    const identity = [attr('name'), field.id, attr('aria-label'), _ariaLabelledByText(field), attr('placeholder'), attr('title'),
      ...[...(field.labels || [])].map(label => label.textContent),
      ...(host ? ['label', 'name', 'aria-label', 'placeholder'].map(name => host.getAttribute?.(name)) : [])]
      .map(value => _passwordFactText(value)).filter(Boolean).join(' ');
    return _ACCOUNT_FIELD_RE.test(identity) || _ACCOUNT_ID_RE.test(identity);
  }

  // What a button says: its text (an input's value), else its aria-label,
  // aria-labelledby text or title, else, for a button inside a component
  // whose label is slotted in, the component's own text or label.
  function _passwordFactButtonText(control) {
    const attr = name => _passwordFactText(control.getAttribute?.(name), 80);
    const own = _passwordFactText(control.tagName === 'INPUT' ? (control.value || control.alt) : control.textContent, 80);
    if (own) return own;
    const labelled = attr('aria-label') || _passwordFactText(_ariaLabelledByText(control), 80) || attr('title');
    if (labelled) return labelled;
    const host = _shadowHost(control);
    return host ? (_passwordFactText(host.textContent, 80) || _passwordFactText(host.getAttribute?.('aria-label'), 80)) : '';
  }

  function _isSubmitControl(control) {
    const type = String(control.type || '').toLowerCase();
    return (control.tagName === 'BUTTON' && (type || 'submit') === 'submit')
      || (control.tagName === 'INPUT' && ['submit', 'image'].includes(type));
  }

  function _passwordFieldFacts(el) {
    const facts = {};
    try {
      const form = _passwordFactForm(el);
      const doc = el.ownerDocument || document;
      const inScope = scopeForm => node => _passwordFactForm(node) === scopeForm;
      const collect = (scope, selector, scopeForm) => {
        const found = new Set(_richTextToolbarQueryAcrossOpenShadowRoots(scope, selector, _PASSWORD_FACT_QUERY_LIMIT));
        if (scopeForm) {
          for (const control of scopeForm.elements || []) {
            try { if (control.matches(selector)) found.add(control); } catch {}
          }
        }
        return [...found].filter(inScope(scopeForm));
      };
      const fields = collect(form || doc, 'input', form);
      facts.passwordFields = fields.filter(field => String(field.type || '').toLowerCase() === 'password'
        && _passwordFactVisible(field)).length;
      facts.usernameFields = fields.filter(field => field !== el && _namesAccount(field)).length;
      if (form) {
        const submit = [...(form.elements || [])].find(control => _isSubmitControl(control) && _passwordFactVisible(control));
        const submitText = submit ? _passwordFactButtonText(submit) : '';
        if (submitText) facts.formSubmitText = submitText;
      }
      let buttons = collect(form || doc, _BUTTON_LIKE_SELECTOR, form).filter(_passwordFactVisible);
      if (form && !buttons.length) buttons = collect(doc, _BUTTON_LIKE_SELECTOR, null).filter(_passwordFactVisible);
      // Nearest first: by how far up from the field the button's branch
      // meets the field's.
      const depth = new Map();
      for (let node = _composedParent(el), level = 0; node; node = _composedParent(node), level += 1) depth.set(node, level);
      const distance = node => {
        for (let cur = node; cur; cur = _composedParent(cur)) if (depth.has(cur)) return depth.get(cur);
        return Infinity;
      };
      const texts = [];
      for (const { text } of buttons.map((control, index) => ({ text: _passwordFactButtonText(control), at: distance(control), index }))
        .sort((a, b) => (a.at - b.at) || (a.index - b.index))) {
        if (text && !texts.includes(text)) texts.push(text);
        if (texts.length >= _PASSWORD_FACT_BUTTON_TEXTS) break;
      }
      if (texts.length) facts.buttonTexts = texts;
    } catch {}
    return facts;
  }

  return {
    candidate(el, baseMeta, options = {}) {
      _axRef = typeof options.axRef === 'function' ? options.axRef : null;
      try {
        return _richTextToolbarCandidate(el, baseMeta);
      } finally {
        _axRef = null;
      }
    },
    regionKey: _richTextToolbarRegionKey,
    ariaLabelledByText: _ariaLabelledByText,
    visibleFieldContextNode: _visibleFieldContextNode,
    queryAcrossOpenShadowRoots: _richTextToolbarQueryAcrossOpenShadowRoots,
    editorsAcrossOpenShadowRoots: _richTextEditorsAcrossOpenShadowRoots,
    availablePresetValues: _richTextToolbarAvailablePresetValues,
    passwordFieldFacts: _passwordFieldFacts,
  };
})();

// Content scripts share this isolated-world global with content.js. The CDP
// probe sets the lexical flag below to false and uses the local binding above
// directly, so a page-owned global can neither replace nor disable the trusted
// packaged heuristic.
if (
  typeof __wbInstallRichTextToolbarHeuristicGlobal === 'undefined'
  || __wbInstallRichTextToolbarHeuristicGlobal
) {
  globalThis.__wbRichTextToolbarHeuristic = __wbRichTextToolbarHeuristic;
}
