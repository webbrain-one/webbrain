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
  'outgoing_history_observed',
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
const MAX_NEW_MESSAGES = 20;
const MAX_MESSAGE_TEXT = 4_000;
const MAX_ID = 240;

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

function messageTextForMatching(message) {
  return message?.authoredText ?? message?.text ?? '';
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
  const authoredText = normalizeChatText(value.authoredText ?? value.primaryText);
  const author = bounded(value.author ?? value.authorName ?? value.sender, 240);
  const timestamp = bounded(value.timestamp ?? value.time ?? value.createdAt, 80);
  const explicitId = bounded(value.id ?? value.messageId ?? value.message_id, MAX_ID);
  return {
    id: explicitId || stableChatMessageId({ threadKey, direction, text, author, timestamp, occurrence }),
    direction,
    text,
    ...(authoredText ? { authoredText } : {}),
    ...(author ? { author } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(value.verified === true ? { verified: true } : {}),
  };
}

function normalizeTelegramMountedFloor(value, threadKey) {
  if (!value || value.coverage !== 'mounted_native_id_floor' || value.complete !== true
      || value.threadKey !== threadKey || !/^dom:telegram:[ak]:-?\d+:0$/.test(threadKey)
      || !Array.isArray(value.messageIds) || value.messageIds.length > MAX_MESSAGES) return null;
  const prefix = threadKey.slice(4) + ':';
  const sequences = [];
  for (const id of value.messageIds) {
    if (typeof id !== 'string' || !id.startsWith(prefix) || !/^\d{1,24}$/.test(id.slice(prefix.length))) return null;
    sequences.push(BigInt(id.slice(prefix.length)));
  }
  if (new Set(sequences.map(String)).size !== sequences.length) return null;
  return String(sequences.reduce((max, sequence) => sequence > max ? sequence : max, 0n));
}

export function normalizeChatSnapshot(value, now = Date.now()) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const conversationId = bounded(source.conversationId ?? source.conversation_id ?? source.threadId, MAX_ID);
  const identity = bounded(source.conversationIdentity ?? source.recipient ?? source.identity, MAX_ID);
  const url = bounded(source.url, 1000);
  const threadKey = bounded(source.threadKey || conversationId || identity, MAX_ID);
  const hasNativeTelegramBaseline = /^dom:telegram:[ak]:-?\d+:0$/.test(threadKey)
    && Object.prototype.hasOwnProperty.call(source, 'nativeChatMessageBaseline');
  const nativeMessageFloor = hasNativeTelegramBaseline
    ? normalizeTelegramMountedFloor(source.nativeChatMessageBaseline, threadKey) : null;
  const seenOccurrences = new Map();
  const messages = [];
  const messageIds = new Set();
  for (const raw of (Array.isArray(source.messages) ? source.messages : [])) {
    const provisionalText = canonicalChatText(raw?.text ?? raw?.content ?? raw?.message);
    const provisionalDirection = normalizeDirection(raw?.direction ?? raw?.authorRole ?? raw?.role);
    const counted = seenOccurrences.get(`${provisionalDirection}\u001f${provisionalText}`) || 0;
    seenOccurrences.set(`${provisionalDirection}\u001f${provisionalText}`, counted + 1);
    // An observation that numbered its own messages before its own truncation
    // is authoritative; such a source must number every message it reports.
    const occurrence = Number.isInteger(raw?.occurrence) && raw.occurrence >= 0 ? raw.occurrence : counted;
    const message = normalizeChatMessage(raw, { threadKey, occurrence });
    if (message && !messageIds.has(message.id)) {
      messageIds.add(message.id);
      messages.push(message);
      if (messages.length > MAX_MESSAGES) messageIds.delete(messages.shift().id);
    }
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
    ...(hasNativeTelegramBaseline ? { nativeMessageBaselineComplete: nativeMessageFloor !== null,
      ...(nativeMessageFloor !== null ? { nativeMessageFloor } : {}) } : {}),
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
    messageBaselineEstablished: false,
    seenMessageIds: [],
    sentMessageKeys: [],
    pendingOutbound: null,
    completionReceipt: null,
    resolutionEvidence: { refund: null, autoRenewal: null, caseNumber: null },
    lastObservedAt: new Date(now).toISOString(),
    userInput: null,
    pausedState: null,
    stopReason: '',
  };
}

export function createChatSession({ threadKey = '', now = Date.now() } = {}) {
  const session = emptySession(now);
  session.threadKey = bounded(threadKey, MAX_ID);
  return session;
}

