/**
 * Browser-neutral state and evidence kernel for long-running support chats.
 *
 * Page text is data. This module only consumes structured observations from
 * the content script and never interprets message text as instructions.
 * Keep the Firefox copy byte-identical.
 */

export const CHAT_WORKFLOW_SCHEMA = 'webbrain-chat-workflow/1';

export const CHAT_STATES = Object.freeze([
  'waiting_for_transfer',
  'agent_connected',
  'we_responded',
  'counterparty_replied',
  'issue_resolved',
  'needs_user_input',
  'stopped',
]);

export const CHAT_MESSAGE_DIRECTIONS = Object.freeze([
  'incoming',
  'outgoing',
  'system',
  'unknown',
]);

export const CHAT_EVENT_TYPES = Object.freeze([
  'thread_bound',
  'thread_changed',
  'agent_connected',
  'outgoing_verified',
  'counterparty_replied',
  'resolution_verified',
  'user_input_required',
  'user_input_cleared',
  'observation_only',
]);

export const CHAT_USER_INPUT_REASONS = Object.freeze([
  'otp',
  'pin',
  'payment',
  'authentication',
  'new_user_decision',
  'thread_changed',
  'unknown',
]);

const STATE_SET = new Set(CHAT_STATES);
const DIRECTION_SET = new Set(CHAT_MESSAGE_DIRECTIONS);
const EVENT_SET = new Set(CHAT_EVENT_TYPES);
const USER_INPUT_REASON_SET = new Set(CHAT_USER_INPUT_REASONS);
const MAX_MESSAGES = 200;
const MAX_MESSAGE_TEXT = 4_000;
const MAX_ID = 240;
// A dispatch that never produced a visible bubble must not block the same text
// forever. `attemptedAt` ages the pending record out so the workflow can retry.
const PENDING_OUTBOUND_TTL_MS = 10 * 60 * 1000;

function bounded(value, max = MAX_ID) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .slice(0, max);
}

export function normalizeChatText(value, max = MAX_MESSAGE_TEXT) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, max);
}

export function canonicalChatText(value) {
  const text = normalizeChatText(value);
  try { return text.normalize('NFKC').toLocaleLowerCase(); } catch { return text.toLowerCase(); }
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function stableChatMessageId({
  threadKey = '',
  direction = 'unknown',
  text = '',
  author = '',
  timestamp = '',
  occurrence = 0,
} = {}) {
  const basis = [
    bounded(threadKey),
    bounded(direction, 20),
    canonicalChatText(text),
    canonicalChatText(author),
    bounded(timestamp, 80),
    Number.isInteger(occurrence) ? occurrence : 0,
  ].join('\u001f');
  return `chatmsg_${hashText(basis)}`;
}

function normalizeDirection(value) {
  const direction = bounded(value, 20).toLowerCase();
  if (DIRECTION_SET.has(direction)) return direction;
  if (/^(?:user|self|me|sent|from[-_ ]?me|outgoing)/.test(direction)) return 'outgoing';
  if (/^(?:agent|operator|support|counterparty|other|incoming|received)/.test(direction)) return 'incoming';
  return 'unknown';
}

function normalizeTriState(value) {
  if (value === true || value === 'verified' || value === 'complete') return true;
  if (value === false || value === 'missing' || value === 'incomplete') return false;
  return null;
}

function normalizeEvidence(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    refund: normalizeTriState(source.refund),
    autoRenewal: normalizeTriState(source.autoRenewal ?? source.auto_renewal),
    caseNumber: normalizeTriState(source.caseNumber ?? source.case_number),
  };
}

function normalizeUserInput(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const required = source.required === true || source.userInputRequired === true;
  if (!required) return null;
  const reason = bounded(source.reason, 40).toLowerCase();
  return {
    required: true,
    reason: USER_INPUT_REASON_SET.has(reason) ? reason : 'unknown',
    message: bounded(source.message, 500),
  };
}

