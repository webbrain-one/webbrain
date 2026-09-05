/**
 * Read-only observation of the active support conversation.
 *
 * The DOM is an untrusted data source. This module deliberately returns
 * message text only as data and only treats app-owned semantic attributes as
 * workflow controls or safety evidence.
 * Keep the Firefox copy byte-identical.
 */

(() => {
  if (typeof window.__wb_observe_chat_dom === 'function') return;

  const SCHEMA = 'webbrain-chat-observation/1';
  const MAX_TEXT = 4000;
  const MAX_ITEMS = 200;
  const MESSAGE_SELECTORS = [
    '[data-message-id]',
    '[data-legacy-message-id]',
    '[data-message-direction]',
    '[data-direction]',
    '[data-message-author-role]',
    '[data-author-role]',
    '[data-outgoing]',
    '[data-is-outgoing]',
    '[data-incoming]',
    '[data-is-incoming]',
    '[data-message]',
    '[role="listitem"]',
    'article',
  ];
  const THREAD_ID_ATTRIBUTES = [
    'data-conversation-id',
    'data-thread-id',
    'data-chat-id',
  ];
  const IDENTITY_ATTRIBUTES = [
    'data-conversation-identity',
    'data-recipient',
    'data-chat-recipient',
    'data-recipient-id',
  ];

  const compact = (value, max = 240) => String(value ?? '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

  const normalizeText = (value) => String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT);

  const attribute = (node, name) => compact(node?.getAttribute?.(name), 1000);

  const visible = (node) => {
    if (!node || node.nodeType !== 1 || node.isConnected === false) return false;
    try {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect?.() || {};
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && (rect.width == null || rect.width > 0)
        && (rect.height == null || rect.height > 0);
    } catch {
      return false;
    }
  };

  const editable = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const tag = String(node.tagName || '').toLowerCase();
    const type = attribute(node, 'type').toLowerCase();
    const role = attribute(node, 'role').toLowerCase();
    return !!node.isContentEditable
      || tag === 'textarea'
      || (tag === 'input' && !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/.test(type || 'text'))
      || role === 'textbox'
      || role === 'searchbox';
  };

  const contains = (parent, child) => parent === child || !!parent?.contains?.(child);

  const query = (root, selector) => {
    try { return Array.from(root?.querySelectorAll?.(selector) || []); } catch { return []; }
  };

  const queryMany = (root, selectors) => {
    const result = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of query(root, selector)) {
        if (!seen.has(node)) {
          seen.add(node);
          result.push(node);
        }
      }
    }
    return result;
  };

  const parentChain = (node, limit = 20) => {
    const result = [];
    for (let current = node, depth = 0; current && depth < limit; depth += 1, current = current.parentElement) {
      result.push(current);
    }
    return result;
  };

  const firstAttribute = (nodes, names) => {
    for (const node of nodes) {
      for (const name of names) {
        const value = attribute(node, name);
        if (value) return { name, value, node };
      }
    }
    return null;
  };

  const booleanValue = (value, attributePresent = false) => {
    const normalized = compact(value, 40).toLowerCase();
    if (['true', 'yes', '1', 'verified', 'complete', 'connected', 'required'].includes(normalized)) return true;
    if (['false', 'no', '0', 'unverified', 'incomplete', 'disconnected', 'optional'].includes(normalized)) return false;
    return attributePresent && !normalized ? true : null;
  };

  const readBooleanSemantic = (root, names) => {
    const nodes = [root, ...queryMany(root, names.map(name => `[${name}]`))];
    for (const node of nodes) {
      for (const name of names) {
        if (!node?.hasAttribute?.(name)) continue;
        const result = booleanValue(node.getAttribute(name), true);
        if (result !== null) return result;
      }
    }
    return null;
  };

  const activeRoot = (composer) => {
    const chain = parentChain(composer);
    const semantic = chain.find(node => THREAD_ID_ATTRIBUTES.some(name => attribute(node, name))
      || ['main', 'data-chat-root', 'data-conversation-root'].some(name => {
        if (name.startsWith('data-')) return node.hasAttribute?.(name);
        return String(node.tagName || '').toLowerCase() === name;
      }));
    if (semantic) return semantic;
    try {
      return document.querySelector('main,[role="main"],[data-chat-root],[data-conversation-root]')
        || document.body
        || document.documentElement;
    } catch {
      return document.body || document.documentElement;
    }
  };

  const markerFor = (composer, root) => {
    const fromComposer = firstAttribute(parentChain(composer), THREAD_ID_ATTRIBUTES);
    if (fromComposer) return fromComposer;
    const activeMarker = queryMany(root, THREAD_ID_ATTRIBUTES.map(name => `[${name}]`))
      .filter(node => visible(node))
      .find(node => (node.hasAttribute?.('aria-current')
          && attribute(node, 'aria-current').toLowerCase() !== 'false')
        || attribute(node, 'aria-selected').toLowerCase() === 'true');
    return firstAttribute(activeMarker ? [activeMarker] : [], THREAD_ID_ATTRIBUTES)
      || firstAttribute([root], THREAD_ID_ATTRIBUTES);
  };

  const identityFor = (composer, root, probe) => {
    const explicit = firstAttribute(parentChain(composer), IDENTITY_ATTRIBUTES)
      || firstAttribute([root], IDENTITY_ATTRIBUTES)
      || firstAttribute(queryMany(root, IDENTITY_ATTRIBUTES.map(name => `[${name}]`)), IDENTITY_ATTRIBUTES);
    if (explicit) return explicit.value;
    const candidate = Array.isArray(probe?.strongIdentityCandidates)
      ? probe.strongIdentityCandidates.find(value => compact(value))
      : '';
    return compact(candidate, 240);
  };

  const messageDirection = (node) => {
    const explicit = [
      attribute(node, 'data-message-direction'),
      attribute(node, 'data-direction'),
      attribute(node, 'data-message-author-role'),
      attribute(node, 'data-author-role'),
    ].find(Boolean)?.toLowerCase() || '';
    if (/^(?:outgoing|sent|self|user|me|from[-_ ]?me|own)/.test(explicit)) return 'outgoing';
    if (/^(?:incoming|received|agent|operator|support|counterparty|other)/.test(explicit)) return 'incoming';
    if (booleanValue(attribute(node, 'data-outgoing'), node.hasAttribute?.('data-outgoing')) === true
      || booleanValue(attribute(node, 'data-is-outgoing'), node.hasAttribute?.('data-is-outgoing')) === true) return 'outgoing';
    if (booleanValue(attribute(node, 'data-incoming'), node.hasAttribute?.('data-incoming')) === true
      || booleanValue(attribute(node, 'data-is-incoming'), node.hasAttribute?.('data-is-incoming')) === true) return 'incoming';
    const className = compact(typeof node.className === 'string' ? node.className : '', 400).toLowerCase();
    const aria = attribute(node, 'aria-label').toLowerCase();
    if (/(?:^|[-_\s])(outgoing|sent|from-me|own-message|self-message)(?:$|[-_\s])/.test(className)
      || /^(?:you(?:\s+sent\b|[:,])|outgoing message\b|sent by you\b)/.test(aria)) return 'outgoing';
    if (/(?:^|[-_\s])(incoming|received|from-them|other-message)(?:$|[-_\s])/.test(className)) return 'incoming';
    return 'unknown';
  };

  const messageText = (node) => normalizeText(node?.innerText || node?.textContent || '');

  const messageId = (node) => [
    'data-message-id',
    'data-legacy-message-id',
    'data-message-key',
  ].map(name => attribute(node, name)).find(Boolean) || '';

  const ignoredMessageNode = (node, composer) => {
    if (contains(node, composer) || contains(composer, node) || editable(node)) return true;
    const tag = String(node.tagName || '').toLowerCase();
    if (['button', 'input', 'textarea', 'select', 'option', 'nav', 'header', 'aside'].includes(tag)) return true;
    try {
      // Chat transcripts are routinely wrapped in a single aria-live/log
      // region, so an announcing ancestor cannot disqualify its messages.
      // Only the node itself counts as a status region; interactive and
      // navigational ancestors still do.
      if (node.matches?.('[aria-live],[role="alert"],[role="status"]')) return true;
      return !!node.closest?.('button,[role="button"],[role="navigation"],nav,header,aside');
    } catch {
      return false;
    }
  };

  const collectMessages = (root, composer) => {
    const candidates = queryMany(root, MESSAGE_SELECTORS)
      .filter(node => visible(node) && !ignoredMessageNode(node, composer))
      .map((node, index) => {
        const text = messageText(node);
        const id = messageId(node);
        const direction = messageDirection(node);
        const metadataScore = (id ? 4 : 0)
          + (direction !== 'unknown' ? 2 : 0)
          + (MESSAGE_SELECTORS.slice(0, 12).some(selector => {
            try { return node.matches?.(selector); } catch { return false; }
          }) ? 1 : 0);
        return {
          node,
          index,
          id,
          text,
          direction,
          metadataScore,
          author: compact(
            attribute(node, 'data-message-author')
              || attribute(node, 'data-author')
              || attribute(node, 'data-sender'),
            240,
          ),
          timestamp: compact(
            attribute(node, 'data-message-timestamp')
              || attribute(node, 'data-timestamp')
              || attribute(node, 'datetime'),
            80,
          ),
        };
      })
      .filter(item => item.text);

    const selected = [];
    for (const candidate of candidates) {
      const duplicate = selected.find(item => {
        if (item.id && candidate.id) return item.id === candidate.id;
        return item.text === candidate.text
          && (contains(item.node, candidate.node) || contains(candidate.node, item.node));
      });
      if (!duplicate) {
        selected.push(candidate);
      } else if (candidate.metadataScore > duplicate.metadataScore
        || (candidate.metadataScore === duplicate.metadataScore && candidate.index > duplicate.index)) {
        selected[selected.indexOf(duplicate)] = candidate;
      }
    }

    // The kernel keeps the last MAX_ITEMS entries, so the newest bubbles —
    // not the oldest — must survive the cap in a long conversation.
    return selected.slice(-MAX_ITEMS).map(item => ({
      ...(item.id ? { id: item.id } : {}),
      direction: item.direction,
      text: item.text,
      ...(item.author ? { author: item.author } : {}),
      ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    }));
  };

  const userInputFor = (root) => {
    const selectors = [
      '[data-webbrain-user-input-required]',
      '[data-requires-user-input]',
      '[data-new-user-decision-required]',
      'input[autocomplete]',
      'input[type="password"]',
      'select[data-webbrain-user-input-required]',
    ];
    for (const node of queryMany(root, selectors)) {
      if (!visible(node)) continue;
      const explicit = [
        attribute(node, 'data-webbrain-user-input-reason'),
        attribute(node, 'data-user-input-reason'),
      ].join(' ').toLowerCase();
      const autocomplete = attribute(node, 'autocomplete').toLowerCase();
      const semantic = [
        attribute(node, 'name'),
        attribute(node, 'id'),
        attribute(node, 'aria-label'),
        attribute(node, 'data-testid'),
      ].join(' ').toLowerCase();
      const type = attribute(node, 'type').toLowerCase();
      let reason = '';
      if (/otp|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/.test(explicit)
        || autocomplete.includes('one-time-code')
        || /otp|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/.test(semantic)) reason = 'otp';
      else if (/pin/.test(explicit) || /(?:^|[^a-z0-9])pin(?:$|[^a-z0-9])/.test(semantic)) reason = 'pin';
      else if (/payment|cc-|credit[-_ ]?card|cvc|cvv/.test(explicit)
        || /cc-|credit[-_ ]?card|cvc|cvv/.test(autocomplete)
        || /payment|credit[-_ ]?card|cvc|cvv/.test(semantic)) reason = 'payment';
      else if (/new[-_ ]?user[-_ ]?decision|decision/.test(explicit)
        || node.hasAttribute?.('data-new-user-decision-required')) reason = 'new_user_decision';
      else if (type === 'password'
        || /authentication|auth|password|login|sign[-_ ]?in/.test(explicit)
        || /(?:^|[^a-z0-9])(?:authentication|auth|password|login|sign[-_ ]?in)(?:$|[^a-z0-9])/.test(semantic)) reason = 'authentication';
      if (!reason) continue;
      const messages = {
        otp: 'A one-time code or verification code requires the user.',
        pin: 'A PIN requires the user.',
        payment: 'A payment or card verification step requires the user.',
        authentication: 'Authentication requires the user.',
        new_user_decision: 'A new user decision requires the user.',
      };
      return { required: true, reason, message: messages[reason] };
    }
    return null;
  };

  const resolutionEvidenceFor = (root) => {
    const names = {
      refund: ['data-webbrain-refund-verified'],
      autoRenewal: ['data-webbrain-auto-renewal-verified'],
      caseNumber: ['data-webbrain-case-number-verified'],
    };
    return Object.fromEntries(Object.entries(names).map(([key, attributes]) => [
      key,
      readBooleanSemantic(root, attributes),
    ]));
  };

  const resolveComposer = (probe, params) => {
    const ref = compact(probe?.composerRef || params.composerRef, 240);
    if (ref && typeof window.__wb_ax_lookup === 'function') {
      try {
        const node = window.__wb_ax_lookup(ref);
        if (node && visible(node)) return { node, ref };
      } catch {}
    }
    const active = document.activeElement;
    if (editable(active) && visible(active)) {
      return { node: active, ref: typeof window.__wb_ax_ref === 'function' ? window.__wb_ax_ref(active) || '' : '' };
    }
    return { node: null, ref: '' };
  };

  window.__wb_observe_chat_dom = (params = {}) => {
    try {
      const probe = params.probe && typeof params.probe === 'object' ? params.probe : {};
      const { node: composer, ref: composerRef } = resolveComposer(probe, params);
      const root = activeRoot(composer);
      const marker = markerFor(composer, root);
      const conversationIdentity = identityFor(composer, root, probe);
      const conversationId = marker?.value || '';
      const url = compact(window.location?.href || '', 1000);
      const threadKey = compact(
        conversationId
          ? `dom:${conversationId}`
          : (url && conversationIdentity ? `${url}#${conversationIdentity}` : url || conversationIdentity || 'document'),
        240,
      );
      const composerValue = composer
        ? ('value' in composer ? composer.value : (composer.innerText || composer.textContent || ''))
        : '';
      const agentConnected = readBooleanSemantic(root, [
        'data-webbrain-agent-connected',
        'data-agent-connected',
      ]);
      return {
        success: true,
        schema: SCHEMA,
        observedAt: new Date().toISOString(),
        ...(url ? { url } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(conversationIdentity ? { conversationIdentity } : {}),
        threadKey,
        messages: collectMessages(root, composer),
        composer: {
          available: !!composer && (probe.composerAvailable !== false),
          ...(composerRef ? { ref: composerRef } : {}),
          empty: normalizeText(composerValue).length === 0,
        },
        agentConnected,
        userInput: userInputFor(root),
        resolutionEvidence: resolutionEvidenceFor(root),
        probe: {
          success: probe.success !== false,
          ...(probe.error ? { error: compact(probe.error, 300) } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        schema: SCHEMA,
        error: error?.message || String(error),
      };
    }
  };
})();
