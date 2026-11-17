import { beforeEach, describe, expect, it } from "vitest";
import { freshEnv } from "./helpers.js";
import { selectCandidates } from "../src/router/lanes.js";
import { classify, routedComplete, runRouted } from "../src/router/router.js";
import { isLocalOnly } from "../src/router/privacy.js";
import { setStubHandler, stubFail } from "./fake.js";
import * as L from "../src/providers/limits.js";
import { getDb } from "../src/db.js";
import { routerStats } from "../src/routes/router.js";

const refs = (s: ReturnType<typeof selectCandidates>) => s.candidates.map((c) => c.ref);

describe("lane selection", () => {
  beforeEach(() => freshEnv());
  it("auto: follows lane order and hides paid lanes when disabled", () => {
    const s = selectCandidates({ task: "code", mode: "auto" });
    expect(refs(s)).toEqual(["openrouter:coder:free", "nvidia:big", "groq:large", "ollama:small"]);
    expect(s.skipped.some((x) => x.ref === "anthropic:opus")).toBe(true);
  });
  it("paid flagships go on top when ENABLE_PAID", () => {
    freshEnv({ ENABLE_PAID: true });
    expect(refs(selectCandidates({ task: "code", mode: "auto" }))[0]).toBe("anthropic:opus");
    expect(refs(selectCandidates({ task: "realtime", mode: "auto" }))[0]).toBe("xai:grok");
  });
  it("paid is dropped when the monthly budget is exhausted", () => {
    freshEnv({ ENABLE_PAID: true, MONTHLY_BUDGET_USD: 1 });
    getDb().prepare("INSERT INTO usage(ts,provider,model,tokens_in,tokens_out,ms,status,cost_usd,kind) VALUES(?,?,?,?,?,?,?,?,?)").run(Date.now(), "anthropic", "opus", 1, 1, 1, 200, 1.5, "chat");
    const s = selectCandidates({ task: "code", mode: "auto" });
    expect(refs(s)).not.toContain("anthropic:opus");
    expect(s.skipped.find((x) => x.ref === "anthropic:opus")?.reason).toMatch(/budget/);
  });
  it("local-first puts ollama first; cost-saver never uses paid; manual is exactly one model", () => {
    expect(refs(selectCandidates({ task: "code", mode: "local-first" }))[0]).toBe("ollama:small");
    freshEnv({ ENABLE_PAID: true });
    expect(refs(selectCandidates({ task: "code", mode: "cost-saver" }))).not.toContain("anthropic:opus");
    expect(refs(selectCandidates({ task: "code", mode: "manual:groq:large" }))).toEqual(["groq:large"]);
  });
  it("Ollama is the fallback for everything: every text lane ends with the local default, vision lanes keep their vision model", () => {
    for (const task of ["research", "realtime", "creative", "agentic", "long-context", "quick"] as const) expect(refs(selectCandidates({ task, mode: "auto" })).at(-1)).toBe("ollama:small");
    expect(refs(selectCandidates({ task: "research", mode: "auto" })).filter((r) => r === "ollama:small")).toHaveLength(1);
    expect(refs(selectCandidates({ task: "vision", mode: "auto" }))).not.toContain("ollama:small");
    expect(refs(selectCandidates({ task: "creative", mode: "manual:groq:fast" }))).toEqual(["groq:fast"]);
  });
  it("skips providers without keys and non-free openrouter models", () => {
    freshEnv({ GROQ_API_KEY: "", NVIDIA_API_KEY: "", GEMINI_API_KEY: "", OPENROUTER_API_KEY: "k" });
    const s = selectCandidates({ task: "code", mode: "manual:openrouter:paid/model" });
    expect(s.candidates).toEqual([]);
    expect(s.skipped[0]!.reason).toMatch(/paid OpenRouter/);
    const t = selectCandidates({ task: "code", mode: "auto" });
    expect(refs(t)).toContain("openrouter:coder:free");
    expect(refs(t)).toContain("ollama:small");
    expect(refs(t)).not.toContain("groq:large");
  });
});

describe("privacy rule", () => {
  beforeEach(() => freshEnv());
  it("private / attachments are local-only unless overridden", () => {
    expect(isLocalOnly({ private: true })).toBe(true);
    expect(isLocalOnly({ hasAttachments: true })).toBe(true);
    expect(isLocalOnly({ private: true, allowCloud: true })).toBe(false);
    expect(isLocalOnly({})).toBe(false);
  });
  it("candidates contain only ollama refs when local-only", () => {
    const s = selectCandidates({ task: "vision", mode: "auto", localOnly: true });
    expect(refs(s)).toEqual(["ollama:vision"]);
    expect(s.skipped.some((x) => x.reason.includes("privacy"))).toBe(true);
  });
  it("falls back to localDefault when a lane has no local model", () => {
    expect(refs(selectCandidates({ task: "research", mode: "auto", localOnly: true }))).toEqual(["ollama:small"]);
  });
  it("never sends private text to a cloud classifier or cloud model", async () => {
    const seen: string[] = [];
    setStubHandler((req, provider, model) => { seen.push(`${provider}:${model}`); return provider === "ollama" ? '{"task":"creative","reason":"local"}' : "cloud"; });
    const ambiguous = "I have been thinking about how my team could organise its week better given that several people are remote and the timezone spread makes it awkward";
    const r = await routedComplete({ messages: [{ role: "user", content: ambiguous }], private: true });
    expect(seen.every((s) => s.startsWith("ollama:"))).toBe(true);
    expect(r.info?.model.startsWith("ollama:")).toBe(true);
    expect(r.info?.localOnly).toBe(true);
  });
  it("attachments route local, override sends to cloud", async () => {
    const a = await routedComplete({ messages: [{ role: "user", content: "what is this" }], attachmentKinds: ["image"], attachments: [{ mime: "image/png", data: "AA" }] });
    expect(a.info?.model).toBe("ollama:vision");
    const b = await routedComplete({ messages: [{ role: "user", content: "what is this" }], attachmentKinds: ["image"], attachments: [{ mime: "image/png", data: "AA" }], allowCloud: true });
    expect(b.info?.model).toBe("google:flash");
  });
});

