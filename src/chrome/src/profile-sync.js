import { USER_MEMORY_STORAGE_KEY, normalizeUserMemoryStore } from './agent/user-memory.js';

export const PROFILE_SYNC_KEYS = {
  enabled: 'profileSyncEnabled', token: 'profileSyncToken', deviceGuid: 'webbrainDeviceGuid',
  metadata: 'profileSyncMetadataV1', recovery: 'profileSyncRecoveryV1', everEnabled: 'profileSyncEverEnabled',
};
export const PROFILE_SYNC_DATA_KEYS = [USER_MEMORY_STORAGE_KEY, 'providers', 'activeProvider', 'visionModel', 'transcriptionModel', 'imageGenModel', 'profileEnabled', 'profileText'];
const API = 'https://api.webbrain.one/v1/sync';
const ITERATIONS = 600000;
const NON_PORTABLE_PROVIDER_ID = 'webgpu';
const PORTABLE_ACTIVE_PROVIDER_KEY = 'profileSyncPortableActiveProvider';
const DEFAULT_PORTABLE_ACTIVE_PROVIDER = 'webbrain_cloud';
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

function nonPortableProviderIds(providers) {
  const ids = new Set([NON_PORTABLE_PROVIDER_ID]);
  for (const [id, config] of Object.entries(providers || {})) {
    if (config?.type === NON_PORTABLE_PROVIDER_ID) ids.add(id);
  }
  return ids;
}

function portableProviders(providers) {
  const excluded = nonPortableProviderIds(providers);
  return Object.fromEntries(Object.entries(providers || {}).filter(([id]) => !excluded.has(id)));
}

function portableActiveProvider(activeProvider, providers, fallback = '') {
  const excluded = nonPortableProviderIds(providers);
  if (!excluded.has(activeProvider)) return activeProvider || '';
  const candidate = String(fallback || '').trim();
  return candidate && !excluded.has(candidate) ? candidate : DEFAULT_PORTABLE_ACTIVE_PROVIDER;
}

function portableProviderMetadata(meta, providers) {
  const output = { ...(meta || {}) };
  if (output.providerItemsAt) {
    const excluded = nonPortableProviderIds(providers);
    output.providerItemsAt = Object.fromEntries(
      Object.entries(output.providerItemsAt).filter(([id]) => !excluded.has(id)),
    );
  }
  return output;
}

function portableVault(vault, fallbackActiveProvider = '') {
  const source = vault || {};
  const providers = source.providers || {};
  return {
    ...source,
    providers: portableProviders(providers),
    activeProvider: portableActiveProvider(source.activeProvider, providers, fallbackActiveProvider),
    meta: portableProviderMetadata(source.meta, providers),
  };
}

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
  const iterations = Number(options.iterations || ITERATIONS);
  const envelope = { version: 1, vaultId: options.vaultId || crypto.randomUUID(),
    kdf: { name: 'PBKDF2-HMAC-SHA-256', iterations, salt: b64(salt) }, nonce: b64(nonce) };
  const key = options.key || await deriveProfileSyncKey(password, salt, iterations);
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
  const localIsEmpty = name === 'profile'
      ? !local?.enabled && !String(local?.text || '').trim()
      : local == null || local === '';
  if (localAt === 0 && remoteAt === 0 && localIsEmpty) return remote;
  if (remoteAt === localAt && stable(local) !== stable(remote)) conflicts.push({ dataset: name, local, remote, at: Date.now() });
  return local;
}

function hasProviderCredentials(providers) {
  const dummyKeys = new Set(['ollama', 'lm-studio']);
  const visit = value => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const credentialField = normalized.includes('secret') || normalized.includes('password') || normalized.includes('token')
        || (normalized.includes('key') && !normalized.endsWith('url'));
      return credentialField && typeof child === 'string' && child.length > 0 && !dummyKeys.has(child) || visit(child);
    });
  };
  return visit(providers);
}

