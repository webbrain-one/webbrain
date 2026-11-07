/**
 * Read-only observation of the active support conversation.
 *
 * The DOM is an untrusted data source. This module deliberately returns
 * message text only as data and only treats bounded semantic attributes as
 * workflow metadata; page attributes never self-authorize completion evidence.
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
  const CHAT_ROOT_SELECTORS = [
    '[data-chat-root]',
    '[data-conversation-root]',
    '[role="log"]',
  ];
  const CHAT_TRANSCRIPT_SELECTORS = [
    '[role="log"]',
    '[aria-live]',
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

  // Mirrors the kernel's canonical form so the fallback ordinal below groups
  // exactly the bubbles the kernel would otherwise give the same id.
  const canonicalText = (value) => {
    const text = normalizeText(value);
    try { return text.normalize('NFKC').toLocaleLowerCase(); } catch { return text.toLowerCase(); }
  };

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
    return query(root, (Array.isArray(selectors) ? selectors : []).filter(Boolean).join(','));
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

  const discordChannel = (composer) => {
    if (!composer || !/^(?:www\.)?discord\.com$/.test(window.location?.hostname || '')) return null;
    const route = /^\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/.exec(window.location?.pathname || '');
    const directMessageRoute = /^\/channels\/@me\/(\d+)(?:\/\d+)?\/?$/.exec(window.location?.pathname || '');
    if ((!route && !directMessageRoute)
        || !composer.matches?.('[data-slate-editor="true"][contenteditable="true"][role="textbox"]')) return null;
    const root = composer.closest('main,[role="main"]');
    if (!root || !visible(root)) return null;
    const transcript = query(root, '[data-list-id="chat-messages"]').find(node =>
      visible(node) && !contains(node, composer));
    const channelId = route?.[2] || directMessageRoute[1];
    const routePath = route
      ? `/channels/${route[1]}/${channelId}`
      : `/channels/@me/${channelId}`;
    const channelLink = query(document, 'nav a[href],[role="navigation"] a[href]').find(node => {
      try {
        const url = new URL(attribute(node, 'href'), window.location.href);
        return visible(node) && attribute(node, 'aria-current') === 'page' && url.origin === window.location.origin
          && url.pathname.replace(/\/$/, '') === routePath;
      } catch { return false; }
    });
    const selectedDmRouteMismatch = !!directMessageRoute
      && query(document, 'nav a[href][data-list-item-id^="private-channels-"],[role="navigation"] a[href][data-list-item-id^="private-channels-"]')
        .some(node => {
          try {
            const url = new URL(attribute(node, 'href'), window.location.href);
            const selectedDmChannelId = /^\/channels\/@me\/(\d+)(?:\/\d+)?\/?$/.exec(url.pathname)?.[1];
            return visible(node) && attribute(node, 'aria-current') === 'page'
              && url.origin === window.location.origin
              && !!selectedDmChannelId && selectedDmChannelId !== channelId;
          } catch { return false; }
        });
    const transcriptRows = query(transcript, '[role="article"]').filter(visible);
    const transcriptChannelIds = transcriptRows
      .map(node => /^chat-messages___chat-messages-(\d+)-\d+$/.exec(attribute(node, 'data-list-item-id'))?.[1])
      .filter(Boolean);
    const transcriptMatchesRoute = transcriptRows.length > 0
      && transcriptChannelIds.length === transcriptRows.length
      && transcriptChannelIds.every(id => id === channelId);
    // The channel's or contact's name, in any language: the longest text of
    // the selected rail link that the composer's label also contains (Discord
    // names the conversation inside its composer's label, in a phrase of the
    // page's language). Without that link the route names it.
    const composerLabel = attribute(composer, 'aria-label');
    const linkTexts = [];
    if (channelLink && composerLabel) {
      const walker = document.createTreeWalker(channelLink, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(), count = 0; node && count < 40; node = walker.nextNode(), count++) {
        const text = compact(node.nodeValue, 240);
        if (text.length >= 2 && composerLabel.includes(text)) linkTexts.push(text);
      }
    }
    const name = linkTexts.sort((left, right) => right.length - left.length)[0]
      || (directMessageRoute ? `direct-message-${channelId}` : `channel-${channelId}`);
    return transcript && (directMessageRoute
      ? !selectedDmRouteMismatch
        && (transcriptRows.length > 0 ? transcriptMatchesRoute : channelLink)
      : (transcriptRows.length > 0 ? transcriptMatchesRoute : channelLink))
      ? {
        root, transcript, name, channelId,
        isDirectMessage: !!directMessageRoute,
        id: directMessageRoute ? `discord:dm:${channelId}` : `discord:${route[1]}:${channelId}`,
      }
      : null;
  };

  const telegramNativeComposer = (composer) => /^(?:web|webk|weba|webz|k)\.telegram\.org$/i.test(window.location?.hostname || '')
    && (composer?.matches?.('.input-message-input[contenteditable="true"]')
      || composer?.matches?.('#editable-message-text[contenteditable="true"][role="textbox"]'));

  const telegramUsername = value => {
    const text = String(value ?? '').trim();
    return /^@?[A-Za-z0-9_]{1,32}(?![\s\S])/.test(text) ? text.replace(/^@/, '').toLowerCase() : '';
  };
  const telegramAliasRoute = () => {
    const [route, search = ''] = window.location.hash.slice(1).split('?');
    const params = new URLSearchParams(search);
    const peer = route === '/im' ? params.get('p') || '' : route;
    return /^@[A-Za-z0-9_]{1,32}(?![\s\S])/.test(peer)
      && !params.has('tgaddr') && !params.has('story') && !params.has('community')
      && (!params.has('thread') || params.get('thread') === '0') ? peer.slice(1).toLowerCase() : '';
  };
  const telegramRendered = node => {
    if (!visible(node)) return false;
    for (let current = node, depth = 0; current; current = current.parentElement) {
      if (++depth > 128) return false;
      const style = getComputedStyle(current);
      if (current.hidden || current.inert || attribute(current, 'aria-hidden') === 'true'
          || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
    }
    return true;
  };
  let telegramAliasProof = null;
  let telegramAliasProofSequence = 0;
  const clearTelegramAliasProof = () => {
    telegramAliasProof?.observer.disconnect();
    telegramAliasProof = null;
  };
  window.addEventListener('hashchange', clearTelegramAliasProof);
  const telegramAliasWitness = (composer, alias) => {
    // WebK keeps a same-geometry fake editor without a native peer attribute.
    // Scanning it must not discard the independently valid real editor proof.
    const composerPeer = String(composer?.getAttribute('data-peer-id') || '');
    if (!/^-?[1-9]\d{0,23}(?![\s\S])/.test(composerPeer)) {
      if (telegramAliasProof?.composer === composer) clearTelegramAliasProof();
      return null;
    }
    const unique = (root, selector) => {
      const nodes = query(root, selector).filter(telegramRendered);
      return nodes.length === 1 ? nodes[0] : null;
    };
    // These two native profile shapes are independently grounded. Self
    // Settings shows usernames; the Saved Messages right profile does not.
    // A display name or data-me-as-notes alone cannot bind an alias route.
    const selfSelector = '#column-left .settings-container.active .settings-layer.profile-container.active .profile-content.is-me';
    const rightSelector = '#column-right .profile-container.active .profile-content:not(.is-me)';
    const candidates = query(document, selfSelector + ',' + rightSelector).filter(telegramRendered).map(profile => {
      const self = profile.matches(selfSelector);
      const column = profile.closest(self ? '#column-left' : '#column-right');
      const settings = self ? profile.closest('.settings-container.active') : null;
      const layer = profile.closest(self ? '.settings-layer.profile-container.active' : '.profile-container.active');
      const name = unique(profile, '.profile-name');
      const titlePeer = unique(name, '.peer-title[data-peer-id]');
      const avatarCarrier = unique(profile, '.profile-avatars-avatar.active');
      const avatarPeer = unique(avatarCarrier, '.avatar[data-peer-id]');
      const icons = query(profile, '.row-with-icon .row-icon > .tgico.row-icon-icon')
        .filter(node => telegramRendered(node) && node.textContent === '\ueac1');
      const icon = icons.length === 1 ? icons[0] : null;
      const row = icon?.closest('.row-with-icon');
      const iconCarrier = icon?.parentElement;
      const username = unique(row, '.row-title');
      const peer = String(titlePeer?.getAttribute('data-peer-id') || '');
      const nodes = [column, ...(self ? [settings] : []), layer, profile, name, titlePeer, avatarCarrier, avatarPeer, row, iconCarrier, icon, username];
      if (nodes.some(node => !node || !telegramRendered(node))
          || !/^-?[1-9]\d{0,23}(?![\s\S])/.test(peer) || (self && peer.startsWith('-'))
          || avatarPeer.getAttribute('data-peer-id') !== peer || composerPeer !== peer
          || telegramUsername(username?.textContent) !== alias
          || query(row, '.row-icon > .tgico.row-icon-icon').filter(telegramRendered).length !== 1) return null;
      return { profile, nodes, username, icon, peer };
    }).filter(Boolean);
    if (candidates.length !== 1) {
      if (telegramAliasProof?.composer === composer) clearTelegramAliasProof();
      return null;
    }
    const { profile, nodes, username, icon, peer } = candidates[0];
    const isMaterial = record => {
      if (record.type === 'characterData') return contains(username, record.target) || contains(icon, record.target);
      if (record.type === 'attributes') return (nodes.some(node => contains(record.target, node)) || record.target === composer)
        && ['class','style','hidden','inert','aria-hidden','data-peer-id'].includes(record.attributeName);
      if (record.type !== 'childList') return false;
      if (contains(username, record.target) || contains(icon, record.target)) return true;
      if ([...record.removedNodes].some(node => nodes.some(pin => node === pin || contains(node, pin)))) return true;
      return [...record.addedNodes].some(node => node.nodeType === 1
        && (node.matches('.profile-content,.peer-title[data-peer-id],.avatar[data-peer-id],.row-with-icon')
          || node.querySelector('.profile-content,.peer-title[data-peer-id],.avatar[data-peer-id],.row-with-icon')));
    };
    if (telegramAliasProof) {
      if (telegramAliasProof.observer.takeRecords().some(telegramAliasProof.isMaterial)) telegramAliasProof.stale = true;
      if (telegramAliasProof.composer !== composer || telegramAliasProof.alias !== alias || telegramAliasProof.peer !== peer
          || telegramAliasProof.url !== location.href || telegramAliasProof.stale
          || telegramAliasProof.nodes.length !== nodes.length
          || telegramAliasProof.nodes.some((node, index) => node !== nodes[index])) clearTelegramAliasProof();
    }
    if (!telegramAliasProof) {
      const proof = { composer, alias, peer, nodes, url: location.href, isMaterial, stale: false,
        sequence: ++telegramAliasProofSequence };
      proof.observer = new MutationObserver(records => { if (records.some(isMaterial)) proof.stale = true; });
      proof.observer.observe(profile, { subtree:true, childList:true, characterData:true, attributes:true });
      proof.observer.observe(composer, { attributes:true, attributeFilter:['data-peer-id'] });
      for (let parent = profile.parentElement, depth = 0; parent && depth++ < 128; parent = parent.parentElement) {
        proof.observer.observe(parent, { childList:true, attributes:true });
      }
      telegramAliasProof = proof;
    }
    return { peer, nodes, signature: JSON.stringify([alias, peer, telegramAliasProof.sequence,
      nodes.map(node => ['class','data-peer-id','hidden','inert','aria-hidden','style'].map(key => node.getAttribute(key))),
      username.textContent, icon.textContent]) };
  };

  const telegramLatestPosition = (root, transcript, webA) => {
    // The numeric maximum of a mounted virtual slice is not the server's
    // latest message. Require the native client's end marker and scrollport.
    const panes = webA ? [transcript] : query(root, '.bubbles-scrollable')
      .filter(node => telegramRendered(node) && contains(node, transcript));
    const scrollPane = panes.length === 1 ? panes[0] : null;
    const markers = webA ? query(transcript, '.messages-container > .list-bottom-marker').filter(marker => {
      for (let node = marker; node && node !== root; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true'
            || style.display === 'none' || ['hidden','collapse'].includes(style.visibility)
            || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
      }
      return true;
    })
      : query(root, '.bubbles').filter(node => telegramRendered(node) && contains(node, transcript));
    const latestMarker = markers.length === 1 ? markers[0] : null;
    const top = Number(scrollPane?.scrollTop), height = Number(scrollPane?.scrollHeight), client = Number(scrollPane?.clientHeight);
    const geometry = !!scrollPane && telegramRendered(scrollPane) && [top, height, client].every(Number.isFinite)
      && client > 0 && height >= client && top >= -4 && top <= height - client + 4;
    const nativeEnd = !!latestMarker && latestMarker.isConnected
      && (webA ? transcript.classList.contains('with-bottom-snap') : latestMarker.classList.contains('scrolled-down'));
    return { scrollPane, latestMarker, latestPositionVerified: geometry && !!latestMarker,
      atLatest: geometry && nativeEnd && Math.abs(height - client - top) <= 4 };
  };

  const telegramThread = (composer, aliasPreparationOnly = false) => {
    if (!telegramNativeComposer(composer)) return null;
    const webA = composer.matches('#editable-message-text');
    const path = window.location.pathname;
    if (window.location.hostname === 'web.telegram.org' && !new RegExp(`^/${webA ? 'a' : 'k'}/?$`).test(path)) return null;
    const fragment = window.location.hash.slice(1);
    let peer = '';
    let thread = '0';
    let aliasWitness = null;
    let aliasPreparation = false;
    if (webA) {
      if (aliasPreparationOnly) return null;
      const route = /^(-?\d+)(?:_(-?\d+|thread)(?:_thread)?)?$/.exec(fragment);
      if (!route) return null;
      [, peer, thread = '0'] = route;
      if (thread === 'thread' || thread === '-1') thread = '0';
    } else {
      const [route, search = ''] = fragment.split('?');
      const params = new URLSearchParams(search);
      peer = route === '/im' ? params.get('p') || '' : route;
      thread = params.get('thread') || '0';
      if (!/^\d+$/.test(thread) || params.has('tgaddr') || params.has('story') || params.has('community')) return null;
      if (/^@[A-Za-z0-9_]{1,32}(?![\s\S])/.test(peer)) {
        if (thread !== '0') return null;
        aliasWitness = telegramAliasWitness(composer, peer.slice(1).toLowerCase());
        if (aliasWitness) {
          if (aliasPreparationOnly) return null;
          peer = aliasWitness.peer;
        } else {
          if (!aliasPreparationOnly) return null;
          peer = String(composer.getAttribute('data-peer-id') || '');
          if (!/^-?[1-9]\d{0,23}(?![\s\S])/.test(peer)) return null;
          aliasPreparation = true;
        }
      } else if (!/^-?\d+$/.test(peer)) return null;
      else {
        if (aliasPreparationOnly) return null;
        clearTelegramAliasProof();
      }
    }
    // A topic/saved-dialog transition can retain the same peer avatar and
    // composer. Without a topic-specific DOM binding it is not a verified
    // native transcript, even though the URL is a communication context.
    if (thread !== '0') return null;
    if ((aliasWitness || aliasPreparation) && query(document, '.input-message-input[contenteditable="true"][data-peer-id]')
      .filter(node => visible(node) && node.getAttribute('data-peer-id') === peer).length !== 1) return null;
    const root = composer.closest(webA ? '#MiddleColumn' : '.chat');
    if (!root || !visible(root)) return null;
    const transcripts = query(root, webA ? '.MessageList' : '.bubbles-inner')
      // WebK permanently mounts a geometry-visible native deletion subtree
      // with the same bubbles-inner class. Its removed rows are not live chat.
      .filter(node => (webA || !node.closest('.bubbles-remover-container > .bubbles-remover.bubbles-inner')) && visible(node));
    const transcript = transcripts.length === 1 ? transcripts[0] : null;
    if (!transcript || contains(transcript, composer) || transcript.matches('.is-animating')) return null;
    // WebA's MessageList layout effect publishes chatId_MAIN_THREAD_ID_type
    // independently of the header. During recipient transitions an updated
    // avatar must not relabel the previous conversation's transcript.
    if (webA && attribute(transcript, 'data-list-key') !== `${peer}_-1_thread`) return null;
    if (webA && query(transcript, ':scope > .Transition_slide-from,:scope > .Transition_slide-to').some(visible)) return null;
    // Recipient changes are asynchronous. A route alone must never bind an old
    // composer or a previous peer's still-rendering bubbles to the new thread.
    const headerPeers = webA ? query(root, '.MiddleHeader .Avatar[data-peer-id]').filter(visible) : [composer];
    if (headerPeers.length !== 1) return null;
    const headerPeer = headerPeers[0];
    if (headerPeer.getAttribute('data-peer-id') !== peer) return null;
    if (!webA && query(transcript, '.bubble[data-mid][data-peer-id]')
      .some(node => visible(node) && node.getAttribute('data-peer-id') !== peer)) return null;
    const titles = query(root, webA ? '.MiddleHeader .ChatInfo .fullName' : '.topbar .chat-info .user-title').filter(visible);
    if (titles.length !== 1) return null;
    const title = titles[0];
    let peerIdentity = headerPeer;
    if (!webA) {
      const titlePeers = query(title, '.peer-title[data-peer-id]').filter(visible);
      if (titlePeers.length !== 1 || titlePeers[0].getAttribute('data-peer-id') !== peer
          || !['', '0'].includes(titlePeers[0].getAttribute('data-thread-id') || '')) return null;
      peerIdentity = titlePeers[0];
    }
    const header = title.closest(webA ? '.MiddleHeader' : '.topbar');
    const name = compact(title.innerText || title.textContent, 240);
    if (!header || !name) return null;
    if (aliasPreparation) {
      // These exact native numeric nodes identify only which read-only UI can
      // be inspected. They do not resolve the route's username or authorize a
      // recipient. Neither localized Saved Messages text nor me-as-notes is
      // self identity; the independently visible native profile still must
      // establish the existing alias witness before normal context succeeds.
      const nodes = [root, transcript, composer, header, title, peerIdentity];
      if (nodes.some(node => !telegramRendered(node))
          || query(transcript, '.bubble[data-mid]').filter(telegramRendered)
            .some(node => node.getAttribute('data-peer-id') !== peer)) return null;
      return { root, transcript, composer, header, carrier: title, peerIdentity,
        peer, alias: telegramAliasRoute(), url: window.location.href,
        timeOrigin: window.performance?.timeOrigin };
    }
    return { root, transcript, peer, thread, webA, header, carrier: title, peerIdentity, ...telegramLatestPosition(root, transcript, webA), service: 'telegram', id: `telegram:${webA ? 'a' : 'k'}:${peer}:${thread}`, name,
      ...(aliasWitness ? { alias: telegramAliasRoute(), aliasWitnessNodes: aliasWitness.nodes, aliasWitnessSignature: aliasWitness.signature } : {}) };
  };

  const telegramMountedMessageState = context => {
    const nativeRows = query(context.transcript, context.webA ? '.Message[data-message-id]' : '.bubble[data-mid]')
      .filter(node => !context.webA || !node.closest('.Transition_slide-inactive'));
    const mountedIds = nativeRows.map(node => node.getAttribute(context.webA ? 'data-message-id' : 'data-mid'));
    const validMountedIds = mountedIds.every(id => /^\d{1,24}$/.test(id || ''))
      && nativeRows.every(node => context.webA
        ? (!node.hasAttribute('data-peer-id') || node.getAttribute('data-peer-id') === context.peer)
        : node.getAttribute('data-peer-id') === context.peer);
    const numericIds = validMountedIds ? mountedIds.map(id => BigInt(id)) : [];
    const uniqueMountedIds = validMountedIds && new Set(numericIds.map(id => String(id))).size === mountedIds.length;
    // This is the latest mounted native-ID floor, including unsupported or
    // empty message bodies. It does not certify a complete history read.
    const nativeIds = uniqueMountedIds ? [...mountedIds].sort((left, right) => {
      const a = BigInt(left), b = BigInt(right); return a < b ? -1 : a > b ? 1 : 0;
    }).slice(-MAX_ITEMS) : [];
    const pendingNative = nativeRows.some(node => context.webA
      ? !!node.querySelector('.MessageOutgoingStatus .icon-message-pending,.MessageOutgoingStatus .icon-message-failed')
      : node.matches('.is-sending,.is-error,.is-outgoing'));
    return { nativeRows, nativeIds, uniqueMountedIds,
      complete: context.atLatest === true && uniqueMountedIds && !pendingNative };
  };
  const telegramMountedMessageBaseline = context => {
    const state = telegramMountedMessageState(context);
    return { threadKey: `dom:${context.id}`, coverage: 'mounted_native_id_floor',
      messageIds: state.nativeIds.map(id => `${context.id}:${id}`), complete: state.complete };
  };
  window.__wb_get_native_telegram_message_baseline = composer => {
    const context = telegramThread(composer);
    return context ? telegramMountedMessageBaseline(context) : null;
  };

  const whatsappNativeComposer = composer => window.location?.hostname === 'web.whatsapp.com'
    && composer?.matches?.('[data-testid="conversation-compose-box-input"][contenteditable="true"][role="textbox"]');

  let whatsappOwner = '';
  const whatsappDocumentEpoch = window.location?.hostname === 'web.whatsapp.com' ? globalThis.crypto?.randomUUID?.() || '' : '';
  let whatsappBindings = new WeakMap();
  let whatsappFloors = new WeakMap();
  let whatsappParkedFloor = null;
  let whatsappRestore = null;
  let whatsappPending = null;
  let whatsappActive = null;
  let whatsappRepairAnchor = null;
  // The anchor is normally the first chat the run looks at. A run that names
  // its recipient may first have to open that person's chat from the chat
  // list: the recipient probe reports that selection, and the anchor then
  // follows WhatsApp's selection until the run arms its one check (a guarded
  // header click). A run for the open chat itself ("this one") never moves
  // its anchor, since that chat is its target. Once a check is armed the
  // anchor stays with that chat, and a later selection change spends it.
  let whatsappAnchorFollowsSelection = false;
  let whatsappCheckArmed = false;
  const whatsappRendered = node => {
    if (!visible(node)) return false;
    for (let current = node, depth = 0; current && depth < 128; current = current.parentElement, depth++) {
      const style = getComputedStyle(current);
      if (current.hidden || current.inert || attribute(current, 'aria-hidden') === 'true'
          || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
    }
    return true;
  };
  const uniqueWhatsappNode = (root, selector) => {
    const nodes = query(root, selector).filter(whatsappRendered);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const whatsappPins = composer => {
    if (!whatsappNativeComposer(composer) || !whatsappRendered(composer)) return null;
    const root = composer.closest('#main[data-testid="conversation-panel-wrapper"]');
    const header = uniqueWhatsappNode(root, '[data-testid="conversation-header"]');
    const carrier = uniqueWhatsappNode(header, '[data-testid="conversation-info-header"]');
    const title = uniqueWhatsappNode(header, '[data-testid="conversation-info-header-chat-title-name"]')
      || uniqueWhatsappNode(header, '[data-testid="conversation-info-header-chat-title"]');
    const name = compact(title?.innerText || title?.textContent, 240);
    const transcript = uniqueWhatsappNode(root, '[data-testid="conversation-panel-messages"]');
    const selected = uniqueWhatsappNode(document, '[data-testid="chat-list"] [aria-selected="true"]');
    const selectedRow = selected?.closest('[role="row"]');
    const rowTitle = uniqueWhatsappNode(selectedRow, '[data-testid="cell-frame-title"]');
    if (!root || !header || !carrier || !title || !name || !transcript || !selectedRow || !rowTitle
        || compact(rowTitle.innerText || rowTitle.textContent, 240) !== name
        || query(header, '[data-testid="you-label"]').some(whatsappRendered)) return null;
    // The production native editor uses a generic placeholder. Recipient
    // authority comes from these exact native nodes and the guarded new
    // contact drawer's unique phone, never from an invented editor label.
    return { root, header, carrier, title, name, composer, transcript, selected, selectedRow, rowTitle,
      url: location.href, timeOrigin: performance.timeOrigin, generation: Number(window.__webbrain_generation) || 0 };
  };
  const sameWhatsappPins = pins => {
    if (!pins || pins.url !== location.href || pins.timeOrigin !== performance.timeOrigin
        || pins.generation !== (Number(window.__webbrain_generation) || 0)) return false;
    const current = whatsappPins(pins.composer);
    return !!current && current.name === pins.name
      && ['root','header','carrier','title','composer','transcript','selected','selectedRow','rowTitle']
        .every(key => current[key] === pins[key]);
  };
  const invalidateWhatsappBindings = (preserveRepair = false, preserveFloor = false) => {
    whatsappBindings = new WeakMap();
    whatsappPending = null;
    whatsappActive = null;
    if (!preserveFloor) { whatsappFloors = new WeakMap(); whatsappParkedFloor = null; }
    if (!preserveRepair && whatsappRepairAnchor) whatsappRepairAnchor.invalidated = true;
  };
  const whatsappAuthority = owner => {
    try {
      const parts = JSON.parse(owner);
      if (!Array.isArray(parts) || !/^tk_[a-f0-9]{8}$/.test(parts[1] || '')
          || !/^[a-f0-9]{64}$/.test(parts[5] || '') || typeof parts[6] !== 'string' || !parts[6] || parts[6].length > 80
          || !/^[a-f0-9]{64}$/.test(parts[7] || '')) return null;
      return { taskKey: parts[1], taskSha256: parts[5], resumeTaskId: parts[6], providerSha256: parts[7] };
    } catch { return null; }
  };
  const sameWhatsappAuthority = (left, right) => !!left && !!right
    && ['taskKey','taskSha256','resumeTaskId','providerSha256'].every(key => left[key] === right[key]);
  const whatsappFloorMatchesRestore = (floor, restore) => !!floor && !!restore
    && restore.schema === 'webbrain-native-opaque-baseline/1' && restore.threadKey === `dom:${floor.peer}`
    && restore.documentEpoch === whatsappDocumentEpoch && restore.timeOrigin === floor.pins.timeOrigin
    && restore.url === floor.pins.url && restore.tailId === `${floor.peer}:${attribute(floor.tail, 'data-id')}`
    && sameWhatsappAuthority(floor.authority, restore) && sameWhatsappAuthority(whatsappAuthority(whatsappOwner), restore)
    && normalizeText(restore.body) === floor.body
    && Array.isArray(restore.messageIds) && restore.messageIds.length === floor.rows.length
    && restore.messageIds.every((id, index) => id === `${floor.peer}:${attribute(floor.rows[index], 'data-id')}`);
  window.__wb_update_native_chat_owner = (owner, restore = null) => {
    const next = typeof owner === 'string' && owner.length <= 1000 ? owner : '';
    whatsappRestore = restore && typeof restore === 'object' ? restore : null;
    if (next !== whatsappOwner) {
      invalidateWhatsappBindings(false, true); whatsappRepairAnchor = null; whatsappOwner = next;
      whatsappAnchorFollowsSelection = false; whatsappCheckArmed = false;
      let sameRunSourceChanged = false;
      try {
        const prior = JSON.parse(whatsappParkedFloor?.owner || 'null'), current = JSON.parse(next || 'null');
        sameRunSourceChanged = !!prior && !!current && prior[0] === current[0]
          && (prior[2] !== current[2] || prior[3] !== current[3]);
      } catch {}
      if (sameRunSourceChanged || !whatsappFloorMatchesRestore(whatsappParkedFloor, whatsappRestore)) {
        whatsappFloors = new WeakMap(); whatsappParkedFloor = null;
      }
    }
  };
  const whatsappDrawers = () => query(document, '[data-testid="chat-info-drawer"]').filter(whatsappRendered);
  // WhatsApp draws each emoji in a contact's name as an <img> inside the
  // name (a traced contact's name held one). Requiring a name node with no
  // child elements at all left such a contact's drawer uncaptured and its
  // Close button blocked, the very step the guard names, so the contact could
  // never be confirmed. A name is still plain text when its only elements are
  // those emoji images: they hold no text, and the header and chat-list
  // titles it is compared with leave the same images out of their text. Any
  // other element, or an image whose text is not emoji, still fails.
  const WHATSAPP_EMOJI_TEXT = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3|[\u200d\ufe0e\ufe0f\u{e0020}-\u{e007f}])+$/u;
  const whatsappEmojiImage = node => node?.localName === 'img' && node.childElementCount === 0
    && !!node.matches?.('.emoji,[data-type="emoji"],[data-plain-text]')
    && WHATSAPP_EMOJI_TEXT.test(attribute(node, 'data-plain-text') || attribute(node, 'alt'));
  const whatsappPlainName = node => !!node && Array.from(node.children).every(whatsappEmojiImage);
  const whatsappPhoneFields = drawer => query(drawer, '[data-testid="selectable-text"]')
    .filter(node => !drawer.isConnected || whatsappRendered(node))
    .map(node => {
      const text = compact(node.innerText || node.textContent, 80);
      const phone = /^\+[\d ()-]{7,40}$/.test(text) ? text.replace(/[ ()-]/g, '') : '';
      return { node, phone: /^\+[1-9]\d{7,14}$/.test(phone) ? phone : '' };
    }).filter(field => field.phone);
  const sameWhatsappDrawerIdentity = record => {
    const drawer = record?.drawer;
    if (!drawer || !record.drawerHeader || !record.subtitle || !record.phoneFields?.length) return false;
    const scoped = selector => query(drawer, selector).filter(node => !drawer.isConnected || whatsappRendered(node));
    const headers = scoped('[data-testid="contact-info-header"]');
    const subtitles = scoped('[data-testid="contact-info-subtitle selectable-text"]');
    const fields = whatsappPhoneFields(drawer);
    return headers.length === 1 && headers[0] === record.drawerHeader
      && subtitles.length === 1 && subtitles[0] === record.subtitle && whatsappPlainName(record.subtitle)
      && compact(record.subtitle.innerText || record.subtitle.textContent, 240) === record.pins.name
      && fields.length === record.phoneFields.length
      && fields.every((field, index) => field.node === record.phoneFields[index].node
        && field.phone === record.phoneFields[index].phone && field.phone === record.phone);
  };
  const whatsappDrawerIdentityChanged = (record, change) => {
    const identity = [record.subtitle, ...record.phoneFields.map(field => field.node)];
    if (identity.some(node => contains(node, change.target))) return true;
    if (change.type !== 'childList') return false;
    if (Array.from(change.removedNodes || [])
      .some(removed => [record.drawerHeader, ...identity].some(node => contains(removed, node)))) return true;
    // An added conflicting field may disappear before the observer callback.
    // Its mutation history cannot preserve the prior unique identity proof.
    const identitySelector = '[data-testid="contact-info-header"],[data-testid="contact-info-subtitle selectable-text"],[data-testid="selectable-text"]';
    return Array.from(change.addedNodes || []).some(added => {
      const fields = [added, ...query(added, identitySelector)].filter(node => node?.matches?.(identitySelector));
      return fields.some(node => attribute(node, 'data-testid') !== 'selectable-text'
        || /^\+[\d ()-]{7,40}$/.test(compact(node.innerText || node.textContent, 80)));
    });
  };
  // The contact drawer's close control, in any language: the one named plain
  // button in the drawer's own header (WhatsApp names it in the page's
  // language). A drawer that was removed is judged as it was when it closed.
  const whatsappDrawerClose = drawer => {
    if (!drawer) return null;
    const shown = node => !drawer.isConnected || whatsappRendered(node);
    const header = query(drawer, 'header').find(shown);
    const buttons = header ? query(header, 'button').filter(button => shown(button)
      && button.closest('[data-testid="chat-info-drawer"]') === drawer && button.closest('header') === header) : [];
    const button = buttons.length === 1 ? buttons[0] : null;
    return button && attribute(button, 'aria-label') && button.type === 'button' && !button.disabled
      && !button.form && !button.hasAttribute('form') ? button : null;
  };
  // The drawer closed through the exact control the guarded click armed,
  // still named as it was then.
  const sameWhatsappCloseWitness = record => {
    const close = record?.closeWitness;
    return !!close?.button && close.owner === whatsappOwner && whatsappDrawerClose(record.drawer) === close.button
      && attribute(close.button, 'aria-label') === close.label;
  };
  const captureWhatsappDrawer = () => {
    const record = whatsappPending;
    if (!record || record.owner !== whatsappOwner || !sameWhatsappPins(record.pins)) return;
    const drawers = whatsappDrawers();
    if (!record.drawer && drawers.length === 1 && !record.priorDrawers.has(drawers[0])) {
      const drawer = drawers[0];
      const header = uniqueWhatsappNode(drawer, '[data-testid="contact-info-header"]');
      const subtitle = uniqueWhatsappNode(drawer, '[data-testid="contact-info-subtitle selectable-text"]');
      if (!header || !subtitle || !whatsappPlainName(subtitle)
          || compact(subtitle.innerText || subtitle.textContent, 240) !== record.pins.name) return;
      const phoneFields = whatsappPhoneFields(drawer);
      const phones = new Set(phoneFields.map(field => field.phone));
      if (phones.size !== 1 || phoneFields.length > 20) return;
      record.drawer = drawer;
      record.drawerHeader = header;
      record.subtitle = subtitle;
      record.phoneFields = phoneFields;
      record.phone = [...phones][0];
      // Canonical phone stays private. The public peer id uses 128 bits of its
      // SHA-256, leaving room for opaque message ids in bounded tool views.
      void crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.phone)).then(bytes => {
        if (whatsappPending !== record || record.owner !== whatsappOwner || !sameWhatsappPins(record.pins)
            || !sameWhatsappDrawerIdentity(record)) return;
        record.id = 'whatsapp:phone:' + Array.from(new Uint8Array(bytes).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
      }).catch(() => {});
    }
    if (record.drawer && !record.drawer.isConnected && !drawers.length && record.id
        && sameWhatsappCloseWitness(record) && sameWhatsappDrawerIdentity(record) && sameWhatsappPins(record.pins)) {
      const floor = whatsappFloors.get(record.pins.composer);
      if (floor?.peer === record.id && sameWhatsappPins(floor.pins) && whatsappFloorMatchesRestore(floor, whatsappRestore)) {
        record.sendFloor = floor;
      }
      whatsappBindings.set(record.pins.composer, record);
      whatsappActive = record;
      whatsappPending = null;
    }
  };
  const whatsappMutations = records => {
    const record = whatsappPending || whatsappActive;
    for (const change of records) {
      const pins = record?.pins || whatsappParkedFloor?.pins;
      if (record?.drawer && change.type === 'childList'
          && Array.from(change.addedNodes || []).some(added =>
            [added, ...query(added, '[data-testid="chat-info-drawer"]')]
              .some(node => node?.matches?.('[data-testid="chat-info-drawer"]') && node !== record.drawer))) {
        invalidateWhatsappBindings(); return;
      }
      // Native Close icons and media loaders update their own visual labels.
      // Preserve those only while the original identity witness is exact.
      // Identity mutation history remains a fence even after change-and-return.
      if (record?.drawer && contains(record.drawer, change.target)) {
        if (whatsappDrawerIdentityChanged(record, change) || !sameWhatsappDrawerIdentity(record)) {
          invalidateWhatsappBindings(); return;
        }
      }
      // Selection can change and return before a read. Its mutation history,
      // rather than only its final name/state, revokes the old peer proof.
      if (change.type === 'attributes' && change.attributeName === 'aria-selected'
          && change.target.closest?.('[data-testid="chat-list"]')) { invalidateWhatsappBindings(); return; }
      if (pins && (change.type === 'characterData' || change.type === 'childList')
          && [pins.title, pins.rowTitle].some(node => contains(node, change.target))) {
        invalidateWhatsappBindings(); return;
      }
      if (pins && !sameWhatsappPins(pins)) { invalidateWhatsappBindings(); return; }
    }
    captureWhatsappDrawer();
  };
  const whatsappObserver = window.location?.hostname === 'web.whatsapp.com' && typeof MutationObserver === 'function'
    ? new MutationObserver(whatsappMutations) : null;
  whatsappObserver?.observe(document, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['aria-selected','aria-label','data-testid','hidden','inert','aria-hidden'],
  });
  if (whatsappObserver) for (const event of ['pagehide','popstate','hashchange']) window.addEventListener(event, () => invalidateWhatsappBindings());
  const nativeApi = typeof chrome !== 'undefined' ? chrome : typeof browser !== 'undefined' ? browser : null;
  if (whatsappObserver) nativeApi?.runtime?.onMessage?.addListener(message => {
    if (message?.target === 'content' && message.action === 'page_monitor_state' && message.active === false) {
      // Monitor listeners may run after this one. Only its accepted stop can
      // revoke the floor; an old run's ignored stop cannot erase a newer run.
      queueMicrotask(() => {
        if (window.__wbPageMonitor?.active !== false) return;
        invalidateWhatsappBindings(); whatsappOwner = ''; whatsappRestore = null;
      });
    }
    if (message?.target === 'content' && ['page_monitor_stop','page_monitor_start'].includes(message.action)) {
      invalidateWhatsappBindings(false, message.action === 'page_monitor_start'); whatsappOwner = ''; whatsappRestore = null;
    }
  });
  window.__wb_prepare_native_chat_contact = target => {
    if (!whatsappObserver) return false;
    whatsappMutations(whatsappObserver.takeRecords());
    if (!whatsappOwner) return false;
    const record = whatsappPending;
    if (record?.drawer && record.id && record.owner === whatsappOwner && sameWhatsappPins(record.pins)
        && sameWhatsappDrawerIdentity(record) && window.__wb_native_whatsapp_repair_action?.(target)) {
      const button = whatsappDrawerClose(record.drawer);
      if (button && target && contains(button, target)) {
        // Only the shipped guarded click path can arm closure of this exact
        // freshly captured drawer. A hidden pane or page-driven removal is not
        // a canonical identity certificate.
        record.closeWitness = { button, owner: whatsappOwner, label: attribute(button, 'aria-label') };
        return true;
      }
    }
    if (query(document, '[data-testid="chat-info-drawer"]').length) return false;
    const composers = query(document, '[data-testid="conversation-compose-box-input"][contenteditable="true"][role="textbox"]');
    const pins = composers.length === 1 ? whatsappPins(composers[0]) : null;
    if (!pins || !contains(pins.carrier, target)) return false;
    invalidateWhatsappBindings(true, true);
    whatsappPending = { pins, owner: whatsappOwner, priorDrawers: new Set(query(document, '[data-testid="chat-info-drawer"]')) };
    // The run's one check now belongs to this chat.
    if (whatsappAnchorFollowsSelection) whatsappRepairAnchor = { pins, invalidated: false };
    whatsappCheckArmed = true; whatsappAnchorFollowsSelection = false;
    return true;
  };
  window.__wb_get_native_whatsapp_repair = () => {
    const composers = query(document, '[data-testid="conversation-compose-box-input"][contenteditable="true"][role="textbox"]');
    const pins = composers.length === 1 ? whatsappPins(composers[0]) : null;
    if (!pins || !whatsappOwner) return null;
    if (!whatsappRepairAnchor || (whatsappAnchorFollowsSelection && !whatsappCheckArmed
        && (whatsappRepairAnchor.invalidated || !sameWhatsappPins(whatsappRepairAnchor.pins)))) {
      whatsappRepairAnchor = { pins, invalidated: false };
    }
    return !whatsappRepairAnchor.invalidated && sameWhatsappPins(whatsappRepairAnchor.pins) ? pins : null;
  };
  // The recipient probe calls this for a guarded chat-list selection in a run
  // that names its recipient (see whatsappAnchorFollowsSelection). False once
  // the run has armed its check, which stays with the chat it armed.
  window.__wb_native_whatsapp_follow_selection = () => {
    if (!whatsappObserver || !whatsappOwner || whatsappCheckArmed) return false;
    whatsappAnchorFollowsSelection = true;
    return true;
  };
  // A run checks one contact through its drawer, for its anchor chat. Once
  // the anchor is invalidated, as when WhatsApp's chat selection changes
  // after the check was armed (or, in a run for the open chat, at all), no
  // chat can be checked again until the next run (a new owner). True when
  // that is why no check is available. Anchored nodes that are only hidden
  // for now, as behind a modal, do not count.
  window.__wb_native_whatsapp_repair_spent = () => {
    if (!whatsappOwner || whatsappRepairAnchor?.invalidated !== true) return false;
    if (whatsappAnchorFollowsSelection && !whatsappCheckArmed) return false;
    const composers = query(document, '[data-testid="conversation-compose-box-input"][contenteditable="true"][role="textbox"]');
    return composers.length === 1 && whatsappNativeComposer(composers[0]);
  };
  window.__wb_native_whatsapp_repair_action = target => {
    const pins = window.__wb_get_native_whatsapp_repair();
    if (!pins || !target?.isConnected) return false;
    const drawers = whatsappDrawers();
    if (!drawers.length) return contains(pins.carrier, target);
    if (drawers.length !== 1) return false;
    const subtitle = uniqueWhatsappNode(drawers[0], '[data-testid="contact-info-subtitle selectable-text"]');
    const close = whatsappDrawerClose(drawers[0]);
    return whatsappPlainName(subtitle) && compact(subtitle.textContent, 240) === pins.name
      && !!close && contains(close, target);
  };
  window.__wb_native_whatsapp_repair_snapshot = target => window.__wb_native_whatsapp_repair_action(target)
    ? { pins: window.__wb_get_native_whatsapp_repair(), owner: whatsappOwner } : null;
  const whatsappRepairGuidance = () => {
    const pins = window.__wb_get_native_whatsapp_repair();
    if (!pins || typeof window.__wb_ax_ref !== 'function') return null;
    const drawers = whatsappDrawers();
    const target = !drawers.length ? pins.carrier
      : drawers.length === 1 ? whatsappDrawerClose(drawers[0]) : null;
    if (!target || !window.__wb_native_whatsapp_repair_action(target)) return null;
    const ref_id = window.__wb_ax_ref(target);
    if (typeof ref_id !== 'string' || !/^ref_[A-Za-z0-9_:-]{1,100}$/.test(ref_id)) return null;
    return { phase: drawers.length ? 'close_contact' : 'open_contact', ref_id };
  };
  // The recipient probe names this same control to the model when it blocks
  // a message action in a chat whose contact is not confirmed yet.
  window.__wb_native_whatsapp_repair_guidance = () => whatsappRepairGuidance();
  window.__wb_native_whatsapp_repair_matches = snapshot => {
    if (!snapshot || snapshot.owner !== whatsappOwner || !whatsappObserver) return false;
    whatsappMutations(whatsappObserver.takeRecords());
    return snapshot.owner === whatsappOwner && !whatsappRepairAnchor?.invalidated && sameWhatsappPins(snapshot.pins);
  };
  const whatsappContactThread = composer => {
    if (!whatsappObserver || !whatsappNativeComposer(composer)) return null;
    whatsappMutations(whatsappObserver.takeRecords());
    captureWhatsappDrawer();
    const record = whatsappBindings.get(composer);
    if (!record || record.owner !== whatsappOwner || !whatsappOwner || !sameWhatsappPins(record.pins) || whatsappDrawers().length) return null;
    return { ...record.pins, service: 'whatsapp', id: record.id, owner: record.owner, documentEpoch: whatsappDocumentEpoch, sendFloor: record.sendFloor,
      atLatest: Math.abs(record.pins.transcript.scrollHeight - record.pins.transcript.clientHeight - record.pins.transcript.scrollTop) <= 4 };
  };
  window.__wb_native_chat_read_repair = composer => {
    const context = telegramThread(composer) || whatsappContactThread(composer);
    if (!context || context.atLatest || typeof window.__wb_ax_ref !== 'function') return null;
    const target = context.service === 'telegram' ? context.scrollPane : context.transcript;
    if (!target) return null;
    const ref_id = window.__wb_ax_ref(target);
    if (typeof ref_id !== 'string' || !/^ref_[A-Za-z0-9_:-]{1,100}$/.test(ref_id)) return null;
    return { phase: 'read_latest', ref_id, direction: 'bottom',
      message: 'This conversation is showing older messages. Read this exact message pane with get_accessibility_tree({ref_id}), scroll({ref_id,direction:"bottom"}), then call chat_observe before sending. Do not repeat Send or Enter against this historical viewport.' };
  };
  window.__wb_native_chat_read_target = owner => {
    if (!whatsappObserver || !owner || owner !== whatsappOwner) return null;
    whatsappMutations(whatsappObserver.takeRecords());
    const pins = window.__wb_get_native_whatsapp_repair();
    if (!pins || owner !== whatsappOwner || !sameWhatsappPins(pins)) return null;
    const context = whatsappContactThread(pins.composer);
    if (context) return context.atLatest ? null
      : { owner, pins, phase: 'read_latest', target: pins.transcript };
    const drawers = whatsappDrawers();
    if (!drawers.length) return { owner, pins, phase: 'open_contact', target: pins.carrier };
    const record = whatsappPending;
    if (drawers.length !== 1 || record?.drawer !== drawers[0] || !record.id
        || record.owner !== owner || !sameWhatsappDrawerIdentity(record)) return null;
    const button = whatsappDrawerClose(record.drawer);
    return button && window.__wb_native_whatsapp_repair_action(button)
      ? { owner, pins, phase: 'close_contact', target: button, record } : null;
  };
  window.__wb_native_chat_read_target_matches = snapshot => {
    if (!snapshot || snapshot.owner !== whatsappOwner || !sameWhatsappPins(snapshot.pins)) return false;
    const current = window.__wb_native_chat_read_target(snapshot.owner);
    return !!current && current.phase === snapshot.phase && current.target === snapshot.target
      && (snapshot.phase !== 'close_contact' || current.record === snapshot.record);
  };
  window.__wb_prepare_native_chat_send = (composer, body) => {
    const context = whatsappContactThread(composer);
    const record = whatsappBindings.get(composer);
    const authority = whatsappAuthority(whatsappOwner);
    if (!context || !record || !context.atLatest || !authority || !whatsappDocumentEpoch) return false;
    const rows = query(context.transcript, '[role="row"] [data-id][data-testid^="conv-msg-"]')
      .filter(node => visible(node) && attribute(node, 'data-testid') === `conv-msg-${attribute(node, 'data-id')}`);
    if (!rows.length || rows.length > MAX_ITEMS) return false;
    record.sendFloor = { ids: new Set(rows.map(node => attribute(node, 'data-id'))), rows,
      tail: rows[rows.length - 1], body: normalizeText(body), peer: context.id, authority, pins: record.pins, owner: whatsappOwner };
    whatsappFloors.set(composer, record.sendFloor); whatsappParkedFloor = record.sendFloor;
    return true;
  };

  const whatsappSelfThread = composer => {
    if (!whatsappNativeComposer(composer)) return null;
    const root = composer.closest('#main[data-testid="conversation-panel-wrapper"]');
    if (!root || !visible(root)) return null;
    const headers = query(root, '[data-testid="conversation-header"]').filter(visible);
    if (headers.length !== 1) return null;
    const header = headers[0];
    // Current WhatsApp message IDs are opaque and the header has no verified
    // peer identifier. The native you-label proves the self-chat subset; a
    // generic contact name alone must not bind a different peer's old rows.
    const selfMarkers = query(header, '[data-testid="you-label"]').filter(whatsappRendered);
    const titles = query(header, '[data-testid="conversation-info-header-chat-title"]').filter(whatsappRendered);
    const carriers = query(header, '[data-testid="conversation-info-header"]').filter(whatsappRendered);
    if (selfMarkers.length !== 1 || titles.length !== 1 || carriers.length > 1) return null;
    const title = titles[0], selfMarker = selfMarkers[0], carrier = carriers[0] || title;
    const name = compact(title?.innerText || title?.textContent, 240);
    if (!name) return null;
    const transcripts = query(root, '[data-testid="conversation-panel-messages"]').filter(visible);
    const transcript = transcripts.length === 1 ? transcripts[0] : null;
    if (!transcript || contains(transcript, composer)) return null;
    const atLatest = Math.abs(transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop) <= 4;
    return { root, transcript, header, carrier, title, selfMarker, service: 'whatsapp-self', atLatest, name,
      id: `whatsapp:self:${telegramTextRevision(canonicalText(name))}` };
  };

  const nativeChatThread = composer => telegramThread(composer) || whatsappSelfThread(composer) || whatsappContactThread(composer);
  // Shared only inside the extension's content world. Recipient dispatch can
  // reuse the exact native nodes/peer binding without scanning message bodies
  // or guessing contact identity from a heading-shaped page element.
  window.__wb_get_native_chat_context = composer => nativeChatThread(composer);
  // Private content-world preparation only. A caller must separately bind an
  // exact native read-only control and recheck these nodes before dispatch.
  // This object deliberately has no verified conversation ID/service/status.
  window.__wb_get_native_telegram_alias_preparation = (composer = null) => {
    if (!/^(?:web|webk|k)\.telegram\.org$/i.test(window.location?.hostname || '')
        || (window.location.hostname === 'web.telegram.org' && !/^\/k\/?$/.test(window.location.pathname))
        || !telegramAliasRoute()) return null;
    const active = document.activeElement;
    if (!composer && editable(active) && visible(active)) composer = active;
    const composers = query(document, '.input-message-input[contenteditable="true"][data-peer-id]')
      .filter(node => telegramNativeComposer(node) && telegramRendered(node)
        && /^-?[1-9]\d{0,23}(?![\s\S])/.test(String(node.getAttribute('data-peer-id') || '')));
    if (composers.length !== 1 || (composer && composer !== composers[0])) return null;
    return telegramThread(composers[0], true);
  };

  const activeRoot = (composer, nativeThread = null) => {
    if (!composer) return null;
    if (nativeThread) return nativeThread.root;
    if (telegramNativeComposer(composer) || whatsappNativeComposer(composer)) return null;
    const channel = discordChannel(composer);
    if (channel) return channel.root;
    const chain = parentChain(composer);
    const explicit = chain.find(node => THREAD_ID_ATTRIBUTES.some(name => attribute(node, name))
      || CHAT_ROOT_SELECTORS.some(selector => {
        try { return node.matches?.(selector); } catch { return false; }
      }));
    if (explicit) return explicit;

    // A generic main/body fallback is unsafe: search, checkout, and article
    // pages all expose editable fields and list items. Accept an inferred root
    // only when it contains a separate semantic transcript region with at
    // least one message-shaped descendant.
    for (const node of chain) {
      if (node === document.body || node === document.documentElement) continue;
      const transcript = queryMany(node, CHAT_TRANSCRIPT_SELECTORS)
        .find(candidate => candidate !== node
          && visible(candidate)
          && !contains(candidate, composer)
          && queryMany(candidate, MESSAGE_SELECTORS.slice(0, 12)).some(item => visible(item)));
      if (transcript) return node;
    }
    return null;
  };

  const markerFor = (composer, root, nativeThread = null) => {
    if (nativeThread?.root === root) return { value: nativeThread.id };
    const channel = discordChannel(composer);
    if (channel?.root === root) return { value: channel.id };
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

  const identityFor = (composer, root, probe, nativeThread = null) => {
    if (nativeThread?.root === root) return nativeThread.name;
    const channel = discordChannel(composer);
    if (channel?.root === root) return channel.isDirectMessage ? channel.name : `#${channel.name}`;
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
    if (/(?:^|[-_\s])(outgoing|sent|from-me|own-message|self-message)(?:$|[-_\s])/.test(className)) return 'outgoing';
    if (/(?:^|[-_\s])(incoming|received|from-them|other-message)(?:$|[-_\s])/.test(className)) return 'incoming';
    // A message label saying the page's own user sent it ("You sent ...") is
    // read by a model in any language (content.js keeps the readings); an
    // unread label says nothing yet.
    const aria = attribute(node, 'aria-label');
    if (aria && window.__wb_page_reading?.('message_author', aria) === 'self') return 'outgoing';
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

  const discordAvatarUserId = (node) => {
    try {
      const url = new URL(attribute(node, 'src'), window.location.href);
      if (url.hostname !== 'cdn.discordapp.com') return '';
      return /^\/avatars\/(\d+)\//.exec(url.pathname)?.[1]
        || /^\/guilds\/\d+\/users\/(\d+)\/avatars\//.exec(url.pathname)?.[1]
        || '';
    } catch { return ''; }
  };

  const discordGlobalAvatarUserId = (node) => {
    try {
      const url = new URL(attribute(node, 'src'), window.location.href);
      return url.hostname === 'cdn.discordapp.com'
        ? /^\/avatars\/(\d+)\//.exec(url.pathname)?.[1] || ''
        : '';
    } catch { return ''; }
  };

  const discordDefaultAvatarIndex = (node) => {
    try {
      const url = new URL(attribute(node, 'src'), window.location.href);
      const match = url.hostname === 'cdn.discordapp.com'
        ? /^\/embed\/avatars\/(\d+)\.png$/.exec(url.pathname)
        : url.origin === window.location.origin
          ? /^\/assets\/embed\/avatars\/(\d+)\.png$/.exec(url.pathname)
          : null;
      return match?.[1] || '';
    } catch { return ''; }
  };

  const discordMessageText = (content) => {
    const read = (node) => {
      if (node?.nodeType === 3) return node.nodeValue || '';
      if (node?.nodeType !== 1 || node.hidden || attribute(node, 'aria-hidden') === 'true') return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      const tag = String(node.tagName || '').toLowerCase();
      if (tag === 'br') return '\n';
      if (tag === 'img') return node.matches?.('.emoji,[data-type="emoji"]') ? attribute(node, 'alt') : '';
      const text = Array.from(node.childNodes || []).map(read).join('');
      return /^(?:div|p|li|blockquote|pre)$/.test(tag) ? `${text}\n` : text;
    };
    return normalizeText(read(content));
  };

  const discordAttachmentDescriptions = (row, messageId) => {
    const accessories = query(row, `[id="message-accessories-${messageId}"]`)[0];
    if (!accessories) return [];
    const reactions = query(accessories, `[id="message-reactions-${messageId}"]`)[0];
    const selectors = [
      '[role="img"][aria-label]',
      'img[alt]',
      '[data-filename]',
      '[data-name]',
      '[class*="fileName"]',
      '[class*="filename"]',
      '[class*="embedFieldName"]',
      '[class*="embedFieldValue"]',
      '[class*="embedTitle"]',
      '[class*="embedDescription"]',
      'a[href*="/attachments/"]',
      'a[href*="/ephemeral-attachments/"]',
    ];
    const seen = new Set();
    const descriptions = [];
    for (const node of queryMany(accessories, selectors)) {
      if (!visible(node) || (reactions && contains(reactions, node))) continue;
      const labelledMedia = node.closest?.('[role="img"][aria-label]');
      if (labelledMedia && labelledMedia !== node) continue;
      const value = compact(
        attribute(node, 'aria-label')
          || attribute(node, 'alt')
          || attribute(node, 'title')
          || attribute(node, 'data-filename')
          || attribute(node, 'data-name')
          || node.innerText
          || node.textContent,
        240,
      );
      const key = canonicalText(value);
      if (!value || seen.has(key)) continue;
      seen.add(key);
      descriptions.push(value);
    }
    const pollSelector = '[class*="poll"],[data-poll]';
    const pollRoots = queryMany(accessories, [pollSelector])
      .filter(node => visible(node) && !node.parentElement?.closest(pollSelector));
    for (const node of pollRoots) {
      const value = compact(node.innerText || node.textContent, 240);
      const key = canonicalText(value);
      if (!value || seen.has(key)) continue;
      seen.add(key);
      descriptions.push(`Poll: ${value}`);
    }
    return descriptions;
  };

  const collectDiscordMessages = (channel) => {
    const account = query(document, '[class*="accountPopoutButtonWrapper"]')[0]?.parentElement;
    const ownAvatar = query(account, 'img[src*="/avatars/"]')[0];
    const ownAvatarId = discordAvatarUserId(ownAvatar);
    const ownDefaultAvatarIndex = discordDefaultAvatarIndex(ownAvatar);
    const rows = query(channel.transcript, '[role="article"][data-list-item-id]');
    const messages = [];
    let previousAuthor = '';
    let previousDirection = 'unknown';
    for (const row of rows) {
      const match = /^chat-messages___chat-messages-(\d+)-(\d+)$/.exec(attribute(row, 'data-list-item-id'));
      if (!match || match[1] !== channel.channelId || !visible(row)) continue;
      const messageId = match[2];
      const usernameNode = query(row, `[id="message-username-${messageId}"]`)[0];
      const username = query(usernameNode, '[data-text]')[0] || usernameNode;
      const system = !username && /(?:^|\s)(?:isSystemMessage|systemMessage)/.test(String(row.className || ''));
      if (system) {
        previousAuthor = '';
        previousDirection = 'unknown';
        continue;
      }
      const content = query(row, `[id="message-content-${messageId}"]`)[0];
      const text = discordMessageText(content);
      const attachments = discordAttachmentDescriptions(row, messageId);
      const body = [text, ...attachments.map(value => `Attachment: ${value}`)].filter(Boolean).join('\n');
      const author = compact(attribute(username, 'data-text') || username?.textContent, 240)
        || (!username ? previousAuthor : '');
      const avatar = username?.closest('h3')?.parentElement?.querySelector('img[src]');
      const avatarId = discordAvatarUserId(avatar);
      const globalAvatarId = discordGlobalAvatarUserId(avatar);
      const defaultAvatarIndex = discordDefaultAvatarIndex(avatar);
      let direction = 'unknown';
      if (ownAvatarId && avatarId) direction = ownAvatarId === avatarId ? 'outgoing' : 'incoming';
      else if (ownAvatarId && defaultAvatarIndex) direction = 'incoming';
      else if (ownDefaultAvatarIndex && defaultAvatarIndex
          && ownDefaultAvatarIndex !== defaultAvatarIndex) direction = 'incoming';
      else if (ownDefaultAvatarIndex && globalAvatarId) direction = 'incoming';
      else if (!username) direction = previousDirection;
      previousAuthor = author;
      previousDirection = direction;
      if (!body) continue;
      const timestamp = attribute(query(row, `[id="message-timestamp-${messageId}"]`)[0], 'datetime');
      messages.push({
        id: `discord:${channel.channelId}:${messageId}`,
        direction,
        text: body,
        ...(text ? { authoredText: text } : {}),
        ...(author ? { author } : {}),
        ...(timestamp ? { timestamp } : {}),
      });
    }
    return messages.slice(-MAX_ITEMS);
  };

  const telegramText = (content, { whatsapp = false } = {}) => {
    const read = node => {
      if (node?.nodeType === 3) return node.nodeValue || '';
      if (node?.nodeType !== 1 || node.hidden || attribute(node, 'aria-hidden') === 'true') return '';
      // Both clients place times/status icons alongside authored text. They
      // cannot become part of the outbound text or an incoming edit revision.
      if (node.matches?.('.time,.MessageMeta,.MessageOutgoingStatus,[data-ignore-on-paste]')) return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') return '\n';
      if (tag === 'img') {
        if (whatsapp && node.matches?.('[data-testid="selectable-text"][data-plain-text]')) {
          return attribute(node, 'data-plain-text');
        }
        return node.matches?.('.emoji,[data-type="emoji"]') ? attribute(node, 'alt') : '';
      }
      const text = Array.from(node.childNodes || []).map(read).join('');
      return /^(?:div|p|li|blockquote|pre)$/.test(tag) ? `${text}\n` : text;
    };
    return normalizeText(read(content));
  };

  const telegramTextRevision = text => {
    let hash = 2166136261;
    for (const char of text) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16);
  };

  const collectTelegramMessages = channel => {
    if (channel.atLatest !== true) return [];
    const mounted = telegramMountedMessageState(channel);
    if (!mounted.uniqueMountedIds) return [];
    const retainedIds = new Set(mounted.nativeIds);
    const rows = mounted.nativeRows.filter(node => retainedIds.has(attribute(node, channel.webA ? 'data-message-id' : 'data-mid')))
      .sort((left, right) => {
        const a = BigInt(attribute(left, channel.webA ? 'data-message-id' : 'data-mid'));
        const b = BigInt(attribute(right, channel.webA ? 'data-message-id' : 'data-mid'));
        return a < b ? -1 : a > b ? 1 : 0;
      });
    const messages = [];
    for (const row of rows.slice(-MAX_ITEMS)) {
      if (!visible(row) || row.matches('.service,.is-date,.is-deleting,.is-dissolving')) continue;
      const id = attribute(row, channel.webA ? 'data-message-id' : 'data-mid');
      if (!/^\d{1,24}$/.test(id)) continue;
      const outgoing = row.classList.contains(channel.webA ? 'own' : 'is-out');
      const incoming = channel.webA || row.classList.contains('is-in');
      if (!outgoing && !incoming) continue;
      if (outgoing) {
        const delivered = channel.webA
          ? query(row, '.MessageOutgoingStatus .icon-check,.MessageOutgoingStatus .icon-message-read').some(visible)
          : row.matches('.is-sent,.is-read') && !row.matches('.is-sending,.is-error,.is-outgoing');
        // Optimistic pending/failed bubbles do not verify sending. A final
        // server-backed status lets the same stable row appear as a new delta.
        if (!delivered) continue;
      }
      const content = query(row, channel.webA ? '.text-content' : '.message')[0];
      const text = telegramText(content);
      if (!text) continue;
      const direction = outgoing ? 'outgoing' : 'incoming';
      messages.push({ id: `${channel.id}:${id}${outgoing ? '' : `:r${telegramTextRevision(text)}`}`,
        direction, text, authoredText: text });
    }
    return messages;
  };

  // Whether a sent message's status label ("Read", "Okundu", "Gelesen")
  // says it reached the recipient. A model reads the label in any language
  // (content.js keeps the readings); a label nobody has read yet says nothing,
  // and the agent reads it before it observes the chat again.
  const whatsappStatusDelivered = meta => query(meta, '[aria-label]').some(node => visible(node)
    && window.__wb_page_reading?.('message_status', attribute(node, 'aria-label')) === 'delivered');

  const collectWhatsappSelfMessages = channel => {
    // A historical virtual viewport cannot establish a new send or delta.
    // Opaque native IDs have no numeric ordering; normal page tools still read
    // history, while chat observation follows the current/latest viewport.
    if (!channel.atLatest) return [];
    const rows = query(channel.transcript, '[role="row"] [data-id][data-testid^="conv-msg-"]');
    const messages = [];
    for (const row of rows.slice(-MAX_ITEMS)) {
      if (!visible(row)) continue;
      const id = attribute(row, 'data-id');
      if (!id || attribute(row, 'data-testid') !== `conv-msg-${id}`) continue;
      const container = query(row, '[data-testid="msg-container"]')[0];
      if (!container) continue;
      const meta = query(container, '[data-testid="msg-meta"]')[0];
      // The current verified DOM exposes a status label ("Read") on a span. Do
      // not infer delivery from color, a tail glyph, clearing the composer, or
      // an imagined sent/read data-icon. A status a model has not read as
      // delivered, in any language, stays unverified.
      if (!whatsappStatusDelivered(meta)) continue;
      const textNodes = query(container, '[data-testid="selectable-text"]')
        .filter(node => visible(node) && !contains(meta, node)
          && !node.parentElement?.closest('[data-testid="selectable-text"]'));
      if (textNodes.length !== 1) continue;
      const text = telegramText(textNodes[0], { whatsapp: true });
      if (!text) continue;
      messages.push({ id: `${channel.id}:${id}`, direction: 'outgoing', text, authoredText: text });
    }
    return messages;
  };

  const collectWhatsappContactMessages = channel => {
    channel.deliveryProof = null;
    if (!channel.atLatest) return [];
    const rows = query(channel.transcript, '[role="row"] [data-id][data-testid^="conv-msg-"]');
    const entries = rows.slice(-MAX_ITEMS).map(row => {
      if (!visible(row)) return null;
      const id = attribute(row, 'data-id');
      const container = uniqueWhatsappNode(row, '[data-testid="msg-container"]');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || attribute(row, 'data-testid') !== `conv-msg-${id}` || !container) return null;
      const meta = query(container, '[data-testid="msg-meta"]')[0];
      const delivered = whatsappStatusDelivered(meta);
      const tailOut = query(container, '[data-icon="tail-out"]').some(visible);
      const tailIn = query(container, '[data-icon="tail-in"]').some(visible);
      const prePlain = query(container, '[data-pre-plain-text]');
      const sender = prePlain.length === 1
        ? compact(/^\[[^\]\r\n]{1,100}\]\s*(.{1,240}):\s*$/.exec(prePlain[0].getAttribute('data-pre-plain-text') || '')?.[1], 240) : '';
      const textNodes = query(container, '[data-testid="selectable-text"]')
        .filter(node => visible(node) && !contains(meta, node)
          && !node.parentElement?.closest('[data-testid="selectable-text"]'));
      const text = textNodes.length === 1 ? telegramText(textNodes[0], { whatsapp: true }) : '';
      return { row, id, sender, text, delivered, tailIn, tailOut };
    });
    const ownNames = new Set(entries.filter(entry => entry && entry.sender && (entry.tailOut || entry.delivered)).map(entry => entry.sender));
    const floor = channel.sendFloor;
    const baselineRows = floor ? rows.filter(row => floor.ids.has(attribute(row, 'data-id'))) : [];
    const floorIndex = floor?.tail?.isConnected && sameWhatsappPins(floor.pins)
      && baselineRows.length === floor.rows.length && baselineRows.every((row, index) => row === floor.rows[index])
      && channel.transcript.contains(floor.tail) ? rows.indexOf(floor.tail) : -1;
    const messages = [];
    let incomingGroup = false;
    for (const entry of entries) {
      if (!entry) { incomingGroup = false; continue; }
      const { row, id, sender, text, delivered, tailIn, tailOut } = entry;
      let direction = '';
      if ((tailOut || delivered) && !tailIn) {
        incomingGroup = false;
        if (!delivered) continue;
        // Only a genuinely appended row after the still-mounted live tail
        // can reconcile a send. An opaque old row remount is not a receipt.
        if (!floor || floorIndex < 0) continue;
        if (!floor.ids.has(id) && (text !== floor.body || rows.indexOf(row) <= floorIndex)) continue;
        direction = 'outgoing';
      } else if (!tailOut && !delivered && sender === channel.name) {
        if (tailIn) incomingGroup = true;
        else if (!incomingGroup || ownNames.has(sender)) continue;
        direction = 'incoming';
      } else incomingGroup = false;
      if (!direction || !text) continue;
      messages.push({ id: `${channel.id}:${id}${direction === 'incoming' ? `:r${telegramTextRevision(text)}` : ''}`,
        direction, text, authoredText: text });
    }
    const deliveredIds = floor && floorIndex >= 0 ? messages.filter(message => message.direction === 'outgoing'
      && message.authoredText === floor.body && !floor.ids.has(message.id.slice(channel.id.length + 1)))
      .map(message => message.id) : [];
    if (deliveredIds.length === 1) channel.deliveryProof = {
      schema: 'webbrain-native-mounted-delivery/1', threadKey: `dom:${channel.id}`, body: floor.body,
      baselineMessageIds: [...floor.ids].map(id => `${channel.id}:${id}`), messageId: deliveredIds[0],
      documentEpoch: whatsappDocumentEpoch, timeOrigin: channel.timeOrigin, url: channel.url,
    };
    return messages;
  };

  const collectMessages = (root, composer, nativeThread = null) => {
    if (nativeThread?.root === root) return nativeThread.service === 'whatsapp-self'
      ? collectWhatsappSelfMessages(nativeThread) : nativeThread.service === 'whatsapp'
        ? collectWhatsappContactMessages(nativeThread) : collectTelegramMessages(nativeThread);
    const channel = discordChannel(composer);
    if (channel?.root === root) return collectDiscordMessages(channel);
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
        if (item.id && candidate.id && item.id === candidate.id) return true;
        // A wrapper and the bubble inside it are one message, even when the
        // page gives each of them its own id: innerText of the ancestor
        // already repeats the descendant's text, so keeping both reports the
        // same message twice. Only DOM containment collapses entries; sibling
        // bubbles with identical text stay separate and are numbered instead.
        if (!contains(item.node, candidate.node) && !contains(candidate.node, item.node)) return false;
        return item.text === candidate.text
          || item.text.includes(candidate.text)
          || candidate.text.includes(item.text);
      });
      if (!duplicate) {
        selected.push(candidate);
      } else if (candidate.metadataScore > duplicate.metadataScore
        || (candidate.metadataScore === duplicate.metadataScore && candidate.index > duplicate.index)) {
        selected[selected.indexOf(duplicate)] = candidate;
      }
    }

    // A bubble the page does not identify is identified positionally, so the
    // ordinal has to be assigned over the whole transcript rather than over
    // the retained tail. Numbering after the cap restarts at 0 as older
    // bubbles age out, which lets a genuinely new duplicate collapse onto an
    // id the session has already seen and never surface as a delta.
    const occurrences = new Map();
    for (const item of selected) {
      const key = [
        item.direction,
        canonicalText(item.text),
        canonicalText(item.author),
        item.timestamp,
      ].join('\u001f');
      const seen = occurrences.get(key) || 0;
      occurrences.set(key, seen + 1);
      item.occurrence = seen;
    }

    // The kernel keeps the last MAX_ITEMS entries, so the newest bubbles —
    // not the oldest — must survive the cap in a long conversation.
    return selected.slice(-MAX_ITEMS).map(item => ({
      ...(item.id ? { id: item.id } : {}),
      direction: item.direction,
      text: item.text,
      occurrence: item.occurrence,
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
    // Before the canonical drawer certificate exists, the generic recipient
    // probe has no composerRef. The private repair pins can still identify
    // the one native editor for a read-only, exact-control repair hint.
    const repair = window.__wb_get_native_whatsapp_repair();
    if (repair?.composer && whatsappNativeComposer(repair.composer) && visible(repair.composer)) {
      return { node: repair.composer,
        ref: typeof window.__wb_ax_ref === 'function' ? window.__wb_ax_ref(repair.composer) || '' : '' };
    }
    // Observation does not require focusing the composer. When the generic
    // probe cannot rank native editors, accept exactly one structurally bound
    // Telegram composer; a focused search/modal editor still fails above.
    const nativeComposers = query(document, '.input-message-input[contenteditable="true"],#editable-message-text[contenteditable="true"][role="textbox"],[data-testid="conversation-compose-box-input"][contenteditable="true"][role="textbox"]')
      .filter(node => visible(node) && nativeChatThread(node));
    if (nativeComposers.length === 1) {
      const node = nativeComposers[0];
      return { node, ref: typeof window.__wb_ax_ref === 'function' ? window.__wb_ax_ref(node) || '' : '' };
    }
    const aliasPreparation = window.__wb_get_native_telegram_alias_preparation();
    if (aliasPreparation) {
      const node = aliasPreparation.composer;
      return { node, ref: typeof window.__wb_ax_ref === 'function' ? window.__wb_ax_ref(node) || '' : '' };
    }
    return { node: null, ref: '' };
  };

  window.__wb_observe_chat_dom = (params = {}) => {
    try {
      const probe = params.probe && typeof params.probe === 'object' ? params.probe : {};
      const { node: composer, ref: composerRef } = resolveComposer(probe, params);
      const nativeThread = nativeChatThread(composer);
      const root = activeRoot(composer, nativeThread);
      if (!composer || !root) {
        const telegramPreparation = composer && window.__wb_get_native_telegram_alias_preparation(composer);
        if (telegramPreparation) {
          let nativeTelegramRepair = { phase: 'open_profile_or_settings' };
          const targetResolver = window.__wb_get_native_telegram_alias_preparation_target;
          if (typeof targetResolver === 'function' && typeof window.__wb_ax_ref === 'function') {
            const resolved = targetResolver(telegramPreparation);
            const current = window.__wb_get_native_telegram_alias_preparation(composer);
            if (resolved && ['open_profile','open_menu','open_self_settings'].includes(resolved.phase)
                && telegramRendered(resolved.target) && current
                && current.peer === telegramPreparation.peer && current.alias === telegramPreparation.alias
                && current.url === telegramPreparation.url && current.timeOrigin === telegramPreparation.timeOrigin
                && ['root','transcript','composer','header','carrier','peerIdentity']
                  .every(key => current[key] === telegramPreparation[key])) {
              const ref_id = window.__wb_ax_ref(resolved.target);
              if (typeof ref_id === 'string' && /^ref_[A-Za-z0-9_:-]{1,100}$/.test(ref_id)) {
                nativeTelegramRepair = { phase: resolved.phase, ref_id };
              }
            }
          }
          const control = { open_profile: 'native chat profile control', open_menu: 'native Tools menu button',
            open_self_settings: 'native Settings menu item' }[nativeTelegramRepair.phase];
          return { success:false, schema:SCHEMA, reason:'native_telegram_alias_binding_required',
            nativeTelegramRepair,
            error: 'This Telegram username route is not yet bound to the active numeric peer. '
              + (nativeTelegramRepair.ref_id
                ? `Read get_accessibility_tree({ref_id:"${nativeTelegramRepair.ref_id}"}), then click_ax({ref_id:"${nativeTelegramRepair.ref_id}"}) on this exact ${control}. `
                : 'Read the accessibility tree and open only the current chat\'s exact native profile control. ')
              + (telegramPreparation.peerIdentity?.getAttribute('data-me-as-notes') === '1'
                ? 'For native Saved Messages, use the native menu and Settings to show your own profile instead. '
                : 'Inspect this current chat\'s exact native profile. ')
              + 'Its native username and numeric name/avatar peer must match the current header, composer and live transcript. After opening that profile, call chat_observe again before concluding the binding remains unavailable. A header label or route alone does not establish recipient identity. Do not send or reuse a previous chat while this binding is unavailable.' };
        }
        // The run's one contact check is spent (it needs no composer found
        // here: the native composer is no longer tied to a checked chat).
        if (window.__wb_native_whatsapp_repair_spent()) {
          return { success: false, schema: SCHEMA, reason: 'native_whatsapp_contact_check_spent', retryable: false,
            error: 'This run can no longer confirm a WhatsApp contact: its one contact check belongs to the chat it first looked at or started checking, and WhatsApp\'s chat selection or that chat\'s header changed since. Nothing was sent. Report what was sent and that a message to this chat needs a new request; do not retry it in this run.' };
        }
        if (composer && window.__wb_get_native_whatsapp_repair()?.composer === composer) {
          const nativeWhatsappRepair = whatsappRepairGuidance();
          return {
          success: false, schema: SCHEMA, reason: 'native_whatsapp_contact_binding_required',
          ...(nativeWhatsappRepair ? { nativeWhatsappRepair } : {}),
          error: nativeWhatsappRepair
            ? `This native WhatsApp contact needs a fresh canonical identity. Read get_accessibility_tree({ref_id:"${nativeWhatsappRepair.ref_id}"}), then click_ax({ref_id:"${nativeWhatsappRepair.ref_id}"}) on that exact ${nativeWhatsappRepair.phase === 'open_contact' ? 'native contact-name control; inspect its newly opened Contact info drawer and close that same drawer with its native Close button' : 'native Close button'} and call chat_observe again. The whole header, avatar, call, search, menu and Send controls are not identity-repair controls. No message was sent.`
            : 'This native WhatsApp contact needs a fresh canonical identity. Read the accessibility tree, click only its exact native contact-name button, inspect its newly opened Contact info drawer, close that drawer with its native Close button, then call chat_observe again. The whole header and other toolbar controls cannot repair identity. No message was sent.',
          };
        }
        return {
          success: false,
          schema: SCHEMA,
          reason: 'chat_root_unverified',
          error: !composer
            ? 'The active page does not expose a verified chat composer.'
            : 'The active editable is not inside a semantic chat root; no conversation was observed.',
        };
      }
      const marker = markerFor(composer, root, nativeThread);
      const conversationIdentity = identityFor(composer, root, probe, nativeThread);
      const conversationId = marker?.value || '';
      const url = compact(window.location?.href || '', 1000);
      const threadKey = compact(
        conversationId
          ? `dom:${conversationId}`
          : (conversationIdentity ? `identity:${conversationIdentity}` : ''),
        240,
      );
      if (!threadKey) {
        return {
          success: false,
          schema: SCHEMA,
          reason: 'chat_thread_unverified',
          error: 'The active chat does not expose a conversation-specific identity; sending is disabled until the thread can be verified.',
        };
      }
      const composerValue = composer
        ? ('value' in composer ? composer.value : (composer.innerText || composer.textContent || ''))
        : '';
      const messages = collectMessages(root, composer, nativeThread);
      const nativeRows = nativeThread?.service === 'whatsapp'
        ? query(nativeThread.transcript, '[role="row"] [data-id][data-testid^="conv-msg-"]') : [];
      const nativeMessageIds = nativeRows.map(node => `${nativeThread.id}:${attribute(node, 'data-id')}`);
      const nativeChatReadRepair = ['whatsapp','telegram'].includes(nativeThread?.service)
        ? window.__wb_native_chat_read_repair(composer) : null;
      return {
        success: true,
        schema: SCHEMA,
        observedAt: new Date().toISOString(),
        ...(url ? { url } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(conversationIdentity ? { conversationIdentity } : {}),
        threadKey,
        messages,
        ...(nativeChatReadRepair ? { nativeChatReadRepair } : {}),
        ...(nativeThread?.service === 'telegram' ? { nativeLatestPosition: {
          schema: 'webbrain-native-latest-position/1', verified: nativeThread.latestPositionVerified, atLatest: nativeThread.atLatest } } : {}),
        ...(nativeThread?.service === 'telegram'
          ? { nativeChatMessageBaseline: telegramMountedMessageBaseline(nativeThread) } : {}),
        ...(nativeThread?.service === 'whatsapp' && nativeThread.deliveryProof
          ? { nativeChatDeliveryProof: nativeThread.deliveryProof } : {}),
        ...(nativeThread?.service === 'whatsapp' ? { nativeChatMessageBaseline: {
          schema: 'webbrain-native-opaque-baseline/1', complete: nativeThread.atLatest && !!nativeRows.length
            && nativeRows.length <= MAX_ITEMS && new Set(nativeMessageIds).size === nativeMessageIds.length
            && nativeRows.every(node => /^[A-Za-z0-9_-]{1,32}$/.test(attribute(node, 'data-id'))
              && attribute(node, 'data-testid') === `conv-msg-${attribute(node, 'data-id')}`),
          threadKey, documentEpoch: whatsappDocumentEpoch, timeOrigin: nativeThread.timeOrigin, url,
          messageIds: nativeMessageIds, tailId: nativeMessageIds.at(-1) || '',
        } } : {}),
        composer: {
          available: !!composer && (nativeThread?.service === 'telegram' ? nativeThread.atLatest === true : (!!nativeThread || probe.composerAvailable !== false)),
          ...(composerRef ? { ref: composerRef } : {}),
          empty: normalizeText(composerValue).length === 0,
        },
        // A page-controlled marker is not proof that a human or virtual agent
        // is connected. Site adapters may provide trusted evidence separately.
        agentConnected: null,
        userInput: userInputFor(root),
        // Do not let page-controlled data attributes self-authorize a refund,
        // renewal change, or case number. The kernel accepts trusted evidence
        // from a future site adapter, but generic DOM observation supplies none.
        resolutionEvidence: { refund: null, autoRenewal: null, caseNumber: null },
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
