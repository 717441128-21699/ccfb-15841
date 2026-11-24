/**
 * IndexedDB 持久化：管段档案、采集数据、分析结果、检漏记录
 */
const DB_NAME = 'leak-correlator-db';
const DB_VERSION = 1;

const STORES = {
  segments: 'segments',
  captures: 'captures',
  results: 'results',
  records: 'records',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      const recStore = req.transaction?.objectStore(STORES.records);
      recStore?.createIndex('segmentId', 'segmentId', { unique: false });
      recStore?.createIndex('createdAt', 'createdAt', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function dbPut<T>(store: keyof typeof STORES, value: T): Promise<void> {
  await tx(STORES[store], 'readwrite', (s) => s.put(value as unknown as object));
}

export async function dbGet<T>(store: keyof typeof STORES, id: string): Promise<T | undefined> {
  return tx(STORES[store], 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
}

export async function dbGetAll<T>(store: keyof typeof STORES): Promise<T[]> {
  return tx(STORES[store], 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function dbDelete(store: keyof typeof STORES, id: string): Promise<void> {
  await tx(STORES[store], 'readwrite', (s) => s.delete(id));
}

export async function dbClear(store: keyof typeof STORES): Promise<void> {
  await tx(STORES[store], 'readwrite', (s) => s.clear());
}
