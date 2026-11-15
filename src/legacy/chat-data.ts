// Boreas: local/remote conversation state and CRUD.

import type { ChatMessage, Conversation, MessagePart, PendingFile } from "../types/chat";

type TierKey = "altra1" | "solstice1" | "sunset2" | "horizon2";
type Effort = "intelligent" | "low" | "medium" | "high" | "xhigh" | "max" | "default";
type NonDefaultEffort = Exclude<Effort, "default">;
declare const title: string;
declare var BoreasSessionContextStale: boolean;
declare var BoreasLoadMoreChats: () => Promise<void>;
declare var BoreasChatsHasMore: () => boolean;
declare var currentAbortController: AbortController | null;
const TIERS: Record<TierKey, { label: string }> = {
  altra1:  { label: "Boreas Altra I" },
  solstice1:  { label: "Boreas Solstice I" },
  sunset2:    { label: "Boreas Sunset II" },
  horizon2: { label: "Boreas Horizon II" },
};

const TIER_SPEEDS: Record<string, string> = { altra1: "cheapest", solstice1: "cheapest", sunset2: "cheapest", horizon2: "fastest" };
let ACCOUNT_SCOPE = "";
let LAST_TIER_KEY = "";

// Altra (coding, text-only) keeps vision disabled in the UI. Keep in sync
// with NO_VISION_TIERS in
// back-end/sub_boreas/config/runtime.js.
const NO_VISION_TIERS = ["altra1"];
const NO_VISION_LABEL = { altra1: "Altra I" };

// Effort levels each tier actually accepts, ordered weakest -> strongest,
// plus the level used when nothing valid is stored yet. Mirrors
// TIER_EFFORTS in back-end/sub_boreas/config/runtime.js - keep both in sync.
const TIER_EFFORTS: Record<string, { levels: Exclude<Effort, "intelligent" | "default">[]; default: Exclude<Effort, "intelligent" | "default"> }> = {
  altra1:     { levels: ["low", "high", "max"],             default: "high" },
  solstice1:  { levels: ["low", "high", "max"],             default: "high" },
  sunset2:    { levels: ["low", "medium", "xhigh"],         default: "xhigh" },
  horizon2:   { levels: ["low", "medium", "high", "xhigh"], default: "high" },
};
// All remaining tiers expose the effort control.
const EFFORT_TIERS = Object.keys(TIER_EFFORTS);
// Label/description shown per level, not per tier - a given level name
// (e.g. "high") reads the same regardless of which tier's ceiling it is.
const EFFORT_LABELS: Record<Exclude<Effort, "default">, string> = { intelligent: "Inteligente", low: "Baixo", medium: "Médio", high: "Alto", xhigh: "Máximo", max: "Máximo" };
const EFFORT_DESCRIPTIONS: Record<Exclude<Effort, "default">, string> = {
  intelligent: "O classificador escolhe o esforço adequado para esta mensagem",
  low: "Para tarefas simples e rápidas",
  medium: "Para tarefas que exigem um pouco mais de pensamento",
  high: "Para trabalhos complexos e difíceis",
  xhigh: "Para os problemas mais difíceis, sem economizar raciocínio",
  max: "Para os problemas mais difíceis, sem economizar raciocínio",
};

let currentTier: TierKey = "solstice1";
let currentSpeed = TIER_SPEEDS[currentTier];

// Stores the last effort used per tier.

function lastEffortFor(tier: string): Effort {
  if (!Object.hasOwn(TIER_EFFORTS, tier)) return "default";
  const cfg = TIER_EFFORTS[tier as TierKey];
  if (!cfg) return "default";
  const v = localStorage.getItem((ACCOUNT_SCOPE ? "boreas_last_effort_" + ACCOUNT_SCOPE + "_" : "boreas_last_effort_unauthed_") + tier);
  return v === "intelligent" || (v !== null && cfg.levels.includes(v as Exclude<Effort, "intelligent" | "default">)) ? v as Effort : cfg.default;
}
let currentEffort = "default";

// Renders the effort options for the active tier (they differ per tier -
// see TIER_EFFORTS) and syncs the pill/section to the current selection.

