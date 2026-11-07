const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const DIRECT_ACTION_TOOLS = new Set([
  'click',
  'click_ax',
  'set_checked',
  'iframe_click',
  'drag_drop',
  // Vision mode's drag (a slider, a reordered item, a canvas stroke); its
  // click_at is recorded as the coordinate click it runs as.
  'drag_at',
  'type_text',
  'type_ax',
  'iframe_type',
  'upload_file',
  'chrome_web_store_upload',
  'chrome_web_store_publish',
  'execute_js',
  'inject_css',
  'remove_injected_css',
  'patch_element',
  'revert_patch',
  'solve_captcha',
  'schedule_resume',
  'schedule_task',
  'chat_send',
]);

const NAVIGATION_ACTION_TOOLS = new Set([
  'navigate',
  'promote_iframe',
  'go_back',
  'go_forward',
]);

// Intentionally excluded from action debt: resize_window is transient viewport
// setup, not a consequential task-result mutation in the v1 runtime contract.
const DOWNLOAD_ACTION_TOOLS = new Set([
  'download_files',
  'download_file',
  'download_resource_from_page',
  'download_social_media',
]);

// These actions complete outside the run tab, so a screenshot of the run
// tab cannot serve as their post-action observation.
const BACKGROUND_ACTION_TOOLS = new Set([
  'delegate_research',
]);

// v1 deliberately enforces ordering, not semantic postcondition matching:
// any successful explicit observation in this allowlist after the latest
// action clears debt. This deterministically blocks success-without-a-read,
// but it cannot prove that the read was relevant to the task. Action-specific
// and domain-specific postconditions belong to a later enforcement layer.
const OBSERVATION_TOOLS = new Set([
  'auto_screenshot',
  'get_accessibility_tree',
  'read_page',
  'read_pdf',
  'read_page_source',
  'get_interactive_elements',
  'extract_data',
  'verify_form',
  'iframe_read',
  'wait_for_element',
  'inspect_element_styles',
  'read_console',
  'inspect_network_requests',
  'get_shadow_dom',
  'shadow_dom_query',
  'get_frames',
  'inspect_viewport',
  'screenshot',
  'full_page_screenshot',
  // Vision mode: a zoom, which captures its region of the page as it is now.
  // take_screenshot only asks for the frame the screen update after its
  // batch captures, which records itself as auto_screenshot once it exists.
  'zoom',
  'list_downloads',
  'read_downloaded_file',
  'chrome_web_store_status',
]);
// inspect_event_listeners briefly marks the live DOM to resolve refs. Treating
// that implementation-level mutation as verification would let it clear debt
// without observing the requested post-action state.

const DONE_OUTCOMES = new Set(['success', 'partial', 'failed']);

function normalizedMethod(args = {}) {
  return String(args?.method || 'GET').trim().toUpperCase();
}

function normalizedOutcome(value) {
  const outcome = String(value || '').trim().toLowerCase();
  return DONE_OUTCOMES.has(outcome) ? outcome : '';
}

