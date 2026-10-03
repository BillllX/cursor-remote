/** 会话正文的浏览器缓存（IndexedDB）。只存正文和它对应的服务端 chatRev，列表永远以网关为准。 */

const DB_NAME = "jiebo-chat-cache";
const STORE = "bodies";
const MAX_ENTRIES = 60;

export type CachedBody<T> = { rev: number; turns: T[]; at: number };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<R>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<R> | void,
): Promise<R | undefined> {
  return openDb().then(
    (db) =>
      new Promise<R | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const tx = db.transaction(STORE, mode);
          const req = body(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

const keyOf = (tenant: string, chatId: string) => `${tenant}:${chatId}`;

export async function readBody<T>(tenant: string, chatId: string): Promise<CachedBody<T> | null> {
  if (!tenant || !chatId) return null;
  const value = await run<CachedBody<T>>("readonly", (store) => store.get(keyOf(tenant, chatId)));
  if (!value || typeof value.rev !== "number" || !Array.isArray(value.turns)) return null;
  return value;
}

export async function writeBody<T>(tenant: string, chatId: string, rev: number, turns: T[]): Promise<void> {
  if (!tenant || !chatId) return;
  const value: CachedBody<T> = { rev, turns, at: Date.now() };
  await run("readwrite", (store) => store.put(value, keyOf(tenant, chatId)));
  await prune();
}

export async function dropBody(tenant: string, chatId: string): Promise<void> {
  if (!tenant || !chatId) return;
  await run("readwrite", (store) => store.delete(keyOf(tenant, chatId)));
}

export async function clearBodies(): Promise<void> {
  await run("readwrite", (store) => store.clear());
}

async function prune(): Promise<void> {
  const keys = await run<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
  if (!keys || keys.length <= MAX_ENTRIES) return;
  const rows = await run<CachedBody<unknown>[]>("readonly", (store) => store.getAll());
  if (!rows || rows.length !== keys.length) return;
  const doomed = keys
    .map((key, index) => ({ key, at: rows[index]?.at ?? 0 }))
    .sort((a, b) => a.at - b.at)
    .slice(0, keys.length - MAX_ENTRIES);
  await run("readwrite", (store) => {
    for (const item of doomed) store.delete(item.key);
  });
}
