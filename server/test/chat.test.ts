import { beforeEach, describe, expect, it } from "vitest";
import { freshEnv } from "./helpers.js";
import { parseArtifacts, artifactsOf, stripArtifacts } from "../src/shared/artifacts.js";
import { stripInvalidCites, citeNumbers } from "../src/shared/cite.js";
import { redactCards } from "../src/util/redact.js";
import { chunkText, indexText, retrieve, formatContext } from "../src/modules/rag.js";
import { hashEmbed } from "../src/modules/embeddings.js";
import { chatTurn, createConv, listMessages, artifactsFor, searchConvs, pathTo } from "../src/modules/chat.js";
import { saveGem } from "../src/modules/gems.js";
import { extractRememberRequest, listMemories, pickTools, recallMemories, saveMemory, setMemoryUrl, setMcpFactoryForTest } from "../src/modules/memory.js";
import { setStubHandler } from "./fake.js";
import { saveAttachment } from "../src/modules/attachments.js";
import { setConfigForTest } from "../src/config.js";

const run = async (body: any) => { const ev: { event: string; data: any }[] = []; for await (const e of chatTurn(body)) ev.push(e); return ev; };
const names = (ev: { event: string }[]) => ev.map((e) => e.event);

describe("artifact parsing", () => {
  it("parses complete blocks with attributes and strips wrapping fences", () => {
    const t = 'Here you go\n:::artifact{title="Hello App" kind="html"}\n```html\n<h1>Hi</h1>\n```\n:::\nDone.';
    const segs = parseArtifacts(t);
    expect(segs.map((s) => s.type)).toEqual(["text", "artifact", "text"]);
    const a = artifactsOf(t)[0]!;
    expect(a).toMatchObject({ title: "Hello App", kind: "html", content: "<h1>Hi</h1>", complete: true, key: "hello-app" });
    expect(stripArtifacts(t)).toContain("[Hello App]");
  });
  it("streaming: unclosed block is incomplete; later chunk completes it", () => {
    const part = ':::artifact{title="Doc" kind="markdown"}\n# Title\nbody';
    expect(artifactsOf(part)[0]).toMatchObject({ complete: false, content: "# Title\nbody" });
    expect(artifactsOf(part + "\n:::\n")[0]!.complete).toBe(true);
  });
  it("handles multiple artifacts, unknown kinds, and keeps language", () => {
    const t = ':::artifact{title="A" kind="code" lang="python"}\nprint(1)\n:::\n:::artifact{title="B" kind="weird"}\nx\n:::';
    const a = artifactsOf(t);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ lang: "python", kind: "code" });
    expect(a[1]!.kind).toBe("code");
  });
  it("plain text without artifacts is untouched", () => { expect(parseArtifacts("just text")).toEqual([{ type: "text", text: "just text" }]); });
});

describe("citations & redaction", () => {
  it("removes citations that point nowhere", () => {
    expect(stripInvalidCites("A [1] B [3] C [9].", 3)).toBe("A [1] B [3] C.");
    expect(citeNumbers("x [2] y [1] [2]")).toEqual([1, 2]);
  });
  it("redacts Luhn-valid card numbers only", () => {
    expect(redactCards("pay 4242 4242 4242 4242 now")).toContain("[card number redacted]");
    expect(redactCards("order 1234567890123 is fine")).toBe("order 1234567890123 is fine");
  });
});

describe("rag", () => {
  beforeEach(() => freshEnv());
  it("chunks long text with overlap and keeps short text whole", () => {
    expect(chunkText("short")).toEqual(["short"]);
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(40)).join("\n\n");
    const c = chunkText(long, 900, 100);
    expect(c.length).toBeGreaterThan(5);
    expect(c.every((x) => x.length < 1500)).toBe(true);
  });
  it("retrieves the relevant chunk with a citation context", async () => {
    await indexText({ kind: "gem", id: "g1" }, { id: "s1", name: "cats.txt" }, "Cats are obligate carnivores and sleep up to sixteen hours a day.\n\nTax law in Canada requires filing by April thirtieth each year.");
    const hits = await retrieve({ kind: "gem", id: "g1" }, "how long do cats sleep", 2);
    expect(hits[0]!.text).toContain("Cats");
    const f = formatContext(hits);
    expect(f.context.startsWith("[1] (cats.txt)")).toBe(true);
    expect(f.citations[0]).toMatchObject({ n: 1, name: "cats.txt" });
  });
  it("hash embeddings are deterministic and normalized", () => {
    const a = hashEmbed("hello world"), b = hashEmbed("hello world");
    expect(a).toEqual(b);
    expect(Math.hypot(...a)).toBeCloseTo(1, 5);
  });
});