function syncEffortUI(): void {
  const section = document.getElementById("effort-section");
  if (!section) return;
  const cfg = TIER_EFFORTS[currentTier as TierKey];
  const supports = !!cfg;
  section.classList.toggle("show", supports);
  if (!supports) section.classList.remove("open");
  const valueEl = document.getElementById("effort-pill-btn-value");
  if (valueEl) valueEl.textContent = EFFORT_LABELS[currentEffort as NonDefaultEffort] ?? "Padrão";
  const inner = document.getElementById("effort-list-inner");
  if (!inner) return;
  if (!supports) { inner.innerHTML = ""; return; }
  inner.innerHTML = ["intelligent", ...cfg.levels].map(level => `
    <div class="effort-option${level === currentEffort ? " active" : ""}" data-effort="${level}">
      <svg class="effort-option-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      <div class="effort-option-info">
        <div class="effort-option-name">${EFFORT_LABELS[level as NonDefaultEffort] ?? level}</div>
        <div class="effort-option-desc">${EFFORT_DESCRIPTIONS[level as NonDefaultEffort] ?? ""}</div>
      </div>
    </div>
  `).join("");
}
let messages: ChatMessage[] = [];
let loading      = false;
let pendingImages: string[] = [];
let pendingFile: PendingFile | null = null;
let chatLoadGeneration = 0;

let memoryEnabledGlobal = localStorage.getItem("boreas_memory_global") !== "false";
let chatMemoryEnabled   = true;
let chatHasMessages     = false;

let ACTIVE_KEY = "";

function refreshAccountScopedState() {
  const storedScope = String(localStorage.getItem("boreas_session_scope") || "");
  ACCOUNT_SCOPE = /^[a-f0-9]{32}$/i.test(storedScope) ? storedScope.toLowerCase() : "";
  LAST_TIER_KEY = ACCOUNT_SCOPE ? "boreas_last_tier_" + ACCOUNT_SCOPE : "boreas_last_tier_unauthed";
  ACTIVE_KEY = "boreas_active_chat_v2_" + (ACCOUNT_SCOPE || "unauthed");
  const savedTier = localStorage.getItem(LAST_TIER_KEY);
  currentTier = savedTier && Object.hasOwn(TIER_SPEEDS, savedTier) ? savedTier as TierKey : "solstice1";
  currentSpeed = TIER_SPEEDS[currentTier];
  currentEffort = EFFORT_TIERS.includes(currentTier) ? lastEffortFor(currentTier) : "default";
  syncEffortUI();
}

globalThis.BoreasRefreshAccountScopedState = refreshAccountScopedState;
refreshAccountScopedState();
BoreasSessionContextStale = false;

// localStorage and the HttpOnly cookie are shared by every tab of this
// origin. If another tab logs in or out, this tab must not keep rendering or
// submitting its old in-memory conversation under the new cookie.
window.addEventListener("storage", event => {
  if (!event.key || !["boreas_session_scope", "boreas_authenticated", "boreas_onboarded"].includes(event.key)) return;
    const nextScope = String(localStorage.getItem("boreas_session_scope") || "").trim().toLowerCase();
  const authenticated = localStorage.getItem("boreas_authenticated") === "true";
  if (nextScope === ACCOUNT_SCOPE && (authenticated || !nextScope)) return;
  BoreasSessionContextStale = true;
  try { currentAbortController?.abort(); } catch {}
  try { localStorage.removeItem("boreas_pending_gen"); } catch {}
  location.reload();
});

function imageStorageScope() {
  const scope = String(localStorage.getItem("boreas_session_scope") || "");
  return /^[a-f0-9]{32}$/i.test(scope) ? scope.toLowerCase() : "unauthed";
}
function imageStoragePrefix(chatId: string): string {
  return `${imageStorageScope()}:${chatId}:`;
}

const CHAT_ID_RE = /^(?!__proto__$|prototype$|constructor$)[A-Za-z0-9_-]{1,80}$/i;
function isSafeChatId(id: unknown): id is string { return typeof id === "string" && CHAT_ID_RE.test(id); }
function isTierKey(tier: string | undefined): tier is TierKey { return !!tier && Object.hasOwn(TIERS, tier); }

