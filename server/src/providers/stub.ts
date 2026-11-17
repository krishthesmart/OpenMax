import { ProviderError, type LLMRequest, type ToolCall } from "./types.js";

export interface StubReply { text: string; toolCalls?: ToolCall[]; tokensIn?: number; tokensOut?: number }
export type StubHandler = (req: LLMRequest, provider: string, model: string) => string | StubReply | Promise<string | StubReply>;

const lastUser = (req: LLMRequest) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

export const defaultStubHandler: StubHandler = (req, provider, model) => {
  const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
  const user = lastUser(req);
  if (/Reply with ONLY JSON/i.test(sys) && /"task"/.test(sys)) {
    return JSON.stringify({ task: /code|function|bug/i.test(user) ? "code" : "reasoning", reason: "stub classifier" });
  }
  if (req.json) return JSON.stringify({ ok: true });
  if (req.tools?.length && !req.messages.some((m) => m.role === "tool")) {
    const t = req.tools[0]!;
    return { text: "", toolCalls: [{ id: "call_stub", name: t.name, args: {} }] };
  }
  return `[stub ${provider}:${model}] ${user.slice(0, 200)}`;
};

let handler: StubHandler = defaultStubHandler;
export const setStubHandler = (h: StubHandler | null) => { handler = h ?? defaultStubHandler; };
/** Providers that should fail in stub mode: provider -> status code. */
const failing = new Map<string, { status: number; retryAfterSec?: number; times: number }>();
export const stubFail = (provider: string, status: number, times = 1, retryAfterSec?: number) => failing.set(provider, { status, times, retryAfterSec });
export const stubReset = () => { failing.clear(); handler = defaultStubHandler; };

export async function stubRun(req: LLMRequest, provider: string, model: string): Promise<StubReply> {
  const f = failing.get(provider);
  if (f && f.times > 0) {
    f.times--;
    throw new ProviderError(`stub ${f.status}`, provider, f.status, f.retryAfterSec);
  }
  const r = await handler(req, provider, model);
  const reply = typeof r === "string" ? { text: r } : r;
  const tin = reply.tokensIn ?? Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
  return { ...reply, tokensIn: tin, tokensOut: reply.tokensOut ?? Math.ceil(reply.text.length / 4) };
}
