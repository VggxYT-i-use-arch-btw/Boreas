import type { AuthMode, AuthRequest, AuthResponse, BackendResponse, SessionResponse } from "../types/api";
import type { ChatRequest, ChatStreamEvent } from "../types/chat";
import { apiFetch } from "./transport";
import { backendBaseUrl } from "../config/backend";

const backendUrl = (): string => backendBaseUrl;

export function rawFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return apiFetch(input, init);
}

async function readObject<T>(response: Response): Promise<T> {
  const value: unknown = await response.json().catch(() => ({}));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {} as T;
  return value as T;
}

export async function getSession(): Promise<BackendResponse<SessionResponse>> {
  const response = await rawFetch(new URL("/session", backendUrl()), {
    credentials: "include",
    cache: "no-store",
  });
  return { ok: response.ok, status: response.status, data: await readObject<SessionResponse>(response) };
}

export async function authenticate(
  mode: AuthMode,
  payload: AuthRequest,
): Promise<BackendResponse<AuthResponse>> {
  const endpoint = mode === "register" ? "/register" : "/login";
  const response = await rawFetch(new URL(endpoint, backendUrl()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  return { ok: response.ok, status: response.status, data: await readObject<AuthResponse>(response) };
}

export async function request<TResponse>(path: string, init: RequestInit = {}): Promise<TResponse> {
  const response = await rawFetch(new URL(path, backendUrl() || location.origin), {
    credentials: "include",
    ...init,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as TResponse;
}

export async function openChatStream(body: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const response = await rawFetch(backendUrl() || location.origin, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

export function parseStreamEvent(data: string): ChatStreamEvent | "[DONE]" | null {
  if (data === "[DONE]") return data;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) return null;
    if ("choices" in value && Array.isArray(value.choices)) {
      const choice = value.choices[0];
      if (typeof choice !== "object" || choice === null || !("delta" in choice)) return null;
      const delta = choice.delta;
      if (typeof delta !== "object" || delta === null) return null;
      if (("content" in delta && typeof delta.content !== "string") ||
          ("reasoning_content" in delta && typeof delta.reasoning_content !== "string")) return null;
      return { type: "choices", choices: value.choices as Extract<ChatStreamEvent, { type: "choices" }>["choices"] };
    }
    if (!("type" in value) || typeof value.type !== "string") return null;
    const event = value as Record<string, unknown>;
    const hasString = (...keys: string[]) => keys.every(key => typeof event[key] === "string");
    const hasNumber = (...keys: string[]) => keys.every(key => typeof event[key] === "number" && Number.isFinite(event[key]));
    switch (event.type) {
      case "gen_id": return hasString("id") ? { type: "gen_id", id: event.id as string } : null;
      case "step": return hasString("tool", "value") ? { type: "step", tool: event.tool as string, value: event.value as string, ...(typeof event.id === "string" ? { id: event.id } : {}), ...(Object.hasOwn(event, "output") ? { output: event.output } : {}) } : null;
      case "thinking_started": case "heartbeat": case "length_cut": case "sync_missing": return { type: event.type };
      case "tier_used": return hasString("tier") ? { type: "tier_used", tier: event.tier as string, ...(typeof event.speed === "string" ? { speed: event.speed } : {}), ...(typeof event.effort === "string" ? { effort: event.effort } : {}) } : null;
      case "sources": return Array.isArray(event.results) ? { type: "sources", results: event.results } : null;
      case "error": case "sync_truncated": return hasString("message") ? { type: event.type, message: event.message as string } : null;
      case "ask_user_prompt_stale": return hasString("promptId") ? { type: "ask_user_prompt_stale", promptId: event.promptId as string } : null;
      case "token_exhausted": return hasNumber("remaining", "total") ? { type: "token_exhausted", remaining: event.remaining as number, total: event.total as number } : null;
      case "file": return hasString("name", "data", "mime") ? { type: "file", name: event.name as string, data: event.data as string, mime: event.mime as string } : null;
      case "deep_research": return hasNumber("percent") ? { type: "deep_research", percent: event.percent as number, ...(typeof event.title === "string" ? { title: event.title } : {}), ...(typeof event.step === "number" ? { step: event.step } : {}), ...(typeof event.label === "string" ? { label: event.label } : {}), ...(typeof event.done === "boolean" ? { done: event.done } : {}) } : null;
      case "agentic_loop": return hasNumber("percent") ? { type: "agentic_loop", percent: event.percent as number, ...(typeof event.stage === "number" ? { stage: event.stage } : {}), ...(typeof event.summary === "string" ? { summary: event.summary } : {}), ...(typeof event.plan === "string" ? { plan: event.plan } : {}), ...(typeof event.done === "boolean" ? { done: event.done } : {}) } : null;
      case "ask_user_prompt": return hasString("promptId") && Array.isArray(event.questions) ? { type: "ask_user_prompt", promptId: event.promptId as string, questions: event.questions } : null;
      default: return null;
    }
  } catch {
    return null;
  }
}
