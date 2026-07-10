import { USER_MEMORY_STORAGE_KEY, normalizeUserMemoryStore } from './agent/user-memory.js';

export const PROFILE_SYNC_KEYS = {
  enabled: 'profileSyncEnabled', token: 'profileSyncToken', deviceGuid: 'webbrainDeviceGuid',
  metadata: 'profileSyncMetadataV1', recovery: 'profileSyncRecoveryV1',
};
export const PROFILE_SYNC_DATA_KEYS = [USER_MEMORY_STORAGE_KEY, 'providers', 'activeProvider', 'visionModel', 'transcriptionModel', 'profileEnabled', 'profileText'];
const API = 'https://api.webbrain.one/v1/sync';
const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const unb64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const randomB64 = n => b64(crypto.getRandomValues(new Uint8Array(n)));
const stable = value => JSON.stringify(canonical(value));
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;

export async function deriveProfileSyncKey(password, salt, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function aadFor(envelope) {
  return enc.encode(JSON.stringify({ version: envelope.version, vaultId: envelope.vaultId, kdf: envelope.kdf }));
}

export async function encryptProfileVault(payload, password, options = {}) {
  const salt = options.salt || crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const envelope = { version: 1, vaultId: options.vaultId || crypto.randomUUID(),
    kdf: { name: 'PBKDF2-HMAC-SHA-256', iterations: ITERATIONS, salt: b64(salt) }, nonce: b64(nonce) };
  const key = options.key || await deriveProfileSyncKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aadFor(envelope) }, key, enc.encode(JSON.stringify(payload)));
  return { envelope: { ...envelope, ciphertext: b64(new Uint8Array(ciphertext)) }, key };
}

export async function decryptProfileVault(envelope, password, key = null) {
  if (envelope?.version !== 1 || envelope?.kdf?.name !== 'PBKDF2-HMAC-SHA-256') throw new Error('Unsupported vault format');
  const derived = key || await deriveProfileSyncKey(password, unb64(envelope.kdf.salt), Number(envelope.kdf.iterations));
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.nonce), additionalData: aadFor(envelope) }, derived, unb64(envelope.ciphertext));
    return { payload: JSON.parse(dec.decode(plaintext)), key: derived };
  } catch { throw new Error('Incorrect sync password or damaged vault'); }
}

function newer(local, remote, localAt, remoteAt, conflicts, name) {
  if (remoteAt > localAt) return remote;
  // A remote vault with no metadata predates sync timestamps. On another
  // device's first unlock, prefer that established cloud value only when
  // local state is genuinely empty/default. Meaningful legacy local state
  // remains the tie winner and the remote variant is retained as a conflict.
  const localIsEmpty = name === 'providers'
    ? Object.keys(local || {}).length === 0
    : name === 'profile'
      ? !local?.enabled && !String(local?.text || '').trim()
      : local == null || local === '';
  if (localAt === 0 && remoteAt === 0 && localIsEmpty) return remote;
  if (remoteAt === localAt && stable(local) !== stable(remote)) conflicts.push({ dataset: name, local, remote, at: Date.now() });
  return local;
}

export function mergeProfileVaults(local, remote) {
  const conflicts = [];
  const out = structuredClone(local);
  const lm = local.meta || {}, rm = remote.meta || {};
  out.providers = newer(local.providers || {}, remote.providers || {}, lm.providersAt || 0, rm.providersAt || 0, conflicts, 'providers');
  out.activeProvider = newer(local.activeProvider || '', remote.activeProvider || '', lm.providersAt || 0, rm.providersAt || 0, conflicts, 'providers');
  out.auxiliaryProviders = newer(local.auxiliaryProviders || {}, remote.auxiliaryProviders || {}, lm.providersAt || 0, rm.providersAt || 0, conflicts, 'providers');
  out.profile = newer(local.profile || {}, remote.profile || {}, lm.profileAt || 0, rm.profileAt || 0, conflicts, 'profile');
  const byId = new Map();
  for (const record of [...(remote.memory?.records || []), ...(local.memory?.records || [])]) {
    const old = byId.get(record.id);
    if (!old || Number(record.updatedAt || 0) > Number(old.updatedAt || 0)) byId.set(record.id, record);
    else if (old && Number(record.updatedAt || 0) === Number(old.updatedAt || 0) && stable(old) !== stable(record)) {
      conflicts.push({ dataset: 'memory', local: record, remote: old, at: Date.now() });
      // Records are iterated remote-first and local-second, so ties preserve
      // the local variant while retaining the displaced remote value for review.
      byId.set(record.id, record);
    }
  }
  const tombstones = { ...(remote.tombstones || {}), ...(local.tombstones || {}) };
  for (const [id, deletedAt] of Object.entries(remote.tombstones || {})) tombstones[id] = Math.max(tombstones[id] || 0, deletedAt);
  for (const [id, deletedAt] of Object.entries(tombstones)) if (deletedAt >= Number(byId.get(id)?.updatedAt || 0)) byId.delete(id);
  out.memory = normalizeUserMemoryStore({ ...(local.memory || {}), records: [...byId.values()] });
  out.tombstones = tombstones;
  out.meta = { providersAt: Math.max(lm.providersAt || 0, rm.providersAt || 0), profileAt: Math.max(lm.profileAt || 0, rm.profileAt || 0), memoryAt: Math.max(lm.memoryAt || 0, rm.memoryAt || 0) };
  return { vault: out, conflicts };
}

