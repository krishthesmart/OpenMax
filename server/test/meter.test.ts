import { beforeEach, describe, expect, it } from "vitest";
import { freshEnv } from "./helpers.js";
import { electricityCost, freeCaps, pct, tokensPerSec, usageReport } from "../src/modules/meter.js";
import { budgetState, costOf, monthlySpend, paidAllowed, recordUsage } from "../src/router/usage.js";
import { getDb } from "../src/db.js";
import { setConfigForTest } from "../src/config.js";

const ins = (provider: string, model: string, o: Partial<{ tin: number; tout: number; ms: number; status: number; cost: number; kind: string; ts: number }> = {}) =>
  getDb().prepare("INSERT INTO usage(ts,provider,model,tokens_in,tokens_out,ms,status,cost_usd,kind) VALUES(?,?,?,?,?,?,?,?,?)").run(o.ts ?? Date.now(), provider, model, o.tin ?? 100, o.tout ?? 200, o.ms ?? 1000, o.status ?? 200, o.cost ?? 0, o.kind ?? "chat");

describe("meter math", () => {
  it("electricity: watts × hours × $/kWh", () => {
    expect(electricityCost(3_600_000, 150, 0.15)).toBeCloseTo(0.0225, 6); // 1 GPU-hour at 150 W
    expect(electricityCost(0, 150, 0.15)).toBe(0); expect(electricityCost(1_800_000, 400, 0.2)).toBeCloseTo(0.04, 6);
  });
  it("tokens per second and percentages", () => { expect(tokensPerSec(200, 2000)).toBe(100); expect(tokensPerSec(5, 0)).toBe(0); expect(pct(80, 100)).toBe(80); expect(pct(1, 3)).toBe(33.3); expect(pct(5, undefined)).toBeUndefined(); expect(pct(5, 0)).toBeUndefined(); });
  it("paid cost uses data/prices.json per million tokens; free and local cost nothing; unknown paid models use the default price", () => {
    expect(costOf("anthropic:claude-opus-5-5", 1_000_000, 1_000_000)).toBeCloseTo(15 + 75, 6);
    expect(costOf("openai:gpt-5", 2_000_000, 0)).toBeCloseTo(2.5, 6);
    expect(costOf("groq:llama", 9e6, 9e6)).toBe(0); expect(costOf("ollama:x", 9e6, 9e6)).toBe(0);
    expect(costOf("deepseek:unknown-model", 1_000_000, 1_000_000)).toBeCloseTo(3 + 15, 6);
  });
});

describe("budget cap", () => {
  beforeEach(() => freshEnv({ ENABLE_PAID: true, MONTHLY_BUDGET_USD: 10 }));
  it("warns at 80%, switches to free/local at 100%", () => {
    expect(budgetState(7.99, 10)).toMatchObject({ warn: false, exceeded: false });
    expect(budgetState(8, 10)).toMatchObject({ warn: true, exceeded: false, pct: 80 });
    expect(budgetState(10, 10)).toMatchObject({ warn: true, exceeded: true });
    expect(paidAllowed()).toBe(true);
    ins("anthropic", "x", { cost: 8.5 }); expect(budgetState().warn).toBe(true); expect(paidAllowed()).toBe(true);
    ins("anthropic", "x", { cost: 2 }); expect(monthlySpend()).toBeCloseTo(10.5, 6); expect(paidAllowed()).toBe(false);
  });
  it("only counts spend from the current month; a 0 cap means unlimited", () => {
    ins("anthropic", "x", { cost: 100, ts: Date.now() - 40 * 86_400_000 }); expect(monthlySpend()).toBe(0);
    expect(budgetState(500, 0)).toMatchObject({ exceeded: false, warn: false });
  });
  it("recordUsage computes cost for paid refs automatically", () => {
    recordUsage({ ref: "anthropic:claude-opus-5-5", tokensIn: 1000, tokensOut: 1000, ms: 100 });
    expect(monthlySpend()).toBeCloseTo((1000 * 15 + 1000 * 75) / 1e6, 8);
  });
});

