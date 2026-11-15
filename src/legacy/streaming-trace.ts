// Unified thinking/tools trace and replay.
// ── Unified thinking/tools trace ──────────────────────────────────────────
// These definitions intentionally keep the public function names used by the
// streaming and history modules above. The old segment implementation is
// retained for compatibility with older saved data, while this single trace
// shell is now the only live/replayed visual surface.
import type { ToolStep } from "../types/chat";
type TracePhase = { title: string; body: string };
type TraceSummary = { segments: Array<{ segmentIndex: number; phases: TracePhase[] }> };
type TraceEntry = { kind: "thinking" | "tool" | "subagent"; id?: string; segmentIndex?: number; items?: HTMLElement[]; raw?: string; summaryEls?: HTMLElement[]; item?: HTMLElement; agentsEl?: HTMLElement };
type TraceView = { pill: HTMLButtonElement; detail: HTMLElement; timeline: HTMLElement; items: TraceEntry[]; toolMap: Map<string, TraceEntry>; running: boolean; expanded: boolean; current?: TraceEntry | { kind: "tool"; itemsEl: HTMLElement } | null; nextThinkingSegmentIndex?: number; thinkingSummary?: unknown; completedEl?: HTMLElement };
export type ActivityState = { trace?: TraceView | null; thinkingSummary?: unknown };
type Subagent = Record<string, unknown>;
const requiredTrace = <T extends Element = HTMLElement>(parent: ParentNode, selector: string): T => parent.querySelector(selector) as T;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function BOREAS_traceIcon(tool: string): string {
  const icons: Record<string, string> = {
    thinking: "ph-lightbulb",
    BASH: "ph-terminal-window",
    WEB_SEARCH: "ph-globe-hemisphere-west",
    MEMORY: "ph-pencil-simple",
    INVOKE_SUBAGENTS: "ph-share-network",
    WEB_FETCH: "ph-globe",
    STR_REPLACE: "ph-pencil-line",
    CREATE_FILE: "ph-file-plus",
    DELETE: "ph-trash",
    SEND_FILE: "ph-file-arrow-up",
    CALCULATOR: "ph-function",
    GRAPH: "ph-chart-line-up",
    ASK_USER: "ph-question",
  };
  return `<i class="ph ${icons[tool] ?? "ph-wrench"}" aria-hidden="true"></i>`;
}

function BOREAS_traceText(value: unknown, max = 150): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function BOREAS_traceEnsure(state: ActivityState, mountFn: (pill: HTMLButtonElement, detail: HTMLElement) => void): TraceView {
  if (state.trace) return state.trace;
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "thinking-trace-toggle";
  pill.setAttribute("aria-expanded", "false");
  pill.innerHTML = `<span class="thinking-trace-current-dot is-running" aria-hidden="true"></span><span class="thinking-trace-preview"></span><span class="thinking-trace-chevron" aria-hidden="true"><i class="ph ph-caret-right"></i></span>`;
  const detail = document.createElement("div");
  detail.className = "thinking-trace-detail";
  const timeline = document.createElement("div");
  timeline.className = "thinking-trace-timeline";
  detail.appendChild(timeline);
  const trace: TraceView = { pill, detail, timeline, items: [], toolMap: new Map<string, TraceEntry>(), running: true, expanded: false };
  pill.addEventListener("click", () => {
    trace.expanded = !trace.expanded;
    trace.pill.classList.toggle("is-expanded", trace.expanded);
    trace.detail.classList.toggle("visible", trace.expanded);
    trace.pill.setAttribute("aria-expanded", String(trace.expanded));
    requiredTrace<HTMLElement>(trace.pill, ".thinking-trace-preview").classList.remove("is-shimmer");
    if (trace.expanded) requiredTrace<HTMLElement>(trace.pill, ".thinking-trace-preview").textContent = "Etapas";
  });
  mountFn(pill, detail);
  state.trace = trace;
  return trace;
}

