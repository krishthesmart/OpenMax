export type Role = "system" | "user" | "assistant" | "tool";
export interface ImagePart { mime: string; data: string } // base64
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface Message {
  role: Role;
  content: string;
  images?: ImagePart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export type Dialect = "openai" | "anthropic" | "ollama";

export interface LLMRequest {
  messages: Message[];
  model: string; // "provider:model"
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  attachments?: ImagePart[];
  signal?: AbortSignal;
  json?: boolean;
  keepAlive?: string;
}
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "done"; finish?: string };

export class ProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public status = 0,
    public retryAfterSec?: number,
    public fix?: string,
  ) { super(message); this.name = "ProviderError"; }
  get isRateLimit() { return this.status === 429; }
}

export function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf(":");
  if (i < 0) return { provider: ref, model: "" };
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export interface ProviderDef {
  id: string;
  label: string;
  dialect: Dialect;
  paid: boolean;
  local: boolean;
  baseUrl: () => string;
  apiKey: () => string;
  keyEnv: string;
  fixHint: string;
}