export function normalizeChatSession(value, now = Date.now()) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const threadKey = bounded(source.threadKey, MAX_ID);
  const deliveredReplyBindings = normalizeDeliveredReplyBindings(source.deliveredReplyBindings, threadKey);
  const state = STATE_SET.has(source.state) ? source.state : 'waiting_for_transfer';
  const evidence = normalizeEvidence(source.resolutionEvidence);
  const pending = source.pendingOutbound && typeof source.pendingOutbound === 'object'
    ? {
        key: bounded(source.pendingOutbound.key, MAX_ID),
        text: normalizeChatText(source.pendingOutbound.text),
        threadKey: bounded(source.pendingOutbound.threadKey, MAX_ID),
        ...(bounded(source.pendingOutbound.replyAnchor, MAX_ID)
          ? { replyAnchor: bounded(source.pendingOutbound.replyAnchor, MAX_ID) }
          : {}),
        attemptedAt: bounded(source.pendingOutbound.attemptedAt, 80),
        ...(/^\d{1,24}$/.test(source.pendingOutbound.nativeMessageFloor || '')
          ? { nativeMessageFloor: String(source.pendingOutbound.nativeMessageFloor) } : {}),
        ...(normalizeNativeOpaqueBaseline(source.pendingOutbound.nativeOpaqueBaseline, source.pendingOutbound.threadKey)
          ? { nativeOpaqueBaseline: normalizeNativeOpaqueBaseline(source.pendingOutbound.nativeOpaqueBaseline, source.pendingOutbound.threadKey) } : {}),
        ...(bounded(source.pendingOutbound.dispatchId, 80)
          ? { dispatchId: bounded(source.pendingOutbound.dispatchId, 80) } : {}),
        ...(bounded(source.pendingOutbound.dispatchedAt, 80)
          ? { dispatchedAt: bounded(source.pendingOutbound.dispatchedAt, 80) }
          : {}),
      }
    : null;
  return {
    schema: CHAT_WORKFLOW_SCHEMA,
    state,
    threadKey,
    messageBaselineEstablished: source.messageBaselineEstablished === true,
    seenMessageIds: [...new Set((Array.isArray(source.seenMessageIds) ? source.seenMessageIds : [])
      .map(value => bounded(value, MAX_ID)).filter(Boolean))].slice(-MAX_MESSAGES),
    ...(/^\d{1,24}$/.test(source.telegramIncomingHighWater || '')
      ? { telegramIncomingHighWater: String(source.telegramIncomingHighWater) } : {}),
    ...(/^\d{1,24}$/.test(source.telegramOutgoingHighWater || '')
      ? { telegramOutgoingHighWater: String(source.telegramOutgoingHighWater) } : {}),
    ...(typeof source.telegramLatestIncomingRevision === 'string'
      ? { telegramLatestIncomingRevision: bounded(source.telegramLatestIncomingRevision, MAX_ID) } : {}),
    sentMessageKeys: [...new Set((Array.isArray(source.sentMessageKeys) ? source.sentMessageKeys : [])
      .map(value => bounded(value, MAX_ID)).filter(Boolean))].slice(-MAX_MESSAGES),
    ...(deliveredReplyBindings.length ? { deliveredReplyBindings } : {}),
    pendingOutbound: pending?.key && pending.text ? pending : null,
    completionReceipt: normalizeChatCompletionReceipt(source.completionReceipt),
    resolutionEvidence: evidence,
    lastObservedAt: bounded(source.lastObservedAt, 80) || new Date(now).toISOString(),
    userInput: normalizeUserInput(source.userInput),
    pausedState: STATE_SET.has(source.pausedState) && source.pausedState !== 'needs_user_input'
      ? source.pausedState
      : null,
    stopReason: bounded(source.stopReason, 120),
  };
}

export function verifiedEmptyWhatsappBaseline(value) {
  return Array.isArray(value?.messageIds) && value.messageIds.length === 0 && value.tailId === ''
    && typeof value.emptyTranscriptId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.emptyTranscriptId || '');
}

export function normalizeNativeOpaqueBaseline(value, threadKey = value?.threadKey) {
  if (!value || value.schema !== 'webbrain-native-opaque-baseline/1'
      || !/^dom:whatsapp:phone:[a-f0-9]{32}$/.test(threadKey || '') || value.threadKey !== threadKey
      || !/^[a-f\d-]{36}$/.test(value.documentEpoch || '')
      || !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0
      || !Array.isArray(value.messageIds) || value.messageIds.length > MAX_MESSAGES
      || (!value.messageIds.length && !verifiedEmptyWhatsappBaseline(value))
      || new Set(value.messageIds).size !== value.messageIds.length
      || !value.messageIds.every(id => typeof id === 'string' && id.startsWith(threadKey.slice(4) + ':')
        && /^[A-Za-z0-9_-]{1,32}$/.test(id.slice(threadKey.length - 3)))
      || value.tailId !== (value.messageIds.at(-1) || '')
      || typeof value.body !== 'string' || !value.body || value.body.length > 20000
      || !/^tk_[a-f\d]{8}$/.test(value.taskKey || '')
      || !/^[a-f\d]{64}$/.test(value.taskSha256 || '') || !/^[a-f\d]{64}$/.test(value.providerSha256 || '')
      || !bounded(value.resumeTaskId) || !bounded(value.originRunToken)
      || !Number.isSafeInteger(value.originActionSequence) || value.originActionSequence <= 0) return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.hostname !== 'web.whatsapp.com' || value.url.length > 1000 || url.username || url.password) return null;
  } catch { return null; }
  return { schema: value.schema, threadKey, documentEpoch: value.documentEpoch, timeOrigin: value.timeOrigin,
    url: value.url, messageIds: [...value.messageIds], tailId: value.tailId, body: value.body, taskKey: value.taskKey,
    ...(verifiedEmptyWhatsappBaseline(value) ? { emptyTranscriptId: value.emptyTranscriptId } : {}),
    taskSha256: value.taskSha256, providerSha256: value.providerSha256, resumeTaskId: bounded(value.resumeTaskId),
    originRunToken: bounded(value.originRunToken), originActionSequence: value.originActionSequence };
}

function nativeOpaqueDeliveryMatch(pending, snapshot, rawSnapshot) {
  const baseline = normalizeNativeOpaqueBaseline(pending?.nativeOpaqueBaseline, pending?.threadKey);
  const proof = rawSnapshot?.nativeChatDeliveryProof;
  if (!baseline || snapshot.threadKey !== baseline.threadKey || snapshot.url !== baseline.url
      || normalizeChatText(baseline.body) !== normalizeChatText(pending.text)
      || snapshot.composer.available !== true || snapshot.composer.empty !== true
      || proof?.schema !== 'webbrain-native-mounted-delivery/1' || proof.threadKey !== baseline.threadKey
      || proof.documentEpoch !== baseline.documentEpoch || proof.timeOrigin !== baseline.timeOrigin || proof.url !== baseline.url
      || proof.emptyTranscriptId !== baseline.emptyTranscriptId
      || normalizeChatText(proof.body) !== normalizeChatText(pending.text)
      || !Array.isArray(proof.baselineMessageIds) || proof.baselineMessageIds.length !== baseline.messageIds.length
      || !proof.baselineMessageIds.every((id, index) => id === baseline.messageIds[index])
      || baseline.messageIds.includes(proof.messageId)) return null;
  return snapshot.messages.find(message => message.id === proof.messageId && message.direction === 'outgoing'
    && normalizeChatText(messageTextForMatching(message)) === normalizeChatText(pending.text)) || null;
}

