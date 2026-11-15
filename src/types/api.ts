export type AuthMode = "login" | "register";

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest extends LoginRequest {
  name: string;
  use: string;
}

export type AuthRequest = LoginRequest | RegisterRequest;

export interface SessionResponse {
  sessionScope?: string;
}

export interface AuthResponse {
  sessionScope?: string;
  name?: string;
  use?: string;
  error?: string;
}

export interface BackendResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

export interface UsagePeriod {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  requests?: number;
}

export interface UsageResponse {
  stats?: Record<string, UsagePeriod>;
}

export interface MemoryResponse {
  memory?: string;
  lastUpdate?: number;
  enabled?: boolean;
}