export function normalizeChatMessage(value, { threadKey = '', occurrence = 0 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const direction = normalizeDirection(value.direction ?? value.authorRole ?? value.role);
  const text = normalizeChatText(value.text ?? value.content ?? value.message);
  if (!text) return null;
  const author = bounded(value.author ?? value.authorName ?? value.sender, 240);
  const timestamp = bounded(value.timestamp ?? value.time ?? value.createdAt, 80);
  const explicitId = bounded(value.id ?? value.messageId ?? value.message_id, MAX_ID);
  return {
    id: explicitId || stableChatMessageId({ threadKey, direction, text, author, timestamp, occurrence }),
    direction,
    text,
    ...(author ? { author } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(value.verified === true ? { verified: true } : {}),
  };
}

export function normalizeChatSnapshot(value, now = Date.now()) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const conversationId = bounded(source.conversationId ?? source.conversation_id ?? source.threadId, MAX_ID);
  const identity = bounded(source.conversationIdentity ?? source.recipient ?? source.identity, MAX_ID);
  const url = bounded(source.url, 1000);
  const threadKey = bounded(source.threadKey || conversationId || identity || url, MAX_ID);
  const seenOccurrences = new Map();
  const messages = [];
  for (const raw of (Array.isArray(source.messages) ? source.messages : []).slice(-MAX_MESSAGES)) {
    const provisionalText = canonicalChatText(raw?.text ?? raw?.content ?? raw?.message);
    const provisionalDirection = normalizeDirection(raw?.direction ?? raw?.authorRole ?? raw?.role);
    const occurrence = seenOccurrences.get(`${provisionalDirection}\u001f${provisionalText}`) || 0;
    seenOccurrences.set(`${provisionalDirection}\u001f${provisionalText}`, occurrence + 1);
    const message = normalizeChatMessage(raw, { threadKey, occurrence });
    if (message && !messages.some(item => item.id === message.id)) messages.push(message);
  }
  const composerSource = source.composer && typeof source.composer === 'object' ? source.composer : {};
  const resolutionEvidence = normalizeEvidence(source.resolutionEvidence ?? source.resolution_evidence);
  const userInput = normalizeUserInput(source.userInput ?? source.user_input);
  return {
    schema: CHAT_WORKFLOW_SCHEMA,
    observedAt: bounded(source.observedAt ?? source.observed_at, 80) || new Date(now).toISOString(),
    ...(url ? { url } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(identity ? { conversationIdentity: identity } : {}),
    threadKey,
    messages,
    composer: {
      available: composerSource.available === true,
      ...(bounded(composerSource.ref, MAX_ID) ? { ref: bounded(composerSource.ref, MAX_ID) } : {}),
      ...(bounded(composerSource.sendRef, MAX_ID) ? { sendRef: bounded(composerSource.sendRef, MAX_ID) } : {}),
      empty: composerSource.empty === true,
    },
    agentConnected: source.agentConnected === true ? true : source.agentConnected === false ? false : null,
    userInput,
    resolutionEvidence,
  };
}

function emptySession(now = Date.now()) {
  return {
    schema: CHAT_WORKFLOW_SCHEMA,
    state: 'waiting_for_transfer',
    threadKey: '',
    seenMessageIds: [],
    sentMessageKeys: [],
    pendingOutbound: null,
    resolutionEvidence: { refund: null, autoRenewal: null, caseNumber: null },
    lastObservedAt: new Date(now).toISOString(),
    userInput: null,
    stopReason: '',
  };
}

export function createChatSession({ threadKey = '', now = Date.now() } = {}) {
  const session = emptySession(now);
  session.threadKey = bounded(threadKey, MAX_ID);
  return session;
}

function pendingOutboundExpired(pending, now) {
  if (!pending) return false;
  const attempted = Date.parse(pending.attemptedAt || '');
  if (!Number.isFinite(attempted)) return true;
  return now - attempted > PENDING_OUTBOUND_TTL_MS;
}

export function normalizeChatSession(value, now = Date.now()) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state = STATE_SET.has(source.state) ? source.state : 'waiting_for_transfer';
  const evidence = normalizeEvidence(source.resolutionEvidence);
  const pending = source.pendingOutbound && typeof source.pendingOutbound === 'object'
    ? {
        key: bounded(source.pendingOutbound.key, MAX_ID),
        text: normalizeChatText(source.pendingOutbound.text),
        threadKey: bounded(source.pendingOutbound.threadKey, MAX_ID),
        attemptedAt: bounded(source.pendingOutbound.attemptedAt, 80),
      }
    : null;
  return {
    schema: CHAT_WORKFLOW_SCHEMA,
    state,
    threadKey: bounded(source.threadKey, MAX_ID),
    seenMessageIds: [...new Set((Array.isArray(source.seenMessageIds) ? source.seenMessageIds : [])
      .map(value => bounded(value, MAX_ID)).filter(Boolean))].slice(-MAX_MESSAGES),
    sentMessageKeys: [...new Set((Array.isArray(source.sentMessageKeys) ? source.sentMessageKeys : [])
      .map(value => bounded(value, MAX_ID)).filter(Boolean))].slice(-MAX_MESSAGES),
    pendingOutbound: pending?.key && pending.text ? pending : null,
    resolutionEvidence: evidence,
    lastObservedAt: bounded(source.lastObservedAt, 80) || new Date(now).toISOString(),
    userInput: normalizeUserInput(source.userInput),
    stopReason: bounded(source.stopReason, 120),
  };
}

function messageKey(threadKey, text) {
  return `chatout_${hashText(`${bounded(threadKey)}\u001f${canonicalChatText(text)}`)}`;
}

function evidenceComplete(evidence) {
  return evidence.refund === true && evidence.autoRenewal === true && evidence.caseNumber === true;
}

export function transitionChatState(state, event) {
  const current = STATE_SET.has(state) ? state : 'waiting_for_transfer';
  const type = EVENT_SET.has(event?.type) ? event.type : 'observation_only';
  if (type === 'user_input_required' || type === 'thread_changed') return 'needs_user_input';
  if (type === 'user_input_cleared' && current === 'needs_user_input') return 'waiting_for_transfer';
  if (type === 'resolution_verified') return 'issue_resolved';
  if (current === 'stopped' || current === 'issue_resolved') return current;
  if (type === 'counterparty_replied') return 'counterparty_replied';
  if (type === 'outgoing_verified') return 'we_responded';
  if (type === 'agent_connected') return 'agent_connected';
  return current;
}

export function advanceChatSession(value, rawSnapshot, now = Date.now()) {
  let session = normalizeChatSession(value, now);
  const snapshot = normalizeChatSnapshot(rawSnapshot, now);
  const events = [];
  if (!session.threadKey && snapshot.threadKey) {
    session.threadKey = snapshot.threadKey;
    events.push({ type: 'thread_bound', threadKey: snapshot.threadKey });
  } else if (session.threadKey && snapshot.threadKey && session.threadKey !== snapshot.threadKey) {
    session = {
      ...session,
      state: transitionChatState(session.state, { type: 'thread_changed' }),
      userInput: { required: true, reason: 'thread_changed', message: 'The active conversation changed. Select and verify the intended thread before continuing.' },
      stopReason: 'thread_changed',
      pendingOutbound: null,
    };
    events.push({ type: 'thread_changed', previousThreadKey: session.threadKey, threadKey: snapshot.threadKey });
    return { session, snapshot, events, newMessages: [], nextAction: 'pause_for_user' };
  }

  const known = new Set(session.seenMessageIds);
  const newMessages = snapshot.messages.filter(message => !known.has(message.id));
  const newIncoming = newMessages.filter(message => message.direction === 'incoming');
  const newOutgoing = newMessages.filter(message => message.direction === 'outgoing');
  const outgoingKeys = new Set(session.sentMessageKeys);
  for (const message of newOutgoing) outgoingKeys.add(messageKey(snapshot.threadKey, message.text));

  if (snapshot.userInput?.required) {
    events.push({ type: 'user_input_required', ...snapshot.userInput });
  } else {
    if (session.state === 'needs_user_input' && session.stopReason !== 'thread_changed') {
      events.push({ type: 'user_input_cleared' });
    }
    if (evidenceComplete(snapshot.resolutionEvidence)) {
      events.push({ type: 'resolution_verified', evidence: snapshot.resolutionEvidence });
    } else if (newIncoming.length) {
      events.push({ type: 'counterparty_replied', messages: newIncoming.map(message => message.id) });
    } else if (newOutgoing.length) {
      events.push({ type: 'outgoing_verified', messages: newOutgoing.map(message => message.id) });
    } else if (snapshot.agentConnected === true && session.state === 'waiting_for_transfer') {
      events.push({ type: 'agent_connected' });
    } else if (events.length === 0) {
      events.push({ type: 'observation_only' });
    }
  }

  let nextState = session.state;
  for (const event of events) nextState = transitionChatState(nextState, event);
  const matchedPending = session.pendingOutbound
    && newOutgoing.some(message => messageKey(snapshot.threadKey, message.text) === session.pendingOutbound.key);
  session = {
    ...session,
    state: nextState,
    seenMessageIds: [...new Set([...session.seenMessageIds, ...snapshot.messages.map(message => message.id)])].slice(-MAX_MESSAGES),
    sentMessageKeys: [...outgoingKeys].slice(-MAX_MESSAGES),
    pendingOutbound: matchedPending || pendingOutboundExpired(session.pendingOutbound, now)
      ? null
      : session.pendingOutbound,
    resolutionEvidence: snapshot.resolutionEvidence,
    lastObservedAt: snapshot.observedAt,
    userInput: snapshot.userInput,
    stopReason: snapshot.userInput?.required
      ? snapshot.userInput.reason
      : (events.some(event => event.type === 'user_input_cleared') ? '' : session.stopReason),
  };
  const nextAction = session.userInput?.required
    ? 'pause_for_user'
    : session.state === 'issue_resolved'
      ? 'stop'
      : newIncoming.length
        ? 'reply'
        : session.state === 'waiting_for_transfer'
          ? 'schedule_resume'
          : 'observe';
  return { session, snapshot, events, newMessages, nextAction };
}

export function decideChatSend(value, rawSnapshot, text, now = Date.now()) {
  const session = normalizeChatSession(value, now);
  const snapshot = normalizeChatSnapshot(rawSnapshot, now);
  // Normalize one character past the cap so an over-long body is rejected
  // rather than silently truncated into a different message than requested.
  const body = normalizeChatText(text, MAX_MESSAGE_TEXT + 1);
  if (!body) return { ok: false, reason: 'empty_message', error: 'A non-empty chat message is required.' };
  if (body.length > MAX_MESSAGE_TEXT) return { ok: false, reason: 'message_too_long', error: 'Chat messages must be 4,000 characters or fewer.' };
  if (session.userInput?.required || snapshot.userInput?.required) {
    return { ok: false, reason: 'user_input_required', error: 'Pause the chat until the user completes the required verification or decision.' };
  }
  if (session.state === 'issue_resolved' || session.state === 'stopped') {
    return { ok: false, reason: 'terminal_session', error: 'The chat session is terminal; do not send another message.' };
  }
  if (!session.threadKey || !snapshot.threadKey || session.threadKey !== snapshot.threadKey) {
    return { ok: false, reason: 'thread_unverified', error: 'The active conversation is not bound to the stored chat session.' };
  }
  if (snapshot.composer.available !== true) {
    return { ok: false, reason: 'composer_unavailable', error: 'The active conversation composer is not available.' };
  }
  const key = messageKey(snapshot.threadKey, body);
  if (session.sentMessageKeys.includes(key)
      || snapshot.messages.some(message => message.direction === 'outgoing' && messageKey(snapshot.threadKey, message.text) === key)) {
    return { ok: false, duplicate: true, reason: 'already_sent', messageKey: key, error: 'This exact message is already visible as an outgoing message in this conversation.' };
  }
  if (session.pendingOutbound?.key === key && !pendingOutboundExpired(session.pendingOutbound, now)) {
    return { ok: false, duplicate: true, pending: true, reason: 'send_pending', messageKey: key, error: 'This exact message is already pending verification; observe the conversation before retrying.' };
  }
  return { ok: true, messageKey: key, threadKey: snapshot.threadKey, text: body, attemptedAt: new Date(now).toISOString() };
}

export function markChatSendPending(value, decision, now = Date.now()) {
  const session = normalizeChatSession(value, now);
  if (!decision?.ok || !decision.messageKey || !decision.threadKey) return session;
  return {
    ...session,
    pendingOutbound: {
      key: bounded(decision.messageKey, MAX_ID),
      text: normalizeChatText(decision.text),
      threadKey: bounded(decision.threadKey, MAX_ID),
      attemptedAt: bounded(decision.attemptedAt, 80) || new Date(now).toISOString(),
    },
  };
}

export function serializeChatSession(value, now = Date.now()) {
  return normalizeChatSession(value, now);
}