function mergeLegacyProviderState(local, remote, conflicts) {
  const providers = structuredClone(remote.providers || {});
  for (const [id, localConfig] of Object.entries(local.providers || {})) {
    const remoteConfig = providers[id];
    if (remoteConfig === undefined || stable(localConfig) === stable(remoteConfig)) providers[id] = localConfig;
    else {
      conflicts.push({ dataset: `providers.${id}`, local: localConfig, remote: remoteConfig, at: Date.now() });
      if (hasProviderCredentials(localConfig) || !hasProviderCredentials(remoteConfig)) providers[id] = localConfig;
    }
  }
  const localActiveHasCredentials = hasProviderCredentials((local.providers || {})[local.activeProvider]);
  const remoteActiveHasCredentials = hasProviderCredentials((remote.providers || {})[remote.activeProvider]);
  return {
    providers,
    activeProvider: remoteActiveHasCredentials && !localActiveHasCredentials ? remote.activeProvider : (local.activeProvider || remote.activeProvider || ''),
    auxiliaryProviders: {
      visionModel: local.auxiliaryProviders?.visionModel ?? remote.auxiliaryProviders?.visionModel ?? null,
      transcriptionModel: local.auxiliaryProviders?.transcriptionModel ?? remote.auxiliaryProviders?.transcriptionModel ?? null,
      imageGenModel: local.auxiliaryProviders?.imageGenModel ?? remote.auxiliaryProviders?.imageGenModel ?? null,
    },
  };
}

function itemTimestamp(meta, group, id) {
  const items = meta?.[group];
  if (items) return Number(items[id] || 0);
  const hasItemizedMetadata = meta?.providerItemsAt || meta?.auxiliaryItemsAt || meta?.activeProviderAt != null;
  return hasItemizedMetadata ? 0 : Number(meta?.providersAt || 0);
}

function mergeProviderState(local, remote, lm, rm, conflicts) {
  const providers = {};
  for (const id of new Set([...Object.keys(remote.providers || {}), ...Object.keys(local.providers || {})])) {
    providers[id] = newer(local.providers?.[id], remote.providers?.[id], itemTimestamp(lm, 'providerItemsAt', id), itemTimestamp(rm, 'providerItemsAt', id), conflicts, `providers.${id}`);
    if (providers[id] === undefined) delete providers[id];
  }
  const auxiliaryProviders = {};
  for (const id of ['visionModel', 'transcriptionModel', 'imageGenModel']) {
    auxiliaryProviders[id] = newer(local.auxiliaryProviders?.[id], remote.auxiliaryProviders?.[id], itemTimestamp(lm, 'auxiliaryItemsAt', id), itemTimestamp(rm, 'auxiliaryItemsAt', id), conflicts, `providers.${id}`) ?? null;
  }
  const localActiveAt = lm.activeProviderAt ?? (lm.providerItemsAt ? 0 : lm.providersAt || 0);
  const remoteActiveAt = rm.activeProviderAt ?? (rm.providerItemsAt ? 0 : rm.providersAt || 0);
  return { providers, auxiliaryProviders, activeProvider: newer(local.activeProvider || '', remote.activeProvider || '', localActiveAt, remoteActiveAt, conflicts, 'activeProvider') };
}

export function mergeProfileVaults(local, remote) {
  local = portableVault(local);
  remote = portableVault(remote, local.activeProvider);
  const conflicts = [];
  const out = structuredClone(local);
  const lm = local.meta || {}, rm = remote.meta || {};
  const providerState = (lm.providersAt || 0) === 0 && (rm.providersAt || 0) === 0
    ? mergeLegacyProviderState(local, remote, conflicts)
    : mergeProviderState(local, remote, lm, rm, conflicts);
  out.providers = providerState.providers;
  out.activeProvider = providerState.activeProvider;
  out.auxiliaryProviders = providerState.auxiliaryProviders;
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
  const providerIds = new Set([...Object.keys(local.providers || {}), ...Object.keys(remote.providers || {}), ...Object.keys(lm.providerItemsAt || {}), ...Object.keys(rm.providerItemsAt || {})]);
  const auxiliaryIds = new Set(['visionModel', 'transcriptionModel', 'imageGenModel', ...Object.keys(lm.auxiliaryItemsAt || {}), ...Object.keys(rm.auxiliaryItemsAt || {})]);
  out.meta = { providersAt: Math.max(lm.providersAt || 0, rm.providersAt || 0), providerItemsAt: Object.fromEntries([...providerIds].map(id => [id, Math.max(itemTimestamp(lm, 'providerItemsAt', id), itemTimestamp(rm, 'providerItemsAt', id))])), activeProviderAt: Math.max(lm.activeProviderAt || 0, rm.activeProviderAt || 0), auxiliaryItemsAt: Object.fromEntries([...auxiliaryIds].map(id => [id, Math.max(itemTimestamp(lm, 'auxiliaryItemsAt', id), itemTimestamp(rm, 'auxiliaryItemsAt', id))])), profileAt: Math.max(lm.profileAt || 0, rm.profileAt || 0), memoryAt: Math.max(lm.memoryAt || 0, rm.memoryAt || 0) };
  return { vault: out, conflicts };
}

