import { beforeEach, describe, expect, it } from "vitest";
import { freshEnv } from "./helpers.js";
import { dedupeResults, normalizeUrl, pool, runResearch } from "../src/modules/research.js";
import { setStubHandler } from "../src/providers/stub.js";
import { setStubPages, setStubSearch } from "../src/modules/search.js";
import { getDb } from "../src/db.js";

const collect = async (o: any) => { const ev: { event: string; data: any }[] = []; for await (const e of runResearch(o)) ev.push(e); return ev; };

describe("research helpers", () => {
  it("normalizes URLs (tracking params, www, http, trailing slash, hash)", () => {
    expect(normalizeUrl("http://www.Example.com/a/?utm_source=x&b=1#frag")).toBe("https://example.com/a?b=1");
    expect(normalizeUrl("https://example.com/a/")).toBe(normalizeUrl("https://m.example.com/a"));
  });
  it("dedupes by URL and by identical title", () => {
    const r = dedupeResults([
      { title: "Solid state batteries explained", url: "https://a.com/x?utm_campaign=1", snippet: "" },
      { title: "Solid state batteries explained", url: "https://b.com/y", snippet: "" },
      { title: "Other", url: "https://www.a.com/x", snippet: "" },
      { title: "Different", url: "https://c.com", snippet: "" },
    ]);
    expect(r.map((x) => x.url)).toEqual(["https://a.com/x?utm_campaign=1", "https://c.com"]);
  });
  it("pool respects concurrency and keeps order", async () => {
    let live = 0, max = 0;
    const out = await pool([1, 2, 3, 4, 5, 6], 2, async (x) => { live++; max = Math.max(max, live); await new Promise((r) => setTimeout(r, 5)); live--; return x * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]); expect(max).toBeLessThanOrEqual(2);
  });
});

describe("research pipeline", () => {
  beforeEach(() => {
    freshEnv();
    setStubSearch((q) => [1, 2, 3, 4].map((i) => ({ title: `${q} result ${i}`, url: `https://site${i}.test/${encodeURIComponent(q)}`, snippet: `snippet ${i}` })));
    setStubPages((u) => `Page text for ${u}`);
  });
  it("plans, searches in parallel, fetches, streams a cited answer, drops bogus citations, suggests follow-ups, persists", async () => {
    const seenQueries: string[] = [];
    setStubSearch((q) => { seenQueries.push(q); return [{ title: `T ${q}`, url: `https://s.test/${q}`, snippet: "s" }, { title: "Shared", url: "https://shared.test/p", snippet: "s" }]; });
    setStubHandler((req) => {
      const sys = req.messages[0]!.content;
      if (/You plan web research/.test(sys)) return '{"queries":["battery chemistry","solid state cost"],"fresh":false}';
      if (/follow-up/.test(sys)) return '{"followups":["a?","b?","c?"]}';
      return "Solid-state cells are denser [1] and costly [2][9].";
    });
    const ev = await collect({ query: "state of solid-state batteries" });
    const names = ev.map((e) => e.event);
    expect(names.indexOf("plan")).toBeLessThan(names.indexOf("sources"));
    expect(names.indexOf("sources")).toBeLessThan(names.indexOf("text"));
    expect(seenQueries.sort()).toEqual(["battery chemistry", "solid state cost"]);
    const sources = ev.find((e) => e.event === "sources")!.data;
    expect(sources).toHaveLength(3); // 2 unique + 1 deduped shared
    expect(sources.map((s: any) => s.n)).toEqual([1, 2, 3]);
    expect(ev.find((e) => e.event === "final")!.data.text).toBe("Solid-state cells are denser [1] and costly [2].");
    expect(ev.find((e) => e.event === "followups")!.data).toEqual(["a?", "b?", "c?"]);
    expect(ev.filter((e) => e.event === "step").some((e) => e.data.id === "write" && e.data.status === "done")).toBe(true);
    const row = getDb().prepare("SELECT * FROM research").get() as any;
    expect(row.answer).toContain("[2]"); expect(row.answer).not.toContain("[9]");
  });
  it("falls back to the raw question when planning returns garbage", async () => {
    const q: string[] = []; setStubSearch((x) => { q.push(x); return [{ title: "a", url: "https://a.test", snippet: "s" }]; });
    setStubHandler((req) => (/plan web research/.test(req.messages[0]!.content) ? "no json at all" : "ok [1]"));
    await collect({ query: "plain question" });
    expect(q).toEqual(["plain question"]);
  });
  it("deep mode runs a gap-analysis round and adds sources", async () => {
    const q: string[] = []; setStubSearch((x) => { q.push(x); return [{ title: `t-${x}`, url: `https://${x.replace(/\W/g, "")}.test`, snippet: "s" }]; });
    setStubHandler((req) => {
      const sys = req.messages[0]!.content;
      if (/plan web research/.test(sys)) return '{"queries":["alpha","beta","gamma"],"fresh":false}';
      if (/review research notes/.test(sys)) return '{"missing":"pricing data","queries":["delta pricing"]}';
      return "answer [1][4]";
    });
    const ev = await collect({ query: "deep topic", deep: true });
    expect(q).toContain("delta pricing");
    expect(ev.find((e) => e.event === "sources")!.data).toHaveLength(4);
    expect(ev.some((e) => e.event === "step" && e.data.id === "gap" && e.data.status === "done")).toBe(true);
  });
  it("shallow mode never runs the gap round; empty search results give a fix-it error", async () => {
    setStubSearch(() => []);
    const ev = await collect({ query: "nothing here" });
    expect(ev.at(-1)!.event).toBe("error");
    expect(ev.at(-1)!.data.fix).toMatch(/search backend/i);
    expect(ev.some((e) => e.data?.id === "gap")).toBe(false);
  });
});
