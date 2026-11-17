import type { LLMRequest, StreamEvent, ToolCall } from "../types.js";
import { readSSE } from "./sse.js";

export function buildAnthropicBody(req: LLMRequest, model: string) {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const lastUserIdx = req.messages.map((m) => m.role).lastIndexOf("user");
  const messages: any[] = [];
  req.messages.forEach((m, i) => {
    if (m.role === "system") return;
    if (m.role === "tool") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] });
      return;
    }
    const imgs = [...(m.images ?? []), ...(i === lastUserIdx ? req.attachments ?? [] : [])];
    const content: any[] = [];
    for (const im of imgs) content.push({ type: "image", source: { type: "base64", media_type: im.mime, data: im.data } });
    if (m.content) content.push({ type: "text", text: m.content });
    for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
    messages.push({ role: m.role, content: content.length ? content : [{ type: "text", text: "" }] });
  });
  const body: Record<string, unknown> = { model, messages, max_tokens: req.maxTokens ?? 4096, stream: true };
  if (system) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  return body;
}

export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  let tin = 0, tout = 0, finish: string | undefined;
  for await (const { data } of readSSE(body)) {
    let j: any;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.type === "error") throw new Error(j.error?.message ?? "anthropic stream error");
    if (j.type === "message_start") tin = j.message?.usage?.input_tokens ?? 0;
    if (j.type === "content_block_start" && j.content_block?.type === "tool_use")
      blocks.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: "" });
    if (j.type === "content_block_delta") {
      if (j.delta?.type === "text_delta") yield { type: "text", text: j.delta.text };
      if (j.delta?.type === "thinking_delta") yield { type: "reasoning", text: j.delta.thinking };
      if (j.delta?.type === "input_json_delta") { const b = blocks.get(j.index); if (b) b.json += j.delta.partial_json; }
    }
    if (j.type === "message_delta") { tout = j.usage?.output_tokens ?? tout; finish = j.delta?.stop_reason ?? finish; }
  }
  for (const b of blocks.values()) {
    let args: Record<string, unknown> = {};
    try { args = b.json ? JSON.parse(b.json) : {}; } catch { args = {}; }
    const call: ToolCall = { id: b.id, name: b.name, args };
    yield { type: "tool_call", call };
  }
  yield { type: "usage", tokensIn: tin, tokensOut: tout };
  yield { type: "done", finish };
}