function normalizeChatCompletionReceipt(value) {
  const telegram = /^dom:telegram:[ak]:-?\d+:0$/.test(value?.threadKey || '');
  const whatsapp = /^dom:whatsapp:phone:[a-f0-9]{32}$/.test(value?.threadKey || '');
  if (!value || value.schema !== 'webbrain-chat-delivery-receipt/1'
      || (!telegram && !whatsapp)
      || !/^tk_[a-f\d]{8}$/.test(value.taskKey || '')
      || !/^[a-f\d]{64}$/.test(value.taskSha256 || '')
      || !/^[a-f\d]{64}$/.test(value.bodySha256 || '')
      || !Number.isSafeInteger(value.originActionSequence) || value.originActionSequence <= 0
      || typeof value.messageId !== 'string' || value.messageId.length > MAX_ID
      || !value.messageId.startsWith(value.threadKey.slice(4) + ':')
      || !(telegram ? /^\d{1,24}$/.test(value.messageId.slice(value.messageId.lastIndexOf(':') + 1))
        : /^[A-Za-z0-9_-]{1,32}$/.test(value.messageId.slice(value.threadKey.length - 3)))
      || (whatsapp && !normalizeNativeOpaqueBaseline(value.nativeOpaqueBaseline, value.threadKey))
      || (whatsapp && ['taskKey','taskSha256','resumeTaskId','originRunToken','originActionSequence','url']
        .some(key => value[key] !== value.nativeOpaqueBaseline[key]))
      || !bounded(value.resumeTaskId) || !bounded(value.originRunToken)
      || !Number.isFinite(Date.parse(value.verifiedAt || ''))) return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || !(telegram ? ['web.telegram.org', 'webk.telegram.org', 'weba.telegram.org'].includes(url.hostname)
      : url.hostname === 'web.whatsapp.com')
        || value.url.length > 4000 || url.username || url.password) return null;
  } catch { return null; }
  return { schema: value.schema, threadKey: value.threadKey, taskKey: value.taskKey,
    taskSha256: value.taskSha256, bodySha256: value.bodySha256, messageId: value.messageId,
    resumeTaskId: bounded(value.resumeTaskId), originRunToken: bounded(value.originRunToken),
    originActionSequence: value.originActionSequence, url: value.url, verifiedAt: bounded(value.verifiedAt, 80),
    ...(whatsapp ? { nativeOpaqueBaseline: normalizeNativeOpaqueBaseline(value.nativeOpaqueBaseline, value.threadKey) } : {}) };
}

function legacyMessageKey(threadKey, text) {
  return `chatout_${hashText(`${bounded(threadKey)}\u001f${canonicalChatText(text)}`)}`;
}

function messageKey(threadKey, text, replyAnchor = 'chat_start') {
  return `chatout_${hashText(`${bounded(threadKey)}\u001f${bounded(replyAnchor, MAX_ID)}\u001f${canonicalChatText(text)}`)}`;
}

function normalizeDeliveredReplyBindings(value, threadKey) {
  const bindings = new Map();
  for (const raw of (Array.isArray(value) ? value : []).slice(-MAX_MESSAGES)) {
    const messageId = bounded(raw?.messageId), replyAnchor = bounded(raw?.replyAnchor), messageKey = bounded(raw?.messageKey);
    if (!threadKey || raw?.threadKey !== threadKey || !messageId || !replyAnchor || !/^chatout_[a-f\d]{8}$/.test(messageKey)) continue;
    let nativeMessageFloor;
    if (/^dom:telegram:[ak]:-?\d+:0$/.test(threadKey)) {
      const sequence = telegramMessageSequence(threadKey, { id: messageId });
      const anchorSequence = replyAnchor === 'chat_start' ? 0n : telegramMessageSequence(threadKey, { id: replyAnchor });
      if (!messageId.startsWith(threadKey.slice(4) + ':') || !/^\d{1,24}$/.test(messageId.slice(messageId.lastIndexOf(':') + 1))
          || !/^\d{1,24}$/.test(raw.nativeMessageFloor || '') || anchorSequence === null
          || sequence <= BigInt(raw.nativeMessageFloor) || BigInt(raw.nativeMessageFloor) < anchorSequence) continue;
      nativeMessageFloor = String(raw.nativeMessageFloor);
    }
    bindings.delete(messageId);
    bindings.set(messageId, { threadKey, messageId, replyAnchor, messageKey,
      ...(nativeMessageFloor !== undefined ? { nativeMessageFloor } : {}) });
  }
  return [...bindings.values()];
}

function matchingReplyBinding(bindings, snapshot, message) {
  const binding = bindings.get(message.id);
  return binding?.threadKey === snapshot.threadKey
    && binding.messageKey === messageKey(snapshot.threadKey, messageTextForMatching(message), binding.replyAnchor) ? binding : null;
}

function outgoingMessageKeys(snapshot, deliveredReplyBindings = []) {
  const keys = new Set();
  const bindings = new Map(deliveredReplyBindings.map(binding => [binding.messageId, binding]));
  const nativeIncoming = snapshot.messages.filter(message => message.direction === 'incoming')
    .map(message => ({ id: message.id, sequence: telegramMessageSequence(snapshot.threadKey, message) }));
  let replyAnchor = 'chat_start';
  for (const message of snapshot.messages) {
    if (message.direction === 'incoming') replyAnchor = message.id;
    if (message.direction !== 'outgoing') continue;
    const binding = matchingReplyBinding(bindings, snapshot, message);
    let anchor = binding?.replyAnchor || replyAnchor;
    const sequence = telegramMessageSequence(snapshot.threadKey, message);
    if (!binding && sequence !== null) {
      // Virtualized old native rows can mount after the newest question in
      // DOM order. Their monotonic IDs still belong to an earlier context.
      anchor = 'chat_start'; let previous = 0n;
      for (const incoming of nativeIncoming) if (incoming.sequence !== null
          && incoming.sequence < sequence && incoming.sequence >= previous) {
        previous = incoming.sequence; anchor = incoming.id;
      }
    }
    keys.add(messageKey(snapshot.threadKey, messageTextForMatching(message), anchor));
  }
  return keys;
}

