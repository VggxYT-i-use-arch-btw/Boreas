// Boreas frontend module: sidebar shell, settings navigation, profile, and capabilities.
// Loaded as a classic script in the exact order declared by index.html.

import type { ChatMessage, Conversation, MessageAttachment, ToolStep } from "../types/chat";

type SidebarChat = Partial<Conversation> & { id: string; title: string; hasMessages?: boolean; role?: string; snippet?: string; messages?: ChatMessage[] };
type SettingsTarget = "profile" | "usage" | "capabilities" | "connectors" | "fontstyle" | "privacy" | "memory";
type CapabilityKey = "webSearch" | "artifacts" | "codeExecution";
const mustEl = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isSidebarChat(value: unknown): value is SidebarChat {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string";
}
declare var currentTier: string;
declare var currentSpeed: string;
declare var memoryEnabledGlobal: boolean;
declare var chatHasMessages: boolean;
declare var chatMemoryEnabled: boolean;
declare var ACTIVE_KEY: string;
declare var _activePeriod: string;
declare const lockBar: HTMLElement;
declare const TIERS: Record<string, { label: string }>;
declare const TIER_SPEEDS: Record<string, string>;
declare function createChat(tier?: string, speed?: string): Promise<string>;
declare function loadAllChats(): Record<string, SidebarChat>;
declare function loadChat(id: string, options?: { skipRemote?: boolean }): Promise<void>;
declare function showCtxMenu(x: number, y: number, chatId: string, title: string): void;
declare function renderUsage(period: string): void;
declare function loadUsageStats(): Promise<void>;
declare function loadMemoryNavSub(): Promise<void>;
declare function saveCurrentMessages(options?: { keepalive?: boolean }): Promise<void>;
declare function updateImageAttach(): void;
declare function renderConnectorsView(body: HTMLElement): Promise<void>;
declare function renderFontView(body: HTMLElement): Promise<void>;
declare function renderPrivacyView(body: HTMLElement): void;
declare function renderMemoryView(body: HTMLElement): void;
declare global {
  interface Window {
    BoreasChatsHasMore?: () => boolean;
    BoreasLoadMoreChats?: () => void;
  }
}

async function generateTitle(chatId: string, promptText: string): Promise<void> {
  const seed = String(promptText ?? "").trim().slice(0, 500);
  if (!seed) return;
  const fallbackTitle = seed
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:;,.!?]+|[\s\-–—:;,.!?]+$/g, "")
    .slice(0, 80)
    .trim();
  const currentMeta = _chatsMeta[chatId];
  if (currentMeta?.title === "Nova conversa" && fallbackTitle) setChatTitle(chatId, fallbackTitle);
  try {
    const r = await BoreasFetchWithTimeout(BACKEND_URL + "/title", {
      method: "POST",
      headers: BoreasSessionHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify({ prompt: seed, chatId }),
    });
    if (!r.ok) return;
    const payload: unknown = await r.json();
    const title = isRecord(payload) && typeof payload.title === "string" ? payload.title : "";
    if (title && _chatsMeta[chatId]?.title === fallbackTitle) setChatTitle(chatId, title);
  } catch (error: unknown) {
    console.warn("[generateTitle] falha ao gerar título:", error instanceof Error ? error.message : error);
  }
}

const sidebarEl    = mustEl<HTMLDivElement>("sidebar");
const sidebarOverlay = mustEl<HTMLDivElement>("sidebar-overlay");

function showToast(message: string): void {
  document.querySelectorAll<HTMLElement>(".sidebar-error-toast").forEach(el => el.remove());
  const toast = document.createElement("div");
  toast.className = "sidebar-error-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function openSidebar()  {
  document.body.classList.remove("sidebar-closed");
  document.body.classList.add("sidebar-open");
  sidebarEl.classList.add("open");
  sidebarOverlay.classList.add("open");
  renderSidebar();
}
function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  if (window.matchMedia("(min-width: 1100px)").matches) document.body.classList.add("sidebar-closed");
  sidebarEl.classList.remove("open");
  sidebarOverlay.classList.remove("open");
}

