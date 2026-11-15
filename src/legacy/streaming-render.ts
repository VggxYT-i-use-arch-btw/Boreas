// Boreas frontend module: streaming state, reconnection, watchdogs, and stop controls.
// Loaded as a classic script in the exact order declared by index.html.
import type { ActivityState } from "./streaming-trace";
import type { ChatMessage, ChatStreamEvent, MessageAttachment } from "../types/chat";

declare global {
  interface HTMLElement {
    _rawText?: string;
  }
}

interface PendingGeneration {
  genId: string;
  chatId: string;
  accountScope: string;
  ts: number;
}

interface BoreasHttpError extends Error {
  status: number;
}

declare function send(): void;

// Boreas: streaming, rendering, sending, and regeneration.

let currentAbortController: AbortController | null = null;

let currentGenId: string | null = null;
let userStoppedGeneration = false; // true only while an explicit Parar click's abort is in flight
const PENDING_GEN_KEY = "boreas_pending_gen";
const messagesContainer = messagesEl as HTMLDivElement;
const renderSendButton = sendBtn as HTMLButtonElement;
const renderMessageInput = msgInput as HTMLTextAreaElement;
function pendingAccountScope(): string {
  const scope = String(localStorage.getItem("boreas_session_scope") || "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(scope) ? scope : "";
}
function validGenerationId(id: unknown): id is string {
  return typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
}

async function boreasHttpError(response: Response): Promise<BoreasHttpError> {
  let message = `HTTP ${response.status}`;
  try {
    const data: unknown = await response.clone().json();
    if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" && data.error.trim()) message = data.error.trim();
  } catch {}
  const error = new Error(message) as BoreasHttpError;
  error.status = response.status;
  if (response.status === 401) document.dispatchEvent(new CustomEvent("boreas:session-expired"));
  return error;
}
function validPendingChatId(id: unknown): id is string {
  return typeof id === "string" && /^(?!__proto__$|prototype$|constructor$)[A-Za-z0-9_-]{1,80}$/i.test(id);
}
function savePendingGen(genId: string, chatId: string | null): void {
  const accountScope = pendingAccountScope();
  if (!validGenerationId(genId) || !validPendingChatId(chatId) || !accountScope) return;
  try { localStorage.setItem(PENDING_GEN_KEY, JSON.stringify({ genId, chatId, accountScope, ts: Date.now() })); } catch {}
}
function getPendingGen(): PendingGeneration | null {
  try {
    const raw = localStorage.getItem(PENDING_GEN_KEY);
    if (!raw) return null;
    const pending: unknown = JSON.parse(raw);
    if (typeof pending !== "object" || pending === null || !("genId" in pending) || !("chatId" in pending) || !("accountScope" in pending) || !("ts" in pending)) return null;
    if (!validGenerationId(pending.genId) || !validPendingChatId(pending.chatId) || typeof pending.accountScope !== "string" || typeof pending.ts !== "number") return null;
    return pending.accountScope === pendingAccountScope()
      ? { genId: pending.genId, chatId: pending.chatId, accountScope: pending.accountScope, ts: pending.ts }
      : null;
  } catch { return null; }
}
function clearPendingGen(): void {
  try { localStorage.removeItem(PENDING_GEN_KEY); } catch {}
}

let syncInFlight: Promise<boolean | undefined> | null = null;
let syncInFlightGenId: string | null = null;
let syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
let syncRetryAttempt = 0;
let syncAbortController: AbortController | null = null;

function schedulePendingSync(genId: string): void {
  if (syncRetryTimer || !genId || navigator.onLine === false) return;
  if (getPendingGen()?.genId !== genId) return;
  const delay = Math.min(16000, 1000 * (2 ** Math.min(syncRetryAttempt++, 4)));
  syncRetryTimer = setTimeout(() => {
    syncRetryTimer = null;
    syncGeneration(genId, { resetRetry: false });
  }, delay);
}

function showSyncBanner(genId: string): void {
  document.getElementById("resume-banner")?.remove();
  document.getElementById("sync-banner")?.remove();
  const banner = document.createElement("div");
  banner.id = "sync-banner";
  banner.className = "resume-banner-el";
  banner.innerHTML = `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12h8"></path><path d="M12 8v8"></path><path d="M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"></path></svg> Conexão interrompida - a resposta pode ter continuado.</span><button id="sync-btn">Reconectar</button>`;
  messagesContainer.appendChild(banner);
  scrollToBottom();
  document.getElementById("sync-btn")!.addEventListener("click", () => { void syncGeneration(genId); });
}

function syncGeneration(genId: string, { resetRetry = true }: { resetRetry?: boolean } = {}): Promise<boolean | undefined> {
  if (!genId) return Promise.resolve(false);
  if (syncInFlight && syncInFlightGenId === genId) return syncInFlight;
  if (syncRetryTimer !== null) clearTimeout(syncRetryTimer);
  syncRetryTimer = null;
  if (resetRetry) syncRetryAttempt = 0;
  syncInFlightGenId = genId;
  syncInFlight = syncGenerationOnce(genId).finally(() => {
    syncInFlight = null;
    syncInFlightGenId = null;
  });
  return syncInFlight ?? Promise.resolve(false);
}

async function syncGenerationOnce(genId: string): Promise<boolean | undefined> {
  document.getElementById("sync-banner")?.remove();
  loading = true; showStopBtn();
  currentGenId = genId;

  // The connection can drop after the partial response is already on
  // screen. The sync endpoint resends every chunk from the start; only the
  // row tagged for this generation is removed before rebuilding it, to
  // avoid a second visual response with the same content.
  messagesContainer.querySelectorAll<HTMLElement>(".msg-row.bot")
    .forEach(row => { if (row.dataset.generationId === String(genId)) row.remove(); });

  let masterRow: HTMLDivElement | null = null;
  let masterCol: HTMLDivElement | null = null;
  let responseBubble: HTMLDivElement | null = null;
  let reply = "", segmentReply = "";
  let msgAttachments: MessageAttachment[] = [];
  const lastMessage = messages.at(-1);
  const previousAssistant: ChatMessage | null = lastMessage?.role === "assistant" ? lastMessage : null;
  const activity: ActivityState = {};
  let sawDone = false;
  let syncMissing = false;
  let syncFailed = false;
  let syncFailureMessage = "";
  const stalePromptIds = new Set<string>();
  const controller = new AbortController();
  syncAbortController = controller;
  currentAbortController = controller;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  function ensureRow(): void {
    if (!masterRow) {
      removeTyping();
      masterRow = document.createElement("div"); masterRow.className = "msg-row bot";
      masterRow.dataset.generationId = String(genId);
      const avatar = document.createElement("div"); avatar.className = "avatar";
      avatar.innerHTML = `<img src="${BOREAS_LOGO_URL}" style="width:42px;height:42px;object-fit:contain;opacity:0.95" loading="lazy" decoding="async" draggable="false">`;
      masterCol = document.createElement("div"); masterCol.className = "bot-col"; masterCol.style.gap = "4px";
      masterRow.appendChild(avatar); masterRow.appendChild(masterCol);
      messagesContainer.appendChild(masterRow);
    }
  }
  const activeColumn = (): HTMLDivElement => masterCol as HTMLDivElement;
  const activeRow = (): HTMLDivElement | null => masterRow as HTMLDivElement | null;
  const activeBubble = (): HTMLDivElement | null => responseBubble as HTMLDivElement | null;

  try {
    if (!validGenerationId(genId)) return false;
    const res = await globalThis.BoreasApi.rawFetch(`${BACKEND_URL}/chat/sync/${encodeURIComponent(genId)}`, {
      headers: BoreasSessionHeaders(),
      credentials: "include",
      signal: controller.signal,
    });
    if (!res.ok) throw await boreasHttpError(res);
    if (!res.body) throw new Error("Resposta de sincronização sem corpo");

    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    const armInactivityTimeout = () => {
      if (inactivityTimer !== null) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => controller.abort(), 30000);
    };
    armInactivityTimeout();
    const MAX_SYNC_SSE_BUFFER = 8 * 1024 * 1024;
    const MAX_SYNC_RESPONSE_CHARS = 8 * 1024 * 1024;
    const syncByteEncoder = new TextEncoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armInactivityTimeout();
      if (!value || value.byteLength > MAX_SYNC_SSE_BUFFER - syncByteEncoder.encode(buffer).byteLength) {
        await reader.cancel().catch(() => {});
        throw new Error("Resposta de sincronização excedeu o limite de 8 MB");
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim(); if (raw === "[DONE]") { sawDone = true; continue; }
        const chunk = globalThis.BoreasApi.parseStreamEvent(raw);
        if (!chunk || chunk === "[DONE]") continue;
        const event: ChatStreamEvent = chunk;

        if (event.type === "sync_missing") {
          syncMissing = true;
          continue;
        }
        if (event.type === "sync_truncated") {
          syncFailed = true;
          syncFailureMessage = event.message || "A resposta não pôde ser reconstruída integralmente.";
          continue;
        }
        if (event.type === "ask_user_prompt_stale") { stalePromptIds.add(event.promptId); continue; }
        if (event.type === "gen_id" || event.type === "heartbeat" || event.type === "token_exhausted" || event.type === "tier_used" || event.type === "length_cut") continue;
        if (event.type === "file") { ensureRow(); activeColumn().appendChild(createFileCard(event.name, event.data, event.mime)); msgAttachments.push({ type: "file", name: event.name, data: event.data, mime: event.mime }); scrollToBottom(); continue; }
        if (event.type === "deep_research") { ensureRow(); renderDeepResearchCard(activeColumn(), event); if (event.done) msgAttachments = [...msgAttachments.filter(a => a.type !== "deep_research"), { ...event }]; continue; }
        if (event.type === "agentic_loop") { ensureRow(); renderAgenticLoopCard(activeColumn(), event); if (event.done) msgAttachments = [...msgAttachments.filter(a => a.type !== "agentic_loop"), { ...event }]; continue; }
        // Um ask_user_prompt já sinalizado como stale (respondido/expirado
        // em outra reconexão ou já resolvido no servidor) vira só um recap
        // somente-leitura - sem isso, cada reconexão (focus/pageshow/online
        // disparam uma) reabria um novo card interativo aguardando resposta
        // para a MESMA pergunta, empilhando cards órfãos a cada vez que a
        // página saía e voltava do foco.
        if (event.type === "ask_user_prompt" && stalePromptIds.has(event.promptId)) {
          ensureRow();
          renderAskUserPromptRecap(activeColumn(), { questions: event.questions, answers: null, timedOut: true });
          msgAttachments.push({ type: "ask_user_prompt", promptId: event.promptId, questions: event.questions, answers: null, timedOut: true });
          continue;
        }
        if (event.type === "ask_user_prompt") { ensureRow(); const _aupAns = await renderAskUserPromptCard(activeColumn(), event.promptId, event.questions); msgAttachments.push({ type: "ask_user_prompt", promptId: event.promptId, questions: event.questions, answers: _aupAns ?? null, timedOut: !_aupAns }); continue; }
        if (event.type === "step") {
          ensureRow(); responseBubble = null; segmentReply = "";
          ensureToolActivityCard(activeColumn(), event, activity, (pill, detail) => { activeColumn().appendChild(pill); activeColumn().appendChild(detail); });
          if (event.output !== undefined && event.output !== "") {
            showInlineToolResult(activeColumn(), event.id ?? "", event.tool, event.output, activeBubble(), event.value);
          }
          scrollToBottom(); continue;
        }
        if (event.type === "sources") { ensureRow(); activeColumn().appendChild(createSourcesButton(event.results)); continue; }
        if (event.type === "error") {
          syncFailed = true;
          syncFailureMessage = event.message || "Falha na geração.";
          continue;
        }

        if (event.type === "thinking_started") {
          ensureRow();
          ensureThinkingSegment(activity, (pill, detail) => { activeColumn().appendChild(pill); activeColumn().appendChild(detail); });
          continue;
        }

        if (event.type !== "choices") continue;
        const delta = event.choices[0]?.delta;
        if (delta?.content) {
          if (reply.length + String(delta.content).length > MAX_SYNC_RESPONSE_CHARS) throw new Error("Resposta de sincronização grande demais");
          ensureRow();
          reply += delta.content;
          segmentReply += delta.content;
          if (!responseBubble) { responseBubble = document.createElement("div"); responseBubble.className = "bubble bot"; activeColumn().appendChild(responseBubble); }
          scheduleMarkdownRender(responseBubble, segmentReply);
          scrollToBottom();
        }
      }
    }

    if (responseBubble) renderMarkdown(responseBubble, segmentReply);
    finalizeThinkingSegment(activity);
    // O replay de sync nunca monta os botões de ação (copiar/tentar
    // novamente) porque, ao contrário do streaming ao vivo, não passa pelo
    // trecho que os cria junto com a bolha. Sem isso a mensagem sincronizada
    // fica sem copiar/retry até a página ser recarregada do zero.
    if (activeColumn() && !syncFailed && !syncMissing && (activeBubble() || msgAttachments.length) && !activeColumn().querySelector(".msg-actions")) {
      const actions = document.createElement("div"); actions.className = "msg-actions";
      const copyBtn = document.createElement("button"); copyBtn.className = "msg-action-btn";
      copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copiar`;
      copyBtn.addEventListener("click", () => copyText(activeBubble()?._rawText ?? reply, copyBtn));
      const regenBtn = document.createElement("button"); regenBtn.className = "msg-action-btn msg-regenerate-btn";
      regenBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.27"/></svg> Tentar novamente`;
      regenBtn.addEventListener("click", () => {
        const row = activeRow();
        const bubble = activeBubble();
        if (row && bubble) void regenerate(row, bubble, actions);
      });
      actions.appendChild(copyBtn); actions.appendChild(regenBtn);
      activeColumn().appendChild(actions);
    }
    if (syncFailed) {
      activeRow()?.remove();
      clearPendingGen();
      appendMessage("bot", `Erro: ${syncFailureMessage || "A resposta não pôde ser reconstruída."}`);
      return false;
    }
    if (syncMissing) {
      clearPendingGen();
      if (!reply && !msgAttachments.length) appendMessage("bot", "A geração não está mais disponível. Tente enviar a mensagem novamente.");
      return false;
    }
    if (sawDone || syncMissing) clearPendingGen();
    if (reply || msgAttachments.length) {
      // Dedupe by genId rather than text equality, since the reconstructed
      // reply can differ slightly from the original render.
      const alreadyAppended = (previousAssistant?.genId === genId) || messages.some(m => m.role === "assistant" && m.genId === genId);
      if (alreadyAppended) {
        activeRow()?.remove();
      } else {
        messages.push({ role: "assistant", content: reply, ...(msgAttachments.length ? { attachments: msgAttachments } : {}), genId });
      }
      saveCurrentMessages();
      refreshPersistedThinkingSummary({
        // The pending marker was cleared above once the replay reached DONE;
        // the active chat is the authoritative scope for this DOM update.
        chatId: localStorage.getItem(ACTIVE_KEY),
        genId,
        activity,
        assistantMessage: messages.find(message => message?.role === "assistant" && message.genId === genId) ?? { role: "assistant", content: reply, genId },
      });
      updateRegenerateAvailability();
      if (responseBubble) responseBubble._rawText = reply;
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError" && userStoppedGeneration) return false;
    if (getPendingGen()?.genId === genId) {
      showSyncBanner(genId);
      schedulePendingSync(genId);
    } else {
      ensureRow();
      appendMessage("bot", "Não foi possível sincronizar agora. Tente de novo em instantes.");
    }
    return false;
  } finally {
    if (inactivityTimer !== null) clearTimeout(inactivityTimer);
    if (syncAbortController === controller) syncAbortController = null;
    if (currentAbortController === controller) currentAbortController = null;
    loading = false; hideStopBtn(); currentGenId = null;
    if (userStoppedGeneration) userStoppedGeneration = false;
  }
}