function normalizedIframeScope(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedIframeMatchIndex(value) {
  const matchIndex = value === undefined || value === null ? 0 : Number(value);
  return Number.isInteger(matchIndex) && matchIndex >= 0 ? matchIndex : 0;
}

function iframeFormObligation(args = {}, result = {}) {
  const selector = String(args?.selector || '').trim();
  const scope = normalizedIframeScope(args?.urlFilter);
  const finalValue = typeof result?.value === 'string'
    ? result.value
    : (typeof result?.frame?.value === 'string' ? result.frame.value : null);
  // verify_form addresses iframe targets by urlFilter. Never create debt that
  // the verification tool has no stable scope with which to discharge it.
  if (!selector || !scope) return null;
  const matchMode = finalValue !== null || args?.clear === true ? 'exact' : 'suffix';
  const rawExpectedValue = String(finalValue ?? args?.text ?? '');
  return {
    scope,
    frameId: Number.isInteger(result?.frameId) ? result.frameId : null,
    selector,
    matchIndex: normalizedIframeMatchIndex(result?.matchIndex ?? args?.matchIndex),
    expectedValue: matchMode === 'suffix' ? rawExpectedValue.slice(-100) : rawExpectedValue.slice(0, 100),
    matchMode,
  };
}

function iframeFormObligationKey(obligation = {}) {
  return JSON.stringify([
    obligation.scope || '',
    Number.isInteger(obligation.frameId) ? obligation.frameId : null,
    obligation.selector || '',
    normalizedIframeMatchIndex(obligation.matchIndex),
  ]);
}

function syncIframeFormDebt(next, obligations) {
  const pending = Array.isArray(obligations) ? obligations : [];
  const scopes = [...new Set(pending.map(item => normalizedIframeScope(item?.scope)).filter(Boolean))];
  next.iframeFormVerificationObligations = pending;
  next.iframeFormVerificationDebt = pending.length > 0;
  next.iframeFormScope = scopes.length === 1 ? scopes[0] : '';
}

function keyText(args = {}) {
  return JSON.stringify(args?.key ?? args?.keys ?? '').toLowerCase();
}

function isSelfVerifyingActionResult(name, result, args = {}) {
  if (name === 'chat_send') {
    const threadKey = String(args.thread_key || args.threadKey || '');
    return !!(threadKey && result?.success === true && result?.sent === true
      && result?.deliveryVerified === true && result?.verificationRequired === false
      && result?.dispatched === true && !result?.outcomeUnknown && !result?.error
      && result.threadKey === threadKey && result?.chatWorkflow?.threadKey === threadKey
      && result.chatWorkflow.pendingOutbound === false && !result.chatWorkflow.userInput?.required
      && result?.composer?.available === true && result.composer.empty === true);
  }
  if (name !== 'schedule_task' && name !== 'schedule_resume') return false;
  return !!(
    result?.success === true
    && result?.scheduled === true
    && String(result?.jobId || '').trim()
    && Number.isFinite(Date.parse(String(result?.scheduledAt || '')))
  );
}

/**
 * Classify one visible form from browser-neutral structural facts.
 *
 * Completion probes run inside the page, so Agent serializes this function
 * with toString() and supplies plain facts rather than DOM nodes. Keep this
 * function self-contained and language-independent for structural fallbacks.
 */
export function classifyCompletionForm({
  label = '',
  utilityRegion = false,
  outsidePrimaryContent = false,
  insideDialog = false,
  method = 'get',
  hiddenNamedCount = 0,
  editable = [],
  submits = [],
  submitReadings = {},
  fieldReadings = {},
} = {}) {
  const fields = Array.isArray(editable) ? editable : [];
  const submitControls = Array.isArray(submits) ? submits : [];
  const normalizedMethod = String(method || 'get').trim().toLowerCase() || 'get';
  const normalizedFields = fields.map(field => ({
    tag: String(field?.tag || '').trim().toLowerCase(),
    type: String(field?.type || '').trim().toLowerCase(),
    role: String(field?.role || '').trim().toLowerCase(),
    name: String(field?.name || '').trim(),
    value: String(field?.value || '').trim(),
    required: field?.required === true,
    focused: field?.focused === true,
    // The field's own aria-label or placeholder: page text, only ever read.
    label: String(field?.label || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
  const normalizedSubmits = submitControls.map(control => ({
    label: String(control?.label || '').trim(),
    type: String(control?.type || '').trim().toLowerCase(),
  }));

  const semanticSearchField = field => field.type === 'search' || field.role === 'searchbox';
  const conventionalSearchField = field => /^(q|query|search|filter)$/i.test(field.name);
  const onlyField = normalizedFields.length === 1 ? normalizedFields[0] : null;
  // A lone empty text field with no name or role says nothing in markup about
  // what it is for: a sidebar search box (Mastodon's has only a localized
  // placeholder and an icon) looks exactly like a task form's only field. It
  // can leave the form only through a model's reading below, never by
  // structure alone. A value in it is a typed draft, so that form stays.
  const unmarkedSearchField = !!(onlyField
    && onlyField.tag === 'input'
    && (onlyField.type === '' || onlyField.type === 'text')
    && !onlyField.role
    && !onlyField.name
    && !onlyField.value);
  // Preserve the previous per-field semantic-or-conventional behavior so a
  // search input plus a named filter control remains utility UI. Task evidence
  // gates the whole shortcut: semantic markup alone must not hide an assignee
  // picker, dialog, POST form, or non-search submission. A retained value is
  // normal search-results state and is not task evidence by itself.
  const markedSearchFieldsOnly = normalizedFields.length > 0
    && normalizedFields.every(field => semanticSearchField(field) || conventionalSearchField(field));
  const searchFieldsOnly = markedSearchFieldsOnly || unmarkedSearchField;
  // What a submit control's caption means is read by a model in any language
  // (the agent's control_effect readings, `submitReadings` by label): only
  // controls read as showing, filtering or searching ("view") leave a
  // search form a search form. An unread caption is no evidence, so it keeps
  // the form relevant here; `searchCandidate` tells the agent to read it.
  // When no control has a caption (icon-only buttons), the lone field's own
  // label or placeholder is what says what the form is for. It is read with
  // its own question (field_purpose, `fieldReadings` by label), because
  // control_effect calls a control that only opens an editor "view" and so
  // passes "Write a comment…" as harmless: only a field read as searching or
  // filtering the site ("search") leaves the form a search form. Marked
  // search fields with no control need no reading; an unmarked field always
  // does.
  const readsField = !normalizedSubmits.some(control => control.label)
    && (normalizedSubmits.length > 0 || unmarkedSearchField);
  const readings = readsField ? fieldReadings : submitReadings;
  const searchReading = readsField ? 'search' : 'view';
  const readingOf = text => (text && readings && typeof readings === 'object'
    && Object.prototype.hasOwnProperty.call(readings, text) ? readings[text] : null);
  const purposeTexts = readsField
    ? [onlyField?.label || '']
    : normalizedSubmits.map(control => control.label);
  const searchSubmitsOnly = purposeTexts.every(text => readingOf(text) === searchReading);
  const searchStructureHasTaskEvidence = !!(
    insideDialog
    || normalizedMethod !== 'get'
    || Number(hiddenNamedCount || 0) !== 0
    || normalizedFields.some(field => (
      field.required
      || field.focused
      || (!!field.name && !conventionalSearchField(field))
    ))
  );
  const searchHasTaskEvidence = searchStructureHasTaskEvidence || !searchSubmitsOnly;
  // Primary content alone is not task evidence: result pages commonly place
  // genuine search/filter forms there.
  const safeSearchOnly = searchFieldsOnly && !searchHasTaskEvidence;
  const searchReason = normalizedFields.some(semanticSearchField)
    ? 'semantic_search'
    : markedSearchFieldsOnly ? 'conventional_search' : 'unmarked_search';
  const searchCandidate = searchFieldsOnly && !searchStructureHasTaskEvidence && !searchSubmitsOnly
    && purposeTexts.every(text => readingOf(text) === null || readingOf(text) === searchReading);

  // A type=button or type=reset control without a caption cannot send its
  // form natively and names nothing, like the icon that clears or focuses a
  // sidebar search box. Any other control may send the form.
  const sendingControls = normalizedSubmits.filter(control => control.label
    || (control.type !== 'button' && control.type !== 'reset'));
  const passiveUtilityShell = !!(
    onlyField
    && outsidePrimaryContent
    && !insideDialog
    && normalizedMethod === 'get'
    && Number(hiddenNamedCount || 0) === 0
    && sendingControls.length === 0
    && onlyField.tag === 'input'
    && (onlyField.type === '' || onlyField.type === 'text' || onlyField.type === 'search')
    && !onlyField.name
    && !onlyField.value
    && !onlyField.required
    && !onlyField.focused
  );

  const utilityReason = utilityRegion
    ? 'utility_region'
    : safeSearchOnly
      ? searchReason
      : passiveUtilityShell
        ? 'passive_utility_shell'
        : null;
  const utility = utilityReason !== null;
  return {
    label: String(label || '').trim().slice(0, 80),
    relevant: !utility && (normalizedFields.length > 0 || normalizedSubmits.length > 0),
    utility,
    utilityReason,
    editableCount: normalizedFields.length,
    submitCount: normalizedSubmits.length,
    ...(searchCandidate && !utility ? {
      searchCandidate: true,
      searchUtilityReason: searchReason,
      // Every submit's caption, so the agent can tell when one has none to read.
      submitLabels: normalizedSubmits.map(control => control.label.slice(0, 120)).slice(0, 4),
      // Read instead of the captions, with field_purpose, when no submit
      // control has one.
      ...(readsField && onlyField?.label ? { fieldLabel: onlyField.label } : {}),
    } : {}),
  };
}

/**
 * Pick the smallest app-owned publication card for one resource link, plus the
 * embedded posts inside it that this post did not author.
 *
 * Social cards may contain another post as a quote/embed, so counting resource
 * permalinks alone cannot distinguish that nested resource from a sibling feed
 * item. Prefer the app's card boundary when it is available, then retain the
 * conservative single-resource ancestry fallback for other sites/markup. The
 * card boundary is wider than the authored content, so the embedded post's
 * subtree is reported separately: its text and shortened links must not be
 * able to satisfy the reviewed body on the outer post's behalf. The app's own
 * post-text elements are reported too, because a card also carries the author
 * name, timestamp, and controls, and a short requested body can equal one of
 * those lines instead of anything the post actually says.
 * Returns { root, excluded, authored, attachments }.
 * Keep this function self-contained because Agent serializes it into the page.
 */
export function publicationResourceRecordRoot(link, identity, publicationResourceIdentity) {
  if (!link || typeof publicationResourceIdentity !== 'function') {
    return { root: link || null, excluded: [], authored: [], attachments: [] };
  }
  const value = String(identity || '');
  const cardSelector = value.startsWith('twitter:')
    ? 'article[data-testid="tweet"],[data-testid="tweet"]'
    : value.startsWith('bluesky:')
    ? '[data-testid^="feedItem-by-"],[data-testid^="postThreadItem-by-"]'
    : '';
  const bodySelector = value.startsWith('twitter:')
    ? '[data-testid="tweetText"]'
    : value.startsWith('bluesky:')
    ? '[data-testid="postText"],div[data-word-wrap="1"]'
    : '';
  const embedSelector = value.startsWith('twitter:')
    ? '[data-testid="quoteTweet"],[role="blockquote"],[data-testid*="quote"],[data-testid*="card.layout"]'
    : value.startsWith('bluesky:')
    ? '[data-testid^="postQuote-"],[data-testid="embeddedPost"],[data-testid*="quote"],[data-testid^="embed-"],div[role="link"]:not([data-testid^="feedItem-by-"]):not([data-testid^="postThreadItem-by-"])'
    : '';
  const identityOf = (candidate) => {
    try {
      return publicationResourceIdentity(candidate.getAttribute('href') || candidate.href || '') || '';
    } catch {
      return '';
    }
  };
  const linksIn = (node) => {
    try {
      return Array.from(node.querySelectorAll('a[href]')).slice(0, 200);
    } catch {
      return null;
    }
  };
  const isInsideAuthoredText = (node) => {
    if (!bodySelector) return false;
    try {
      if (typeof node.closest === 'function') {
        const bodyEl = node.closest(bodySelector);
        if (bodyEl) {
          if (!embedSelector || typeof node.closest !== 'function' || !node.closest(embedSelector)) {
            return true;
          }
        }
      }
    } catch {}
    let curr = node.parentElement;
    for (let i = 0; curr && i < 5; i++, curr = curr.parentElement) {
      try {
        if (typeof curr.matches === 'function' && curr.matches(bodySelector)) {
          if (!embedSelector || typeof node.closest !== 'function' || !node.closest(embedSelector)) {
            return true;
          }
        }
      } catch {}
    }
    return false;
  };
  // The largest subtree around a foreign permalink that this post's own
  // permalink never reaches into is the embedded post.
  const embeddedResourcesIn = (card) => {
    const links = linksIn(card);
    if (!links) return [];
    // Native Bluesky quotes are pressable divs, often without either an
    // embed test ID or a permalink anchor. Exclude the whole subtree even
    // when its target cannot be established from DOM links.
    const nativeQuoteSelector = 'div[role="link"]:not([data-testid^="feedItem-by-"]):not([data-testid^="postThreadItem-by-"])';
    const excluded = value.startsWith('bluesky:')
      ? Array.from(card.querySelectorAll(nativeQuoteSelector))
        .filter(node => node.matches?.(nativeQuoteSelector) && node.closest(cardSelector) === card)
        .filter((node, _i, nodes) => !nodes.some(other => other !== node && other.contains(node)))
        .slice(0, 9)
      : [];
    for (const candidate of links) {
      if (excluded.length >= 9) break;
      const found = identityOf(candidate);
      if (!found || found === value) continue;
      if (isInsideAuthoredText(candidate)) continue;
      if (excluded.some(node => node === candidate || node.contains?.(candidate))) continue;
      let embedContainer = null;
      if (embedSelector) {
        try {
          if (typeof candidate.closest === 'function') {
            embedContainer = candidate.closest(embedSelector);
          }
        } catch {}
      }
      let best = embedContainer || candidate;
      if (!embedContainer) {
        let node = candidate.parentElement;
        for (let depth = 0; node && node !== card && depth < 9; depth++, node = node.parentElement) {
          if (bodySelector) {
            try {
              if (typeof node.matches === 'function' && node.matches(bodySelector)) break;
            } catch {}
          }
          const inner = linksIn(node);
          if (!inner || inner.some(entry => identityOf(entry) === value)) break;
          best = node;
        }
      }
      excluded.push(best);
    }
    return excluded.slice(0, 9);
  };

  const authoredTextNodesIn = (card, excluded) => {
    if (!bodySelector) return [];
    try {
      return Array.from(card.querySelectorAll(bodySelector))
        .filter(node => !excluded.some(entry => entry === node || entry.contains?.(node) || node.contains?.(entry)))
        .filter(node => {
          // Bluesky's native rich text has no postText test ID. Its word-wrap
          // div must belong to this card, not a preview, byline, or control.
          if (!node.matches?.('div[data-word-wrap="1"]')) return true;
          return node.closest(cardSelector) === card
            && !node.closest(embedSelector + ',a[href],button,[role="button"],[data-testid="replyingTo"],[data-testid="replyToPost"]');
        })
        .filter((node, _index, nodes) => !nodes.some(other => other !== node && other.contains?.(node)))
        .slice(0, 9);
    } catch {
      return [];
    }
  };

  const authoredMediaNodesIn = (card, excluded) => {
    try {
      const candidates = Array.from(card.querySelectorAll([
        'img',
        'video',
        '[data-testid="tweetPhoto"]',
        '[data-testid="videoPlayer"]',
        '[data-testid="videoComponent"]',
        '[data-testid^="postImage"]',
        '[data-testid="postGalleryImage"]',
        '[data-testid="contentHider-post"]',
        '[data-testid="card.layoutLarge.media"]',
      ].join(','))).filter(node => !excluded.some(entry => entry === node || entry.contains?.(node)));
      const isAvatarOrEmoji = (node) => {
        try {
          if (node.closest?.('[data-testid*="Avatar"],[data-testid*="avatar"]')) return true;
          if (node.closest?.('[data-testid="emoji"]') || node.classList?.contains?.('emoji')) return true;
          const src = String(node.getAttribute?.('src') || node.src || '').toLowerCase();
          if (src.includes('profile_images') || src.includes('/avatar/') || src.includes('/emoji/') || src.includes('twemoji')) return true;
          const alt = String(node.getAttribute?.('alt') || '');
          // Digits (and "#" / "*") carry the Emoji property as keycap bases,
          // so a numeric-only alt such as "1" must not read as an emoji: only
          // discard the node when some other Emoji character is present.
          if (/^(?=[\s\S]*[^\d\s#*])\p{Emoji}+$/u.test(alt)) return true;
        } catch {}
        return false;
      };
      // The page host when there is one, and the hosts these adapters serve
      // otherwise, so the test holds outside a browser too.
      const isSameSiteHost = (host) => {
        const pageHost = String(globalThis.location?.hostname || '').toLowerCase();
        if (pageHost) {
          return host === pageHost || host.endsWith('.' + pageHost) || pageHost.endsWith('.' + host);
        }
        return /(?:^|\.)(?:x\.com|twitter\.com|bsky\.app)$/i.test(host);
      };
      const isLinkPreview = (node) => {
        try {
          // An uploaded-media wrapper is genuine whatever container holds it.
          if (node.closest?.('[data-testid="tweetPhoto"],[data-testid^="postImage"],[data-testid="postGalleryImage"]')) return false;
          if (node.closest?.('[data-testid*="card.layout"]')) return true;
          // Bluesky draws an external link card as a thumbnail inside an anchor
          // that leaves the site, and names no card container of its own. Both
          // apps link their own media on-site, so the host separates the two.
          const anchor = node.closest?.('a[href]');
          if (anchor) {
            const href = String(anchor.getAttribute?.('href') || anchor.href || '');
            const host = /^https?:\/\//i.test(href)
              ? href.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase()
              : '';
            if (host && !isSameSiteHost(host)) return true;
          }
        } catch {}
        return false;
      };
      const validMedia = candidates.filter(node => {
        const tag = (node.tagName || '').toLowerCase();
        const testId = typeof node.getAttribute === 'function' ? (node.getAttribute('data-testid') || '') : '';
        if (tag !== 'img' && tag !== 'video'
            && !testId.includes('tweetPhoto')
            && !testId.includes('video')
            && !testId.includes('postImage')
            && !testId.includes('postGalleryImage')
            && !testId.includes('contentHider-post')
            && !testId.includes('card.layoutLarge.media')) {
          return false;
        }
        return !isAvatarOrEmoji(node) && !isLinkPreview(node);
      });
      return validMedia
        .filter(node => !validMedia.some(other => other !== node && other.contains?.(node)))
        .slice(0, 21);
    } catch {
      return [];
    }
  };

  if (cardSelector) {
    try {
      const card = link.closest?.(cardSelector) || null;
      // The app drew this boundary, so its size is not evidence that it is the
      // wrong element. A long X Premium post must not fall through to the
      // ancestry walk, which skips long ancestors and would leave a timestamp
      // subtree carrying no post body at all.
      if (card && String(card.innerText || '').trim()) {
        const excluded = embeddedResourcesIn(card);
        const authored = authoredTextNodesIn(card, excluded);
        return {
          root: card,
          excluded,
          // Keep one overflow sentinel; a truncated observation is not proof
          // of the complete authored body or its embedded relationships.
          authorshipComplete: excluded.length <= 8 && authored.length <= 8,
          // A quote whose own permalink is unavailable is unknown context,
          // not evidence that this is a standalone post. Body links inside
          // that quote cannot stand in for its own identity.
          contextComplete: excluded.filter(node => value.startsWith('bluesky:') && node.matches?.('div[role="link"]'))
            .every(node => new Set((linksIn(node) || [])
              .filter(candidate => !candidate.closest?.(bodySelector))
              .map(identityOf).filter(identity => identity && identity !== value)).size === 1),
          authored,
          attachments: authoredMediaNodesIn(card, excluded),
        };
      }
    } catch {}
  }

  let node = link;
  let best = link;
  for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
    const text = String(node.innerText || '').trim();
    if (!text || text.length > 5000) continue;
    const candidates = linksIn(node);
    if (!candidates) continue;
    const resourceIdentities = new Set(candidates.map(identityOf).filter(Boolean));
    if (resourceIdentities.size > 1) break;
    best = node;
  }
  return { root: best, excluded: [], authored: [], attachments: authoredMediaNodesIn(best, []) };
}

// The focused Bluesky thread item renders its timestamp as text, without a
// self-permalink anchor. The detail route may name the author by DID while
// the focused card renders the account handle, so binding cannot assume the
// route identifier and rendered handle are spelled identically. Bind the
// route only to one visible, focused card in the app's thread screen. Feed
// items, embeds, and cards that already identify a different post cannot
// borrow the current URL.
// Keep self-contained: Agent serializes this function into the page.
export function publicationDetailResource(doc, pageUrl, publicationResourceIdentity) {
  try {
    const page = new URL(pageUrl);
    if (!/^https?:$/.test(page.protocol) || page.hostname !== 'bsky.app'
        || page.username || page.password || page.port) return null;
    const match = page.pathname.match(/^\/profile\/([^/]+)\/post\/[^/]+\/?$/);
    if (!match) return null;
    const url = page.origin + page.pathname.replace(/\/+$/, '');
    const identity = publicationResourceIdentity(url);
    if (!identity) return null;
    const owner = decodeURIComponent(match[1]).toLowerCase();
    const didOwner = /^did:[a-z0-9][a-z0-9:._-]*$/i.test(owner);
    const authorOf = card => {
      const testId = card.getAttribute('data-testid') || '';
      const prefix = 'postthreaditem-by-';
      return testId.toLowerCase().startsWith(prefix) ? testId.toLowerCase().slice(prefix.length) : '';
    };
    const cards = '[data-testid^="feedItem-by-"],[data-testid^="postThreadItem-by-"]';
    const excluded = '[data-testid^="postQuote-"],[data-testid="embeddedPost"],[data-testid*="quote"],[data-testid^="embed-"],div[role="link"]:not([data-testid^="feedItem-by-"]):not([data-testid^="postThreadItem-by-"]),dialog,[role="dialog"],aside,[role="complementary"]';
    const body = '[data-testid="postText"],div[data-word-wrap="1"]';
    const visible = node => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      for (let el = node; el; el = el.parentElement) {
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        if (el.hidden || el.getAttribute('aria-hidden') === 'true'
            || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const candidates = Array.from(doc.querySelectorAll('[data-testid="postThreadScreen"] [data-testid^="postThreadItem-by-"]'));
    if (candidates.length > 200) return null;
    const matches = candidates.filter(card => {
      if (!visible(card) || card.closest(excluded) || card.parentElement?.closest(cards)) return false;
      const author = authorOf(card);
      // A handle-backed route must still name the rendered author verbatim.
      // A DID-backed route cannot be compared by string equality; it binds
      // through the authored-identity and screen-wide uniqueness checks below,
      // and the later body match still confirms authorship.
      if (!author || (!didOwner && author !== owner)) return false;
      const links = Array.from(card.querySelectorAll('a[href]'));
      if (links.length > 200) return false;
      const owned = links.filter(a => a.closest(cards) === card && !a.closest(body + ',' + excluded));
      // A non-focused thread item supplies its own permalink. Even a single
      // conflicting identity is enough to reject route-based attribution. The
      // focused card is anchorless, so this alone cannot bind a DID route; the
      // screen-wide uniqueness check below does.
      const identities = owned.map(a => publicationResourceIdentity(a.href)).filter(Boolean);
      if (identities.some(value => value !== identity)) return false;
      return owned.some(a => {
        const profile = new URL(a.href, pageUrl);
        if (!visible(a) || profile.origin !== page.origin) return false;
        const path = decodeURIComponent(profile.pathname).replace(/\/+$/, '').toLowerCase();
        if (!/^\/profile\/[^/]+$/.test(path)) return false;
        // A handle route requires the on-site profile link to be the route
        // owner. A DID route renders the handle instead; while that handle is
        // not comparable on-page, the card binds only when it is the thread
        // screen's unique anchorless item with no conflicting post identity.
        return didOwner || path === '/profile/' + owner;
      });
    });
    if (matches.length !== 1) return null;
    const link = matches[0];
    const screen = link.closest('[data-testid="postThreadScreen"]');
    const threadCards = Array.from(screen.querySelectorAll(cards))
      .filter(node => !node.closest(excluded) && !node.parentElement?.closest(cards));
    // Earlier native thread cards are ancestors even when separate wrappers
    // prevent the legacy parent matcher from identifying the exact parent.
    // Preserve that uncertainty; an empty replyToUrl must not erase it.
    const replyContextComplete = threadCards.length <= 200 && threadCards[0] === link
      && !link.hasAttribute('data-in-reply-to-url')
      && !link.querySelector('[data-testid="replyingTo"],[data-testid="replyToPost"],a[rel="in-reply-to"]')
      && !screen.querySelector('[aria-busy="true"],[role="progressbar"]');
    return { link, url, identity, replyContextComplete };
  } catch { return null; }
}

// Infer a published reply's parent only from the page's own thread structure.
// Keep self-contained: Agent serializes this function into the completion probe.
export function publicationReplyParent(card, pageUrl, publicationResourceIdentity, expectedIdentity, detailResource = null) {
  try {
    const page = new URL(pageUrl);
    const host = page.hostname.toLowerCase().replace(/^www\./, '');
    const twitter = host === 'x.com' || host === 'twitter.com';
    if (!twitter && host !== 'bsky.app') return '';
    const cardSelector = twitter ? '[data-testid="tweet"]' : '[data-testid^="feedItem-by-"],[data-testid^="postThreadItem-by-"]';
    const bodySelector = twitter ? '[data-testid="tweetText"]' : '[data-testid="postText"],div[data-word-wrap="1"]';
    const embeds = '[data-testid="quoteTweet"],[role="blockquote"],[data-testid*="quote"],[data-testid*="card.layout"],[data-testid^="postQuote-"],[data-testid="embeddedPost"],[data-testid^="embed-"]'
      + (twitter ? '' : ',div[role="link"]:not([data-testid^="feedItem-by-"]):not([data-testid^="postThreadItem-by-"])');
    const hints = '[data-testid="replyingTo"],[data-testid="replyToPost"]';
    if (!card?.matches?.(cardSelector) || card.parentElement?.closest(cardSelector + ',' + embeds)) return '';
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
    };
    const parse = value => {
      if (!value) return null;
      const parsed = new URL(value, pageUrl);
      const candidateHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.port
          || (twitter ? !['x.com', 'twitter.com'].includes(candidateHost) : candidateHost !== 'bsky.app')) return null;
      return parsed;
    };
    const permalink = value => {
      try {
        const parsed = parse(value);
        if (!parsed) return '';
        const url = parsed.origin + parsed.pathname.replace(/\/+$/, '');
        return publicationResourceIdentity(url) ? url : '';
      } catch { return ''; }
    };
    const profile = value => {
      try {
        const parsed = parse(value);
        if (!parsed) return '';
        const match = parsed.pathname.replace(/\/+$/, '').match(twitter ? /^\/([A-Za-z0-9_]{1,15})$/ : /^\/profile\/([^/]+)$/);
        return match ? match[1].toLowerCase() : '';
      } catch { return ''; }
    };
    const owner = value => {
      try {
        const parsed = parse(value);
        const match = parsed?.pathname.match(twitter ? /^\/([^/]+)\/status\/\d+\/?$/ : /^\/profile\/([^/]+)\/post\/[^/]+\/?$/);
        return match ? match[1].toLowerCase() : '';
      } catch { return ''; }
    };
    const owned = (node, root) => node.closest(cardSelector) === root && !node.closest(bodySelector + ',' + embeds);
    const ownPermalink = root => {
      if (root === detailResource?.link) return detailResource.url;
      const urls = new Map(Array.from(root.querySelectorAll('a[href]')).filter(a => visible(a) && owned(a, root) && !a.closest(hints))
        .map(a => permalink(a.getAttribute('href'))).filter(Boolean).map(url => [publicationResourceIdentity(url), url]));
      return urls.size === 1 ? [...urls.values()][0] : '';
    };
    const childUrl = ownPermalink(card), childId = publicationResourceIdentity(childUrl);
    if (!childId || childId !== expectedIdentity) return '';
    const explicit = new Map([
      card.getAttribute('data-in-reply-to-url'),
      ...Array.from(card.querySelectorAll('[data-testid="replyToPost"] a[href],a[data-testid="replyToPost"],a[rel="in-reply-to"]'))
        .filter(a => visible(a) && owned(a, card)).map(a => a.getAttribute('href')),
    ].map(permalink).filter(Boolean).map(url => [publicationResourceIdentity(url), url]));
    if (explicit.size) return explicit.size === 1 && !explicit.has(childId) ? [...explicit.values()][0] : '';
    if (card.hasAttribute('data-in-reply-to-url')) return '';

    const threadUrl = permalink(pageUrl), threadId = publicationResourceIdentity(threadUrl);
    const scope = card.closest('[data-testid="primaryColumn"],[data-testid="postThreadScreen"],main,[role="main"]');
    if (!threadId || !scope || card.closest('dialog,[role="dialog"],aside,[role="complementary"]')) return '';
    const cards = Array.from(scope.querySelectorAll(cardSelector)).filter(node => visible(node)
      && !node.parentElement?.closest(cardSelector + ',' + embeds)
      && !node.closest('dialog,[role="dialog"],aside,[role="complementary"]'));
    if (cards.length > 200) return '';
    const items = cards.map(root => ({ root, url: ownPermalink(root) })).filter(item => item.url);
    const current = items.findIndex(item => item.root === card);
    if (current <= 0 || items.filter(item => publicationResourceIdentity(item.url) === threadId).length !== 1
        || items.filter(item => publicationResourceIdentity(item.url) === childId).length !== 1) return '';
    const parent = items[current - 1], parentId = publicationResourceIdentity(parent.url);
    // The active permalink must be one endpoint of this adjacent thread pair.
    // A grandparent route, a feed, or mere page co-occurrence is insufficient.
    if (threadId !== childId && threadId !== parentId) return '';
    if (items.filter(item => publicationResourceIdentity(item.url) === parentId).length !== 1) return '';
    const parentCell = parent.root.closest('[data-testid="cellInnerDiv"]') || parent.root;
    const childCell = card.closest('[data-testid="cellInnerDiv"]') || card;
    if (parentCell.parentElement !== childCell.parentElement || parentCell.nextElementSibling !== childCell) return '';
    const markedHints = Array.from(card.querySelectorAll(hints)).filter(visible);
    const profileLinks = markedHints.length
      ? markedHints.flatMap(node => Array.from(node.querySelectorAll('a[href]')))
      : Array.from(card.querySelectorAll('a[href]')).filter(a => !a.closest('[data-testid="User-Name"],[data-testid*="Avatar"],[data-testid*="avatar"],button,[role="button"]')
        && profile(a.getAttribute('href')) !== owner(childUrl));
    const recipients = new Set(profileLinks.filter(a => visible(a) && owned(a, card)).map(a => profile(a.getAttribute('href'))).filter(Boolean));
    return recipients.size === 1 && recipients.has(owner(parent.url)) ? parent.url : '';
  } catch { return ''; }
}

export function isCompletionActionTool(name, args = {}) {
  if (name === 'execute_webmcp_tool') return true;
  if (
    DIRECT_ACTION_TOOLS.has(name)
    || NAVIGATION_ACTION_TOOLS.has(name)
    || DOWNLOAD_ACTION_TOOLS.has(name)
    || args?.__completionDownloadAction === true
  ) {
    return true;
  }
  if (name === 'set_field') return true;
  if (name === 'press_keys') {
    const keys = keyText(args);
    const benign = /\b(tab|escape|esc)\b/.test(keys);
    const risky = /\b(enter|return)\b/.test(keys);
    // Arrow keys are consequential: Chrome's trusted CDP path can change
    // native select/range values, and either browser can trigger page key
    // handlers. Unsupported keys remain fail-closed here; their handlers opt
    // out with dispatched:false before emitting any keyboard event.
    return !benign || risky;
  }
  if (name === 'fetch_url' || name === 'research_url') {
    return MUTATION_METHODS.has(normalizedMethod(args));
  }
  return false;
}

export function didCompletionActionExecute(name, args = {}, result) {
  if (!isCompletionActionTool(name, args)) return false;
  if (name === 'fetch_url' || name === 'research_url') {
    // Once a write request reaches the network tool, an error response cannot
    // prove that the server did not commit the mutation.
    return true;
  }
  if (result == null) return true;
  if (
    name === 'set_checked'
    && result.success === true
    && result.idempotent === true
    && result.verified === true
    && result.dispatched === false
    && result.noDispatch === true
    && result.checkedAfter === args?.checked
  ) {
    return false;
  }
  if (result.dispatched === true) return true;
  if (
    result.missingToolResponse
    || result.outcomeUnknown
    || result.inconclusive
    || result.fallbackAttempted
    || result.noProgress
  ) {
    return true;
  }
  if (result.success === true) return true;
  if (
    result.denied
    || result.skipped
    || result.cancelled
    || result.noDispatch === true
    || result.dispatched === false
  ) {
    return false;
  }
  // click_ax reports fallbackAttempted:false only when it failed before either
  // the DOM click or the CDP fallback was dispatched (for example a stale ref).
  if (name === 'click_ax' && result.success === false && result.fallbackAttempted === false) {
    return false;
  }
  // upload_file handlers mark the point where file data reached the page.
  // Validation/download-resolution failures happen before that point.
  if (name === 'upload_file' && result.success === false && result.dispatched !== true) {
    return false;
  }
  // Once an action handler was invoked, an error is not proof that nothing
  // happened: page JS may mutate before throwing, uploads may be consumed
  // before confirmation fails, and navigation responses can be lost. Action
  // tools must opt into the false path with dispatched:false/noDispatch:true.
  if (result.success === false || result.error) return true;
  // Most legacy action tools return a result object without an explicit
  // success boolean. No error means the action was dispatched.
  return true;
}

// Tools that use no page, or only read the run's tab, besides the
// observations above. The read line done adds after a background read
// (network-tools.js backgroundReadNote) says the active tab was not changed
// only while every tool of the run was one of these or a fetch_url or
// research_url read; anything else, a tool added later included, drops that
// claim.
const RUN_TAB_NEUTRAL_TOOLS = new Set([
  'done', 'done_json', 'clarify', 'calculate', 'scratchpad_write', 'progress_read', 'progress_update',
  'recall_memcode', 'wait', 'wait_for_stable', 'take_screenshot', 'get_window_info', 'get_selection',
  'list_webmcp_tools',
]);

// Whether this call may have changed the run's tab: an action that ran (as
// the completion state counts it), or any unlisted tool (scroll, hover,
// find_text, carousel_navigate, a Tab or Escape key) unless its result says
// it never ran.
export function changedRunTab(name, args = {}, result) {
  if (name === 'fetch_url' || name === 'research_url') return MUTATION_METHODS.has(normalizedMethod(args));
  if (OBSERVATION_TOOLS.has(name) || RUN_TAB_NEUTRAL_TOOLS.has(name)) return false;
  if (isCompletionActionTool(name, args)) return didCompletionActionExecute(name, args, result);
  return !(result && (result.denied || result.skipped || result.cancelled
    || result.noDispatch === true || result.dispatched === false));
}

function validNativeChatBinding(binding) {
  const telegram = /^dom:telegram:[ak]:-?\d+:0$/.test(binding?.threadKey || '');
  const whatsapp = /^dom:whatsapp:phone:[a-f0-9]{32}$/.test(binding?.threadKey || '');
  return binding?.complete === true && typeof binding.body === 'string'
    && binding.body.length > 0 && binding.body.length <= 20000 && (telegram || whatsapp)
    && Array.isArray(binding.messageIds) && binding.messageIds.length <= 200
    && (!whatsapp || binding.messageIds.length > 0)
    && new Set(binding.messageIds).size === binding.messageIds.length
    && binding.messageIds.every(id => typeof id === 'string'
      && id.startsWith(binding.threadKey.slice(4) + ':')
      && (telegram ? /^\d{1,24}$/.test(id.slice(id.lastIndexOf(':') + 1))
        : /^[A-Za-z0-9_-]{1,32}$/.test(id.slice(binding.threadKey.length - 3))));
}

function nativeChatDeliveryAfterBaseline(binding, proof) {
  if (!validNativeChatBinding(binding) || typeof proof?.messageId !== 'string'
      || binding.messageIds.includes(proof.messageId)
      || !proof.messageId.startsWith(binding.threadKey.slice(4) + ':')) return false;
  if (/^dom:whatsapp:phone:/.test(binding.threadKey)) {
    // Opaque WhatsApp ids have no chronological ordering. Only the private
    // content-world mounted-tail certificate can establish a fresh receipt.
    return proof.nativeMountedTailVerified === true
      && /^[A-Za-z0-9_-]{1,32}$/.test(proof.messageId.slice(binding.threadKey.length - 3));
  }
  const sequence = proof.messageId.slice(proof.messageId.lastIndexOf(':') + 1);
  return /^\d{1,24}$/.test(sequence)
    && binding.messageIds.every(id => BigInt(id.slice(id.lastIndexOf(':') + 1)) < BigInt(sequence));
}

export function isCompletionObservationTool(name, args = {}, result, state = null) {
  if (name === 'chat_observe') {
    const proof = result?.chatDeliveryVerification;
    const binding = state?.lastAction?.chatDeliveryBinding;
    return result?.success === true && !result.error && !result.outcomeUnknown
      && !result.denied && !result.skipped && !result.cancelled
      && result?.chatWorkflow?.pendingOutbound === false && !result.chatWorkflow.userInput?.required
      && result?.composer?.available === true && result.composer.empty === true
      && proof?.schema === 'webbrain-chat-completion/1' && !!binding
      && proof.actionSequence === state.lastAction.sequence && proof.threadKey === binding.threadKey
      && result.threadKey === binding.threadKey && result.chatWorkflow.threadKey === binding.threadKey
      && nativeChatDeliveryAfterBaseline(binding, proof);
  }
  if (name === 'fetch_url' || name === 'research_url') {
    if (MUTATION_METHODS.has(normalizedMethod(args))) return false;
  } else if (!OBSERVATION_TOOLS.has(name)) {
    return false;
  }
  if (result == null || result.missingToolResponse || result.outcomeUnknown) return false;
  if (
    result.success === false
    || result.denied
    || result.skipped
    || result.cancelled
    || result.error
  ) {
    return false;
  }
  if (name === 'wait_for_element' && (result.found !== true || result.timedOut === true)) {
    return false;
  }
  if (name === 'auto_screenshot' || name === 'inspect_viewport' || name === 'screenshot' || name === 'full_page_screenshot') {
    if (result.method === 'save_only') return false;
    if (result.method === 'vision_describe') return !!result.description;
    if (result.method === 'image_attach') return !!result._attachImage;
    return !!(result._attachImage || result.image || result.dataUrl);
  }
  return true;
}

export function createCompletionInvariantState(runToken = '') {
  return {
    runToken: String(runToken || ''),
    sequence: 0,
    hadAction: false,
    verificationDebt: false,
    lastAction: null,
    lastObservation: null,
    consumedActionSequence: 0,
    consumedObservationSequence: 0,
    iframeFormVerificationDebt: false,
    iframeFormScope: '',
    iframeFormVerificationObligations: [],
  };
}

export function recordCompletionToolResult(state, name, args = {}, result, { chatDeliveryBinding = null, nativeChatReadRepair = false } = {}) {
  const current = state || createCompletionInvariantState();
  const sequence = Number(current.sequence || 0) + 1;
  const next = { ...current, sequence };
  const ownedNativeReadRepair = nativeChatReadRepair === true && name === 'click_ax'
    && result?.success === true && !result.outcomeUnknown && result.noDispatch !== true
    && (result._nativeWhatsappReadRepair === true || result._nativeTelegramReadRepair === true);

  if (didCompletionActionExecute(name, args, result) && !ownedNativeReadRepair) {
    const selfVerified = isSelfVerifyingActionResult(name, result, args);
    const downloadAction = DOWNLOAD_ACTION_TOOLS.has(name)
      || args?.__completionDownloadAction === true;
    next.hadAction = true;
    // A persisted scheduler result proves its own mutation, but it must never
    // erase verification debt opened by an earlier page action.
    if (selfVerified && current.verificationDebt) {
      // The run has moved on, though lastAction still names the page action the
      // debt belongs to: the later action's sequence is kept apart.
      next.laterSelfVerifiedSequence = sequence;
      return next;
    }
    next.verificationDebt = !selfVerified;
    next.lastAction = {
      name,
      sequence,
      ...(validNativeChatBinding(chatDeliveryBinding)
        ? { chatDeliveryBinding: { ...chatDeliveryBinding, messageIds: [...chatDeliveryBinding.messageIds] } } : {}),
      ...(selfVerified ? { selfVerified: true } : {}),
      ...(downloadAction ? { downloadAction: true } : {}),
      uncertain: !!(
        result == null
        || result?.missingToolResponse
        || result?.outcomeUnknown
        || result?.inconclusive
        || result?.fallbackAttempted
        || result?.noProgress
        || (result?.dispatched === true && result?.success !== true)
        || result?.success === false
        || result?.error
      ),
    };
    if (name === 'iframe_type') {
      const obligation = iframeFormObligation(args, result);
      const obligations = Array.isArray(current.iframeFormVerificationObligations)
        ? [...current.iframeFormVerificationObligations]
        : [];
      if (obligation) {
        const key = iframeFormObligationKey(obligation);
        const existingIndex = obligations.findIndex(item => iframeFormObligationKey(item) === key);
        if (existingIndex >= 0) obligations[existingIndex] = obligation;
        else obligations.push(obligation);
      }
      syncIframeFormDebt(next, obligations);
    }
    return next;
  }

  if (isCompletionObservationTool(name, args, result, current)) {
    if (
      current.verificationDebt
      && current.lastAction?.downloadAction === true
      && !['list_downloads', 'read_downloaded_file'].includes(name)
    ) {
      return next;
    }
    if (
      name === 'auto_screenshot'
      && (
        current.lastAction?.downloadAction === true
        || BACKGROUND_ACTION_TOOLS.has(current.lastAction?.name)
      )
    ) {
      return next;
    }
    next.lastObservation = { name, sequence };
    if (current.verificationDebt) next.verificationDebt = false;
    if (
      name === 'verify_form'
      && result?.success === true
      && result?.scope === 'iframe'
      && Array.isArray(result?.targetChecks)
    ) {
      const verifiedScope = normalizedIframeScope(result?.urlFilter || args?.urlFilter);
      const checks = result.targetChecks.filter(check => (
        check?.matched === true
        && check?.valueMatchesExpected === true
        && normalizedIframeScope(check?.scope || verifiedScope) === verifiedScope
      ));
      const obligations = (Array.isArray(current.iframeFormVerificationObligations)
        ? current.iframeFormVerificationObligations
        : []).filter(obligation => !checks.some(check => (
          normalizedIframeScope(obligation?.scope) === verifiedScope
          && String(check?.selector || '') === String(obligation?.selector || '')
          && normalizedIframeMatchIndex(check?.matchIndex) === normalizedIframeMatchIndex(obligation?.matchIndex)
          && (
            !Number.isInteger(obligation?.frameId)
            || Number(check?.frameId) === obligation.frameId
          )
        )));
      syncIframeFormDebt(next, obligations);
    }
  }
  return next;
}

export function hasFreshCompletionObservation(state) {
  if (!state?.hadAction || state.verificationDebt) return false;
  const actionSequence = Number(state.lastAction?.sequence || 0);
  const observationSequence = Number(state.lastObservation?.sequence || 0);
  return observationSequence > actionSequence;
}

export function hasUnconsumedCompletionObservation(state) {
  if (!hasFreshCompletionObservation(state)) return false;
  const actionSequence = Number(state.lastAction?.sequence || 0);
  const observationSequence = Number(state.lastObservation?.sequence || 0);
  const consumedActionSequence = Number(state.consumedActionSequence || 0);
  const consumedSequence = Number(state.consumedObservationSequence || 0);
  return actionSequence > consumedActionSequence && observationSequence > consumedSequence;
}

export function hasUnconsumedCompletionObservationResult(state) {
  const actionSequence = Number(state?.lastAction?.sequence || 0);
  const observationSequence = Number(state?.lastObservation?.sequence || 0);
  const consumedSequence = Number(state?.consumedObservationSequence || 0);
  return observationSequence > actionSequence && observationSequence > consumedSequence;
}

export function consumeCompletionObservation(state) {
  if (!hasUnconsumedCompletionObservation(state)) return state;
  return {
    ...state,
    consumedActionSequence: Number(state.lastAction?.sequence || 0),
    consumedObservationSequence: Number(state.lastObservation?.sequence || 0),
  };
}

export function consumeCompletionObservationResult(state) {
  if (!hasUnconsumedCompletionObservationResult(state)) return state;
  return {
    ...state,
    consumedObservationSequence: Number(state.lastObservation?.sequence || 0),
  };
}

// `skip`: reasons a caller already accepted over advice (Strict checks off,
// see guard-policy.js), so the next invariant still gets its own note.
export function completionDoneBlock(state, toolName, args = {}, { skip = null } = {}) {
  const skipped = reason => skip?.has?.(reason) === true;
  const isDoneJson = toolName === 'done_json';
  const outcome = isDoneJson ? 'success' : normalizedOutcome(args?.outcome);
  if (!isDoneJson && !outcome && !skipped('missing_outcome')) {
    return {
      reason: 'missing_outcome',
      error: 'done requires outcome="success", "partial", or "failed". Use partial or failed when the task is not fully verified.',
    };
  }
  if (outcome === 'partial' || outcome === 'failed') return null;
  if (state?.iframeFormVerificationDebt && !skipped('iframe_form_verification_required')) {
    const pendingCount = Array.isArray(state.iframeFormVerificationObligations)
      ? state.iframeFormVerificationObligations.length
      : 1;
    return {
      reason: 'iframe_form_verification_required',
      error: `${pendingCount} iframe form target${pendingCount === 1 ? '' : 's'} have not been semantically verified. Call verify_form for each edited iframe host, compare the returned labels and values with the intended answers, correct any mismatch, then call done again.`,
      urlFilter: state.iframeFormScope || null,
      pendingTargetCount: pendingCount,
    };
  }
  if (state?.verificationDebt && !skipped('verification_required')) {
    return {
      reason: 'verification_required',
      error: 'The latest consequential action has not been verified by a successful explicit page/state observation. Re-read the relevant state after the action, then call done again; otherwise finish with outcome="partial" or outcome="failed".'
        + (state.lastAction?.downloadAction ? ' Use list_downloads or read_downloaded_file to verify this download.'
          : ' For parent-page state or absence, use get_accessibility_tree or read_page. verify_form({urlFilter}) reads matching child iframe forms only, not a parent-page URL.'),
      lastAction: state.lastAction ? {
        name: state.lastAction.name,
        sequence: state.lastAction.sequence,
        uncertain: state.lastAction.uncertain,
      } : null,
    };
  }
  return null;
}

export function completionPlainFinalBlock(state) {
  if (!state?.hadAction) return null;
  if (state.iframeFormVerificationDebt) {
    return '[RUNTIME COMPLETION BLOCK: A plain final answer cannot end this run because edited iframe form state still requires semantic verification. Do not call done with outcome="success" yet. Call verify_form for every pending iframe target, inspect the returned labels and values, correct any mismatch, and only then call done on a later turn. Use outcome="partial" or outcome="failed" if verification cannot be completed.]';
  }
  if (state.verificationDebt) {
    return '[RUNTIME COMPLETION BLOCK: A plain final answer cannot end this run because the latest consequential action has not been verified by a successful post-action observation. Do not call done with outcome="success" yet. Call one available read-only page/state observation tool now, inspect its result, and only then call done on a later turn. Use outcome="partial" or outcome="failed" if verification cannot be completed.]';
  }
  return '[RUNTIME COMPLETION BLOCK: This Act/Dev run executed a consequential action and its post-action state has been observed, but a plain final answer cannot end it. Call done now with an explicit outcome of success, partial, or failed.]';
}

export function completionPlainFinalPartial(state, content, { verificationPending = false } = {}) {
  const mustVerify = verificationPending
    || !!state?.verificationDebt
    || !!state?.iframeFormVerificationDebt;
  const lines = [
    'The run stopped after the model returned plain text repeatedly instead of the required structured completion.',
    'Outcome: partial.',
  ];
  if (mustVerify) {
    lines.push('A consequential action may have occurred, but its final state was not verified. Inspect the current page before retrying so the action is not repeated blindly.');
    return lines.join('\n\n');
  }
  lines.push('The latest page state was observed, but the model did not complete the required done handoff.');
  const summary = String(content || '').trim();
  if (summary) {
    const bounded = summary.length > 12000 ? `${summary.slice(0, 12000)}\n[Latest model output truncated]` : summary;
    lines.push(`Latest model output (not accepted as verified completion):\n${bounded}`);
  }
  return lines.join('\n\n');
}
