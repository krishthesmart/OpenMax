import { describe, expect, it, beforeEach } from "vitest";
import { extractJSON, repairTruncatedJSON, complete, completeJSON, stream } from "../src/providers/llm.js";
import { parseModelList, classifyKind, guessSizeB } from "../src/providers/discovery.js";
import { buildOpenAIBody, parseOpenAIStream } from "../src/providers/dialects/openai.js";
import { buildAnthropicBody, parseAnthropicStream } from "../src/providers/dialects/anthropic.js";
import { buildOllamaBody, parseOllamaStream } from "../src/providers/dialects/ollama.js";
import { providerEnabled, getProvider, refAllowed, visibleProviders } from "../src/providers/registry.js";
import { setStubHandler, stubFail } from "./fake.js";
import { ProviderError } from "../src/providers/types.js";
import { freshEnv } from "./helpers.js";

const body = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))); c.close(); } });
const collect = async <T>(g: AsyncGenerator<T>) => { const o: T[] = []; for await (const x of g) o.push(x); return o; };

describe("extractJSON", () => {
  it("handles fences, prose and trailing commas", () => {
    expect(extractJSON('Sure!\n```json\n{"a":1,}\n```')).toEqual({ a: 1 });
    expect(extractJSON('here: {"task":"code","reason":"x"} thanks')).toEqual({ task: "code", reason: "x" });
    expect(extractJSON("[1,2,3]")).toEqual([1, 2, 3]);
    expect(extractJSON("no json here")).toBeUndefined();
  });
});

describe("truncated JSON repair (small models cut off at max tokens)", () => {
  it("closes strings and brackets, drops dangling commas/keys", () => {
    expect(extractJSON('{"cards":[{"front":"a","back":"b"},{"front":"c","back":"d')).toEqual({ cards: [{ front: "a", back: "b" }, { front: "c", back: "d" }] });
    expect(extractJSON('{"a":[1,2,3,')).toEqual({ a: [1, 2, 3] });
    expect(extractJSON('{"a":1,"b":')).toEqual({ a: 1, b: null });
    expect(repairTruncatedJSON("no json")).toBeUndefined();
    expect(extractJSON('{"ok":true}')).toEqual({ ok: true });
  });
});