const BOREAS_WORK_STATUS_LABELS = [
  "Pensando...",
  "Processando...",
  "Trabalhando...",
  "Preparando...",
  "Analisando...",
  "Gerando...",
  "Executando...",
  "Aguarde...",
];

function boreasRandomWorkStatus(): string {
  return BOREAS_WORK_STATUS_LABELS[Math.floor(Math.random() * BOREAS_WORK_STATUS_LABELS.length)];
}

function startElapsedTicker(getBubbleEl: () => HTMLElement | null, startTime: number): () => void {
  const intervalId = setInterval(() => {
    const b = getBubbleEl();
    const label = b?.querySelector(".work-status-label")?.textContent || "";
    if (!b || !label) return;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    b.innerHTML = `<span class="work-status-label">${label}</span><span class="work-status-elapsed">${elapsed}s</span><span style="display:inline-flex;gap:3px;margin-left:6px;vertical-align:middle"><span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span></span>`;
  }, 1000);
  return () => clearInterval(intervalId); // stop() - idempotente
}

// No server chunk at all (not even "gen_id") within this window means the
// generation stalled before it even started. Aborts and lets the user
// retry, instead of waiting for the fetch's generic 90s timeout.
const NO_RESPONSE_TIMEOUT_MS = 20000;
function startNoResponseWatchdog(_getBubbleEl: () => HTMLElement | null, onExpire: () => void): () => void {
  const timer = setTimeout(onExpire, NO_RESPONSE_TIMEOUT_MS);
  return () => clearTimeout(timer); // stop()
}