export class ProfileSyncManager {
  constructor(storage) { this.storage = storage; this.password = null; this.key = null; this.envelope = null; this.revision = null; this.timer = null; this.applying = false; this.status = 'disabled'; this.changeQueue = Promise.resolve(); this.syncPromise = null; this.syncAgain = false; this.sessionGeneration = 0; }
  async state() { const s = await this.storage.get([PROFILE_SYNC_KEYS.enabled, PROFILE_SYNC_KEYS.token]); const enabled = s[PROFILE_SYNC_KEYS.enabled] === true; return { enabled, authenticated: !!s[PROFILE_SYNC_KEYS.token], unlocked: !!this.password, status: enabled && !this.password && this.status === 'disabled' ? 'locked' : this.status, revision: this.revision }; }
  async localVault() {
    const s = await this.storage.get([...PROFILE_SYNC_DATA_KEYS, PROFILE_SYNC_KEYS.metadata, PORTABLE_ACTIVE_PROVIDER_KEY]);
    const rawMeta = s[PROFILE_SYNC_KEYS.metadata] || {};
    const portable = portableVault({
      providers: s.providers || {},
      activeProvider: s.activeProvider || '',
      meta: rawMeta,
    }, s[PORTABLE_ACTIVE_PROVIDER_KEY]);
    const meta = portable.meta;
    return { version: 1, memory: normalizeUserMemoryStore(s[USER_MEMORY_STORAGE_KEY]), tombstones: meta.tombstones || {}, providers: portable.providers, activeProvider: portable.activeProvider, auxiliaryProviders: { visionModel: s.visionModel || null, transcriptionModel: s.transcriptionModel || null, imageGenModel: s.imageGenModel || null }, profile: { enabled: !!s.profileEnabled, text: s.profileText || '' }, meta: { providersAt: meta.providersAt || 0, providerItemsAt: meta.providerItemsAt, activeProviderAt: meta.activeProviderAt, auxiliaryItemsAt: meta.auxiliaryItemsAt, profileAt: meta.profileAt || 0, memoryAt: meta.memoryAt || 0 } };
  }
  async request(path, options = {}) {
    const s = await this.storage.get(PROFILE_SYNC_KEYS.token); const token = s[PROFILE_SYNC_KEYS.token];
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }; if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { ...options, headers }); const body = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body?.error?.message || `Sync request failed (${res.status})`); e.status = res.status; e.body = body; throw e; } return { body, res };
  }
  async authStart(email) { const s = await this.storage.get(PROFILE_SYNC_KEYS.deviceGuid); const verifier = randomB64(32); const r = await this.request('/auth/start', { method: 'POST', body: JSON.stringify({ email, device_guid: s[PROFILE_SYNC_KEYS.deviceGuid], verifier }) }); return { ...r.body, verifier }; }
  async authStatus(challengeId, verifier) { const q = new URLSearchParams({ challenge_id: challengeId }); const r = await this.request(`/auth/status?${q}`, { headers: { 'X-WebBrain-Sync-Verifier': verifier } }); if (r.body.token) await this.storage.set({ [PROFILE_SYNC_KEYS.token]: r.body.token }); return r.body; }
  async unlock(password, create = false) { this.sessionGeneration++; this.password = password; this.status = 'syncing'; try { await this.sync({ create }); this.status = 'current'; } catch (e) { this.password = null; this.key = null; this.status = e.status === 404 ? 'empty' : [402, 403].includes(e.status) ? 'subscription' : e instanceof TypeError ? 'offline' : 'error'; throw e; } return this.state(); }
  lock() { this.sessionGeneration++; clearTimeout(this.timer); this.timer = null; this.password = null; this.key = null; this.envelope = null; this.status = 'locked'; }
  noteChanges(changes) {
    this.changeQueue = this.changeQueue.then(() => this.updateChangeMetadata(changes), () => this.updateChangeMetadata(changes));
    return this.changeQueue;
  }
  async updateChangeMetadata(changes) {
    if (this.applying) return;
    const stored = await this.storage.get([PROFILE_SYNC_KEYS.metadata, PROFILE_SYNC_KEYS.enabled, PROFILE_SYNC_KEYS.everEnabled, PORTABLE_ACTIVE_PROVIDER_KEY]);
    const meta = stored[PROFILE_SYNC_KEYS.metadata] || {};
    let portableActive = stored[PORTABLE_ACTIVE_PROVIDER_KEY] || DEFAULT_PORTABLE_ACTIVE_PROVIDER;
    let portableActiveChanged = false;
    if (changes.activeProvider) {
      const previous = changes.activeProvider.oldValue || '';
      const next = changes.activeProvider.newValue || '';
      const previousPortable = previous === NON_PORTABLE_PROVIDER_ID ? portableActive : previous;
      const nextPortable = next === NON_PORTABLE_PROVIDER_ID
        ? (previous && previous !== NON_PORTABLE_PROVIDER_ID ? previous : portableActive)
        : next;
      if (nextPortable && nextPortable !== portableActive) {
        portableActive = nextPortable;
        portableActiveChanged = true;
      }
      changes = {
        ...changes,
        activeProvider: previousPortable === nextPortable ? null : changes.activeProvider,
      };
    }
    const metadataEnabled = stored[PROFILE_SYNC_KEYS.enabled] === true
      || stored[PROFILE_SYNC_KEYS.everEnabled] === true
      || Object.keys(meta).length > 0;
    if (!metadataEnabled) {
      if (portableActiveChanged) await this.storage.set({ [PORTABLE_ACTIVE_PROVIDER_KEY]: portableActive });
      return;
    }
    const now = Date.now();
    let syncRelevantChange = false;
    if (changes.providers) {
      const before = portableProviders(changes.providers.oldValue);
      const after = portableProviders(changes.providers.newValue);
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (stable(before[id]) !== stable(after[id])) {
          meta.providersAt = now;
          meta.providerItemsAt = meta.providerItemsAt || {};
          meta.providerItemsAt[id] = now;
          syncRelevantChange = true;
        }
      }
      // Preserve legacy callers that report a provider write without an old snapshot.
      // An explicitly WebGPU-only snapshot remains device-local and does not upload.
      const rawAfter = changes.providers.newValue || {};
      const explicitlyWebGpuOnly = Object.keys(rawAfter).length > 0 && Object.keys(after).length === 0;
      if (!Object.hasOwn(changes.providers, 'oldValue') && !explicitlyWebGpuOnly) {
        meta.providersAt = now;
        syncRelevantChange = true;
      }
    }
    if (changes.activeProvider) { meta.providersAt = now; meta.activeProviderAt = now; }
    if (changes.activeProvider) syncRelevantChange = true;
    for (const id of ['visionModel', 'transcriptionModel', 'imageGenModel']) if (changes[id]) { meta.providersAt = now; meta.auxiliaryItemsAt = meta.auxiliaryItemsAt || {}; meta.auxiliaryItemsAt[id] = now; syncRelevantChange = true; }
    if (changes.profileEnabled || changes.profileText) { meta.profileAt = now; syncRelevantChange = true; }
    if (changes[USER_MEMORY_STORAGE_KEY]) {
      syncRelevantChange = true;
      meta.memoryAt = now; meta.tombstones = meta.tombstones || {};
      const before = normalizeUserMemoryStore(changes[USER_MEMORY_STORAGE_KEY].oldValue).records;
      const afterIds = new Set(normalizeUserMemoryStore(changes[USER_MEMORY_STORAGE_KEY].newValue).records.map(r => r.id));
      for (const record of before) if (!afterIds.has(record.id)) meta.tombstones[record.id] = now;
      const cutoff = now - 90 * 86400 * 1000;
      for (const [id, at] of Object.entries(meta.tombstones)) if (at < cutoff) delete meta.tombstones[id];
    }
    const values = {
      ...(syncRelevantChange ? { [PROFILE_SYNC_KEYS.metadata]: portableProviderMetadata(meta, changes.providers?.newValue) } : {}),
      ...(portableActiveChanged ? { [PORTABLE_ACTIVE_PROVIDER_KEY]: portableActive } : {}),
    };
    if (Object.keys(values).length) await this.storage.set(values);
    if (syncRelevantChange) this.schedule();
  }
  schedule() { if (this.applying || !this.password) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.sync().catch((e) => { this.status = [402, 403].includes(e.status) ? 'subscription' : e instanceof TypeError ? 'offline' : 'error'; }), 1500); }
  async apply(vault, conflicts) { this.applying = true; try { const current = await this.storage.get(['providers', 'activeProvider', PORTABLE_ACTIVE_PROVIDER_KEY]); const currentProviders = current.providers || {}; const localOnlyIds = nonPortableProviderIds(currentProviders); const portable = portableVault(vault, current[PORTABLE_ACTIVE_PROVIDER_KEY]); const providers = { ...portable.providers }; for (const id of localOnlyIds) if (currentProviders[id]) providers[id] = currentProviders[id]; const preserveLocalActive = localOnlyIds.has(current.activeProvider) && !!currentProviders[current.activeProvider]; const portableActive = portable.activeProvider || DEFAULT_PORTABLE_ACTIVE_PROVIDER; await this.storage.set({ [USER_MEMORY_STORAGE_KEY]: portable.memory, providers, activeProvider: preserveLocalActive ? current.activeProvider : portableActive, visionModel: portable.auxiliaryProviders?.visionModel || null, transcriptionModel: portable.auxiliaryProviders?.transcriptionModel || null, imageGenModel: portable.auxiliaryProviders?.imageGenModel || null, profileEnabled: portable.profile.enabled, profileText: portable.profile.text, [PORTABLE_ACTIVE_PROVIDER_KEY]: portableActive, [PROFILE_SYNC_KEYS.metadata]: { ...portable.meta, tombstones: portable.tombstones }, [PROFILE_SYNC_KEYS.recovery]: conflicts }); } finally { this.applying = false; } }
  sync(options = {}) {
    if (this.syncPromise) { this.syncAgain = true; return this.syncPromise; }
    this.syncAgain = false;
    this.syncPromise = (async () => {
      let result = await this.runSync(options);
      while (this.syncAgain) { this.syncAgain = false; result = await this.runSync(); }
      return result;
    })().finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }
  async runSync({ create = false } = {}) {
    if (!this.password) throw new Error('Cloud Sync is locked'); const password = this.password; const generation = this.sessionGeneration; this.status = 'syncing'; let local = await this.localVault();
    let remote = null; try { const got = await this.request('/vault'); remote = got.body; this.revision = remote.revision; } catch (e) { if (e.status !== 404 || !create) throw e; this.revision = null; this.envelope = null; this.key = null; }
    let runKey = this.key, runEnvelope = this.envelope;
    if (remote?.envelope) { const decrypted = await decryptProfileVault(remote.envelope, password); runKey = decrypted.key; runEnvelope = remote.envelope; await this.changeQueue; local = await this.localVault(); const merged = mergeProfileVaults(local, decrypted.payload); local = merged.vault; if (generation !== this.sessionGeneration || this.password !== password) throw new Error('Cloud Sync was locked'); await this.apply(local, merged.conflicts); }
    if (generation !== this.sessionGeneration || this.password !== password) throw new Error('Cloud Sync was locked');
    const encrypted = await encryptProfileVault(local, password, runEnvelope ? { vaultId: runEnvelope.vaultId, salt: unb64(runEnvelope.kdf.salt), iterations: runEnvelope.kdf.iterations, key: runKey } : {});
    if (generation !== this.sessionGeneration || this.password !== password) throw new Error('Cloud Sync was locked');
    this.key = encrypted.key; this.envelope = encrypted.envelope;
    try { const put = await this.request('/vault', { method: 'PUT', headers: this.revision != null ? { 'If-Match': String(this.revision) } : {}, body: JSON.stringify({ envelope: encrypted.envelope }) }); this.revision = put.body.revision; }
    catch (e) { if (e.status === 409) { this.revision = null; return this.runSync(); } throw e; }
    this.status = 'current'; return this.state();
  }
  async changePassword(oldPassword, nextPassword) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.unlock(oldPassword);
      const generation = this.sessionGeneration;
      const local = await this.localVault();
      const vaultId = this.envelope?.vaultId;
      const encrypted = await encryptProfileVault(local, nextPassword, { vaultId });
      try {
        const put = await this.request('/vault', {
          method: 'PUT',
          headers: { 'If-Match': String(this.revision) },
          body: JSON.stringify({ envelope: encrypted.envelope }),
        });
        if (generation !== this.sessionGeneration) return this.state();
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
    const generation = this.sessionGeneration;
    const local = await this.localVault();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.revision == null) { try { const current = await this.request('/vault'); this.revision = current.body.revision; } catch (error) { if (error.status !== 404) throw error; } }
      const encrypted = await encryptProfileVault(local, password);
      try {
        const put = await this.request('/vault', { method: 'PUT', headers: this.revision != null ? { 'If-Match': String(this.revision) } : {}, body: JSON.stringify({ envelope: encrypted.envelope }) });
        if (generation !== this.sessionGeneration) return this.state();
        this.password = password; this.key = encrypted.key; this.envelope = encrypted.envelope; this.revision = put.body.revision; this.status = 'current'; return this.state();
      } catch (error) { if (error.status !== 409 || attempt === 1) throw error; this.revision = null; }
    }
  }
}
