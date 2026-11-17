/**
 * Test fixture ONLY (never imported by shipped code): a local HTTP server that speaks the real wire protocols of the services
 * OpenMax talks to (OpenAI-compatible, Ollama, Anthropic, SearXNG, ComfyUI, Kokoro). Tests point the real
 * provider/search/media code at it through the *_URL settings, so the actual HTTP, streaming and error paths run.
 */
import http from "node:http";
import zlib from "node:zlib";
import { ProviderError, type LLMRequest, type Message, type ToolCall } from "../src/providers/types.js";

export interface FakeReply { text: string; toolCalls?: ToolCall[]; tokensIn?: number; tokensOut?: number }
export type FakeHandler = (req: LLMRequest, provider: string, model: string) => string | FakeReply | Promise<string | FakeReply>;
export interface FakeSearchResult { title: string; url: string; snippet: string }

const lastUser = (req: LLMRequest) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
export const defaultHandler: FakeHandler = (req, provider, model) => {
  const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
  const user = lastUser(req);
  if (/Reply with ONLY JSON/i.test(sys) && /"task"/.test(sys)) return JSON.stringify({ task: /code|function|bug/i.test(user) ? "code" : "reasoning", reason: "fixture classifier" });
  if (req.json) return JSON.stringify({ ok: true });
  if (req.tools?.length && !req.messages.some((m) => m.role === "tool")) return { text: "", toolCalls: [{ id: "call_fixture", name: req.tools[0]!.name, args: {} }] };
  return `[fixture ${provider}:${model}] ${user.slice(0, 200)}`;
};

let handler: FakeHandler = defaultHandler;
const failing = new Map<string, { status: number; retryAfterSec?: number; times: number }>();
let searchFn: (q: string) => FakeSearchResult[] = (q) => [
  { title: `Result one for ${q}`, url: "https://example.test/a", snippet: `Snippet about ${q}.` },
  { title: `Result two for ${q}`, url: "https://example.test/b", snippet: `More detail on ${q}.` },
];
let transcript = "this is a transcript";
export const catalogs: Record<string, any[]> = {};
export const setStubHandler = (h: FakeHandler | null) => { handler = h ?? defaultHandler; };
export const stubFail = (provider: string, status: number, times = 1, retryAfterSec?: number) => failing.set(provider, { status, times, retryAfterSec });
export const setStubSearch = (f: (q: string) => FakeSearchResult[]) => { searchFn = f; };
export const setTranscript = (t: string) => { transcript = t; };
export const stubReset = () => { handler = defaultHandler; failing.clear(); for (const k of Object.keys(catalogs)) delete catalogs[k]; transcript = "this is a transcript"; comfy.jobs.clear(); comfy.posted.length = 0; nvidiaImage.posted.length = 0; comfy.up = true; };