mustEl("hamburger-btn").addEventListener("click", openSidebar);
mustEl("sidebar-close").addEventListener("click", closeSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);

(function setupSidebarSwipe() {
  const EDGE_ZONE = 24;      // px a partir da borda esquerda pra iniciar o gesto de abrir
  const SIDEBAR_W = 280;
  const MOVE_THRESHOLD = 10; // px de arrasto real antes de "armar" o gesto - evita comer taps/cliques
  let startX = 0, startY = 0, tracking = false, dragging = false, mode: "open" | "close" | null = null;

  function onStart(x: number, y: number): void {
    const isOpen = sidebarEl.classList.contains("open");
    if (!isOpen && x > EDGE_ZONE) return;
    startX = x; startY = y; tracking = true; dragging = false;
    mode = isOpen ? "close" : "open";
  }
  function onMove(x: number, y: number): void {
    if (!tracking) return;
    const dx = x - startX, dy = y - startY;
    if (!dragging) {
      if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return; // ainda pode ser só um tap
      if (Math.abs(dy) > Math.abs(dx) * 1.3) { tracking = false; return; } // gesto vertical (scroll) - não é swipe de sidebar

      dragging = true;
      sidebarEl.style.transition = "none";
      sidebarOverlay.style.transition = "none";
      if (mode === "open") { sidebarEl.classList.add("open"); sidebarOverlay.classList.add("open"); }
    }
    let progress;
    if (mode === "open") progress = Math.min(1, Math.max(0, dx / SIDEBAR_W));
    else progress = Math.min(1, Math.max(0, 1 + dx / SIDEBAR_W));
    sidebarEl.style.transform = `translateX(${(progress - 1) * 100}%)`;
    sidebarOverlay.style.opacity = String(progress * 0.5 * 2 <= 1 ? progress : 1);
  }
  function onEnd(x: number): void {
    tracking = false;
    if (!dragging) return; // nunca virou arrasto - era só um tap, não faz nada
    dragging = false;
    sidebarEl.style.transition = "";
    sidebarOverlay.style.transition = "";
    sidebarEl.style.transform = "";
    sidebarOverlay.style.opacity = "";
    const dx = x - startX;
    const shouldOpen = mode === "open" ? dx > SIDEBAR_W * 0.3 : dx > -SIDEBAR_W * 0.3;
    if (shouldOpen) openSidebar(); else closeSidebar();
  }

  document.addEventListener("touchstart", e => onStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  document.addEventListener("touchmove", e => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  document.addEventListener("touchend", e => onEnd(e.changedTouches[0].clientX), { passive: true });
})();

mustEl("sidebar-new-chat").addEventListener("click", async () => {
  saveCurrentMessages(); // salva a conversa anterior em segundo plano - não trava a criação da nova
  const tierParaNovoChat = lockBar.classList.contains("show") ? "horizon2" : currentTier;
  if (tierParaNovoChat !== currentTier) {
    currentTier = tierParaNovoChat;
    currentSpeed = TIER_SPEEDS[currentTier];
    mustEl("model-label").textContent = TIERS[currentTier].label;
    document.querySelectorAll<HTMLElement>(".model-option").forEach(o =>
      o.classList.toggle("active", o.dataset.tier === currentTier)
    );
  }
  const id = await createChat(currentTier, currentSpeed);

  await loadChat(id, { skipRemote: true });
  updateImageAttach();
  closeSidebar();
});

mustEl("sidebar-projeto").addEventListener("click", () => {
  mustEl("coming-soon-overlay").classList.add("show");
});
mustEl("coming-soon-close").addEventListener("click", () => {
  mustEl("coming-soon-overlay").classList.remove("show");
});
mustEl("coming-soon-overlay").addEventListener("click", e => {
  if (e.target === mustEl("coming-soon-overlay"))
    mustEl("coming-soon-overlay").classList.remove("show");
});

function renderSidebar(): void {
  const chats    = loadAllChats();
  const activeId = localStorage.getItem(ACTIVE_KEY);
  const searchQuery = String(window.__boreasSearchQuery ?? "").trim();
  const searchMatches = Array.isArray(window.__boreasSearchResults) ? window.__boreasSearchResults.filter(isSidebarChat) : [];

  const sorted = searchQuery
    ? searchMatches.map(match => ({ ...(chats[match.id] ?? {}), ...match, hasMessages: true }))
    : Object.values(chats)
      .filter(c => c.hasMessages || (c.updatedAt && c.updatedAt !== c.createdAt))
      .sort((a, b) => (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? 1 : -1);
  const listEl = mustEl<HTMLDivElement>("sidebar-chat-list");
  listEl.innerHTML = "";

  if (!sorted.length) {
    const emptyText = searchQuery
      ? (window.__boreasSearchPending ? "Buscando nas mensagens…" : "Nenhum conteúdo encontrado")
      : "Nenhum chat ainda";
    const emptyIcon = searchQuery ? "ph-magnifying-glass" : "ph-chats-circle";
    const pending = searchQuery && window.__boreasSearchPending;
    listEl.innerHTML = `<div class="sidebar-empty-msg"><i class="ph ${emptyIcon}" aria-hidden="true"></i>${pending ? '<span class="ui-skeleton ui-skeleton-line" aria-label="Buscando"></span>' : `<span>${emptyText}</span>`}</div>`;
    return;
  }

  for (const chat of sorted) {
    const item = document.createElement("div");
    item.className = "sidebar-chat-item" + (chat.id === activeId ? " active" : "");

    const tierLabel = chat.tier ? TIERS[chat.tier]?.label ?? chat.tier : "Boreas";
    item.dataset.chatId = chat.id;
    item.innerHTML = `
      <div class="sidebar-chat-item-text">
        <div class="sidebar-chat-title">${escHtml(chat.title)}</div>
        <div class="sidebar-chat-meta">${escHtml(tierLabel)}${chat.role ? ` · ${chat.role === "user" ? "Você" : "Boreas"}` : ""}</div>
        ${chat.snippet ? `<div class="sidebar-chat-match">${escHtml(chat.snippet)}</div>` : ""}
      </div>`;

    item.addEventListener("click", async () => {
      if (item.classList.contains("active")) { closeSidebar(); return; }
      try {
        await saveCurrentMessages();
        await loadChat(chat.id);
      } catch (error) {
        console.error("[sidebar] Falha ao abrir conversa:", error);
        if (typeof showToast === "function") showToast("Não foi possível abrir esta conversa.");
      } finally {
        closeSidebar();
      }
    });

    let _pt: ReturnType<typeof setTimeout> | undefined;
    item.addEventListener("pointerdown", e => {
      item.classList.add("pressing");
      _pt = setTimeout(() => {
        e.preventDefault();
        item.classList.remove("pressing");
        showCtxMenu(e.clientX, e.clientY, chat.id, chat.title);
      }, 500);
    });
    ["pointerup", "pointercancel", "pointermove"].forEach(ev =>
      item.addEventListener(ev, () => { clearTimeout(_pt); item.classList.remove("pressing"); })
    );

    listEl.appendChild(item);
  }

  if (!searchQuery && window.BoreasChatsHasMore?.()) {
    const sentinel = document.createElement("div");
    sentinel.className = "sidebar-chat-load-more";
    sentinel.textContent = "Carregando mais conversas…";
    listEl.appendChild(sentinel);
    requestAnimationFrame(() => {
      if (listEl.scrollHeight <= listEl.clientHeight + 8) window.BoreasLoadMoreChats?.();
    });
  }
}

mustEl("sidebar-chat-list")?.addEventListener("scroll", event => {
  const list = event.currentTarget as HTMLElement;
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 120) {
    window.BoreasLoadMoreChats?.();
  }
}, { passive: true });

function updateSidebarUser() {
  const name  = localStorage.getItem("boreas_name") ?? "";
  const email = localStorage.getItem("boreas_email") ?? "";
  const initial = name ? name[0].toUpperCase() : "?";
  const el = (id: string): HTMLElement => mustEl(id);
  if (el("sidebar-avatar"))       el("sidebar-avatar").textContent = initial;
  if (el("sidebar-user-name"))    el("sidebar-user-name").textContent = name || "-";
  if (el("settings-avatar-lg"))   el("settings-avatar-lg").textContent = initial;
  if (el("settings-user-name-modal")) el("settings-user-name-modal").textContent = name || "-";
  if (el("settings-user-email"))  el("settings-user-email").textContent = email || "-";
}

function updateMemoryBtns() {
  const btns = mustEl("memory-btns");
  const btn  = mustEl("memory-toggle-btn");
  if (!btns) return;
  if (!memoryEnabledGlobal || chatHasMessages) {
    btns.style.display = "none";
  } else {
    btns.style.display = "flex";
    btn.classList.toggle("active", chatMemoryEnabled);
  }
}

mustEl("memory-toggle-btn").addEventListener("click", (e) => {
  if (chatHasMessages) return;
  chatMemoryEnabled = !chatMemoryEnabled;
  const btn = mustEl("memory-toggle-btn");
  btn.classList.toggle("active", chatMemoryEnabled);

  btn.blur();
  const id = localStorage.getItem(ACTIVE_KEY);
  if (id) {
    if (_chatsMeta[id]) { _chatsMeta[id].memoryEnabled = chatMemoryEnabled; }
  }
});

let _memInfoClose: ((event: PointerEvent) => void) | null = null;

mustEl("memory-info-btn").addEventListener("click", e => {
  e.stopPropagation();

  if (_memInfoClose) { document.removeEventListener("pointerdown", _memInfoClose); _memInfoClose = null; }
  const existing = mustEl("memory-popup-el");
  if (existing) { existing.remove(); return; }
  const popup = document.createElement("div");
  popup.className = "memory-info-popup"; popup.id = "memory-popup-el";
  const state = chatMemoryEnabled ? "ligadas" : "desligadas";
  popup.innerHTML = `
    <div class="memory-popup-title">Memória do Boreas</div>
    <div class="memory-popup-desc">Ao ativar, o Boreas pode usar a memória persistente organizada por categorias. O modelo adiciona ou consulta itens quando isso for relevante.</div>
    <div class="memory-popup-status">Atualmente as memórias estão <strong>${state}</strong> para essa conversa.</div>`;
  const r = mustEl("memory-info-btn").getBoundingClientRect();
  popup.style.top   = (r.bottom + 8) + "px";
  popup.style.right = Math.max(8, window.innerWidth - r.right - 20) + "px";
  document.body.appendChild(popup);
  const infoBtn = mustEl("memory-info-btn");
  const close = (ev: PointerEvent): void => {
    if (!(ev.target instanceof Node) || (!popup.contains(ev.target) && !infoBtn.contains(ev.target))) {
      popup.remove();
      document.removeEventListener("pointerdown", close);
      _memInfoClose = null;
    }
  };
  _memInfoClose = close;
  setTimeout(() => document.addEventListener("pointerdown", close), 10);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveCurrentMessages({ keepalive: true });
});
window.addEventListener("pagehide", () => saveCurrentMessages({ keepalive: true }));

const SETTINGS_ICONS: Record<string, string> = {
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  usage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
  capabilities: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="var(--bg)"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="16" cy="12" r="2" fill="var(--bg)"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2" fill="var(--bg)"/></svg>',
  connectors: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M9 2v4M15 2v4M7 6h10l-1 5a5 5 0 0 1-8 0L7 6Z"/><path d="M12 15v3M9 21h6"/></svg>',
  font: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 7v13"/></svg>',
  privacy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><polyline points="9 18 15 12 9 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"><polyline points="20 6 9 17 4 12"/></svg>',
};
document.querySelectorAll<HTMLElement>("[data-icon]").forEach(el => {
  const iconName = el.dataset.icon;
  el.innerHTML = iconName ? SETTINGS_ICONS[iconName] ?? "" : "";
});

function openSettingsSubview(target: SettingsTarget): void {
  const titles = {
    profile: "Perfil", usage: "Uso", capabilities: "Capacidades",
    connectors: "Conectores", fontstyle: "Estilo de fonte", privacy: "Privacidade",
    memory: "Memória",
  };
  mustEl("sub-title").textContent = titles[target] ?? "-";
  mustEl("sub-body").innerHTML = "";
  mustEl("sub-body").dataset.view = target;
  mustEl("view-main").classList.remove("active");
  mustEl("view-main").classList.add("behind");
  mustEl("view-sub").classList.add("active");
  renderSubview(target);
}
function closeSettingsSubview(): void {
  mustEl("view-sub").classList.remove("active");
  mustEl("view-main").classList.remove("behind");
  mustEl("view-main").classList.add("active");
}
mustEl("settings-back").addEventListener("click", closeSettingsSubview);
mustEl("settings-close").addEventListener("click", () => {
  closeUsageModal();
  mustEl("settings-overlay").classList.remove("show");
});

function openUsageModal() {
  const overlay = mustEl("usage-modal-overlay");
  const body = mustEl("usage-modal-body");
  if (!overlay || !body) return;
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
  renderUsageView(body);
}

function closeUsageModal() {
  const overlay = mustEl("usage-modal-overlay");
  if (!overlay) return;
  overlay.classList.remove("show");
  overlay.setAttribute("aria-hidden", "true");
}

mustEl("usage-modal-close")?.addEventListener("click", closeUsageModal);
mustEl("usage-modal-overlay")?.addEventListener("click", e => {
  if (e.target instanceof HTMLElement && e.target.id === "usage-modal-overlay") closeUsageModal();
});

function renderSubview(target: SettingsTarget): void | Promise<void> {
  const body = mustEl("sub-body");
  if (target === "profile")       return renderProfileView(body);
  if (target === "usage")         return renderUsageView(body);
  if (target === "capabilities")  return renderCapabilitiesView(body);
  if (target === "connectors")    return renderConnectorsView(body);
  if (target === "fontstyle")     return renderFontView(body);
  if (target === "privacy")       return renderPrivacyView(body);
  if (target === "memory")        return renderMemoryView(body);
}

document.querySelectorAll<HTMLElement>(".settings-menu-item[data-target]").forEach(btn => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    if (!target) return;
    if (target === "usage") openUsageModal();
    else if (["profile", "capabilities", "connectors", "fontstyle", "privacy", "memory"].includes(target)) openSettingsSubview(target as SettingsTarget);
  });
});

