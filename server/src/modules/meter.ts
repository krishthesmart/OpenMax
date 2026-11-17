import { cfg } from "../config.js";
import { getDb, now } from "../db.js";
import { count429 } from "../providers/limits.js";
import { allProviders } from "../providers/registry.js";
import { budgetState, dailyUsage, monthlySpend, prices } from "../router/usage.js";

export const electricityCost = (gpuMs: number, watts: number, usdPerKwh: number) => (gpuMs / 3_600_000) * (watts / 1000) * usdPerKwh;
export const pct = (used: number, cap?: number) => (cap && cap > 0 ? Math.round((used / cap) * 1000) / 10 : undefined);
export const tokensPerSec = (tokensOut: number, ms: number) => (ms > 0 ? Math.round((tokensOut / (ms / 1000)) * 10) / 10 : 0);
const dayStart = (t = now()) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
const monthStart = (t = now()) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

export interface FreeCapRow { provider: string; requestsToday: number; tokensToday: number; requestPct?: number; tokenPct?: number; warn: boolean; exceeded: boolean; caps: { requestsPerDay?: number; tokensPerDay?: number } }
export function freeCaps(t = now()): FreeCapRow[] {
  const caps = prices().freeCaps;
  return Object.keys(caps).map((p) => {
    const u = dailyUsage(p, t); const c = caps[p]!;
    const rp = pct(u.requests, c.requestsPerDay), tp = pct(u.tokens, c.tokensPerDay);
    const worst = Math.max(rp ?? 0, tp ?? 0);
    return { provider: p, requestsToday: u.requests, tokensToday: u.tokens, requestPct: rp, tokenPct: tp, warn: worst >= 80, exceeded: worst >= 100, caps: c };
  });
}
export const capWarning = (provider: string) => freeCaps().find((c) => c.provider === provider);

export function usageReport(range: "day" | "month" | "all" = "month", t = now()) {
  const db = getDb(); const since = range === "day" ? dayStart(t) : range === "month" ? monthStart(t) : 0;
  const rows = db.prepare(`SELECT provider, model, COUNT(CASE WHEN status=200 THEN 1 END) requests, COUNT(CASE WHEN status=429 THEN 1 END) r429, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(ms),0) ms, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(CASE WHEN status=200 THEN tokens_out ELSE 0 END),0) gen_tokens, COALESCE(SUM(CASE WHEN status=200 THEN ms ELSE 0 END),0) gen_ms
    FROM usage WHERE ts>=? AND kind NOT IN ('429') GROUP BY provider, model ORDER BY requests DESC, tout DESC`).all(since) as any[];
  const models = rows.map((r) => ({ provider: r.provider, model: r.model, requests: r.requests, r429: r.r429, tokensIn: r.tin, tokensOut: r.tout, tps: tokensPerSec(r.gen_tokens, r.gen_ms), costUsd: Math.round(r.cost * 1e6) / 1e6, local: allProviders().find((p) => p.id === r.provider)?.local ?? false }));
  const byProvider: Record<string, { requests: number; tokens: number; r429: number; costUsd: number; liveR429: number }> = {};
  for (const m of models) { const p = (byProvider[m.provider] ??= { requests: 0, tokens: 0, r429: 0, costUsd: 0, liveR429: count429(m.provider) }); p.requests += m.requests; p.tokens += m.tokensIn + m.tokensOut; p.r429 += m.r429; p.costUsd += m.costUsd; }
  // the 429 rows are logged with kind '429' (excluded above so they don't inflate request counts): count them separately
  for (const r of db.prepare("SELECT provider, COUNT(*) n FROM usage WHERE ts>=? AND (status=429 OR kind='429') GROUP BY provider").all(since) as any[]) { const p = (byProvider[r.provider] ??= { requests: 0, tokens: 0, r429: 0, costUsd: 0, liveR429: count429(r.provider) }); p.r429 = r.n; }

  // local GPU time: Ollama generation time + media jobs on GPU backends
  const ollamaMs = (db.prepare("SELECT COALESCE(SUM(ms),0) ms FROM usage WHERE provider='ollama' AND ts>=?").get(since) as { ms: number }).ms;
  const mediaMs = (db.prepare("SELECT COALESCE(SUM(finished_at - created_at),0) ms FROM media_jobs WHERE backend='comfy' AND status='done' AND created_at>=?").get(since) as { ms: number }).ms;
  const watts = cfg.GPU_WATTS || prices().electricity.gpuWatts, kwh = cfg.USD_PER_KWH || prices().electricity.usdPerKwh;
  const gpuMs = ollamaMs + mediaMs;
  const local = { ollamaMs, mediaMs, gpuHours: Math.round((gpuMs / 3_600_000) * 1000) / 1000, watts, usdPerKwh: kwh, electricityUsd: Math.round(electricityCost(gpuMs, watts, kwh) * 10000) / 10000 };

  const month = monthlySpend(t);
  const paidSpend = Math.round(month * 10000) / 10000;
  const subs = prices().subscriptions; const subsTotal = subs.reduce((n, s) => n + s.monthly, 0);
  const monthLocal = range === "month" ? local.electricityUsd : Math.round(electricityCost((db.prepare("SELECT COALESCE(SUM(ms),0) ms FROM usage WHERE provider='ollama' AND ts>=?").get(monthStart(t)) as any).ms, watts, kwh) * 10000) / 10000;
  const actual = Math.round((paidSpend + monthLocal) * 100) / 100;
  const days = db.prepare("SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') d, provider, COUNT(*) n, COALESCE(SUM(tokens_in+tokens_out),0) tok FROM usage WHERE ts>=? AND status=200 GROUP BY d, provider ORDER BY d").all(dayStart(t) - 13 * 86_400_000);
  return {
    range, models, byProvider, local, freeCaps: freeCaps(t), days,
    budget: { ...budgetState(month), enabled: cfg.ENABLE_PAID },
    comparison: { subscriptions: subs, subscriptionsMonthly: subsTotal, actualMonthly: actual, paidSpendMonthly: paidSpend, electricityMonthly: monthLocal, savedMonthly: Math.round((subsTotal - actual) * 100) / 100, note: "Subscription prices come from data/prices.json and change often. Verify them before relying on this comparison." },
  };
}