// ───────── binary fixtures ─────────
export function pngBuffer(w: number, h: number, rgb: [number, number, number] = [90, 120, 200]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = (rgb[2] + x) & 255; } }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export function wavTone(seconds = 0.3, rate = 24000, hz = 440): Buffer {
  const n = Math.round(seconds * rate), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ───────── ComfyUI protocol ─────────
export const nvidiaImage = { posted: [] as { model: string; auth: string; body: any }[] };
export const comfy = { up: true, jobs: new Map<string, { graph: any; ready: number }>(), posted: [] as any[], freed: 0, delayMs: 30 };

// ───────── wire → LLMRequest ─────────
const argsOf = (a: unknown): Record<string, unknown> => { if (typeof a === "string") { try { return JSON.parse(a); } catch { return {}; } } return (a as any) ?? {}; };
function fromOpenAI(b: any): LLMRequest {
  const messages: Message[] = (b.messages ?? []).map((m: any): Message => {
    if (m.role === "tool") return { role: "tool", content: String(m.content ?? ""), toolCallId: m.tool_call_id };
    if (Array.isArray(m.content)) return { role: m.role, content: m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join(""), images: m.content.filter((p: any) => p.type === "image_url").map((p: any) => { const mm = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url) ?? []; return { mime: mm[1] ?? "image/png", data: mm[2] ?? "" }; }) };
    const msg: Message = { role: m.role, content: String(m.content ?? "") };
    if (m.tool_calls?.length) msg.toolCalls = m.tool_calls.map((c: any) => ({ id: c.id, name: c.function.name, args: argsOf(c.function.arguments) }));
    return msg;
  });
  return { model: b.model, messages, temperature: b.temperature, maxTokens: b.max_tokens, json: b.response_format?.type === "json_object", tools: b.tools?.map((t: any) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) };
}
function fromOllama(b: any): LLMRequest {
  const messages: Message[] = (b.messages ?? []).map((m: any): Message => {
    const msg: Message = { role: m.role, content: String(m.content ?? ""), ...(m.images?.length ? { images: m.images.map((d: string) => ({ mime: "image/png", data: d })) } : {}) };
    if (m.role === "tool") msg.name = m.tool_name;
    if (m.tool_calls?.length) msg.toolCalls = m.tool_calls.map((c: any, i: number) => ({ id: `call_${i}`, name: c.function.name, args: argsOf(c.function.arguments) }));
    return msg;
  });
  return { model: b.model, messages, temperature: b.options?.temperature, maxTokens: b.options?.num_predict, json: b.format === "json", tools: b.tools?.map((t: any) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) };
}
function fromAnthropic(b: any): LLMRequest {
  const messages: Message[] = [];
  if (b.system) messages.push({ role: "system", content: b.system });
  for (const m of b.messages ?? []) {
    const parts: any[] = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    const tr = parts.find((p) => p.type === "tool_result");
    if (tr) { messages.push({ role: "tool", content: String(tr.content), toolCallId: tr.tool_use_id }); continue; }
    const msg: Message = { role: m.role, content: parts.filter((p) => p.type === "text").map((p) => p.text).join("") };
    const tu = parts.filter((p) => p.type === "tool_use"); if (tu.length) msg.toolCalls = tu.map((p) => ({ id: p.id, name: p.name, args: p.input }));
    messages.push(msg);
  }
  return { model: b.model, messages, temperature: b.temperature, maxTokens: b.max_tokens, tools: b.tools?.map((t: any) => ({ name: t.name, description: t.description, parameters: t.input_schema })) };
}

const readBody = (req: http.IncomingMessage) => new Promise<Buffer>((res) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });
const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };

async function runHandler(req: LLMRequest, provider: string, model: string): Promise<FakeReply> {
  const f = failing.get(provider);
  if (f && f.times > 0) { f.times--; throw new ProviderError(`fixture ${f.status}`, provider, f.status, f.retryAfterSec); }
  const r = await handler(req, provider, model);
  const reply = typeof r === "string" ? { text: r } : r;
  return { ...reply, tokensIn: reply.tokensIn ?? Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4), tokensOut: reply.tokensOut ?? Math.ceil(reply.text.length / 4) };
}
function sendError(res: http.ServerResponse, e: any) {
  const status = typeof e?.status === "number" && e.status >= 400 ? e.status : 500;
  json(res, status, { error: { message: String(e?.message ?? e) } }, e?.retryAfterSec ? { "retry-after": String(e.retryAfterSec) } : {});
}