type ChatMeta = { id: string; title?: string; messages?: ChatMessage[]; tier?: string; speed?: string; effort?: string; createdAt?: string; updatedAt?: string; hasMessages?: boolean; memoryEnabled?: boolean };
let _chatsMeta: Record<string, ChatMeta> = Object.create(null) as Record<string, ChatMeta>;
let chatsNextOffset = 0;
let chatsHasMore = false;
let chatsPageLoading: Promise<void> | null = null;

function loadAllChats() {
  return _chatsMeta;
}

async function syncChatsFromServer({ reset = true }: { reset?: boolean } = {}): Promise<void> {
  if (!BoreasSync.isAuthed()) return;
  if (reset) {
    _chatsMeta = Object.create(null);
    chatsNextOffset = 0;
    chatsHasMore = true;
  }
  const page = await BoreasSync.chats.listPage(chatsNextOffset, 50);
  if (!page || !Array.isArray(page.chats)) return;
  for (const item of page.chats) {
    const sc = item as Partial<ChatMeta>;
    if (isSafeChatId(sc?.id)) _chatsMeta[sc.id] = { ...sc, id: sc.id, hasMessages: true };
  }
  chatsNextOffset = Number.isInteger(page.nextOffset) ? page.nextOffset : chatsNextOffset + page.chats.length;
  chatsHasMore = page.hasMore === true;
}

async function loadMoreChats() {
  if (chatsPageLoading || !chatsHasMore || !BoreasSync.isAuthed()) return;
  chatsPageLoading = syncChatsFromServer({ reset: false })
    .catch(error => console.warn("[syncChats] Falha ao carregar página:", error))
    .finally(() => { chatsPageLoading = null; renderSidebar(); });
  await chatsPageLoading;
}

BoreasLoadMoreChats = loadMoreChats;
BoreasChatsHasMore = () => chatsHasMore;

async function pushChatToServer(id: string, msgs: ChatMessage[], tier: string, speed: string, effort: string, { keepalive = false }: { keepalive?: boolean } = {}): Promise<boolean> {
  if (!BoreasSync.isAuthed()) return false;

  const safeMsgs = (msgs ?? []).map((m: ChatMessage) => {
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map((p: MessagePart) => {
      if (p.type !== "image_url") return p;
      const url = p.image_url?.url ?? "";
      // "data:" covers a raw image passed directly; "__idb:" is the normal
      // case, since stripImagesForStorage already replaced it with a local
      // IndexedDB reference before this runs. Both become a text placeholder
      // for the server, which never stores image bytes.
      return (url.startsWith("data:") || url.startsWith("__idb:"))
        ? { type: "text" as const, text: "[imagem]" }
        : p;
    })};
  });

  // The title never travels through here: generateTitle()/setChatTitle()
  // run in parallel with the first save and use the dedicated rename
  // endpoint. Sending the still-captured "New conversation" title in this
  // save would risk resolving after the rename and wiping out the real
  // title, both on the server and locally (both write to _chatsMeta[id].title).
  const res = await BoreasSync.chats.save({ id, messages: safeMsgs, tier, speed, effort }, { keepalive, localMessages: msgs });
  if (!res.ok) {
    console.warn("[pushChatToServer] falhou (" + res.error + ") - chat enfileirado para reenvio automático:", id);
    return false;
  }

  if (_chatsMeta[id]) {
    _chatsMeta[id].tier  = tier;
    _chatsMeta[id].effort = effort;
    _chatsMeta[id].updatedAt = new Date().toISOString();
    if (safeMsgs.length > 0) _chatsMeta[id].hasMessages = true;
  } else {
    _chatsMeta[id] = { id, title, tier, effort, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), messages: safeMsgs, hasMessages: safeMsgs.length > 0 };
  }
  return true;
}