function latestIncomingId(snapshot) {
  let latest = null, sequence = 0n;
  for (const message of snapshot.messages) if (message.direction === 'incoming') {
    const candidate = telegramMessageSequence(snapshot.threadKey, message);
    if (candidate !== null && candidate >= sequence) { latest = message; sequence = candidate; }
  }
  if (latest) return latest.id;
  return [...snapshot.messages].reverse().find(message => message.direction === 'incoming')?.id || 'chat_start';
}

function telegramMessageSequence(threadKey, message) {
  const prefix = String(threadKey || '').replace(/^dom:/, '');
  if (!/^telegram:[ak]:-?\d+:-?\d+$/.test(prefix) || !message.id.startsWith(`${prefix}:`)) return null;
  const sequence = /^(\d{1,24})(?::r[0-9a-f]{1,8})?$/.exec(message.id.slice(prefix.length + 1))?.[1];
  return sequence ? BigInt(sequence) : null;
}

function evidenceComplete(evidence) {
  return evidence.refund === true && evidence.autoRenewal === true && evidence.caseNumber === true;
}

export function transitionChatState(state, event) {
  const current = STATE_SET.has(state) ? state : 'waiting_for_transfer';
  const type = EVENT_SET.has(event?.type) ? event.type : 'observation_only';
  if (type === 'user_input_required' || type === 'thread_changed') return 'needs_user_input';
  if (type === 'user_input_cleared' && current === 'needs_user_input') {
    return STATE_SET.has(event?.resumeState) && event.resumeState !== 'needs_user_input'
      ? event.resumeState
      : 'waiting_for_transfer';
  }
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
      completionReceipt: null,
    };
    events.push({ type: 'thread_changed', previousThreadKey: session.threadKey, threadKey: snapshot.threadKey });
    return { session, snapshot, events, newMessages: [], nextAction: 'pause_for_user' };
  }

  // Rows already mounted at the first observation establish a history/dedup
  // baseline. Without an owned pending send they are not a fresh delivery.
  const initialHistory = !session.messageBaselineEstablished && session.state === 'waiting_for_transfer'
    && !session.seenMessageIds.length && !session.pendingOutbound
    && !session.completionReceipt && !session.deliveredReplyBindings?.length
    && !session.telegramIncomingHighWater && !session.telegramOutgoingHighWater;
  const known = new Set(session.seenMessageIds);
  let telegramIncomingHighWater = BigInt(session.telegramIncomingHighWater || '0');
  let telegramOutgoingHighWater = BigInt(session.telegramOutgoingHighWater || '0');
  const unseenMessages = snapshot.messages.filter(message => {
    if (known.has(message.id)
        || message.id === session.telegramLatestIncomingRevision) return false;
    const sequence = telegramMessageSequence(snapshot.threadKey, message);
    if (message.direction === 'outgoing' && sequence !== null) return sequence > telegramOutgoingHighWater;
    // Virtual lists can remount arbitrarily old rows after the bounded ID cache
    // expires. Only native monotonic Telegram IDs establish this watermark;
    // opaque IDs from generic/WhatsApp observers retain their existing behavior.
    // An edit revision at the current latest ID remains a new incoming delta.
    return sequence === null || sequence >= telegramIncomingHighWater;
  });
  const initialOutgoingHistory = initialHistory
    ? unseenMessages.filter(message => message.direction === 'outgoing') : [];
  const historicalIds = new Set(initialOutgoingHistory.map(message => message.id));
  const newMessages = unseenMessages.filter(message => !historicalIds.has(message.id));
  if (initialOutgoingHistory.length) events.push({ type: 'outgoing_history_observed',
    messages: initialOutgoingHistory.slice(-MAX_NEW_MESSAGES).map(message => message.id) });
  const newIncoming = newMessages.filter(message => message.direction === 'incoming');
  const newOutgoing = newMessages.filter(message => message.direction === 'outgoing');
  const pendingDiscordDelivery = discordPendingDeliveryMatch(session.pendingOutbound, snapshot, newMessages);

  if (snapshot.userInput?.required) {
    events.push({ type: 'user_input_required', ...snapshot.userInput });
  } else {
    // A thread_changed pause is only lifted by evidence that the bound thread
    // is active again — either an explicit rebind (which starts a fresh
    // session) or an observation of the same threadKey. Without the second
    // case the pause is escaped implicitly by the next state transition while
    // stopReason stays 'thread_changed' forever, which would keep the rebind
    // precondition permanently satisfied.
    const boundThreadObserved = !!session.threadKey && session.threadKey === snapshot.threadKey;
    if (session.state === 'needs_user_input'
        && (session.stopReason !== 'thread_changed' || boundThreadObserved)) {
      events.push({ type: 'user_input_cleared', resumeState: session.pausedState });
    }
    if (evidenceComplete(snapshot.resolutionEvidence)) {
      events.push({ type: 'resolution_verified', evidence: snapshot.resolutionEvidence });
    } else if (newIncoming.length) {
      events.push({ type: 'counterparty_replied', messages: newIncoming.slice(-MAX_NEW_MESSAGES).map(message => message.id) });
    } else if (newOutgoing.length) {
      events.push({ type: 'outgoing_verified', messages: newOutgoing.slice(-MAX_NEW_MESSAGES).map(message => message.id) });
    } else if (pendingDiscordDelivery) {
      events.push({
        type: 'outgoing_verified',
        messages: [pendingDiscordDelivery.id],
        evidence: 'discord_pending_delivery',
      });
    } else if (snapshot.agentConnected === true && session.state === 'waiting_for_transfer') {
      events.push({ type: 'agent_connected' });
    } else if (events.length === 0) {
      events.push({ type: 'observation_only' });
    }
  }

  let nextState = session.state;
  for (const event of events) nextState = transitionChatState(nextState, event);
  const visibleOutgoingKeys = outgoingMessageKeys(snapshot, session.deliveredReplyBindings);
  // The anchored key is recomputed from DOM order, so a counterparty message
  // that renders after a send could move our anchor and the key never matches,
  // stranding the pending record. A newly visible outgoing bubble carrying the
  // pending text is the same proof of delivery without depending on the anchor.
  const nativePendingFloor = session.pendingOutbound?.nativeMessageFloor;
  const nativeOpaquePending = /^dom:whatsapp:phone:[a-f0-9]{32}$/.test(session.pendingOutbound?.threadKey || '');
  const opaquePendingDelivery = nativeOpaquePending ? nativeOpaqueDeliveryMatch(session.pendingOutbound, snapshot, rawSnapshot) : null;
  const matchedPending = session.pendingOutbound
    && (nativeOpaquePending ? !!opaquePendingDelivery : nativePendingFloor !== undefined
      ? snapshot.nativeMessageBaselineComplete !== false && snapshot.messages.some(message => message.direction === 'outgoing'
        && telegramMessageSequence(snapshot.threadKey, message) !== null
        && telegramMessageSequence(snapshot.threadKey, message) > BigInt(nativePendingFloor)
        && canonicalChatText(messageTextForMatching(message)) === canonicalChatText(session.pendingOutbound.text))
      : (visibleOutgoingKeys.has(session.pendingOutbound.key)
      || newOutgoing.some(message => canonicalChatText(messageTextForMatching(message)) === canonicalChatText(session.pendingOutbound.text))
      || !!pendingDiscordDelivery
      || (!session.pendingOutbound.replyAnchor
        && session.pendingOutbound.key === legacyMessageKey(snapshot.threadKey, session.pendingOutbound.text))));
  let deliveredReplyBindings = session.deliveredReplyBindings || [];
  const pending = session.pendingOutbound;
  if (matchedPending && pending?.replyAnchor && pending.threadKey === snapshot.threadKey
      && pending.key === messageKey(snapshot.threadKey, pending.text, pending.replyAnchor)) {
    const matching = newOutgoing.filter(message => (!nativeOpaquePending || message.id === opaquePendingDelivery?.id)
      && canonicalChatText(messageTextForMatching(message)) === canonicalChatText(pending.text)
      && (nativePendingFloor === undefined || (telegramMessageSequence(snapshot.threadKey, message) !== null
        && telegramMessageSequence(snapshot.threadKey, message) > BigInt(nativePendingFloor))));
    if (matching.length === 1) {
      // This fresh receipt verifies the original pending action, whose
      // incoming anchor cannot move when another question arrives first.
      deliveredReplyBindings = normalizeDeliveredReplyBindings([...deliveredReplyBindings, {
        threadKey: snapshot.threadKey, messageId: matching[0].id, replyAnchor: pending.replyAnchor, messageKey: pending.key,
        ...(nativePendingFloor !== undefined ? { nativeMessageFloor: nativePendingFloor } : {}),
      }], snapshot.threadKey);
    }
  }
  const outgoingKeys = new Set(session.sentMessageKeys);
  for (const key of outgoingMessageKeys(snapshot, deliveredReplyBindings)) outgoingKeys.add(key);
  if ((matchedPending || pendingDiscordDelivery) && pending) outgoingKeys.add(pending.key);
  const clearUserInput = events.some(event => event.type === 'user_input_cleared');
  const pauseState = session.state === 'needs_user_input'
    ? session.pausedState
    : session.state;
  let telegramLatestIncomingRevision = session.telegramLatestIncomingRevision || '';
  if (!snapshot.userInput?.required) {
    for (const message of newIncoming) {
      const sequence = telegramMessageSequence(snapshot.threadKey, message);
      if (sequence !== null && sequence >= telegramIncomingHighWater) {
        telegramIncomingHighWater = sequence;
        telegramLatestIncomingRevision = message.id;
      }
    }
  }
  session = {
    ...session,
    state: nextState,
    messageBaselineEstablished: session.messageBaselineEstablished || !!(snapshot.threadKey && snapshot.threadKey === session.threadKey),
    // A question received while a verification/decision gate blocks replies
    // remains unhandled. Keep it in the next delta after the user clears the
    // gate, including across persisted resumes, while recording delivery and
    // other observations normally.
    seenMessageIds: [...new Set([...session.seenMessageIds, ...snapshot.messages
      .filter(message => !snapshot.userInput?.required || message.direction !== 'incoming')
      .map(message => message.id)])].slice(-MAX_MESSAGES),
    ...(telegramIncomingHighWater > 0n ? { telegramIncomingHighWater: String(telegramIncomingHighWater) } : {}),
    ...(snapshot.messages.some(message => message.direction === 'outgoing' && telegramMessageSequence(snapshot.threadKey, message) !== null)
      ? { telegramOutgoingHighWater: String(snapshot.messages.filter(message => message.direction === 'outgoing')
        .reduce((max, message) => {
          const sequence = telegramMessageSequence(snapshot.threadKey, message);
          return sequence !== null && sequence > max ? sequence : max;
        }, telegramOutgoingHighWater)) } : {}),
    ...(telegramLatestIncomingRevision ? { telegramLatestIncomingRevision } : {}),
    sentMessageKeys: [...outgoingKeys].slice(-MAX_MESSAGES),
    ...(deliveredReplyBindings.length ? { deliveredReplyBindings } : {}),
    pendingOutbound: matchedPending ? null : session.pendingOutbound,
    resolutionEvidence: snapshot.resolutionEvidence,
    lastObservedAt: snapshot.observedAt,
    userInput: snapshot.userInput,
    pausedState: snapshot.userInput?.required
      ? pauseState
      : (clearUserInput ? null : session.pausedState),
    stopReason: snapshot.userInput?.required
      ? snapshot.userInput.reason
      : (clearUserInput ? '' : session.stopReason),
  };
  const resumedReply = clearUserInput && session.state === 'counterparty_replied';
  const nextAction = session.userInput?.required
    ? 'pause_for_user'
    : session.state === 'issue_resolved'
      ? 'stop'
      : (newIncoming.length || resumedReply)
        ? 'reply'
        : !initialOutgoingHistory.length && (session.state === 'waiting_for_transfer'
          || (session.state === 'we_responded' && !session.pendingOutbound))
          ? 'schedule_resume'
          : 'observe';
  return {
    session,
    snapshot,
    pendingDeliveryVerified: !!pendingDiscordDelivery || !!opaquePendingDelivery,
    initialOutgoingHistoryCount: initialOutgoingHistory.length,
    events,
    newMessages: newMessages.slice(-MAX_NEW_MESSAGES),
    newMessagesTruncated: newMessages.length > MAX_NEW_MESSAGES,
    nextAction,
  };
}

