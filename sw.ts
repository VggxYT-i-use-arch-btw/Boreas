/// <reference lib="webworker" />
import { apiFetch } from "./src/api/transport";

// Background Sync worker. The build injects the backend endpoint from the
// same TypeScript config used by the page.
const SYNC_QUEUE_DB = "boreas_sync_queue_db";
const SYNC_QUEUE_DB_VERSION = 2;
const SYNC_META_STORE = "meta";
const ACTIVE_SCOPE_KEY = "activeAccountScope";
const BOREAS_BACKEND_URL = "__BOREAS_BACKEND_URL__";
const BOREAS_BACKEND_ORIGIN = new URL(BOREAS_BACKEND_URL).origin;

interface QueuedRequest {
  accountScope: string;
  path?: string;
  url?: string;
  method: string;
  body?: unknown;
}

interface QueuedItem extends QueuedRequest {
  key: IDBValidKey;
}

interface SyncEventLike extends ExtendableEvent {
  readonly tag: string;
}

interface ScopeMessage {
  type: "boreas-auth-scope";
  accountScope: string | null;
}

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SYNC_QUEUE_DB, SYNC_QUEUE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue");
      if (!db.objectStoreNames.contains(SYNC_META_STORE)) db.createObjectStore(SYNC_META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function setActiveScope(scope: string | null): Promise<void> {
  return openQueueDb().then(db => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(SYNC_META_STORE, "readwrite");
    transaction.objectStore(SYNC_META_STORE).put(scope, ACTIVE_SCOPE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }));
}

async function getServerAccountScope(): Promise<string | null> {
  try {
    const response = await apiFetch(new URL("/session", BOREAS_BACKEND_URL), {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("sessionScope" in value)) return null;
    const scope = String(value.sessionScope ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(scope)) return null;
    await setActiveScope(scope);
    return scope;
  } catch {
    return null;
  }
}

function isQueuedRequest(value: unknown): value is QueuedRequest {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.accountScope === "string" && typeof item.method === "string" &&
    (item.path === undefined || typeof item.path === "string") &&
    (item.url === undefined || typeof item.url === "string");
}

function getAllQueued(db: IDBDatabase): Promise<QueuedItem[]> {
  return new Promise((resolve, reject) => {
    const items: QueuedItem[] = [];
    const request = db.transaction("queue", "readonly").objectStore("queue").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(items); return; }
      if (isQueuedRequest(cursor.value)) items.push({ key: cursor.key, ...cursor.value });
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

function deleteQueued(db: IDBDatabase, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("queue", "readwrite");
    transaction.objectStore("queue").delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function flushQueueInSW(): Promise<void> {
  let db: IDBDatabase;
  let items: QueuedItem[];
  try {
    db = await openQueueDb();
    items = await getAllQueued(db);
  } catch {
    return;
  }
  const activeScope = await getServerAccountScope();
  if (!activeScope) return;
  for (const item of items) {
    try {
      if (item.accountScope !== activeScope) {
        await deleteQueued(db, item.key);
        continue;
      }
      const target = new URL(item.path || item.url || "/", BOREAS_BACKEND_URL);
      if (target.origin !== BOREAS_BACKEND_ORIGIN) {
        await deleteQueued(db, item.key);
        continue;
      }
      const response = await apiFetch(target.href, {
        method: item.method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        mode: "cors",
        body: item.body === undefined ? undefined : JSON.stringify(item.body),
      });
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        await deleteQueued(db, item.key);
      }
    } catch {
      // Keep transient failures queued for the next Background Sync attempt.
    }
  }
}

type ServiceWorkerRuntime = Omit<ServiceWorkerGlobalScope, "addEventListener"> & {
  addEventListener(type: "sync", listener: (event: SyncEventLike) => void): void;
  addEventListener(type: "message", listener: (event: ExtendableMessageEvent) => void): void;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
};

const worker = self as unknown as ServiceWorkerRuntime;

worker.addEventListener("sync", event => {
  if (event.tag === "boreas-flush-queue") event.waitUntil(flushQueueInSW());
});

worker.addEventListener("message", event => {
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || !("type" in data) || !("accountScope" in data)) return;
  const message = data as ScopeMessage;
  if (message.type === "boreas-auth-scope") event.waitUntil(setActiveScope(message.accountScope));
});

worker.addEventListener("install", event => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", event => event.waitUntil(worker.clients.claim()));
