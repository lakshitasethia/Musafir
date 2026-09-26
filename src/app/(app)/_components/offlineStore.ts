"use client";

/**
 * Tiny IndexedDB mirror of trip bundles for offline use (Taxi Rescue card,
 * trip page without signal). Per-device only; cleared on logout because
 * phones are shared. Every call is best-effort: storage can be unavailable
 * (private mode, quota), and the app must work without it.
 */
const DB_NAME = "musafir";
const STORE = "bundles";

export interface SavedBundle<T = unknown> {
  tripId: string;
  savedAt: string;
  bundle: T;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "tripId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export const saveBundle = (tripId: string, bundle: unknown) =>
  run("readwrite", (s) => s.put({ tripId, savedAt: new Date().toISOString(), bundle } satisfies SavedBundle));

export const loadBundle = <T>(tripId: string) => run<SavedBundle<T>>("readonly", (s) => s.get(tripId));

export async function clearOfflineData() {
  await run("readwrite", (s) => s.clear());
  try {
    if (typeof caches !== "undefined") for (const k of await caches.keys()) if (k.startsWith("musafir")) await caches.delete(k);
  } catch {
    /* best effort */
  }
}
