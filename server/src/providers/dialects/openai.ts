import type { LLMRequest, Message, StreamEvent, ToolCall } from "../types.js";
import { readSSE } from "./sse.js";

export function toOpenAIMessages(msgs: Message[], extraImages: LLMRequest["attachments"] = []) {
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  return msgs.map((m, i) => {
    const imgs = [...(m.images ?? []), ...(i === lastUserIdx ? extraImages ?? [] : [])];
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length)
      return {
        role: "assistant", content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      };
    if (imgs.length)
      return {
        role: m.role,
        content: [{ type: "text", text: m.content }, ...imgs.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } }))],
      };
    return { role: m.role, content: m.content };
  });
}

export function buildOpenAIBody(req: LLMRequest, model: string) {
  const body: Record<string, unknown> = {
    model, messages: toOpenAIMessages(req.messages, req.attachments), stream: true,
    stream_options: { include_usage: true },
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.json) body.response_format = { type: "json_object" };
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return body;
}

export async function* parseOpenAIStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish: string | undefined;
  for await (const { data } of readSSE(body)) {
    if (data === "[DONE]") break;
    let j: any;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    const ch = j.choices?.[0];
    const d = ch?.delta;
    if (d?.content) yield { type: "text", text: d.content };
    const r = d?.reasoning_content ?? d?.reasoning;
    if (typeof r === "string" && r) yield { type: "reasoning", text: r };
    for (const tc of d?.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const cur = calls.get(i) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(i, cur);
    }
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (j.usage) yield { type: "usage", tokensIn: j.usage.prompt_tokens ?? 0, tokensOut: j.usage.completion_tokens ?? 0 };
  }
  for (const c of calls.values()) {
    let args: Record<string, unknown> = {};
    try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { _raw: c.args }; }
    const call: ToolCall = { id: c.id || `call_${Math.random().toString(36).slice(2, 8)}`, name: c.name, args };
    yield { type: "tool_call", call };
  }
  yield { type: "done", finish };
}