describe("classification with LLM fallback", () => {
  beforeEach(() => freshEnv());
  it("low heuristic confidence calls the classifier lane", async () => {
    setStubHandler(() => '{"task":"creative","reason":"vibes"}');
    const c = await classify({ messages: [{ role: "user", content: "I have been thinking about how my team could organise its week better given that several people are remote and the timezone spread makes it awkward to find shared hours at all" }] });
    expect(c).toMatchObject({ task: "creative", source: "classifier" });
  });
  it("high confidence skips the classifier", async () => {
    let calls = 0; setStubHandler(() => { calls++; return "x"; });
    const c = await classify({ messages: [{ role: "user", content: "```js\nfoo()\n``` fix this bug" }] });
    expect(c.source).toBe("heuristic"); expect(calls).toBe(0);
  });
});

describe("fallback and cooldown", () => {
  beforeEach(() => freshEnv());
  it("falls through on 429 and 5xx, reports fallbacksTried, and logs the decision", async () => {
    stubFail("openrouter", 429, 1, 40);
    stubFail("nvidia", 503, 1);
    const r = await routedComplete({ task: "code", messages: [{ role: "user", content: "hi" }] });
    expect(r.info!.model).toBe("groq:large");
    expect(r.info!.fallbacksTried.map((f) => f.ref)).toEqual(["openrouter:coder:free", "nvidia:big"]);
    expect(r.info!.fallbacksTried[0]!.status).toBe(429);
    const row = getDb().prepare("SELECT * FROM route_log ORDER BY id DESC LIMIT 1").get() as any;
    expect(row).toMatchObject({ task: "code", model: "groq:large", error: null });
    expect(JSON.parse(row.fallbacks)).toHaveLength(2);
  });
  it("a 429 sets a provider cooldown that later requests skip without calling", async () => {
    let t = 5_000_000; L.setClock(() => t);
    L.record429("openrouter", 40);
    let called = 0; setStubHandler((_r, p) => { if (p === "openrouter") called++; return "ok"; });
    const r = await routedComplete({ task: "code", messages: [{ role: "user", content: "hi" }] });
    expect(called).toBe(0);
    expect(r.info!.fallbacksTried[0]).toMatchObject({ ref: "openrouter:coder:free", status: 429 });
    expect(r.info!.fallbacksTried[0]!.error).toMatch(/cooling down 40s/);
    t += 41_000;
    const r2 = await routedComplete({ task: "code", messages: [{ role: "user", content: "hi" }] });
    expect(r2.info!.model).toBe("openrouter:coder:free");
    L.setClock(() => Date.now());
  });
  it("throws a clear rate-limit error when every candidate is exhausted", async () => {
    for (const p of ["groq", "ollama"]) stubFail(p, 429, 5, 10);
    await expect(routedComplete({ task: "quick", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ status: 429 });
  });
  it("mid-stream failure does not fall through", async () => {
    setStubHandler((_r, p) => { if (p === "openrouter") throw Object.assign(new Error("boom"), {}); return "ok"; });
    // thrown before any token => falls through
    const r = await routedComplete({ task: "code", messages: [{ role: "user", content: "hi" }] });
    expect(r.info!.fallbacksTried[0]!.ref).toBe("openrouter:coder:free");
  });
  it("emits a route event before any text, forceRef bypasses the lane", async () => {
    const order: string[] = [];
    for await (const ev of runRouted({ forceRef: "groq:large", task: "code", messages: [{ role: "user", content: "yo" }] })) order.push(ev.type);
    expect(order[0]).toBe("route"); expect(order).toContain("text"); expect(order.at(-1)).toBe("meta");
  });
  it("stats: wins, failures, 429s per task/model", async () => {
    stubFail("openrouter", 429, 1, 5);
    await routedComplete({ task: "code", messages: [{ role: "user", content: "x" }] });
    const st = routerStats();
    const w = st.byModel.find((m) => m.task === "code" && m.model === "nvidia:big")!;
    const f = st.byModel.find((m) => m.task === "code" && m.model === "openrouter:coder:free")!;
    expect(w.wins).toBe(1); expect(f.failures).toBe(1); expect(f.r429).toBe(1);
  });
});