function genChatId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return "c" + uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure random generator unavailable.");
  globalThis.crypto.getRandomValues(bytes);
  return "c" + [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function stripImagesForStorage(msgs: ChatMessage[], chatId: string): Promise<ChatMessage[]> {
  const result = [];
  const expectedPrefix = imageStoragePrefix(chatId);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!Array.isArray(m.content)) { result.push(m); continue; }
    const newContent: MessagePart[] = [];
    let imgIdx = 0;
    for (const p of m.content) {
      if (p.type === "image_url") {
        const url = p.image_url?.url ?? "";
        const key = `${imageStoragePrefix(chatId)}${i}:${imgIdx++}`;
        if (url.startsWith("data:")) {
          try { await idbSetImage(key, url); } catch {}
        }

        const storedReference = url.startsWith("__idb:") && url.slice(6).startsWith(expectedPrefix)
          ? url
          : `__idb:${key}`;
          newContent.push({ type: "image_url", image_url: { url: storedReference } });
      } else {
        newContent.push(p);
      }
    }
    result.push({ ...m, content: newContent });
  }
  return result;
}

async function restoreImages(msgs: ChatMessage[], chatId: string): Promise<ChatMessage[]> {
  const result = [];
  const expectedPrefix = imageStoragePrefix(chatId);
  const imageKeys = [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      const url = p?.type === "image_url" ? p.image_url?.url ?? "" : "";
      if (url.startsWith("__idb:") && url.slice(6).startsWith(expectedPrefix)) imageKeys.push(url.slice(6));
    }
  }
  const storedImages = imageKeys.length && typeof idbGetImages === "function"
    ? await idbGetImages(imageKeys)
    : new Map();
  for (const m of msgs) {
    if (!Array.isArray(m.content)) { result.push(m); continue; }
    const newContent: MessagePart[] = [];
    for (const p of m.content) {
      if (p.type === "image_url") {
        const url = p.image_url?.url ?? "";
        if (url.startsWith("__idb:") && url.slice(6).startsWith(expectedPrefix)) {
          const b64 = storedImages.get(url.slice(6)) ?? null;
          newContent.push(b64
            ? { type: "image_url", image_url: { url: b64 } }
            : { type: "text", text: "[imagem não disponível]" }
          );
        } else {
          newContent.push(p);
        }
      } else {
        newContent.push(p);
      }
    }
    result.push({ ...m, content: newContent });
  }
  return result;
}

async function createChat(tier?: string, speed?: string): Promise<string> {
  const id  = genChatId();
  const now = new Date().toISOString();
  const resolvedTier = tier ?? currentTier;
  // New chats start with the saved effort for that tier.

  const resolvedEffort = EFFORT_TIERS.includes(resolvedTier) ? lastEffortFor(resolvedTier) : "default";
  currentEffort = resolvedEffort;
  syncEffortUI();
  const meta = {
    id, title: "Nova conversa",
    tier: resolvedTier,
    speed: speed ?? currentSpeed,
    effort: resolvedEffort,
    createdAt: now, updatedAt: now,
    hasMessages: false,
  };
  _chatsMeta[id] = meta;
  localStorage.setItem(ACTIVE_KEY, id);

  return id;
}

async function saveCurrentMessages({ keepalive = false }: { keepalive?: boolean } = {}): Promise<void> {
  if (BoreasSessionContextStale) return;
  const id = localStorage.getItem(ACTIVE_KEY);
  if (!id) return;
  const meta = _chatsMeta[id];
  if (!meta) return;

  const snapshot = messages;
  const storedMsgs = await stripImagesForStorage(snapshot, id);
  // Image persistence is asynchronous. If the user changed chats while it
  // was running, never save the old snapshot under the new active chat.
  if (localStorage.getItem(ACTIVE_KEY) !== id || messages !== snapshot || _chatsMeta[id] !== meta) return;

  await pushChatToServer(id, storedMsgs, meta.tier ?? currentTier, meta.speed ?? currentSpeed, meta.effort ?? currentEffort, { keepalive });

  if (!keepalive && localStorage.getItem(ACTIVE_KEY) === id && messages === snapshot) renderSidebar();
}

