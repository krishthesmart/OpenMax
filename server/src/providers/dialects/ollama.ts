import type { LLMRequest, StreamEvent, ToolCall } from "../types.js";
import { readLines } from "./sse.js";

export function buildOllamaBody(req: LLMRequest, model: string) {
  const lastUserIdx = req.messages.map((m) => m.role).lastIndexOf("user");
  const messages = req.messages.map((m, i) => {
    const imgs = [...(m.images ?? []), ...(i === lastUserIdx ? req.attachments ?? [] : [])];
    const o: Record<string, unknown> = { role: m.role, content: m.content };
    if (imgs.length) o.images = imgs.map((x) => x.data);
    if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
    if (m.role === "tool" && m.name) o.tool_name = m.name;
    return o;
  });
  const body: Record<string, unknown> = { model, messages, stream: true, keep_alive: req.keepAlive ?? "30m" };
  const options: Record<string, unknown> = { repeat_penalty: 1.12 };
  if (req.temperature !== undefined) options.temperature = req.temperature;
  if (req.maxTokens) options.num_predict = req.maxTokens;
  body.options = options;
  if (req.json) body.format = "json";
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return body;
}

export async function* parseOllamaStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  let n = 0;
  for await (const line of readLines(body)) {
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.error) throw new Error(j.error);
    if (j.message?.thinking) yield { type: "reasoning", text: j.message.thinking };
    if (j.message?.content) yield { type: "text", text: j.message.content };
    for (const tc of j.message?.tool_calls ?? []) {
      const call: ToolCall = { id: `call_${n++}`, name: tc.function?.name, args: tc.function?.arguments ?? {} };
      yield { type: "tool_call", call };
    }
    if (j.done) {
      yield { type: "usage", tokensIn: j.prompt_eval_count ?? 0, tokensOut: j.eval_count ?? 0 };
      yield { type: "done", finish: j.done_reason };
    }
  }
}