function showNoResponseError(retryFn: () => void): void {
  removeTyping();
  document.getElementById("sync-banner")?.remove();
  document.getElementById("no-response-banner")?.remove();
  const banner = document.createElement("div");
  banner.id = "no-response-banner";
  banner.className = "resume-banner-el";
  banner.innerHTML = `<span>⏱️ Sem resposta, cancelado automaticamente.</span><button id="no-response-retry-btn">Tentar novamente ↻</button>`;
  messagesContainer.appendChild(banner);
  scrollToBottom();
  document.getElementById("no-response-retry-btn")!.addEventListener("click", () => {
    banner.remove();
    retryFn();
  }, { once: true });
}

// The send button always reverts to the official PNG after "stop" mode.
// Stop mode keeps using the inline square, a separate state.
const SEND_ICON = `<img src="https://raw.githubusercontent.com/VggxYT-i-use-arch-btw/chatly/main/send_msg.png" alt="Enviar mensagem" draggable="false">`;
const STOP_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--bg)"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;

function showStopBtn(): void {
  renderSendButton.innerHTML = STOP_ICON;
  renderSendButton.classList.add("stop-mode");
  renderSendButton.disabled = false;
}
function hideStopBtn(): void {
  renderSendButton.innerHTML = SEND_ICON;
  renderSendButton.classList.remove("stop-mode");
  renderSendButton.disabled = !renderMessageInput.value.trim() && !pendingImages.length && !pendingFile;
}

renderSendButton.addEventListener("click", () => {
  if (loading && (currentAbortController || syncAbortController)) {
    userStoppedGeneration = true;
    try { currentAbortController?.abort(); } catch {}
    try { syncAbortController?.abort(); } catch {}

    if (currentGenId) {
      globalThis.BoreasApi.rawFetch(`${BACKEND_URL}/chat/stop`, {
        method: "POST",
        headers: BoreasSessionHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ genId: currentGenId }),
        keepalive: true,
      }).catch(() => {});
    }
    clearPendingGen();
  } else if (!loading) {
    send();
  }
});

export {};