async function renderProfileView(body: HTMLElement): Promise<void> {
  body.innerHTML = `
    <div class="settings-field-label">Seu nome</div>
    <input class="settings-input" id="profile-name-input" placeholder="Seu nome">
    <div class="settings-field-label" style="margin-top:6px">Eu uso o Boreas para...</div>
    <input class="settings-input" id="profile-use-input" placeholder="Ex: estudar, programar, organizar o dia">
    <div class="settings-field-label" style="margin-top:6px">Quais preferências pessoais o Boreas deve seguir?</div>
    <div class="settings-field-hint">Suas preferências serão aplicadas a todas as conversas</div>
    <textarea class="settings-textarea" id="profile-prefs-input" placeholder="Ex: seja direto, evite emojis, use humor ácido..."></textarea>
    <button class="settings-save-btn" id="profile-save-btn" disabled>Atualizar perfil</button>
  `;
  const nameEl = mustEl<HTMLInputElement>("profile-name-input");
  const useEl  = mustEl<HTMLInputElement>("profile-use-input");
  const prefEl = mustEl<HTMLTextAreaElement>("profile-prefs-input");
  const saveBtn = mustEl<HTMLButtonElement>("profile-save-btn");
  let original = { name: "", use: "", preferences: "" };

  nameEl.value = localStorage.getItem("boreas_name") ?? "";
  useEl.value  = localStorage.getItem("boreas_use") ?? "";
  original.name = nameEl.value; original.use = useEl.value;

  if (BoreasSync.isAuthed()) {
    try {
      const r = await BoreasFetchWithTimeout(BACKEND_URL + "/profile", { headers: BoreasSessionHeaders(), credentials: "include" });
      if (r.ok) {
        const payload: unknown = await r.json();
        const data = isRecord(payload) ? payload : {};
        nameEl.value = typeof data.name === "string" ? data.name : nameEl.value;
        useEl.value  = typeof data.use === "string" ? data.use : useEl.value;
        prefEl.value = typeof data.preferences === "string" ? data.preferences : "";
        original = { name: nameEl.value, use: useEl.value, preferences: prefEl.value };
      }
    } catch {}
  }

  function checkDirty() {
    const dirty = nameEl.value !== original.name || useEl.value !== original.use || prefEl.value !== original.preferences;
    saveBtn.disabled = !dirty;
  }
  [nameEl, useEl, prefEl].forEach(el => el.addEventListener("input", checkDirty));

  saveBtn.addEventListener("click", async () => {
    if (!BoreasSync.isAuthed()) return;
    saveBtn.disabled = true; saveBtn.textContent = "Salvando...";
    try {
      const r = await BoreasFetchWithTimeout(BACKEND_URL + "/profile", {
        method: "PUT",
        headers: BoreasSessionHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ name: nameEl.value, use: useEl.value, preferences: prefEl.value }),
      });
      if (!r.ok) throw await boreasHttpError(r);
      const payload: unknown = await r.json();
      const data = isRecord(payload) ? payload : {};
      const savedName = typeof data.name === "string" ? data.name : nameEl.value;
      const savedUse = typeof data.use === "string" ? data.use : useEl.value;
      const savedPreferences = typeof data.preferences === "string" ? data.preferences : prefEl.value;
      original = { name: savedName, use: savedUse, preferences: savedPreferences };
      localStorage.setItem("boreas_name", savedName);
      localStorage.setItem("boreas_use", savedUse);
      updateSidebarUser();
      saveBtn.textContent = "Atualizar perfil";
    } catch {
      saveBtn.textContent = "Erro - tentar novamente";
      saveBtn.disabled = false;
    }
  });
}