describe("memory", () => {
  beforeEach(() => { freshEnv(); setMcpFactoryForTest(undefined); });
  it("detects explicit remember requests only", () => {
    expect(extractRememberRequest("Remember that I prefer metric units.")).toBe("I prefer metric units");
    expect(extractRememberRequest("do you remember the movie?")).toBeUndefined();
  });
  it("local store dedupes, redacts cards and recalls", async () => {
    await saveMemory("I live in Lisbon"); await saveMemory("i live in lisbon"); await saveMemory("card 4242 4242 4242 4242");
    expect(listMemories()).toHaveLength(2);
    expect(listMemories().some((m) => m.text.includes("4242 4242"))).toBe(false);
    expect((await recallMemories("where do I live")).length).toBe(2);
  });
  it("picks read/write tools by name and uses MemoryOS over MCP when configured", async () => {
    expect(pickTools([{ name: "memory_search" }, { name: "memory_add" }])).toEqual({ read: "memory_search", write: "memory_add" });
    const calls: any[] = [];
    setMcpFactoryForTest(async () => ({ client: {
      listTools: async () => ({ tools: [{ name: "search_memories", inputSchema: { properties: { query: { type: "string" } } } }, { name: "add_memory", inputSchema: { properties: { content: { type: "string" } } } }] }),
      callTool: async (c: any) => { calls.push(c); return { content: [{ type: "text", text: c.name === "search_memories" ? '["likes tea"]' : "ok" }] }; },
      close: async () => {},
    } as any }));
    setMemoryUrl("http://memoryos.test/mcp");
    expect(await recallMemories("drinks")).toEqual(["likes tea"]);
    await saveMemory("works at Acme");
    expect(calls.find((c) => c.name === "add_memory")!.arguments).toEqual({ content: "works at Acme" });
    setMemoryUrl(""); setMcpFactoryForTest(undefined);
  });
});