function BOREAS_traceSetPreview(state: ActivityState, text: string): void {
  const trace = state?.trace;
  if (!trace || trace.expanded) return;
  const preview = requiredTrace<HTMLElement>(trace.pill, ".thinking-trace-preview");
  preview.textContent = BOREAS_traceText(text, 128) || "Processando";
  if (trace.running) preview.classList.add("is-shimmer");
}

function BOREAS_traceNormalizeSummary(summary: unknown): TraceSummary {
  if (typeof summary === "string" && summary.trim()) {
    return { segments: [{ segmentIndex: 0, phases: [{ title: "Raciocínio", body: summary.trim() }] }] };
  }
  if (Array.isArray(summary)) {
    const phases = summary.filter((item): item is TracePhase => isRecord(item) && typeof item.title === "string" && typeof item.body === "string");
    return { segments: phases.length ? [{ segmentIndex: 0, phases }] : [] };
  }
  if (!isRecord(summary) || !Array.isArray(summary.segments)) return { segments: [] };
  return {
    segments: summary.segments.map((rawSegment, index) => {
      const segment = isRecord(rawSegment) ? rawSegment : {};
      return {
      segmentIndex: typeof segment.segmentIndex === "number" && Number.isInteger(segment.segmentIndex) ? segment.segmentIndex : index,
      phases: Array.isArray(segment.phases)
        ? segment.phases.filter((item): item is TracePhase => isRecord(item) && typeof item.title === "string" && typeof item.body === "string").slice(0, 4)
        : [],
    }; }).filter(segment => segment.phases.length),
  };
}

function BOREAS_tracePhasesForSegment(summary: unknown, segmentIndex: number): TracePhase[] {
  const normalized = BOREAS_traceNormalizeSummary(summary);
  return normalized.segments.find(segment => segment.segmentIndex === segmentIndex)?.phases ?? [];
}

function BOREAS_traceBuildThinkingItem(phase: TracePhase): { item: HTMLElement; summaryEl: HTMLElement } {
  const item = document.createElement("div");
  item.className = "thinking-trace-item trace-thinking";
  item.innerHTML = `<span class="thinking-trace-item-icon">${BOREAS_traceIcon("thinking")}</span><div class="thinking-trace-item-main"><div class="thinking-trace-item-title"></div><div class="thinking-trace-item-summary"></div></div>`;
  requiredTrace<HTMLElement>(item, ".thinking-trace-item-title").textContent = String(phase.title || "Analisando o raciocínio");
  const summaryEl = requiredTrace<HTMLElement>(item, ".thinking-trace-item-summary");
  summaryEl.textContent = String(phase.body || "Resumo sendo preparado…");
  return { item, summaryEl };
}

function BOREAS_traceCreateThinking(state: ActivityState, summary: unknown, segmentIndex = 0): TraceEntry {
  const trace = state.trace!;
  const phases = BOREAS_tracePhasesForSegment(summary, segmentIndex);
  const visiblePhases = phases.length ? phases : [{ title: "Analisando o raciocínio", body: "Resumo sendo preparado…" }];
  const built = visiblePhases.map(phase => BOREAS_traceBuildThinkingItem(phase));
  trace.timeline.append(...built.map(part => part.item));
  const entry: TraceEntry = {
    kind: "thinking",
    segmentIndex,
    items: built.map(part => part.item),
    raw: "",
    summaryEls: built.map(part => part.summaryEl),
  };
  trace.items.push(entry);
  const latestPhase = phases.at(-1);
  BOREAS_traceSetPreview(state, latestPhase?.title || "Pensando…");
  return entry;
}

function ensureThinkingSegment(state: ActivityState, mountFn: (pill: HTMLButtonElement, detail: HTMLElement) => void): TraceEntry {
  BOREAS_traceEnsure(state, mountFn);
  const trace = state.trace!;
  if (trace.current?.kind === "thinking") return trace.current as TraceEntry;
  const segmentIndex = trace.nextThinkingSegmentIndex ?? 0;
  trace.nextThinkingSegmentIndex = segmentIndex + 1;
  trace.current = BOREAS_traceCreateThinking(state, state.thinkingSummary, segmentIndex);
  return trace.current as TraceEntry;
}

