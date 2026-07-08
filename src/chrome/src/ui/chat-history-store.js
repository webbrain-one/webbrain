const DB_NAME = 'webbrain_chat_history';
const DB_VERSION = 1;
const STORE_NAME = 'records';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('conversationId', 'conversationId');
        store.createIndex('url', 'url');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode = 'readonly') {
  return db.transaction([STORE_NAME], mode);
}

function promisifyReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalizeText(value, max = 20000) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function normalizeMessage(message, index) {
  return {
    role: ['user', 'assistant', 'system', 'error'].includes(message?.role) ? message.role : 'unknown',
    text: normalizeText(message?.text),
    index: Number.isFinite(Number(message?.index)) ? Number(message.index) : index,
    createdAt: Number.isFinite(Number(message?.createdAt)) ? Number(message.createdAt) : null,
  };
}

function firstText(messages, role) {
  return messages.find((message) => message.role === role && message.text)?.text || '';
}

function lastText(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === role && message.text) return message.text;
  }
  return '';
}

function buildTitle(record, messages) {
  const fromUser = firstText(messages, 'user');
  if (fromUser) return fromUser.replace(/\s+/g, ' ').slice(0, 140);
  if (record.tabTitle) return String(record.tabTitle).slice(0, 140);
  if (record.url) {
    try {
      const u = new URL(record.url);
      return u.hostname || record.url;
    } catch {
      return String(record.url).slice(0, 140);
    }
  }
  return 'Untitled conversation';
}

function normalizeRecord(input, existing = null) {
  const now = Date.now();
  const messages = (Array.isArray(input?.messages) ? input.messages : [])
    .map(normalizeMessage)
    .filter((message) => message.text);
  const userMessageCount = messages.filter((message) => message.role === 'user').length;
  const assistantMessageCount = messages.filter((message) => message.role === 'assistant').length;
  const record = {
    ...(existing || {}),
    id: String(input?.id || existing?.id || ''),
    conversationId: input?.conversationId ? String(input.conversationId) : existing?.conversationId || null,
    tabId: Number.isFinite(Number(input?.tabId)) ? Number(input.tabId) : existing?.tabId ?? null,
    url: String(input?.url || existing?.url || ''),
    tabTitle: String(input?.tabTitle || existing?.tabTitle || ''),
    mode: String(input?.mode || existing?.mode || ''),
    providerId: String(input?.providerId || existing?.providerId || ''),
    providerLabel: String(input?.providerLabel || existing?.providerLabel || ''),
    createdAt: Number.isFinite(Number(existing?.createdAt))
      ? Number(existing.createdAt)
      : Number.isFinite(Number(input?.createdAt))
        ? Number(input.createdAt)
        : now,
    updatedAt: Number.isFinite(Number(input?.updatedAt)) ? Number(input.updatedAt) : now,
    messages,
    messageCount: messages.length,
    userMessageCount,
    assistantMessageCount,
    firstUserMessage: firstText(messages, 'user'),
    lastUserMessage: lastText(messages, 'user'),
    lastAssistantMessage: lastText(messages, 'assistant'),
  };
  record.title = buildTitle(record, messages);
  return record;
}

export async function saveChatHistoryRecord(input) {
  if (!input?.id) return null;
  const db = await openDB();
  const existing = await promisifyReq(tx(db).objectStore(STORE_NAME).get(String(input.id))).catch(() => null);
  const record = normalizeRecord(input, existing);
  if (!record.id || record.userMessageCount < 1) return null;
  await promisifyReq(tx(db, 'readwrite').objectStore(STORE_NAME).put(record));
  return record;
}

export async function listChatHistoryRecords({ limit = 500 } = {}) {
  const db = await openDB();
  const index = tx(db).objectStore(STORE_NAME).index('updatedAt');
  const out = [];
  await new Promise((resolve) => {
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve();
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => resolve();
  });
  return out;
}

export async function getChatHistoryRecord(id) {
  if (!id) return null;
  const db = await openDB();
  return promisifyReq(tx(db).objectStore(STORE_NAME).get(String(id)));
}

export async function deleteChatHistoryRecord(id) {
  if (!id) return;
  const db = await openDB();
  await promisifyReq(tx(db, 'readwrite').objectStore(STORE_NAME).delete(String(id)));
}

export async function clearChatHistoryRecords() {
  const db = await openDB();
  await promisifyReq(tx(db, 'readwrite').objectStore(STORE_NAME).clear());
}
