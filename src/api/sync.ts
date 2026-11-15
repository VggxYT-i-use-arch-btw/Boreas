// Boreas: network layer, cache, and sync queue.

export {};

import type { ChatMessage, Conversation, MessagePart, ResumeConversationResponse } from "../types/chat";
import type { MemoryResponse, UsageResponse } from "../types/api";

// Resolve the configured backend endpoint before the sync layer initializes.
const BACKEND_URL = globalThis.BOREAS_BACKEND_URL ?? "";

interface SyncQueueItem {
  key: IDBValidKey;
  path?: string;
  url?: string;
  method?: string;
  body?: unknown;
  accountScope?: string;
  ts: number;
}
type SyncQueueValue = Omit<SyncQueueItem, "key">;

type SyncMessage = ChatMessage;
type SyncMessagePart = MessagePart;
type SyncChat = Partial<Conversation> & { id: string; messages?: SyncMessage[] };

interface ApiData {
  [key: string]: unknown;
}

type ApiResult =
  | { ok: true; data: ApiData; error?: never; status?: number }
  | { ok: false; error: string; status?: number; data?: ApiData };

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  retries?: number;
  silent?: boolean;
  keepalive?: boolean;
  timeoutMs?: number;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isMessageParts(value: unknown): value is SyncMessagePart[] {
  return Array.isArray(value) && value.every((part: unknown) => typeof part === "object" && part !== null);
}

function asSyncChat(value: unknown): SyncChat | null {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") return null;
  return value as SyncChat;
}

function asSyncQueueItem(value: unknown, key: IDBValidKey): SyncQueueItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("path" in value) || typeof value.path !== "string") return null;
  if (!("method" in value) || typeof value.method !== "string") return null;
  if (!("ts" in value) || typeof value.ts !== "number") return null;
  if ("url" in value && typeof value.url !== "string") return null;
  if ("accountScope" in value && typeof value.accountScope !== "string") return null;
  return { ...value, key } as SyncQueueItem;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Keeps the pending write queue in IndexedDB so the tab and the Service