function finalizeThinkingSegment(state: ActivityState): void {
  const trace = state?.trace;
  if (!trace) return;
  trace.running = false;
  trace.items.filter(item => item.kind === "thinking").forEach(entry => {
    entry.summaryEls?.forEach(summaryEl => {
      if (summaryEl.textContent === "Resumo sendo preparado…") summaryEl.textContent = "Resumo indisponível.";
    });
  });
  trace.pill.classList.add("is-complete");
  requiredTrace<HTMLElement>(trace.pill, ".thinking-trace-current-dot").classList.remove("is-running");
  const preview = requiredTrace<HTMLElement>(trace.pill, ".thinking-trace-preview");
  preview.classList.remove("is-shimmer");
  if (!trace.expanded) preview.textContent = "Concluído";
  if (!trace.completedEl) {
    trace.completedEl = document.createElement("div");
    trace.completedEl.className = "thinking-trace-completed";
    trace.completedEl.innerHTML = `<i class="ph ph-check-circle" aria-hidden="true"></i><span>Concluído</span>`;
    trace.timeline.appendChild(trace.completedEl);
  }
}

function ensureToolSegment(state: ActivityState, mountFn: (pill: HTMLButtonElement, detail: HTMLElement) => void): { kind: "tool"; itemsEl: HTMLElement } {
  BOREAS_traceEnsure(state, mountFn);
  const segment = { kind: "tool" as const, itemsEl: state.trace!.timeline };
  state.trace!.current = segment;
  return segment;
}

function BOREAS_traceToolTitle(tool: string, value: unknown): string {
  if (tool === "BASH") return BOREAS_traceText(value, 220) || "Executando comando";
  if (tool === "WEB_SEARCH") return `Procurei por "${String(value ?? "").trim()}"`;
  return (TOOL_ACTIVITY_LABELS as Record<string, string>)[tool] ?? (BOREAS_traceText(value, 150) || "Usando ferramenta");
}

function BOREAS_traceOutput(item: HTMLElement, output: unknown): void {
  if (output === undefined || output === null || String(output).trim() === "") return;
  item.dataset.hasRaw = "true";
  requiredTrace<HTMLElement>(item, ".thinking-trace-raw").textContent = String(output).slice(0, 12000);
  requiredTrace<HTMLButtonElement>(item, ".thinking-trace-raw-toggle").hidden = false;
}

function BOREAS_traceCreateTool(state: ActivityState, step: ToolStep): TraceEntry {
  const trace = state.trace!;
  const tool = String(step.tool ?? "");
  const lineOnly = tool === "WEB_SEARCH" || tool === "MEMORY";
  const item = document.createElement("div");
  item.className = `thinking-trace-item trace-tool ${lineOnly ? "trace-line-only" : ""}`;
  item.innerHTML = `<span class="thinking-trace-item-icon">${BOREAS_traceIcon(tool)}</span><div class="thinking-trace-item-main"><div class="thinking-trace-item-title"></div><div class="thinking-trace-item-summary"></div><button type="button" class="thinking-trace-raw-toggle" hidden>Ver saída bruta</button><pre class="thinking-trace-raw"></pre></div>`;
  const title = requiredTrace<HTMLElement>(item, ".thinking-trace-item-title");
  title.textContent = tool === "MEMORY" ? "Memória atualizada" : BOREAS_traceToolTitle(tool, step.value);
  if (tool === "WEB_SEARCH") requiredTrace<HTMLElement>(item, ".thinking-trace-item-summary").remove();
  if (tool === "MEMORY") item.classList.add("trace-memory");
  const rawToggle = requiredTrace<HTMLButtonElement>(item, ".thinking-trace-raw-toggle");
  rawToggle.addEventListener("click", event => {
    event.stopPropagation();
    item.classList.toggle("raw-visible");
  });
  trace.timeline.appendChild(item);
  const entry: TraceEntry = { kind: "tool", id: step.id, item };
  trace.items.push(entry);
  BOREAS_traceOutput(item, step.output);
  BOREAS_traceSetPreview(state, title.textContent ?? "");
  return entry;
}