// Send preconditions a caller may waive with a note (WebBrain's quality
// checks). The empty/over-long body, user input (credentials, payment, a new
// user decision), thread binding, a user's own draft in the composer and the
// duplicate checks are never waivable: an over-long body could not be matched
// to its pending record afterwards, and a draft belongs to the user.
// Only a missing composer may be waived by default (the send then simply
// cannot dispatch). A terminal session and an unverified native message
// baseline stay blocking: the baseline is what delivery matching and
// duplicate-send detection rely on, and a terminal session asked for no
// further message.
export const WAIVABLE_CHAT_SEND_REASONS = Object.freeze([
  'composer_unavailable',
]);

export function decideChatSend(value, rawSnapshot, text, now = Date.now(), { waive = null } = {}) {
  const session = normalizeChatSession(value, now);
  const snapshot = normalizeChatSnapshot(rawSnapshot, now);
  const waived = reason => WAIVABLE_CHAT_SEND_REASONS.includes(reason)
    && (waive instanceof Set ? waive.has(reason) : Array.isArray(waive) && waive.includes(reason));
  // Normalize one character past the cap so an over-long body is rejected
  // rather than silently truncated into a different message than requested.
  const body = normalizeChatText(text, MAX_MESSAGE_TEXT + 1);
  if (!body) return { ok: false, reason: 'empty_message', error: 'A non-empty chat message is required.' };
  if (body.length > MAX_MESSAGE_TEXT) return { ok: false, reason: 'message_too_long', error: 'Chat messages must be 4,000 characters or fewer.' };
  if (session.userInput?.required || snapshot.userInput?.required) {
    return { ok: false, reason: 'user_input_required', error: 'Pause the chat until the user completes the required verification or decision.' };
  }
  if ((session.state === 'issue_resolved' || session.state === 'stopped') && !waived('terminal_session')) {
    return { ok: false, reason: 'terminal_session', error: 'The chat session is terminal; do not send another message.' };
  }
  if (!session.threadKey || !snapshot.threadKey || session.threadKey !== snapshot.threadKey) {
    return { ok: false, reason: 'thread_unverified', error: 'The active conversation is not bound to the stored chat session.' };
  }
  if (snapshot.nativeMessageBaselineComplete === false && !waived('native_baseline_unverified')) {
    return { ok: false, reason: 'native_baseline_unverified',
      error: 'The latest mounted native message IDs or pending statuses are not verified. Observe the current conversation before sending.' };
  }
  if (snapshot.composer.available !== true && !waived('composer_unavailable')) {
    return { ok: false, reason: 'composer_unavailable', error: 'The active conversation composer is not available.' };
  }
  if (snapshot.composer.empty !== true) {
    return { ok: false, reason: 'composer_not_empty', error: 'Chat send blocked because the composer contains a user draft. Clear or reconcile the draft before sending.' };
  }
  const replyAnchor = latestIncomingId(snapshot);
  const key = messageKey(snapshot.threadKey, body, replyAnchor);
  const latestIncomingIndex = snapshot.messages.findIndex(message => message.id === replyAnchor);
  const latestIncomingSequence = latestIncomingIndex < 0 ? null : telegramMessageSequence(snapshot.threadKey, snapshot.messages[latestIncomingIndex]);
  const replyBindings = new Map((session.deliveredReplyBindings || []).map(binding => [binding.messageId, binding]));
  const sameReplyAlreadyVisible = snapshot.messages.some((message, index) => (
    message.direction === 'outgoing'
      && canonicalChatText(messageTextForMatching(message)) === canonicalChatText(body)
      && (() => {
        const binding = matchingReplyBinding(replyBindings, snapshot, message);
        if (binding) return binding.replyAnchor === replyAnchor;
        const sequence = telegramMessageSequence(snapshot.threadKey, message);
        return sequence !== null && latestIncomingSequence !== null
          ? sequence > latestIncomingSequence : index > latestIncomingIndex;
      })()
  ));
  if (session.sentMessageKeys.includes(key)
      || sameReplyAlreadyVisible) {
    return { ok: false, duplicate: true, reason: 'already_sent', messageKey: key, error: 'This exact message is already visible as an outgoing message in this conversation.' };
  }
  if (session.pendingOutbound) {
    return {
      ok: false,
      duplicate: true,
      pending: true,
      reason: 'send_pending',
      messageKey: key,
      pendingMessageKey: session.pendingOutbound.key,
      error: 'An outbound message is still pending verification; observe the conversation or explicitly reconcile its outcome before sending again.',
    };
  }
  return {
    ok: true,
    ...(/^dom:telegram:[ak]:-?\d+:0$/.test(snapshot.threadKey)
      ? { nativeMessageFloor: String(snapshot.messages.reduce((max, message) => {
          const sequence = telegramMessageSequence(snapshot.threadKey, message);
          return sequence !== null && sequence > max ? sequence : max;
        }, [session.telegramIncomingHighWater, session.telegramOutgoingHighWater, snapshot.nativeMessageFloor]
          .reduce((max, floor) => floor !== undefined && BigInt(floor) > max ? BigInt(floor) : max, 0n))) } : {}),
    messageKey: key,
    replyAnchor,
    threadKey: snapshot.threadKey,
    text: body,
    attemptedAt: new Date(now).toISOString(),
  };
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
      ...(bounded(decision.replyAnchor, MAX_ID)
        ? { replyAnchor: bounded(decision.replyAnchor, MAX_ID) }
        : {}),
      attemptedAt: bounded(decision.attemptedAt, 80) || new Date(now).toISOString(),
      ...(/^\d{1,24}$/.test(decision.nativeMessageFloor || '')
        ? { nativeMessageFloor: String(decision.nativeMessageFloor) } : {}),
      ...(normalizeNativeOpaqueBaseline(decision.nativeOpaqueBaseline, decision.threadKey)
        ? { nativeOpaqueBaseline: normalizeNativeOpaqueBaseline(decision.nativeOpaqueBaseline, decision.threadKey) } : {}),
      ...(bounded(decision.dispatchId, 80) ? { dispatchId: bounded(decision.dispatchId, 80) } : {}),
    },
  };
}