export class ProfileSyncManager {
  constructor(storage) { this.storage = storage; this.password = null; this.key = null; this.envelope = null; this.revision = null; this.timer = null; this.applying = false; this.status = 'disabled'; }
  async state() { const s = await this.storage.get([PROFILE_SYNC_KEYS.enabled, PROFILE_SYNC_KEYS.token]); const enabled = s[PROFILE_SYNC_KEYS.enabled] === true; return { enabled, authenticated: !!s[PROFILE_SYNC_KEYS.token], unlocked: !!this.password, status: enabled && !this.password && this.status === 'disabled' ? 'locked' : this.status, revision: this.revision }; }
  async localVault() {
    const s = await this.storage.get([...PROFILE_SYNC_DATA_KEYS, PROFILE_SYNC_KEYS.metadata]); const meta = s[PROFILE_SYNC_KEYS.metadata] || {};
    return { version: 1, memory: normalizeUserMemoryStore(s[USER_MEMORY_STORAGE_KEY]), tombstones: meta.tombstones || {}, providers: s.providers || {}, activeProvider: s.activeProvider || '', auxiliaryProviders: { visionModel: s.visionModel || null, transcriptionModel: s.transcriptionModel || null }, profile: { enabled: !!s.profileEnabled, text: s.profileText || '' }, meta: { providersAt: meta.providersAt || 0, profileAt: meta.profileAt || 0, memoryAt: meta.memoryAt || 0 } };
  }
  async request(path, options = {}) {
    const s = await this.storage.get(PROFILE_SYNC_KEYS.token); const token = s[PROFILE_SYNC_KEYS.token];
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }; if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { ...options, headers }); const body = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body?.error?.message || `Sync request failed (${res.status})`); e.status = res.status; e.body = body; throw e; } return { body, res };
  }
  async authStart(email) { const s = await this.storage.get(PROFILE_SYNC_KEYS.deviceGuid); const verifier = randomB64(32); const r = await this.request('/auth/start', { method: 'POST', body: JSON.stringify({ email, device_guid: s[PROFILE_SYNC_KEYS.deviceGuid], verifier }) }); return { ...r.body, verifier }; }
  async authStatus(challengeId, verifier) { const q = new URLSearchParams({ challenge_id: challengeId }); const r = await this.request(`/auth/status?${q}`, { headers: { 'X-WebBrain-Sync-Verifier': verifier } }); if (r.body.token) await this.storage.set({ [PROFILE_SYNC_KEYS.token]: r.body.token }); return r.body; }
  async unlock(password, create = false) { this.password = password; this.status = 'syncing'; try { await this.sync({ create }); this.status = 'current'; } catch (e) { this.password = null; this.key = null; this.status = e.status === 404 ? 'empty' : [402, 403].includes(e.status) ? 'subscription' : e instanceof TypeError ? 'offline' : 'error'; throw e; } return this.state(); }
  lock() { this.password = null; this.key = null; this.envelope = null; this.status = 'locked'; }
  async noteChanges(changes) {
    if (this.applying) return;
    const stored = await this.storage.get(PROFILE_SYNC_KEYS.metadata);
    const meta = stored[PROFILE_SYNC_KEYS.metadata] || {};
    const now = Date.now();
    if (changes.providers || changes.activeProvider || changes.visionModel || changes.transcriptionModel) meta.providersAt = now;
    if (changes.profileEnabled || changes.profileText) meta.profileAt = now;
    if (changes[USER_MEMORY_STORAGE_KEY]) {
      meta.memoryAt = now; meta.tombstones = meta.tombstones || {};
      const before = normalizeUserMemoryStore(changes[USER_MEMORY_STORAGE_KEY].oldValue).records;
      const afterIds = new Set(normalizeUserMemoryStore(changes[USER_MEMORY_STORAGE_KEY].newValue).records.map(r => r.id));
      for (const record of before) if (!afterIds.has(record.id)) meta.tombstones[record.id] = now;
      const cutoff = now - 90 * 86400 * 1000;
      for (const [id, at] of Object.entries(meta.tombstones)) if (at < cutoff) delete meta.tombstones[id];
    }
    await this.storage.set({ [PROFILE_SYNC_KEYS.metadata]: meta });
    this.schedule();
  }
  schedule() { if (this.applying || !this.password) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.sync().catch((e) => { this.status = [402, 403].includes(e.status) ? 'subscription' : e instanceof TypeError ? 'offline' : 'error'; }), 1500); }
  async apply(vault, conflicts) { this.applying = true; try { await this.storage.set({ [USER_MEMORY_STORAGE_KEY]: vault.memory, providers: vault.providers, activeProvider: vault.activeProvider, visionModel: vault.auxiliaryProviders?.visionModel || null, transcriptionModel: vault.auxiliaryProviders?.transcriptionModel || null, profileEnabled: vault.profile.enabled, profileText: vault.profile.text, [PROFILE_SYNC_KEYS.metadata]: { ...vault.meta, tombstones: vault.tombstones }, [PROFILE_SYNC_KEYS.recovery]: conflicts }); } finally { this.applying = false; } }
  async sync({ create = false } = {}) {
    if (!this.password) throw new Error('Cloud Sync is locked'); this.status = 'syncing'; let local = await this.localVault();
    let remote = null; try { const got = await this.request('/vault'); remote = got.body; this.revision = remote.revision; } catch (e) { if (e.status !== 404 || !create) throw e; }
    if (remote?.envelope) { const decrypted = await decryptProfileVault(remote.envelope, this.password); this.key = decrypted.key; this.envelope = remote.envelope; const merged = mergeProfileVaults(local, decrypted.payload); local = merged.vault; await this.apply(local, merged.conflicts); }
    const encrypted = await encryptProfileVault(local, this.password, this.envelope ? { vaultId: this.envelope.vaultId, salt: unb64(this.envelope.kdf.salt), key: this.key } : {}); this.key = encrypted.key; this.envelope = encrypted.envelope;
    try { const put = await this.request('/vault', { method: 'PUT', headers: this.revision != null ? { 'If-Match': String(this.revision) } : {}, body: JSON.stringify({ envelope: encrypted.envelope }) }); this.revision = put.body.revision; }
    catch (e) { if (e.status === 409) { this.revision = null; return this.sync(); } throw e; }
    this.status = 'current'; return this.state();
  }
  async changePassword(oldPassword, nextPassword) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.unlock(oldPassword);
      const local = await this.localVault();
      const vaultId = this.envelope?.vaultId;
      const encrypted = await encryptProfileVault(local, nextPassword, { vaultId });
      try {
        const put = await this.request('/vault', {
          method: 'PUT',
          headers: { 'If-Match': String(this.revision) },
          body: JSON.stringify({ envelope: encrypted.envelope }),
        });
        this.password = nextPassword;
        this.key = encrypted.key;
        this.envelope = encrypted.envelope;
        this.revision = put.body.revision;
        this.status = 'current';
        return this.state();
      } catch (error) {
        if (error.status !== 409 || attempt === 1) throw error;
        this.password = oldPassword;
        this.key = null;
        this.envelope = null;
        this.revision = null;
      }
    }
  }
  async disable() { try { await this.request('/auth/revoke', { method: 'POST' }); } catch {} this.lock(); await this.storage.remove([PROFILE_SYNC_KEYS.token]); await this.storage.set({ [PROFILE_SYNC_KEYS.enabled]: false }); this.status = 'disabled'; }
  async reset(password) {
    if (this.revision == null) {
      try { const current = await this.request('/vault'); this.revision = current.body.revision; }
      catch (error) { if (error.status !== 404) throw error; }
    }
    await this.request('/vault', { method: 'DELETE', headers: this.revision != null ? { 'If-Match': String(this.revision) } : {} });
    this.password = password; this.key = null; this.envelope = null; this.revision = null;
    return this.sync({ create: true });
  }
}