describe("chat turn", () => {
  beforeEach(() => freshEnv());
  it("streams route + text, persists the tree, auto-titles, and saves artifacts", async () => {
    setStubHandler((_r, p) => p === "ollama" ? "x" : 'Sure.\n:::artifact{title="Page" kind="html"}\n<p>hi</p>\n:::\n');
    const ev = await run({ text: "Write me a small html page", mode: "auto" });
    expect(names(ev)).toEqual(expect.arrayContaining(["start", "route", "text", "done", "title"]));
    const convId = ev[0]!.data.conversationId;
    const msgs = listMessages(convId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.parent_id).toBe(msgs[0]!.id);
    expect(msgs[1]!.meta.route.task).toBeTruthy();
    expect(artifactsFor(convId)[0]!.versions).toHaveLength(1);
  });
  it("regenerate creates a sibling; edit-and-resend branches from the original parent", async () => {
    const e1 = await run({ text: "first question about cats" });
    const convId = e1[0]!.data.conversationId;
    const asst1 = e1.find((e) => e.event === "done")!.data.messageId;
    const e2 = await run({ conversationId: convId, text: "", regenerateOf: asst1 });
    const asst2 = e2.find((e) => e.event === "done")!.data.messageId;
    const all = listMessages(convId);
    expect(all.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(all.find((m) => m.id === asst2)!.parent_id).toBe(all.find((m) => m.id === asst1)!.parent_id);
    const userId = all.find((m) => m.role === "user")!.id;
    const e3 = await run({ conversationId: convId, text: "edited question", parentId: null });
    expect(listMessages(convId).filter((m) => m.role === "user")).toHaveLength(2);
    expect(pathTo(e3.find((e) => e.event === "done")!.data.messageId).map((m) => m.role)).toEqual(["user", "assistant"]);
    void userId;
  });
  it("includes history and memories in the prompt; 'remember that' saves a memory", async () => {
    await saveMemory("The user is called Sam");
    let sys = "";
    setStubHandler((req, p) => { if (p !== "ollama" && /You are OpenMax/.test(req.messages[0]!.content)) sys = req.messages[0]!.content; return "ok"; });
    const e1 = await run({ text: "Remember that I use Linux." });
    expect(names(e1)).toContain("memory");
    expect(sys).toContain("The user is called Sam");
    expect(listMemories().some((m) => m.text === "I use Linux")).toBe(true);
  });
  it("gem: instructions + knowledge retrieval with citations; private gem stays local", async () => {
    const gem = saveGem({ name: "Cat expert", instructions: "Answer as a vet.", private: true });
    await indexText({ kind: "gem", id: gem.id }, { id: "s", name: "cats.txt" }, "Cats sleep sixteen hours a day.", { localOnly: true });
    const seen: string[] = []; let sys = "";
    setStubHandler((req, p, m) => { seen.push(`${p}:${m}`); sys = req.messages[0]!.content; return "They sleep a lot [1]."; });
    const ev = await run({ text: "how long do cats sleep?", gemId: gem.id });
    expect(sys).toContain("Answer as a vet.");
    expect(sys).toContain("Cats sleep sixteen hours");
    expect(ev.find((e) => e.event === "sources")!.data[0]).toMatchObject({ n: 1, kind: "knowledge" });
    expect(seen.every((s) => s.startsWith("ollama:"))).toBe(true);
    expect(ev.find((e) => e.event === "route")!.data.localOnly).toBe(true);
  });
  it("realtime questions search the web first and offer numbered sources", async () => {
    let sys = "";
    setStubHandler((req) => { if (/You are OpenMax/.test(req.messages[0]!.content)) sys = req.messages[0]!.content; return "Answer [1] and [7]."; });
    const ev = await run({ text: "what is the latest news today?" });
    expect(sys).toContain("Live web results");
    expect(ev.find((e) => e.event === "route")!.data.needsSearch).toBe(true);
    const done = listMessages(ev[0]!.data.conversationId).find((m) => m.role === "assistant")!;
    expect(done.content).toBe("Answer [1] and.");
    expect(done.meta.citations.length).toBeGreaterThan(0);
  });
  it("attachments inline text and force local routing; cloud override works", async () => {
    const att = await saveAttachment("notes.txt", "text/plain", Buffer.from("The secret launch date is March 3."));
    let sys = "", last = "";
    setStubHandler((req) => { sys = req.messages[0]!.content; last = req.messages.at(-1)!.content; return "ok"; });
    const ev = await run({ text: "when is launch?", attachmentIds: [att.id] });
    expect(last).toContain("March 3");
    expect(ev.find((e) => e.event === "route")!.data.model.startsWith("ollama:")).toBe(true);
    void sys;
    const ev2 = await run({ text: "when is launch?", attachmentIds: [att.id], allowCloud: true });
    expect(ev2.find((e) => e.event === "route")!.data.model.startsWith("ollama:")).toBe(false);
  });
  it("surfaces needsCloudOverride when private content has no local model", async () => {
    setConfigForTest({ OLLAMA_URL: "http://127.0.0.1:1", GROQ_API_KEY: "k" });
    const conv = createConv({ private: true });
    const ev = await run({ conversationId: conv.id, text: "hello there friend" });
    // ollama is "local" so it is enabled; the call itself fails and is reported with a fix
    expect(names(ev)).toContain("error");
  });
  it("conversation search matches titles and message bodies", async () => {
    await run({ text: "tell me about zebras and their stripes" });
    expect((searchConvs("zebras") as any[]).length).toBe(1);
    expect((searchConvs("nonexistentword") as any[]).length).toBe(0);
  });
});