describe("usage report", () => {
  beforeEach(() => freshEnv({ ENABLE_PAID: true, MONTHLY_BUDGET_USD: 10, GPU_WATTS: 200, USD_PER_KWH: 0.1 }));
  it("aggregates requests, tokens, tok/s and 429s per provider and model", () => {
    ins("groq", "fast", { tin: 100, tout: 300, ms: 1000 }); ins("groq", "fast", { tin: 50, tout: 100, ms: 1000 });
    ins("groq", "fast", { tin: 0, tout: 0, ms: 5, status: 429, kind: "429" }); ins("nvidia", "big", { tin: 10, tout: 20, ms: 500 });
    const r = usageReport("month"); const m = r.models.find((x) => x.model === "fast")!;
    expect(m).toMatchObject({ requests: 2, tokensIn: 150, tokensOut: 400, tps: 200 }); expect(r.byProvider.groq).toMatchObject({ requests: 2, tokens: 550, r429: 1 }); expect(r.byProvider.nvidia!.requests).toBe(1);
  });
  it("percent of known free-tier caps, warning at 80% and exceeded at 100%", () => {
    for (let i = 0; i < 4; i++) ins("google", "flash", { tin: 10, tout: 10 }); // prices.json: google 250 requests/day -> 1.6%
    expect(freeCaps().find((c) => c.provider === "google")).toMatchObject({ requestsToday: 4, warn: false });
    getDb().prepare("DELETE FROM usage").run();
    const ins2 = getDb().prepare("INSERT INTO usage(ts,provider,model,tokens_in,tokens_out,ms,status,cost_usd,kind) VALUES(?,?,?,?,?,?,?,?,?)");
    getDb().transaction(() => { for (let i = 0; i < 200; i++) ins2.run(Date.now(), "google", "flash", 1, 1, 1, 200, 0, "chat"); })();
    expect(freeCaps().find((c) => c.provider === "google")).toMatchObject({ requestsToday: 200, requestPct: 80, warn: true, exceeded: false });
    getDb().transaction(() => { for (let i = 0; i < 60; i++) ins2.run(Date.now(), "google", "flash", 1, 1, 1, 200, 0, "chat"); })();
    expect(freeCaps().find((c) => c.provider === "google")!.exceeded).toBe(true);
  });
  it("local GPU time (Ollama + ComfyUI jobs) and the electricity estimate", () => {
    ins("ollama", "llama", { ms: 1_800_000 });
    getDb().prepare("INSERT INTO media_jobs(id,kind,backend,params,status,progress,outputs,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)").run("j1", "t2v", "comfy", "{}", "done", 1, "[]", Date.now() - 1_800_000, Date.now());
    const r = usageReport("month"); expect(r.local.gpuHours).toBeCloseTo(1, 2); expect(r.local.watts).toBe(200);
    expect(r.local.electricityUsd).toBeCloseTo(1 * 0.2 * 0.1, 3);
  });
  it("comparison: actual spend (paid + electricity) vs the subscriptions in prices.json", () => {
    ins("anthropic", "claude-opus-5-5", { cost: 4.5 }); ins("ollama", "llama", { ms: 3_600_000 });
    const c = usageReport("month").comparison;
    expect(c.subscriptionsMonthly).toBe(1188); // 100+200+300+200+250+39+99
    expect(c.paidSpendMonthly).toBeCloseTo(4.5, 3); expect(c.electricityMonthly).toBeCloseTo(0.02, 3);
    expect(c.actualMonthly).toBeCloseTo(4.52, 2); expect(c.savedMonthly).toBeCloseTo(1188 - 4.52, 2);
  });
  it("budget block mirrors the cap state", () => { ins("anthropic", "x", { cost: 9 }); expect(usageReport("month").budget).toMatchObject({ warn: true, exceeded: false, cap: 10, enabled: true }); });
});
void setConfigForTest;
