// Keep inline assets outside the bounded run journal and serialized chat HTML.
const DB_NAME = 'webbrain_generated_media';
const STORE_NAME = 'assets';
const MAX_BYTES = 20 * 1024 * 1024;
// A video joined from its scenes' clips: up to two minutes of generated video.
export const MAX_JOINED_VIDEO_BYTES = 160 * 1024 * 1024;
const MEDIA_MIME = /^(image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg)|video\/mp4)$/;

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storeGeneratedMedia(dataUrl) {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  if (!match || !MEDIA_MIME.test(match[1]) || match[2].length > MAX_BYTES * 1.4) throw new Error('Unsupported generated media.');
  const binary = atob(match[2]);
  if (binary.length > MAX_BYTES) throw new Error('Generated media exceeds the 20 MB inline limit.');
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return storeGeneratedMediaBlob(new Blob([bytes], { type: match[1] }));
}

// `maxBytes` above 20 MB is for videos: one joined from clips, or a clip of one.
export async function storeGeneratedMediaBlob(blob, { maxBytes = MAX_BYTES } = {}) {
  if (!(blob instanceof Blob) || !MEDIA_MIME.test(blob.type)) throw new Error('Unsupported generated media.');
  const limit = Math.min(maxBytes, blob.type === 'video/mp4' ? MAX_JOINED_VIDEO_BYTES : MAX_BYTES);
  if (blob.size > limit) throw new Error(`Generated media exceeds the ${Math.round(limit / 1024 / 1024)} MB inline limit.`);
  const id = crypto.randomUUID();
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ id, blob });
      // Wait for commit before publishing a handle to other extension contexts.
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Generated media could not be saved.'));
    });
  } finally { db.close(); }
  return { mediaId: id, mimeType: blob.type, inlineMedia: true };
}

export async function loadGeneratedMedia(id) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id || '')) return null;
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        const blob = request.result?.blob;
        const limit = blob?.type === 'video/mp4' ? MAX_JOINED_VIDEO_BYTES : MAX_BYTES;
        resolve(blob instanceof Blob && MEDIA_MIME.test(blob.type) && blob.size <= limit ? blob : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

// The finished clips of videos that failed part-way, kept for a retry: each
// is paid for, and a retry asks the model for the same clip again. They have
// a database of their own because Chrome stops an idle background worker
// soon after a run ends, and the user may ask for the retry later. A clip is
// named by what was asked of the model (`key`) and handed out once, oldest
// first; together the kept clips weigh at most what one video may.
export const KEPT_VIDEO_CLIP_MS = 30 * 60 * 1000;
const CLIP_DB_NAME = 'webbrain_kept_video_clips';
const CLIP_STORE_NAME = 'clips';

function openClipDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CLIP_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(CLIP_STORE_NAME, { keyPath: 'id', autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// One read-write transaction over the kept clips: those older than
// KEPT_VIDEO_CLIP_MS are deleted, then `change(store, fresh, now)` sees the
// others, oldest first. Its result is returned once the transaction commits.
async function changeKeptClips(change) {
  const db = await openClipDB();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(CLIP_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(CLIP_STORE_NAME);
      let result;
      const read = store.getAll();
      read.onsuccess = () => {
        const now = Date.now();
        const fresh = [];
        for (const record of read.result) {
          if (now - record.at <= KEPT_VIDEO_CLIP_MS && record.blob instanceof Blob) fresh.push(record);
          else store.delete(record.id);
        }
        try { result = change(store, fresh, now); }
        catch (error) { reject(error); transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Kept video clips could not be saved.'));
    });
  } finally { db.close(); }
}

/** Keeps clips ({ key, bytes }) for a retry. False when they could not be kept. */
export async function keepVideoClips(clips) {
  try {
    await changeKeptClips((store, fresh, now) => {
      const all = [...fresh.map(record => ({ record, size: record.blob.size })), ...clips.map(clip => ({ clip, size: clip.bytes.length }))];
      let total = all.reduce((sum, item) => sum + item.size, 0);
      while (all.length && total > MAX_JOINED_VIDEO_BYTES) {
        const { record, size } = all.shift();
        total -= size;
        if (record) store.delete(record.id);
      }
      for (const { clip } of all) if (clip) store.add({ key: clip.key, at: now, blob: new Blob([clip.bytes], { type: 'video/mp4' }) });
    });
    return true;
  } catch { return false; }
}

/** The bytes of the oldest clip kept under `key`, handed out once; null when none is. */
export async function takeVideoClip(key) {
  try {
    const record = await changeKeptClips((store, fresh) => {
      const found = fresh.find(item => item.key === key);
      if (found) store.delete(found.id);
      return found;
    });
    // A Blob read from the database stays readable after its record is deleted.
    return record ? new Uint8Array(await record.blob.arrayBuffer()) : null;
  } catch { return null; }
}

/** Forgets the clips kept for a retry. */
export async function forgetVideoClips() {
  await changeKeptClips(store => { store.clear(); });
}
