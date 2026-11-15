export type MessageRole = "user" | "assistant" | "bot";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export interface TextFilePart {
  type: "text_file";
  text_file: { name: string; content: string };
}

export type MessagePart = TextPart | ImagePart | TextFilePart;

export type MessageAttachment =
  | { type: "file"; name: string; data: string; mime: string }
  | { type: "deep_research"; title?: string; percent?: number; step?: number; done?: boolean }
  | { type: "agentic_loop"; plan?: string; percent?: number; stage?: number; summary?: string; converged?: boolean }
  | { type: "ask_user_prompt"; promptId: string; questions: unknown[]; answers: unknown; timedOut: boolean }
  | { type: "sources"; results: unknown[] };

export interface ToolStep {
  tool: string;
  value: string;
  id?: string;
  output?: unknown;
}

export interface ChatMessage {
  [key: string]: unknown;
  role: MessageRole;
  content: string | MessagePart[];
  attachments?: MessageAttachment[];
  thinking?: string;
  steps?: ToolStep[];
  activity?: Array<{ type: "thinking" } | ({ type: "tool" } & ToolStep)>;
  thinkingSummary?: unknown;
}

export interface Conversation {
  [key: string]: unknown;
  id: string;
  title: string;
  messages: ChatMessage[];
  tier?: string;
  speed?: string;
  effort?: string;
  createdAt?: string;
  updatedAt?: string;
  hasMessages?: boolean;
  memoryEnabled?: boolean;
}

export interface ResumeConversationResponse {
  resumed?: boolean;
  reason?: string;
  charsBefore?: number;
  charsAfter?: number;
  messagesCompacted?: number;
}

export interface PendingFile {
  name: string;
  content: string;
  type: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  chatId: string;
  tier: string;
  speed: string;
  effort: string;
  plugin?: string | null;
}

export type ChatStreamEvent =
  | { type: "gen_id"; id: string }
  | { type: "step"; tool: string; value: string; id?: string; output?: unknown }
  | { type: "thinking_started" | "heartbeat" | "length_cut" | "sync_missing" }
  | { type: "tier_used"; tier: string; speed?: string; effort?: string }
  | { type: "sources"; results: unknown[] }
  | { type: "error"; message: string }
  | { type: "sync_truncated"; message: string }
  | { type: "ask_user_prompt_stale"; promptId: string }
  | { type: "token_exhausted"; remaining: number; total: number }
  | { type: "file"; name: string; data: string; mime: string }
  | { type: "deep_research"; percent: number; title?: string; step?: number; label?: string; done?: boolean }
  | { type: "agentic_loop"; percent: number; stage?: number; summary?: string; plan?: string; done?: boolean }
  | { type: "ask_user_prompt"; promptId: string; questions: unknown[] }
  | { type: "choices"; choices: Array<{ delta: { content?: string; reasoning_content?: string } }> }

export type ChatState = {
  conversations: Conversation[];
  activeConversationId: string | null;
  status: "idle" | "loading" | "streaming" | "error";
  error: string | null;
  currentGenerationId: string | null;
};
