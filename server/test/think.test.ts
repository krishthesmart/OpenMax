import { beforeEach, describe, expect, it } from "vitest";
import { freshEnv } from "./helpers.js";
import { estimateThink, judgePrompt, parseVerdict, runThink, thinkCandidates } from "../src/modules/think.js";
import { chatTurn, listMessages } from "../src/modules/chat.js";
import { setStubHandler, stubFail } from "../src/providers/stub.js";
import * as L from "../src/providers/limits.js";
import { getDb } from "../src/db.js";

const run = async (opts: any) => { const ev: any[] = []; for await (const e of runThink({ messages: [{ role: "user", content: "Why is the sky blue?" }], ...opts })) ev.push(e); return ev; };
const text = (ev: any[]) => ev.filter((e) => e.type === "text").map((e) => e.text).join("");
const answerBy = (map: Record<string, string>, judge: (req: any) => string) => setStubHandler((req, p) => (/impartial judge/.test(req.messages[0]!.content) ? judge(req) : /Reply with ONLY JSON/.test(req.messages[0]!.content) ? '{"task":"reasoning","reason":"x"}' : map[p] ?? `answer-${p}`));

describe("think candidates", () => {
  beforeEach(() => freshEnv());
  it("uses the configured trio, adds groq for short questions, and drops cooling providers", () => {
    expect(thinkCandidates({})).toEqual(["nvidia:big", "google:flash", "openrouter:coder:free"]);
    expect(thinkCandidates({ short: true })).toEqual(["nvidia:big", "google:flash", "openrouter:coder:free", "groq:large"]);
    L.record429("google", 30); expect(thinkCandidates({})).not.toContain("google:flash"); L.resetLimits();
  });
  it("adds paid flagships only when allowed; private content only uses local models", () => {
    expect(thinkCandidates({ paid: true })).not.toContain("anthropic:opus");
    freshEnv({ ENABLE_PAID: true }); expect(thinkCandidates({ paid: true })).toContain("anthropic:opus");
    expect(thinkCandidates({ localOnly: true }).every((r) => r.startsWith("ollama:"))).toBe(true);
  });
});

describe("verdict parsing & prompt", () => {
  it("accepts pick and merge, rejects nonsense", () => {
    expect(parseVerdict('{"verdict":"B is right","action":"pick","pick":"B"}', 3)).toMatchObject({ action: "pick", pick: 1 });
    expect(parseVerdict('```json\n{"verdict":"v","action":"merge","merged":"A combined answer that is long enough."}\n```', 3)).toMatchObject({ action: "merge" });
    expect(parseVerdict('{"action":"pick","pick":"Z"}', 3)).toBeUndefined();
    expect(parseVerdict('{"action":"merge","merged":"x"}', 3)).toBeUndefined();
    expect(parseVerdict("nope", 3)).toBeUndefined();
  });
  it("judge prompt lists every draft under a label", () => {
    const m = judgePrompt("Q?", [{ label: "A", text: "first" }, { label: "B", text: "second" }]);
    expect(m[1]!.content).toContain("DRAFT A:\nfirst"); expect(m[1]!.content).toContain("DRAFT B:\nsecond"); expect(m[1]!.content).toContain("QUESTION:\nQ?");
  });
});