function setChatTitle(id: string, title: string): void {
  const meta = _chatsMeta[id];
  if (!meta) return;
  const newTitle = title.trim().slice(0, 80) || "Nova conversa";
  meta.title = newTitle;
  renderSidebar();

  // Updates only the title on the server, to avoid overwriting messages with a stale snapshot.
  if (BoreasSync.isAuthed()) BoreasSync.chats.renameTitle(id, newTitle);
}

async function deleteChat(id: string): Promise<void> {

  if (BoreasSync.isAuthed()) {
    await BoreasSync.chats.remove(id); // queues for retry automatically if it fails
  }

  delete _chatsMeta[id];
  try { await idbDeleteByPrefix(imageStoragePrefix(id)); } catch {}
  const activeId = localStorage.getItem(ACTIVE_KEY);
  if (activeId === id) {
    const sorted = Object.values(_chatsMeta).sort((a, b) => (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? 1 : -1);
    if (sorted.length) {
      loadChat(sorted[0].id);
    } else {
      const newId = await createChat();
      loadChat(newId, { skipRemote: true });
    }
  } else {
    renderSidebar();
  }
}

async function loadChat(id: string, { skipRemote = false, cachedChat = null }: { skipRemote?: boolean; cachedChat?: (Partial<Conversation> & { id: string; messages?: ChatMessage[] }) | null } = {}): Promise<void> {
  if (!isSafeChatId(id)) return;

  const loadGeneration = ++chatLoadGeneration;

  if (currentAbortController) { try { currentAbortController.abort(); } catch {} }
  loading = false;
  hideStopBtn();
  currentAbortController = null;
  removeTyping();

  const cachedSnapshot = !cachedChat && !skipRemote && BoreasSync.isAuthed()
    ? BoreasSync.chats.peek(id)
    : null;
  const immediateChat = cachedChat || cachedSnapshot;
  let chat: (Partial<Conversation> & { id: string; messages?: ChatMessage[] }) | null = (immediateChat || ((!skipRemote && BoreasSync.isAuthed()) ? await BoreasSync.chats.get(id) : null) || null) as (Partial<Conversation> & { id: string; messages?: ChatMessage[] }) | null;

  if (!chat && _chatsMeta[id]) chat = { ..._chatsMeta[id], messages: [] };
  if (!chat) return;

  localStorage.setItem(ACTIVE_KEY, id);
  messages = await restoreImages(chat.messages ?? [], id);
  if (loadGeneration !== chatLoadGeneration) return;

  chatMemoryEnabled = chat.memoryEnabled !== false;
  chatHasMessages   = messages.length > 0;
  updateMemoryBtns();

  if (isTierKey(chat.tier) && Object.hasOwn(TIER_SPEEDS, chat.tier)) {
    currentTier = chat.tier;
    currentSpeed = TIER_SPEEDS[currentTier];
    document.getElementById("model-label")?.replaceChildren(document.createTextNode(TIERS[currentTier].label));
    document.querySelectorAll<HTMLElement>(".model-option").forEach(o =>
      o.classList.toggle("active", o.dataset.tier === currentTier)
    );
  }
  currentEffort = EFFORT_TIERS.includes(currentTier)
    ? (chat.effort === "intelligent" || (chat.effort !== undefined && TIER_EFFORTS[currentTier].levels.includes(chat.effort as Exclude<Effort, "intelligent" | "default">)) ? chat.effort as Effort : TIER_EFFORTS[currentTier].default)
    : "default";
  syncEffortUI();
  updateImageAttach();

  warnShownThisSession = false;
  document.getElementById("warn-overlay")?.classList.remove("show");
  document.getElementById("lock-bar")?.classList.remove("show");
  const ir = document.querySelector<HTMLElement>(".input-row");
  if (ir) ir.style.display = "";
  const chatSendBtn = document.getElementById("send-btn");
  if (chatSendBtn instanceof HTMLButtonElement) chatSendBtn.disabled = false;

  const chatMessagesEl = document.getElementById("messages");
  if (!(chatMessagesEl instanceof HTMLDivElement)) return;
  chatMessagesEl.innerHTML = "";
  autoScroll = true;
  updateScrollBtn();
  pendingImages = [];
  pendingFile = null;
  document.getElementById("image-preview-wrap")?.classList.remove("show");

  const msgInputEl = document.getElementById("msg-input");
  const textInput = msgInputEl instanceof HTMLTextAreaElement ? msgInputEl : null;
  if (textInput) textInput.placeholder = "Explore infinitas possibilidades...";

  if (!messages.length) {
    chatMessagesEl.innerHTML = `<div class="empty-state" id="empty">
      <img src="${BOREAS_LOGO_URL}" class="empty-logo-img" alt="Boreas" draggable="false">
      <span class="empty-text"></span>
    </div>`;
    setGreeting();
  } else {

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "user") {
        let text = "", imgs: string[] = [], fileAttachment: { name: string; content: string } | null = null;
        if (typeof m.content === "string") {
          // The backend persists user images as "[imagem:ID.ext]" inside a
          // string (attachment-service.js/persistUserImage), later served
          // via GET /chat-image/:id; this turns that marker back into an image.
          const imageMarker = /\[imagem:([A-Za-z0-9_-]+\.[A-Za-z0-9]+)\]\s*/g;
          imgs = [...m.content.matchAll(imageMarker)].map(match => `${BACKEND_URL}/chat-image/${match[1]}`);
          text = m.content.replace(imageMarker, "").trim();
        } else if (Array.isArray(m.content)) {
          const tp = m.content.find(p => p.type === "text");
          imgs = m.content.filter(p => p.type === "image_url").map(p => p.image_url?.url).filter(Boolean);
          // #15: histórico novo guarda o arquivo como part próprio, não mais
          // embutido no texto. Conversas antigas (formato "[Arquivo: ...]"
          // dentro do texto) continuam sendo pegas pelo FILE_RE legado em
          // appendMessage - não migradas, só não geradas mais assim.
          const fp = m.content.find(p => p.type === "text_file");
          fileAttachment = fp?.text_file ? { name: fp.text_file.name, content: fp.text_file.content } : null;
          text = tp?.text ?? "";
        }
        appendMessage("user", text, imgs, i, null, null, null, null, fileAttachment);
      } else if (m.role === "assistant") {

        const raw = typeof m.content === "string" ? m.content : "";
        const display = raw.replace(/^\[Ferramentas usadas nesta resposta:[\s\S]*?\]\n\n/, "");
        appendMessage("bot", display, null, i, m.attachments, null, m.steps, m.activity, null, m.thinkingSummary);
      }
    }
    if (typeof updateRegenerateAvailability === "function") updateRegenerateAvailability();
    scrollToBottom();
    if (textInput) textInput.placeholder = "Continue explorando o infinito...";

    // Shows the "unanswered message" banner when an open chat still has a pending message.
    const pendingHere = getPendingGen();
    const hasPendingHere = pendingHere?.genId && pendingHere.chatId === id;
    if (!hasPendingHere && messages.length > 0 && messages[messages.length - 1].role === "user") {
      const banner = document.createElement("div");
      banner.id = "resume-banner";
      banner.className = "resume-banner-el";
      banner.innerHTML = `<span>⚠️ Esta mensagem ficou sem resposta.</span><button id="resume-btn">Retomar ↺</button>`;
      chatMessagesEl.appendChild(banner);
      document.getElementById("resume-btn")?.addEventListener("click", resumePending);
    }
  }

  renderSidebar();

  // The cache only serves the first paint; the network updates silently in
  // parallel. Doesn't re-render while another generation or attachment is active.
  if (cachedSnapshot && !cachedChat && !skipRemote && BoreasSync.isAuthed()) {
    // The cache is only for the first paint. This call always hits the
    // network, even when the cache exists, and only remounts the
    // conversation if something changed.
    BoreasSync.chats.revalidate(id, cachedSnapshot).then(result => {
      const active = localStorage.getItem(ACTIVE_KEY) === id;
      const safeToRefresh = active && loadGeneration === chatLoadGeneration
        && !loading && !pendingImages.length && !pendingFile;
      if (result?.chat && result.changed && safeToRefresh) {
        loadChat(id, { skipRemote: true, cachedChat: result.chat });
      }
    }).catch(() => {});
  }
}

export {};