function renderUsageView(body: HTMLElement): void {
  body.innerHTML = `
    <div class="usage-period-tabs" id="usage-tabs">
      <button class="usage-tab active" data-period="last_hour">Última hora</button>
      <button class="usage-tab" data-period="today">Hoje</button>
      <button class="usage-tab" data-period="yesterday">Ontem</button>
      <button class="usage-tab" data-period="last_7_days">7 dias</button>
      <button class="usage-tab" data-period="last_30_days">30 dias</button>
      <button class="usage-tab" data-period="last_3_months">3 meses</button>
      <button class="usage-tab" data-period="all_time">Total</button>
    </div>
    <div id="usage-display"><div class="usage-loading"><span class="ui-skeleton ui-skeleton-line" aria-label="Carregando"></span></div></div>
  `;
  mustEl("usage-tabs").addEventListener("click", e => {
    const target = e.target;
    const btn = target instanceof Element ? target.closest<HTMLButtonElement>(".usage-tab") : null;
    if (!btn) return;
    document.querySelectorAll<HTMLElement>("#usage-tabs .usage-tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    _activePeriod = btn.dataset.period ?? "last_hour";
    renderUsage(_activePeriod);
  });
  loadUsageStats();
}

async function renderCapabilitiesView(body: HTMLElement): Promise<void> {
  body.innerHTML = `
    <div class="settings-row">
      <div><div class="settings-row-label">Busca na web</div>
        <div class="settings-row-sub">Dá acesso ao Boreas a pesquisa na web, quando necessitar de informações atuais</div></div>
      <div class="toggle-switch" id="cap-webSearch"><div class="toggle-knob"></div></div>
    </div>
    <div class="settings-row">
      <div><div class="settings-row-label">Artefatos</div>
        <div class="settings-row-sub">Permite que o Boreas te envie arquivos diretamente</div></div>
      <div class="toggle-switch" id="cap-artifacts"><div class="toggle-knob"></div></div>
    </div>
    <div class="settings-row">
      <div><div class="settings-row-label">Execução de código</div>
        <div class="settings-row-sub">Dá a capacidade que o Boreas execute código e comandos em seu terminal bash</div></div>
      <div class="toggle-switch" id="cap-codeExecution"><div class="toggle-knob"></div></div>
    </div>
    <div class="settings-section-label">Memória</div>
    <div class="settings-row">
      <div><div class="settings-row-label">Memória persistente</div>
        <div class="settings-row-sub">Permitir que o modelo guarde e consulte contexto relevante por categoria</div></div>
      <div class="toggle-switch" id="memory-global-toggle"><div class="toggle-knob"></div></div>
    </div>
    <button class="settings-menu-item" id="memory-nav-row" style="background:var(--surface);border:1px solid var(--border);border-radius:12px">
      <span class="settings-menu-item-text">
        <div class="settings-row-label" style="font-weight:500">Memória</div>
        <div class="settings-menu-item-sub" id="memory-nav-sub">Carregando...</div>
      </span>
      <span class="settings-menu-chevron" data-icon="chevron"></span>
    </button>
  `;
  mustEl("memory-nav-row").querySelector<HTMLElement>('[data-icon="chevron"]')!.innerHTML = SETTINGS_ICONS.chevron;
  mustEl("memory-global-toggle").classList.toggle("on", memoryEnabledGlobal);
  mustEl("memory-global-toggle").addEventListener("click", () => {
    memoryEnabledGlobal = !memoryEnabledGlobal;
    localStorage.setItem("boreas_memory_global", String(memoryEnabledGlobal));
    mustEl("memory-global-toggle").classList.toggle("on", memoryEnabledGlobal);
    updateMemoryBtns();
  });
  mustEl("memory-nav-row").addEventListener("click", () => openSettingsSubview("memory"));
  loadMemoryNavSub();

  const caps: CapabilityKey[] = ["webSearch", "artifacts", "codeExecution"];
  const current: Record<CapabilityKey, boolean> = { webSearch: true, artifacts: true, codeExecution: true };
  if (BoreasSync.isAuthed()) {
    try {
      const r = await BoreasFetchWithTimeout(BACKEND_URL + "/capabilities", { headers: BoreasSessionHeaders(), credentials: "include" });
      if (r.ok) {
        const payload: unknown = await r.json();
        if (isRecord(payload) && isRecord(payload.capabilities)) {
          for (const cap of caps) if (typeof payload.capabilities[cap] === "boolean") current[cap] = payload.capabilities[cap] as boolean;
        }
      }
    } catch {}
  }
  caps.forEach(cap => {
    const el = mustEl("cap-" + cap);
    el.classList.toggle("on", current[cap] !== false);
    el.addEventListener("click", async () => {
      const next = !el.classList.contains("on");
      el.classList.toggle("on", next);
      if (!BoreasSync.isAuthed()) return;
      try {
        const response = await BoreasFetchWithTimeout(BACKEND_URL + "/capabilities", {
          method: "PUT",
          headers: BoreasSessionHeaders({ "Content-Type": "application/json" }),
          credentials: "include",
          body: JSON.stringify({ [cap]: next }),
        });
        if (!response.ok) throw await boreasHttpError(response);
      } catch (error: unknown) {
        el.classList.toggle("on", !next);
        showToast(error instanceof Error ? error.message : "Não foi possível atualizar essa permissão.");
      }
    });
  });
}

export {};