export interface Fake { url: string; port: number; close: () => Promise<void> }
export async function startFake(): Promise<Fake> {
  const srv = http.createServer(async (rq, res) => {
    const url = new URL(rq.url ?? "/", "http://x"); const p = url.pathname;
    try {
      const prov = /^\/p\/([a-z]+)\//.exec(p)?.[1];
      // ── model lists
      if (prov && rq.method === "GET" && /\/models$/.test(p)) return json(res, 200, { data: catalogs[prov] ?? [{ id: "fixture-model" }] });
      if (prov === "ollama" && p === "/p/ollama/api/tags") return json(res, 200, { models: (catalogs.ollama ?? [{ name: "llama3.2:1b", details: { parameter_size: "1.2B" } }]) });
      if (prov === "ollama" && p === "/p/ollama/api/ps") return json(res, 200, { models: [] });
      if (prov === "ollama" && p === "/p/ollama/api/pull") { res.writeHead(200, { "content-type": "application/x-ndjson" }); for (const c of [20, 60, 100]) res.write(JSON.stringify({ status: "pulling manifest", completed: c, total: 100 }) + "\n"); return void res.end(JSON.stringify({ status: "success" }) + "\n"); }
      if (prov === "ollama" && p === "/p/ollama/api/embed") return json(res, 404, { error: "model not found" });
      // ── chat: OpenAI-compatible
      if (prov && rq.method === "POST" && /\/chat\/completions$/.test(p)) {
        const body = JSON.parse((await readBody(rq)).toString()); const req = fromOpenAI(body);
        let reply: FakeReply; try { reply = await runHandler(req, prov, body.model); } catch (e) { return sendError(res, e); }
        res.writeHead(200, { "content-type": "text/event-stream", "x-ratelimit-remaining-requests": "100", "x-ratelimit-limit-requests": "1000" });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        for (let i = 0; i < reply.text.length; i += 40) send({ choices: [{ delta: { content: reply.text.slice(i, i + 40) } }] });
        (reply.toolCalls ?? []).forEach((c, i) => send({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] }));
        send({ choices: [{ delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: reply.tokensIn, completion_tokens: reply.tokensOut } });
        res.write("data: [DONE]\n\n"); return void res.end();
      }
      // ── chat: Ollama
      if (prov === "ollama" && rq.method === "POST" && p === "/p/ollama/api/chat") {
        const body = JSON.parse((await readBody(rq)).toString()); const req = fromOllama(body);
        let reply: FakeReply; try { reply = await runHandler(req, "ollama", body.model); } catch (e) { return sendError(res, e); }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (let i = 0; i < reply.text.length; i += 40) res.write(JSON.stringify({ message: { role: "assistant", content: reply.text.slice(i, i + 40) }, done: false }) + "\n");
        for (const c of reply.toolCalls ?? []) res.write(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: c.name, arguments: c.args } }] }, done: false }) + "\n");
        return void res.end(JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: reply.tokensIn, eval_count: reply.tokensOut }) + "\n");
      }
      // ── chat: Anthropic
      if (prov === "anthropic" && rq.method === "POST" && p === "/p/anthropic/v1/messages") {
        const body = JSON.parse((await readBody(rq)).toString()); const req = fromAnthropic(body);
        let reply: FakeReply; try { reply = await runHandler(req, "anthropic", body.model); } catch (e) { return sendError(res, e); }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (o: any) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
        ev({ type: "message_start", message: { usage: { input_tokens: reply.tokensIn } } });
        if (reply.text) ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } });
        (reply.toolCalls ?? []).forEach((c, i) => { ev({ type: "content_block_start", index: i + 1, content_block: { type: "tool_use", id: c.id, name: c.name } }); ev({ type: "content_block_delta", index: i + 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.args) } }); });
        ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: reply.tokensOut } });
        return void res.end();
      }
      if (prov && /\/embeddings$/.test(p)) return json(res, 404, { error: { message: "no embedding models in the fixture" } });
      if (prov === "groq" && /\/audio\/transcriptions$/.test(p)) { await readBody(rq); return json(res, 200, { text: transcript }); }
      // ── SearXNG
      if (p === "/searx/healthz") { res.writeHead(200); return void res.end("OK"); }
      if (p === "/searx/search") return json(res, 200, { results: searchFn(url.searchParams.get("q") ?? "").map((r) => ({ ...r, content: r.snippet, engine: "fixture" })) });
      // ── Kokoro TTS
      if (p === "/kokoro/health") { res.writeHead(200); return void res.end("ok"); }
      if (p === "/kokoro/v1/audio/speech") { await readBody(rq); res.writeHead(200, { "content-type": "audio/wav" }); return void res.end(wavTone(0.3)); }
      // ── NVIDIA hosted image API (mirrors the real validation: fixed sizes, no seed)
      if (p.startsWith("/p/nvidia/genai/") && rq.method === "POST") {
        const body = JSON.parse((await readBody(rq)).toString()); nvidiaImage.posted.push({ model: p.replace("/p/nvidia/genai/", ""), auth: String(rq.headers.authorization ?? ""), body });
        const sizes = [768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344]; const detail: any[] = [];
        if ("seed" in body) detail.push({ type: "extra_forbidden", loc: ["body", "seed"], msg: "Extra inputs are not permitted" });
        for (const k of ["width", "height"]) if (!sizes.includes(body[k])) detail.push({ type: "literal_error", loc: ["body", k], msg: `Input should be ${sizes.join(", ")}` });
        if (detail.length) return json(res, 422, { detail });
        if (String(body.prompt).includes("__quota__")) return json(res, 429, { detail: "rate limited" });
        if (String(body.prompt).includes("__auth__")) return json(res, 401, { detail: "bad key" });
        const filtered = String(body.prompt).includes("__filtered__");
        return json(res, 200, { artifacts: [{ base64: pngBuffer(Math.min(64, body.width / 16), Math.min(64, body.height / 16)).toString("base64"), finishReason: filtered ? "CONTENT_FILTERED" : "SUCCESS" }] });
      }
      // ── ComfyUI
      if (p.startsWith("/comfy/")) {
        if (!comfy.up) { res.writeHead(503); return void res.end("down"); }
        if (p === "/comfy/system_stats") return json(res, 200, { system: { os: "fixture" } });
        if (p === "/comfy/upload/image") { await readBody(rq); return json(res, 200, { name: "uploaded.png", subfolder: "", type: "input" }); }
        if (p === "/comfy/free" || p === "/comfy/interrupt") { await readBody(rq); comfy.freed += p.endsWith("free") ? 1 : 0; return json(res, 200, {}); }
        if (p === "/comfy/prompt" && rq.method === "POST") {
          const body = JSON.parse((await readBody(rq)).toString()); comfy.posted.push(body.prompt);
          if (JSON.stringify(body.prompt).includes("__reject__")) return json(res, 400, { error: { message: "Prompt outputs failed validation" }, node_errors: { "3": { class_type: "KSampler", errors: [{ message: "missing checkpoint" }] } } });
          const id = `pid_${comfy.jobs.size + 1}`; comfy.jobs.set(id, { graph: body.prompt, ready: Date.now() + comfy.delayMs }); return json(res, 200, { prompt_id: id });
        }
        const h = /^\/comfy\/history\/(.+)$/.exec(p);
        if (h) { const j = comfy.jobs.get(h[1]!); if (!j || Date.now() < j.ready) return json(res, 200, {}); const video = JSON.stringify(j.graph).includes("VHS_VideoCombine"); const files = [{ filename: video ? "clip.mp4" : "out.png", subfolder: "", type: "output" }]; return json(res, 200, { [h[1]!]: { status: { status_str: "success" }, outputs: { "9": video ? { gifs: files } : { images: files } } } }); }
        if (p === "/comfy/view") { const fn = url.searchParams.get("filename") ?? ""; if (fn.endsWith(".mp4")) { res.writeHead(200, { "content-type": "video/mp4" }); return void res.end(Buffer.from("fixture-mp4-bytes")); } res.writeHead(200, { "content-type": "image/png" }); return void res.end(pngBuffer(32, 32)); }
      }
      res.writeHead(404); res.end("not found: " + p);
    } catch (e) { sendError(res, e); }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port; const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    NVIDIA_BASE_URL: `${base}/p/nvidia/v1`, GEMINI_BASE_URL: `${base}/p/google/v1beta/openai`, GEMINI_NATIVE_URL: `${base}/p/google/v1beta`, OPENROUTER_BASE_URL: `${base}/p/openrouter/v1`,
    GROQ_BASE_URL: `${base}/p/groq/openai/v1`, ANTHROPIC_BASE_URL: `${base}/p/anthropic/v1`, OPENAI_BASE_URL: `${base}/p/openai/v1`, XAI_BASE_URL: `${base}/p/xai/v1`,
    DEEPSEEK_BASE_URL: `${base}/p/deepseek/v1`, META_BASE_URL: `${base}/p/meta/v1`, OLLAMA_URL: `${base}/p/ollama`, SEARXNG_URL: `${base}/searx`, SEARCH_BACKEND: "searxng",
    KOKORO_URL: `${base}/kokoro/v1`, TTS_BACKEND: "kokoro", COMFY_URL: `${base}/comfy`, NVIDIA_GENAI_URL: `${base}/p/nvidia/genai`, ALLOW_LOCAL_FETCH: "true",
  });
  return { url: base, port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