function discordPendingDeliveryMatch(pending, snapshot, newMessages) {
  if (!pending || !snapshot.threadKey.startsWith('dom:discord:')
      || pending.threadKey !== snapshot.threadKey
      || snapshot.composer.available !== true || snapshot.composer.empty !== true
      || !pending.dispatchedAt) return null;
  const dispatchedAt = Date.parse(pending.dispatchedAt);
  const observedAt = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(dispatchedAt) || !Number.isFinite(observedAt)
      || observedAt < dispatchedAt - 5_000) return null;
  const matchingMessages = newMessages.filter(message => (
    canonicalChatText(messageTextForMatching(message)) === canonicalChatText(pending.text)
  ));
  // Discord default avatars and server nicknames do not identify an author.
  // Correlate delivery only after a persisted successful dispatch, with one
  // fresh exact-text bubble and an empty composer; leave its direction unchanged.
  if (matchingMessages.length !== 1 || matchingMessages[0].direction !== 'unknown') return null;
  const [candidate] = matchingMessages;
  const messageAt = Date.parse(candidate.timestamp || '');
  if (!Number.isFinite(messageAt)
      || messageAt < dispatchedAt - 5_000 || messageAt > dispatchedAt + 5_000
      || messageAt > observedAt + 5_000) return null;
  return candidate;
}