function BOREAS_traceCreateSubagent(state: ActivityState, step: ToolStep): TraceEntry {
  const trace = state.trace!;
  let snapshot: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(step.value || "{}"); if (isRecord(parsed)) snapshot = parsed; } catch {}
  let result: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(String(step.output ?? "{}")); if (isRecord(parsed)) result = parsed; } catch {}
  const currentAgents = Array.isArray(result.agents) && result.agents.length ? result.agents : (Array.isArray(snapshot.agents) ? snapshot.agents : []);
  const agents = currentAgents.filter(isRecord) as Subagent[];
  const mapKey = step.id ?? "";
  let entry = trace.toolMap.get(mapKey);
  if (!entry) {
    const item = document.createElement("div");
    item.className = "thinking-trace-item trace-subagent";
    item.innerHTML = `<span class="thinking-trace-item-icon">${BOREAS_traceIcon("INVOKE_SUBAGENTS")}</span><div class="thinking-trace-item-main"><div class="thinking-trace-item-title">Executando subagente</div><div class="subagent-trace-card"><div class="subagent-trace-agents"></div></div></div>`;
    trace.timeline.appendChild(item);
    entry = { kind: "subagent", id: step.id, item, agentsEl: requiredTrace<HTMLElement>(item, ".subagent-trace-agents") };
    trace.items.push(entry);
    trace.toolMap.set(mapKey, entry);
  }
  const agentsEl = entry.agentsEl!;
  agentsEl.replaceChildren();
  agents.forEach((agent: Subagent) => {
    const agentEl = document.createElement("div");
    agentEl.className = "subagent-trace-agent";
    const finished = new Set(["done", "completed", "failed", "stopped", "max_rounds"]).has(String(agent.status));
    if (finished) agentEl.classList.add("is-complete");
    if (["failed", "stopped", "max_rounds"].includes(String(agent.status))) agentEl.classList.add("is-failed");
    const name = document.createElement("div");
    name.className = "subagent-trace-name";
    name.textContent = String(agent.name || agent.label || "Subagente");
    const output = document.createElement("div");
    output.className = "subagent-trace-output";
    output.textContent = String(agent.output || (finished ? agent.error || "Sem resposta." : "Executando…"));
    agentEl.append(name, output);
    agentsEl.appendChild(agentEl);
  });
  const allFinished = agents.length > 0 && agents.every((agent: Subagent) => new Set(["done", "completed", "failed", "stopped", "max_rounds"]).has(String(agent.status)));
  BOREAS_traceSetPreview(state, allFinished ? "Subagentes concluídos" : agents.length ? `Executando ${agents.length} subagente${agents.length === 1 ? "" : "s"}` : "Executando subagente");
  return entry;
}

function ensureToolActivityCard(container: HTMLElement | null, step: ToolStep | null | undefined, activityState: ActivityState, mountFn: (pill: HTMLButtonElement, detail: HTMLElement) => void): HTMLElement | null {
  if (!container || !step) return null;
  BOREAS_traceEnsure(activityState, mountFn);
  if (step.tool === "INVOKE_SUBAGENTS") {
    const entry = BOREAS_traceCreateSubagent(activityState, step);
    activityState.trace!.current = entry;
    return entry.item ?? null;
  }
  const id = step.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let entry = activityState.trace!.toolMap.get(id);
  if (!entry) {
    entry = BOREAS_traceCreateTool(activityState, { ...step, id });
    activityState.trace!.toolMap.set(id, entry);
  } else {
    requiredTrace<HTMLElement>(entry.item!, ".thinking-trace-item-title").textContent = step.tool === "MEMORY" ? "Memória atualizada" : BOREAS_traceToolTitle(step.tool, step.value);
    BOREAS_traceOutput(entry.item!, step.output);
  }
  activityState.trace!.current = entry;
  return entry.item ?? null;
}

function closeActivitySegment(state: ActivityState): void {
  if (state?.trace) state.trace.current = null;
}

export {};
