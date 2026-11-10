import '../content/whatsapp-phone.js';
import { normalizeMessageTarget, normalizeRecipientIdentity } from './message-recipient-guard.js';

const { canonical: canonicalWhatsappPhone, needsCountryCode: whatsappPhoneNeedsCountryCode } = globalThis.__wbWhatsappPhone;
export { whatsappPhoneNeedsCountryCode };

const nativePeer = /^whatsapp:phone:[a-f0-9]{32}$/;

export function whatsappRecipientPeer(target, sha256) {
  const named = normalizeMessageTarget(target);
  if (named?.target_kind !== 'named' || named.recipients.length !== 1 || named.recipients[0].role !== 'to') return '';
  const identity = normalizeRecipientIdentity(named.recipients[0].identity);
  if (nativePeer.test(identity)) return identity;
  const phone = canonicalWhatsappPhone(identity);
  return phone ? 'whatsapp:phone:' + sha256(phone).slice(0, 32) : '';
}

// Only the isolated Contact info reader can establish a native peer. A
// scoped composer label supplies the canonical alias on older layouts.
export function resolveWhatsappRecipient(target, probe, candidates, pageUrl, sha256) {
  const named = normalizeMessageTarget(target);
  if (!named) return null;
  const openChat = named.target_kind === 'active_conversation';
  if (!openChat && (named.recipients.length !== 1 || named.recipients[0].role !== 'to')) return null;
  const page = pageUrl || probe?.nativeChatMessageBaseline?.url || probe?.whatsappOrigin;
  try { if (new URL(page).origin !== 'https://web.whatsapp.com') return null; } catch { return null; }

  const expected = openChat ? '' : normalizeRecipientIdentity(named.recipients[0].identity);
  const phone = canonicalWhatsappPhone(expected);
  const localNumber = whatsappPhoneNeedsCountryCode(expected);
  const mismatch = { matches: false, phone, localNumber };
  if (localNumber || probe?.success !== true || probe.conclusive !== true) return mismatch;
  const baselinePeer = probe.nativeChatMessageBaseline?.threadKey?.replace(/^dom:/, '');
  if (openChat && !nativePeer.test(baselinePeer)) return null;
  const peer = probe.whatsappPeer || baselinePeer;
  if (nativePeer.test(peer)) {
    if (baselinePeer && baselinePeer !== peer) return mismatch;
    const candidate = candidates.find(item => item.role === 'to' && normalizeRecipientIdentity(item.identity) === peer);
    if (!candidate) return mismatch;
    const aliases = new Set((candidate.aliases || []).map(normalizeRecipientIdentity));
    // Some readers report both the peer and its display name. Either order
    // describes one recipient. Another peer, role or unknown name does not.
    if (!candidates.every(item => {
      const identity = normalizeRecipientIdentity(item.identity);
      return item.role === 'to' && (identity === peer || (!nativePeer.test(identity) && aliases.has(identity)));
    })) return mismatch;
    const requestedPeer = whatsappRecipientPeer(named, sha256);
    const matches = openChat || (requestedPeer ? requestedPeer === peer : !expected.startsWith('whatsapp:') && aliases.has(expected));
    return matches ? { matches: true, phone, pin: { target_kind: 'named', recipients: [{ identity: peer, role: 'to' }] } } : mismatch;
  }
  // An opaque id copied into an editable display name cannot stand in for
  // the native proof that originally authorized that peer.
  if (nativePeer.test(expected) || candidates.some(item => nativePeer.test(normalizeRecipientIdentity(item.identity)))) return mismatch;
  if (!phone) return null;
  if (candidates.length !== 1 || candidates[0].role !== 'to') return mismatch;
  // A numeric header can contradict the composer. It never authorizes the
  // destination, even if WhatsApp omits the plus sign from its display.
  const headerPhone = canonicalWhatsappPhone(candidates[0].identity, true);
  return { matches: probe.whatsappComposerPhone === phone && (!headerPhone || headerPhone === phone), phone };
}