export function serializeChatSession(value, now = Date.now()) {
  return normalizeChatSession(value, now);
}


/**
 * Consume only repairs issued by the app's current native chat observation.
 * The controller stays private to Agent. Tool arguments cannot mint a record.
 * Dispatch must use the ordinary recorded tool path, including its guards.
 */
export function createOwnedNativeChatReadRepair() {
  const records = new WeakMap();
  const issued = new Map();
  let currentOwner = '';
  const refPattern = /^ref_[A-Za-z0-9_:-]{1,100}$/;
  const identityPhases = new Set(['open_profile_or_settings', 'open_profile', 'open_menu', 'open_self_settings']);
  const current = entry => !entry.signal?.aborted
    && Date.now() - entry.issuedAt <= 60000
    && entry.isCurrent(entry.scope) === true;

  function issue(observation, authority) {
    if (!authority || typeof authority.isCurrent !== 'function'
        || !['owner', 'documentToken', 'url'].every(key => typeof authority[key] === 'string' && authority[key])
        || authority.signal?.aborted) return null;
    const scope = Object.freeze({ owner: authority.owner, documentToken: authority.documentToken,
      url: authority.url, threadKey: String(authority.threadKey || '') });
    if (authority.isCurrent(scope) !== true) return null;
    const latest = observation?.nativeChatReadRepair;
    const identity = observation?.nativeTelegramRepair;
    let phase, ref;
    if (observation?.success === true && latest?.phase === 'read_latest'
        && latest.direction === 'bottom' && scope.threadKey
        && observation.threadKey === scope.threadKey && refPattern.test(latest.ref_id || '')) {
      phase = 'read_latest'; ref = latest.ref_id;
    } else if (observation?.success === false && observation.reason === 'native_telegram_alias_binding_required'
        && identityPhases.has(identity?.phase) && refPattern.test(identity?.ref_id || '')) {
      phase = identity.phase; ref = identity.ref_id;
    } else return null;
    if (currentOwner !== scope.owner) { currentOwner = scope.owner; issued.clear(); }
    // An identity repair can bind a previously unknown thread. That binding
    // must not make the same current control eligible for a second attempt.
    // The record still retains and checks its exact captured thread scope.
    const key = JSON.stringify([scope.owner, scope.documentToken, scope.url, phase, ref]);
    if (issued.has(key)) {
      const record = issued.get(key), entry = records.get(record);
      return entry && !entry.used && current(entry) ? record : null;
    }
    if (issued.size >= 32) return null;
    const record = Object.freeze({ phase, ref_id: ref, scope });
    records.set(record, { scope, signal: authority.signal, isCurrent: authority.isCurrent,
      issuedAt: Date.now(), used: false });
    issued.set(key, record);
    return record;
  }

  async function run(record, dispatch) {
    const entry = records.get(record), calls = [];
    const finish = (success, reason, result = null, interruptedOutcomeUnknown = false) => ({
      success, reason, attemptedTools: calls.slice(), sendCalls: 0, result,
      outcomeUnknown: interruptedOutcomeUnknown || result?.outcomeUnknown === true,
    });
    if (!entry || entry.used || typeof dispatch !== 'function') {
      return { ...finish(false, 'native_chat_read_repair_not_issued'), noDispatch: true };
    }
    // Even a blocked/uncertain attempt consumes this exact issued repair.
    entry.used = true;
    const guard = () => current(entry);
    const step = async (name, args) => {
      if (!guard()) return { stale: true };
      calls.push(name);
      let result;
      try { result = await dispatch(name, Object.freeze(args), record); }
      catch (error) {
        return { interrupted: true, error, outcomeUnknown: name !== 'get_accessibility_tree' };
      }
      if (!guard()) return { stale: true, result };
      return { result };
    };
    const unusable = value => value.stale || value.interrupted || !value.result
      || typeof value.result !== 'object' || value.result.success === false
      || !!value.result.error || value.result.outcomeUnknown === true || value.result.inconclusive === true;
    let response;
    response = await step('get_accessibility_tree', { ref_id: record.ref_id });
    if (unusable(response)
        || !(response.result.success === true || typeof response.result.pageContent === 'string'
          || typeof response.result.text === 'string')) {
      return finish(false, 'native_chat_read_repair_read_failed', response.result || null, response.outcomeUnknown === true);
    }
    if (record.phase === 'read_latest') {
      response = await step('scroll', { ref_id: record.ref_id, direction: 'bottom' });
      if (unusable(response) || response.result.success !== true || response.result.noDispatch === true) {
        return finish(false, 'native_chat_read_repair_scroll_unverified', response.result || null, response.outcomeUnknown === true);
      }
    } else {
      response = await step('click_ax', { ref_id: record.ref_id });
      if (unusable(response) || response.result.success !== true || response.result.noDispatch === true
          || response.result._nativeTelegramReadRepair !== true) {
        return finish(false, 'native_chat_read_repair_identity_unverified', response.result || null, response.outcomeUnknown === true);
      }
    }
    response = await step('chat_observe', { reconcile_pending_outbound: false });
    if (unusable(response) || response.result.success !== true
        || (record.scope.threadKey && response.result.threadKey !== record.scope.threadKey)
        || !response.result.threadKey || response.result.nativeChatReadRepair
        || response.result.nativeTelegramRepair || response.result.composer?.available !== true) {
      return finish(false, 'native_chat_read_repair_observation_unverified', response.result || null, response.outcomeUnknown === true);
    }
    // This is viewport/identity recovery, never delivery or send permission.
    return finish(true, 'native_chat_read_repair_observed', response.result);
  }

  const isCurrent = record => {
    const entry = records.get(record);
    return !!entry && !entry.used && current(entry);
  };
  return Object.freeze({ issue, run, isCurrent });
}