// Worker can resend it once the connection comes back.
const SYNC_QUEUE_DB = "boreas_sync_queue_db";
const SYNC_QUEUE_DB_VERSION = 2;
const SYNC_META_STORE = "meta";
const ACTIVE_SCOPE_KEY = "activeAccountScope";
let _syncQueueDb: IDBDatabase | null = null;
function openSyncQueueDb(): Promise<IDBDatabase> {
  if (_syncQueueDb) return Promise.resolve(_syncQueueDb);
  return new Promise((res, rej) => {
    const req = indexedDB.open(SYNC_QUEUE_DB, SYNC_QUEUE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue");
      if (!db.objectStoreNames.contains(SYNC_META_STORE)) db.createObjectStore(SYNC_META_STORE);
    };
    req.onsuccess = () => { _syncQueueDb = req.result; res(req.result); };
    req.onerror   = () => rej(req.error);
  });
}
async function qdbSetActiveScope(scope: string | null): Promise<void> {
  const db = await openSyncQueueDb();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(SYNC_META_STORE, "readwrite");
    tx.objectStore(SYNC_META_STORE).put(scope || null, ACTIVE_SCOPE_KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function qdbClearQueue(): Promise<void> {
  const db = await openSyncQueueDb();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(["queue", SYNC_META_STORE], "readwrite");
    tx.objectStore("queue").clear();
    tx.objectStore(SYNC_META_STORE).put(null, ACTIVE_SCOPE_KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function qdbPut(key: IDBValidKey, val: SyncQueueValue): Promise<void> {
  const db = await openSyncQueueDb();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function qdbDelete(key: IDBValidKey): Promise<void> {
  const db = await openSyncQueueDb();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function qdbGetAll(): Promise<SyncQueueItem[]> {
  const db = await openSyncQueueDb();
  return new Promise<SyncQueueItem[]>((res, rej) => {
    const tx = db.transaction("queue", "readonly");
    const store = tx.objectStore("queue");
    const items: SyncQueueItem[] = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const value: unknown = cursor.value;
      const item = asSyncQueueItem(value, cursor.key);
      if (item) items.push(item);
      cursor.continue();
    };
    req.onerror = () => rej(req.error);
    tx.oncomplete = () => res(items);
    tx.onabort = () => rej(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

// Asks the browser to wake up the Service Worker (the "sync" event) as
// soon as connectivity returns, even if the app is closed. Without support
// (iOS Safari has no Background Sync), falls back to the normal
// flushQueue() via online/visibilitychange/interval; the IndexedDB queue
// still holds either way, it just won't run in the background in that case.
async function registerBackgroundSync(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.sync) await reg.sync.register("boreas-flush-queue");
  } catch { /* Background Sync unavailable; the fallbacks stay active. */ }
}
if ("serviceWorker" in navigator) {
    const workerUrl = new URL(`${import.meta.env.BASE_URL}sw.js`, document.baseURI);
    navigator.serviceWorker.register(workerUrl.href, { scope: import.meta.env.BASE_URL }).catch(e => console.warn("[SW] registration failed:", e.message));
}

// BoreasSync centralizes authenticated chats, memory, and usage calls.

// Local cache for read fallback.

const BoreasSync = (() => {
  // Identity still lives in an HttpOnly cookie. This flag only avoids
  // obviously unnecessary calls before the server validates the session;
  // it's never treated as a credential.
  function isAuthed()  { return localStorage.getItem("boreas_authenticated") === "true"; }
  function accountScope() {
    const scope = String(localStorage.getItem("boreas_session_scope") || "").trim().toLowerCase();
    return /^[a-f0-9]{32}$/.test(scope) ? scope : "";
  }
  function cacheScope() {
    const scope = String(localStorage.getItem("boreas_session_scope") || "");
    return /^[a-f0-9]{32}$/i.test(scope) ? scope.toLowerCase() : "";
  }
  function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

  // Local cache for read fallback.
  function cacheKey(key: string): string | null {
    const scope = cacheScope();
    return scope ? "boreas_cache_" + encodeURIComponent(scope) + "_" + key : null;
  }
  function cacheSet(key: string, val: unknown): void {
    const scopedKey = cacheKey(key);
    if (!scopedKey) return;
    try { localStorage.setItem(scopedKey, JSON.stringify({ v: val, t: Date.now() })); } catch {}
  }
  function cacheGet(key: string): unknown {
    const scopedKey = cacheKey(key);
    if (!scopedKey) return undefined;
    try {
      const raw = localStorage.getItem(scopedKey);
      if (!raw) return undefined;
      const value: unknown = JSON.parse(raw);
      return typeof value === "object" && value !== null && "v" in value ? value.v : undefined;
    }
    catch { return undefined; }
  }
  // The server never stores the real image, only the "[imagem]" text
  // placeholder (the image itself lives only in local IndexedDB, referenced
  // as "__idb:..."). Restore that reference over the placeholder so a fresh
  // server read never overwrites it.
  function reconcileImagePlaceholders(previous: SyncChat | null | undefined, incoming: SyncChat | null | undefined): SyncChat | null | undefined {
    if (!previous || !incoming) return incoming;
    const prevMsgs = isUnknownArray(previous.messages) ? previous.messages as SyncMessage[] : [];
    const nextMsgs = isUnknownArray(incoming.messages) ? incoming.messages as SyncMessage[] : [];
    const merged = nextMsgs.map((m, i) => {
      const prevM = prevMsgs[i];
      if (!prevM || !isMessageParts(m.content) || !isMessageParts(prevM.content)) return m;
      let changed = false;
      const content = m.content.map((part, j) => {
        const prevPart = (prevM.content as SyncMessagePart[])[j];
        const isPlaceholder = part?.type === "text" && part.text === "[imagem]";
      const prevUrl = prevPart?.type === "image_url" ? prevPart.image_url.url : "";
      const prevIsImage = prevUrl.startsWith("__idb:") || prevUrl.startsWith("data:");
        if (isPlaceholder && prevIsImage) { changed = true; return prevPart; }
        return part;
      });
      return changed ? { ...m, content } : m;
    });
    return { ...incoming, messages: merged };
  }
  function cacheDel(key: string): void {
    const scopedKey = cacheKey(key);
    if (!scopedKey) return;
    try { localStorage.removeItem(scopedKey); } catch {}
  }

  async function setAuthScope(scope: string | null): Promise<void> {
    const normalized = String(scope ?? "").trim().toLowerCase();
    try { await qdbSetActiveScope(normalized || null); } catch (error: unknown) { console.warn("[BoreasSync] escopo não persistido:", errorMessage(error)); }
    try {
      const registration = await navigator.serviceWorker?.ready;
      registration?.active?.postMessage({ type: "boreas-auth-scope", accountScope: normalized || null });
    } catch {}
  }

  async function clearSyncQueue(): Promise<void> {
    try { await qdbClearQueue(); } catch (error: unknown) { console.warn("[BoreasSync] fila não limpa:", errorMessage(error)); }
    try {
      const registration = await navigator.serviceWorker?.ready;
      registration?.active?.postMessage({ type: "boreas-auth-scope", accountScope: null });
    } catch {}
  }

  function clearScopedCache(scope: string | null = localStorage.getItem("boreas_session_scope")): void {
    const normalized = String(scope ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/i.test(normalized)) return;
    const prefix = "boreas_cache_" + normalized + "_";
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  }

  function clearAllScopedCaches(): void {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith("boreas_cache_")) localStorage.removeItem(key);
    }
  }

  function clearPendingGenerations(): void {
    localStorage.removeItem("boreas_pending_gen");
  }

  globalThis.BoreasSetAuthScope = setAuthScope;
  globalThis.BoreasClearSyncQueue = clearSyncQueue;
  globalThis.BoreasClearScopedCache = clearScopedCache;
  globalThis.BoreasClearAllScopedCaches = clearAllScopedCaches;
  globalThis.BoreasClearPendingGenerations = clearPendingGenerations;
  globalThis.BoreasSessionHeaders = function (extra: Record<string, string> = {}) {
    return { ...extra };
  };
  globalThis.BoreasFetchWithTimeout = async function (input: RequestInfo | URL, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await globalThis.BoreasApi.rawFetch(input, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };

  async function serverAccountScope(): Promise<string | null> {
    try {
      const response = await globalThis.BoreasApi.rawFetch(BACKEND_URL + "/session", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      const data = typeof payload === "object" && payload !== null
        ? payload as { sessionScope?: unknown }
        : {};
      const scope = String(data?.sessionScope ?? "").trim().toLowerCase();
      return /^[a-f0-9]{32}$/.test(scope) ? scope : null;
    } catch {
      return null;
    }
  }

  // Retry queue for failed writes, now in IndexedDB (see qdb* above), so it
  // survives long enough for the Service Worker to read it.
  const MAX_QUEUE = 200;
  const MAX_QUEUE_BYTES = 50 * 1024 * 1024; // cap by total size on top of the count; an item with a base64 image weighs MBs
  async function queueWrite(path: string, method: string, body?: unknown): Promise<void> {
    // A key built from just "method + path" collided whenever the same
    // endpoint was called more than once offline (e.g. 3 new chats = 3x
    // "POST /chats", same key); the next qdbPut overwrote the previous
    // one, so only the last one survived to sync. A timestamp+random
    // suffix guarantees one key per call.
    const key = method + " " + path + " " + Date.now() + "_" + Math.random().toString(36).slice(2);
    try {
      await qdbPut(key, {
        path,
        url: new URL(path, BACKEND_URL).href,
        method,
        body,
        accountScope: accountScope(),
        ts: Date.now(),
      });
      // Caps the write queue's size in IndexedDB to avoid excessive local storage growth.
      const all = await qdbGetAll();
      let over = all.length > MAX_QUEUE;
      if (!over) {
        const totalBytes = all.reduce((s, item) => s + (item.body ? JSON.stringify(item.body).length : 0), 0);
        over = totalBytes > MAX_QUEUE_BYTES;
      }
      if (over) {
        const sorted = all.sort((a, b) => a.ts - b.ts);
        const toDrop = sorted.slice(0, sorted.length - MAX_QUEUE);
        for (const item of toDrop) await qdbDelete(item.key);
      }
    } catch (e: unknown) { console.error("[queueWrite]", e); }
    registerBackgroundSync();
  }
  async function flushQueue() {
    if (!isAuthed()) return;
    let q: SyncQueueItem[];
    try { q = await qdbGetAll(); } catch { return; }
    if (!q.length) return;
    // The email returned by the server is the source of truth. localStorage
    // may be stale in another tab; never use that flag to decide which
    // session an offline item should be resent under.
    const currentScope = await serverAccountScope();
    if (!currentScope) return;
    const backendOrigin = new URL(BACKEND_URL || location.origin, location.origin).origin;
    for (const item of q) {
      // Never resends a write created under a different account. The queue
      // is shared by the browser, so the current session alone isn't proof of identity.
      if (item.accountScope !== currentScope) {
        try { await qdbDelete(item.key); } catch {}
        continue;
      }
      // The full URL stored in the queue may point at an old Quick Tunnel.
      // Never send the body to that hostname; it may have been shut down
      // or even reassigned. Rebuild the destination from the path and only
      // accept the origin currently serving the app.
      let target;
      try { target = new URL(item.path || item.url || "/", BACKEND_URL || location.origin); } catch { target = null; }
      if (!target || target.origin !== backendOrigin) {
        try { await qdbDelete(item.key); } catch {}
        continue;
      }
      const res = await request(target.pathname + target.search, {
        method: item.method,
        body: item.body,
        retries: 0,
        silent: true,
      });
      if (res.ok) { try { await qdbDelete(item.key); } catch {} }
    }
  }
  window.addEventListener("online", flushQueue);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) flushQueue(); });
  setInterval(flushQueue, 60_000);

  if (localStorage.getItem("boreas_authenticated") === "true") {
    setAuthScope(accountScope()).catch(() => {});
  }

  // Shared request helper for authenticated calls.
  async function request(path: string, {
    method = "GET", body, headers: extraHeaders = {}, retries = 2, silent = false, keepalive = false, timeoutMs = 8000,
  }: RequestOptions = {}): Promise<ApiResult> {
    if (!isAuthed()) return { ok: false, error: "no-session" };
    const requestScope = accountScope();
    const headers = { ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const useKeepalive = keepalive && (!bodyStr || bodyStr.length < 60_000); // keepalive has a body-size ceiling
    let target;
    try {
      target = new URL(path, BACKEND_URL || location.origin);
    } catch {
      return { ok: false, error: "invalid-target" };
    }
    const backendOrigin = new URL(BACKEND_URL || location.origin, location.origin).origin;
    // This helper is used by authenticated code.  Never allow a caller,
    // stale queue item, or compromised extension to turn it into a credential
    // forwarding primitive for another origin.
    if (target.origin !== backendOrigin) return { ok: false, error: "invalid-target" };
    const targetUrl = target.href;
    let lastErr = "network";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (requestScope !== accountScope()) return { ok: false, error: "session-changed" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await globalThis.BoreasApi.rawFetch(targetUrl, {
          method,
          headers,
          body: bodyStr,
          signal: controller.signal,
          credentials: "include",
          ...(useKeepalive ? { keepalive: true } : {}),
        });
        clearTimeout(timer);
        if (requestScope !== accountScope()) return { ok: false, error: "session-changed" };
        if (r.status === 401) {
          if (!silent) document.dispatchEvent(new CustomEvent("boreas:session-expired"));
          return { ok: false, error: "unauthorized", status: 401 };
        }
        if (!r.ok) {
          lastErr = `http-${r.status}`;
          if (r.status >= 500 && attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
          return { ok: false, error: lastErr, status: r.status };
        }
        const payload: unknown = await r.json().catch(() => ({}));
        const data: ApiData = typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? payload as ApiData
          : {};
        if (requestScope !== accountScope()) return { ok: false, error: "session-changed" };
        return { ok: true, data };
      } catch (e: unknown) {
        clearTimeout(timer);
        lastErr = e instanceof Error && e.name === "AbortError" ? "timeout" : "network";
        if (attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
      }
    }
    return { ok: false, error: lastErr };
  }

  const chats = {
    async listPage(offset: number = 0, limit: number = 50) {
      const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
      const safeLimit = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 50)));
      const res = await request(`/chats?limit=${safeLimit}&offset=${safeOffset}`, { retries: 1, timeoutMs: 4000 });
      if (res.ok) {
        const chats = isUnknownArray(res.data.chats) ? res.data.chats : [];
        if (safeOffset === 0) cacheSet("chats_index", chats);
        return {
          chats,
          hasMore: res.data.hasMore === true,
          nextOffset: typeof res.data.nextOffset === "number" && Number.isInteger(res.data.nextOffset) ? res.data.nextOffset : safeOffset + chats.length,
        };
      }
      if (res.error === "unauthorized") return { chats: [], hasMore: false, nextOffset: safeOffset };
      const cached = safeOffset === 0 ? cacheGet("chats_index") : null;
      const cachedChats = isUnknownArray(cached) ? cached : [];
      return { chats: cachedChats, hasMore: false, nextOffset: safeOffset + cachedChats.length };
    },
    // Returns metadata index, falling back to cache on failure.
    async list() {
      return (await this.listPage(0, 50)).chats;
    },
    async get(id: string) {
      const res = await request("/chats/" + encodeURIComponent(id), { retries: 1, timeoutMs: 4000 });
      if (res.ok) {
        const merged = reconcileImagePlaceholders(asSyncChat(cacheGet("chat_" + id)), asSyncChat(res.data.chat));
        cacheSet("chat_" + id, merged);
        return merged;
      }
      if (res.error === "unauthorized") return null;
      return cacheGet("chat_" + id) ?? null;
    },
    // Lets an already-visited conversation paint immediately without
    // waiting for the network. loadChat calls revalidate explicitly right after the first paint.
    peek(id: string) { return asSyncChat(cacheGet("chat_" + id)); },
    async revalidate(id: string, baseline: SyncChat | null = null) {
      const res = await request("/chats/" + encodeURIComponent(id), { retries: 1, timeoutMs: 4000 });
      if (!res.ok) return { chat: null, changed: false };
      const previous = baseline ?? asSyncChat(cacheGet("chat_" + id));
      const fresh = reconcileImagePlaceholders(previous, asSyncChat(res.data.chat));
      const changed = JSON.stringify(fresh ?? {}) !== JSON.stringify(previous ?? {});
      cacheSet("chat_" + id, fresh);
      return { chat: fresh, changed };
    },
    async search(query: string): Promise<unknown[]> {
      const q = String(query ?? "").trim();
      if (q.length < 2) return [];
      const res = await request("/chats/search?q=" + encodeURIComponent(q), { retries: 1, timeoutMs: 8000 });
      return res.ok && isUnknownArray(res.data.matches) ? res.data.matches : [];
    },
    // Retries upserts and queues them on failure.

    async save(chat: SyncChat, { keepalive = false, localMessages = null }: { keepalive?: boolean; localMessages?: SyncMessage[] | null } = {}) {
      const res = await request("/chats", { method: "POST", body: chat, keepalive, ...(keepalive ? { retries: 0 } : {}) });
      if (!res.ok && !["unauthorized", "session-changed"].includes(res.error)) queueWrite("/chats", "POST", chat);
      if (res.ok || res.error !== "unauthorized") {
        const key = "chat_" + chat.id;
        const previous = asSyncChat(cacheGet(key));
        // A late response from an older tab must not overwrite a newer
        // server snapshot. Equal timestamps are merged only for fields that
        // are absent in the incoming response.
        // localMessages, when provided, keeps the "__idb:" image references
        // for the local cache; chat.messages is the anonymized payload
        // ("[imagem]") that was actually sent to the server.
        const cachedChat = localMessages ? { ...chat, messages: localMessages } : chat;
        if (!previous?.updatedAt || !chat.updatedAt || String(chat.updatedAt) >= String(previous.updatedAt)) {
          cacheSet(key, { ...previous, ...cachedChat });
        }
      }
      return res;
    },
    async remove(id: string) {
      const path = "/chats/" + encodeURIComponent(id);
      const res = await request(path, { method: "DELETE" });
      if (!res.ok && !["unauthorized", "session-changed"].includes(res.error)) queueWrite(path, "DELETE");
      cacheDel("chat_" + id);
      return res;
    },
    // Updates only the chat's title on the server, without touching the saved history.
    async renameTitle(id: string, title: string) {
      const path = "/chats/" + encodeURIComponent(id) + "/title";
      const res = await request(path, { method: "PATCH", body: { title } });
      if (!res.ok && !["unauthorized", "session-changed"].includes(res.error)) queueWrite(path, "PATCH", { title });
      const cached = cacheGet("chat_" + id);
      if (cached && res.error !== "unauthorized") cacheSet("chat_" + id, { ...cached, title });
      return res;
    },
    // Never queued for retry; on failure, the user decides whether to try
    // again (this is an explicit action, not a silent autosave).
    async resume(id: string) {
      const result = await request("/chats/" + encodeURIComponent(id) + "/resume", { method: "POST", retries: 0, silent: true, timeoutMs: 45000 });
      return result.ok
        ? { ...result, data: result.data as ResumeConversationResponse }
        : result;
    },
  };

  const memory = {
    async get(): Promise<MemoryResponse> {
      const res = await request("/memory");
      if (res.ok) { cacheSet("memory", res.data); return res.data; }
      if (res.error === "unauthorized") return { memory: "", lastUpdate: 0, enabled: true };
      const cached = cacheGet("memory");
      return cached !== null && typeof cached === "object" && !Array.isArray(cached)
        ? cached as MemoryResponse
        : { memory: "", lastUpdate: 0, enabled: true };
    },
    async set(memoryText: string | undefined, enabled: boolean | undefined) {
      const body: Record<string, unknown> = {};
      if (memoryText !== undefined) body.memory = memoryText;
      if (enabled   !== undefined) body.enabled = enabled;
      const res = await request("/memory", { method: "PUT", body });
      if (!res.ok && !["unauthorized", "session-changed"].includes(res.error)) queueWrite("/memory", "PUT", body);
      return res;
    },
  };

  const usage = {
    async get(): Promise<UsageResponse | null> {
      const res = await request("/usage");
      if (res.ok) { cacheSet("usage", res.data); return res.data; }
      if (res.error === "unauthorized") return null;
      const cached = cacheGet("usage");
      return cached !== null && typeof cached === "object" && !Array.isArray(cached)
        ? cached as UsageResponse
        : null;
    },
  };

  let sessionExpiryHandled = false;
  document.addEventListener("boreas:session-expired", () => {
    if (sessionExpiryHandled) return;
    sessionExpiryHandled = true;
    console.warn("[BoreasSync] Sessão inválida/expirada - retornando ao login.");
    localStorage.removeItem("boreas_authenticated");
    localStorage.removeItem("boreas_onboarded");
    localStorage.removeItem("boreas_session_scope");
    clearPendingGenerations();
    clearSyncQueue().catch(() => {});
    clearAllScopedCaches();
    setAuthScope("").catch(() => {});
    setTimeout(() => location.reload(), 0);
  });

  return { request, chats, memory, usage, isAuthed, flushQueue, clearSyncQueue, setAuthScope };
})();

export type BoreasSyncApi = typeof BoreasSync;
export { BACKEND_URL, BoreasSync };