describe("model discovery parsing", () => {
  it("parses openai-style lists and strips google models/ prefix", () => {
    const m = parseModelList("google", { data: [{ id: "models/gemini-2.5-flash" }, { id: "models/text-embedding-004" }] });
    expect(m.map((x) => x.id)).toEqual(["gemini-2.5-flash", "text-embedding-004"]);
    expect(m[1]!.kind).toBe("embedding");
  });
  it("parses openrouter metadata (ctx, vision, tools)", () => {
    const [m] = parseModelList("openrouter", { data: [{ id: "x/y:free", context_length: 1000, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools"] }] });
    expect(m).toMatchObject({ id: "x/y:free", ctx: 1000, vision: true, tools: true });
  });
  it("parses ollama tags", () => {
    const m = parseModelList("ollama", { models: [{ name: "llama3.2:1b", details: { parameter_size: "1.2B" } }] });
    expect(m[0]).toMatchObject({ id: "llama3.2:1b", sizeB: 1.2 });
  });
  it("classifies kinds and sizes", () => {
    expect(classifyKind("nvidia/nemotron-3.5-embed-1b")).toBe("embedding");
    expect(classifyKind("whisper-large-v3")).toBe("audio");
    expect(classifyKind("nvidia/llama-3.1-nemotron-safety-guard-8b-v3")).toBe("other");
    expect(guessSizeB("nvidia/nemotron-3-ultra-550b-a55b")).toBe(550);
  });
});

describe("wire dialects", () => {
  it("openai: streams text, reasoning, usage and assembles tool calls", async () => {
    const ev = await collect(parseOpenAIStream(body([
      'data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\ndata: [DONE]\n\n',
    ])));
    expect(ev.filter((e) => e.type === "text").map((e: any) => e.text).join("")).toBe("Hello");
    expect(ev.find((e) => e.type === "tool_call")).toMatchObject({ call: { id: "c1", name: "f", args: { a: 1 } } });
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ tokensIn: 5, tokensOut: 7 });
    expect(ev.some((e) => e.type === "reasoning")).toBe(true);
  });
  it("openai body: images become data URLs on the last user message, tools are wrapped", () => {
    const b: any = buildOpenAIBody({ model: "x:y", messages: [{ role: "user", content: "see" }], attachments: [{ mime: "image/png", data: "AAA" }], tools: [{ name: "t", description: "d", parameters: {} }] }, "y");
    expect(b.messages[0].content[1].image_url.url).toBe("data:image/png;base64,AAA");
    expect(b.tools[0].function.name).toBe("t");
  });
  it("anthropic: text deltas, tool_use, usage", async () => {
    const ev = await collect(parseAnthropicStream(body([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"go"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":2}"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
    ])));
    expect(ev.find((e) => e.type === "text")).toMatchObject({ text: "Hi" });
    expect(ev.find((e) => e.type === "tool_call")).toMatchObject({ call: { name: "go", args: { x: 2 } } });
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ tokensIn: 9, tokensOut: 4 });
  });
  it("anthropic body: system split out, tool results become user blocks", () => {
    const b: any = buildAnthropicBody({ model: "a:b", messages: [{ role: "system", content: "S" }, { role: "user", content: "u" }, { role: "tool", content: "r", toolCallId: "t1" }] }, "b");
    expect(b.system).toBe("S");
    expect(b.messages[1].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
  });
  it("ollama: NDJSON with usage; body carries keep_alive", async () => {
    const ev = await collect(parseOllamaStream(body(['{"message":{"content":"a"}}\n{"message":{"content":"b"}}\n{"done":true,"prompt_eval_count":3,"eval_count":2}\n'])));
    expect(ev.filter((e) => e.type === "text").map((e: any) => e.text).join("")).toBe("ab");
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ tokensIn: 3, tokensOut: 2 });
    expect((buildOllamaBody({ model: "ollama:m", messages: [] }, "m") as any).keep_alive).toBe("30m");
  });
});

describe("registry gates", () => {
  beforeEach(() => freshEnv());
  it("hides paid providers unless ENABLE_PAID", () => {
    expect(visibleProviders().some((p) => p.id === "anthropic")).toBe(false);
    freshEnv({ ENABLE_PAID: true });
    expect(visibleProviders().some((p) => p.id === "anthropic")).toBe(true);
    expect(providerEnabled(getProvider("anthropic")!)).toBe(true);
  });
  it("only :free openrouter models without ENABLE_PAID", () => {
    expect(refAllowed("openrouter", "a/b:free")).toBe(true);
    expect(refAllowed("openrouter", "a/b")).toBe(false);
    freshEnv({ ENABLE_PAID: true });
    expect(refAllowed("openrouter", "a/b")).toBe(true);
  });
  it("refuses a paid openrouter model at call time", async () => {
    await expect(complete({ model: "openrouter:a/b", messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/ENABLE_PAID/);
  });
});

describe("llm via stub", () => {
  beforeEach(() => freshEnv());
  it("complete / stream / completeJSON", async () => {
    expect((await complete({ model: "groq:fast", messages: [{ role: "user", content: "hello" }] })).text).toContain("hello");
    setStubHandler(() => 'ok ```json\n{"v":2}\n```');
    expect((await completeJSON<{ v: number }>({ model: "groq:fast", messages: [] })).value.v).toBe(2);
  });
  it("propagates provider errors with status and retry-after", async () => {
    stubFail("groq", 429, 1, 40);
    await expect(complete({ model: "groq:fast", messages: [] })).rejects.toMatchObject({ status: 429, retryAfterSec: 40 });
  });
  it("aborts when the signal is already aborted", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(collect(stream({ model: "groq:fast", messages: [], signal: ac.signal }))).rejects.toThrow();
  });
  it("unknown provider is a ProviderError", async () => {
    await expect(complete({ model: "nope:x", messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});