const CHAT_RUN_ENDED_NOTICES = Object.freeze({
  en: 'This run has ended. No automatic continuation is scheduled.',
  ar: 'انتهى هذا التشغيل. لم تتم جدولة أي متابعة تلقائية.',
  bn: 'এই কাজের চলমান পর্ব শেষ হয়েছে। স্বয়ংক্রিয়ভাবে চালিয়ে যাওয়ার জন্য কিছু নির্ধারিত হয়নি।',
  de: 'Dieser Durchlauf ist beendet. Eine automatische Fortsetzung wurde nicht geplant.',
  es: 'Esta ejecución ha terminado. No se ha programado ninguna continuación automática.',
  fa: 'این اجرا پایان یافته است. هیچ ادامهٔ خودکاری زمان‌بندی نشده است.',
  fr: 'Cette exécution est terminée. Aucune reprise automatique n’a été programmée.',
  he: 'הריצה הזו הסתיימה. לא נקבע המשך אוטומטי.',
  hi: 'यह रन समाप्त हो गया है। कोई स्वचालित अगली प्रक्रिया निर्धारित नहीं की गई है।',
  id: 'Proses ini telah berakhir. Tidak ada kelanjutan otomatis yang dijadwalkan.',
  ja: 'この実行は終了しました。自動的に続行する予定はありません。',
  ko: '이번 실행은 종료되었습니다. 자동으로 이어서 실행하도록 예약된 작업은 없습니다.',
  ms: 'Pelaksanaan ini telah tamat. Tiada sambungan automatik dijadualkan.',
  nl: 'Deze uitvoering is beëindigd. Er is geen automatische voortzetting gepland.',
  pl: 'Ten przebieg zakończył się. Nie zaplanowano automatycznej kontynuacji.',
  pt: 'Esta execução terminou. Nenhuma continuação automática foi agendada.',
  ru: 'Этот запуск завершён. Автоматическое продолжение не запланировано.',
  th: 'การทำงานครั้งนี้สิ้นสุดแล้ว ไม่มีการกำหนดเวลาทำงานต่อโดยอัตโนมัติ',
  tl: 'Natapos na ang pagpapatakbong ito. Walang nakaiskedyul na awtomatikong pagpapatuloy.',
  tr: 'Bu çalışma sona erdi. Otomatik devam için zamanlanmış bir iş yok.',
  uk: 'Цей запуск завершено. Автоматичне продовження не заплановано.',
  vi: 'Lần chạy này đã kết thúc. Không có lần tiếp tục tự động nào được lên lịch.',
  zh: '本次运行已结束。没有安排自动继续执行的任务。',
});

/** Display only for an ended current run with no authorized continuation. */
export function chatRunEndedNotice(locale = 'en') {
  const code = String(locale || 'en').trim().replace(/_/g, '-').toLowerCase().split('-')[0];
  return Object.prototype.hasOwnProperty.call(CHAT_RUN_ENDED_NOTICES, code)
    ? CHAT_RUN_ENDED_NOTICES[code] : CHAT_RUN_ENDED_NOTICES.en;
}