describe("think pipeline", () => {
  beforeEach(() => freshEnv());
  it("drafts in parallel, the judge picks the best, and the UI gets the considered approaches", async () => {
    let judged = ""; answerBy({ nvidia: "Rayleigh scattering", google: "Because of the ocean", openrouter: "Light is blue" }, (req) => { judged = req.messages[1].content; return '{"verdict":"nvidia is correct","action":"pick","pick":"A"}'; });
    const ev = await run({});
    const types = ev.map((e) => e.type);
    expect(types[0]).toBe("think"); expect(ev[0].data.phase).toBe("drafting"); expect(types.indexOf("route")).toBeLessThan(types.indexOf("text")); expect(types.at(-1)).toBe("meta");
    expect(text(ev)).toBe("Rayleigh scattering");
    expect(judged).toContain("Because of the ocean"); expect(judged).toContain("Light is blue");
    const done = ev.filter((e) => e.type === "think").at(-1).data;
    expect(done).toMatchObject({ phase: "done", chosen: "nvidia:big", judge: { ref: "google:judge", action: "pick" } }); expect(done.candidates).toHaveLength(4); expect(done.estimateSec).toBeGreaterThan(0);
    const route = ev.find((e) => e.type === "route").info; expect(route.model).toBe("think:nvidia:big"); expect(route.reason).toMatch(/4\/4 drafts/);
  });
  it("merge: the judge's merged text is the final answer", async () => {
    answerBy({}, () => '{"verdict":"each has half","action":"merge","merged":"The merged final answer with the best of all drafts."}');
    const ev = await run({}); expect(text(ev)).toBe("The merged final answer with the best of all drafts."); expect(ev.find((e) => e.type === "route").info.model).toBe("think:merged");
  });
  it("a failed draft is reported but the others are still judged; one survivor skips the judge", async () => {
    answerBy({}, () => '{"verdict":"ok","action":"pick","pick":"A"}');
    stubFail("nvidia", 503, 1);
    const ev = await run({}); const info = ev.find((e) => e.type === "route").info;
    expect(info.fallbacksTried.map((f: any) => f.ref)).toContain("nvidia:big"); expect(info.reason).toMatch(/3\/4 drafts/);
    freshEnv(); let judgeCalls = 0; setStubHandler((req, p) => { if (/impartial judge/.test(req.messages[0]!.content)) judgeCalls++; if (p !== "nvidia") throw Object.assign(new Error("x"), {}); return "solo"; });
    const solo = await run({}); expect(text(solo)).toBe("solo"); expect(judgeCalls).toBe(0);
  });
  it("falls back to the first good draft when the judge is down or rambles; fails clearly when every draft fails", async () => {
    answerBy({ nvidia: "first draft" }, () => "I refuse to answer in JSON");
    const ev = await run({}); expect(text(ev)).toBe("first draft"); expect(ev.filter((e) => e.type === "think").at(-1).data.judge.action).toBe("fallback");
    freshEnv(); setStubHandler(() => { throw new Error("all broken"); });
    await expect(run({})).rejects.toThrow(/Every Think draft failed/);
  });
  it("private content stays local: only Ollama drafts (sampled twice when only one local model exists) and a local-only judge", async () => {
    const seen: string[] = []; const temps: any[] = [];
    setStubHandler((req, p, m) => { seen.push(`${p}:${m}`); temps.push(req.temperature); return /impartial judge/.test(req.messages[0]!.content) ? '{"action":"pick","pick":"A","verdict":"v"}' : "local answer"; });
    const ev = await run({ private: true });
    expect(seen.every((s) => s.startsWith("ollama:"))).toBe(true); expect(temps).toEqual(expect.arrayContaining([0.3, 0.9])); expect(ev.find((e) => e.type === "route").info.localOnly).toBe(true);
  });
  it("logs a single decision row for the whole think run", async () => {
    answerBy({}, () => '{"action":"pick","pick":"A","verdict":"v"}'); await run({});
    const rows = getDb().prepare("SELECT provider, model FROM route_log").all() as any[]; expect(rows).toHaveLength(1); expect(rows[0].provider).toBe("think");
  });
  it("chat integration: think:true streams a think event and persists the considered approaches in message meta", async () => {
    answerBy({ nvidia: "N" }, () => '{"verdict":"v","action":"pick","pick":"A"}');
    const ev: any[] = []; for await (const e of chatTurn({ text: "Why is the sky blue?", think: true })) ev.push(e);
    expect(ev.some((e) => e.event === "think")).toBe(true);
    const m = listMessages(ev[0].data.conversationId).find((x) => x.role === "assistant")!;
    expect(m.meta.think.phase).toBe("done"); expect(m.meta.think.candidates).toHaveLength(4); expect(m.content).toBe("N");
  });
  it("time estimate uses this machine's recent latencies", () => {
    const ins = getDb().prepare("INSERT INTO usage(ts,provider,model,tokens_in,tokens_out,ms,status,cost_usd,kind) VALUES(?,?,?,?,?,?,?,?,?)");
    ins.run(Date.now(), "nvidia", "big", 1, 1, 40000, 200, 0, "chat"); ins.run(Date.now(), "google", "judge", 1, 1, 6000, 200, 0, "chat");
    const e = estimateThink({ candidates: ["nvidia:big", "google:flash"], judge: "google:judge" });
    expect(e.seconds).toBe(Math.round(((40000 + 6000) / 1000) * 1.15)); expect(e.drafts).toBe(2);
  });
});
