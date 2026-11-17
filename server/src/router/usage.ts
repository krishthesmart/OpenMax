import { getDb, now } from "../db.js";
import { cfg, dataPath, readJson } from "../config.js";
import { getProvider } from "../providers/registry.js";

export interface Prices {
  subscriptions: { name: string; monthly: number }[];
  models: Record<string, { in: number; out: number }>;
  freeCaps: Record<string, { requestsPerDay?: number; tokensPerDay?: number }>;
  electricity: { gpuWatts: number; usdPerKwh: number };
}
export const prices = (): Prices => readJson<Prices>(dataPath("prices.json"), { subscriptions: [], models: {}, freeCaps: {}, electricity: { gpuWatts: 150, usdPerKwh: 0.15 } });

/** USD cost for a call; free/local providers cost 0. */
export function costOf(ref: string, tokensIn: number, tokensOut: number): number {
  const provider = ref.split(":")[0]!;
  const p = getProvider(provider);
  if (!p?.paid) return 0;
  const pr = prices().models;
  const m = pr[ref] ?? pr.default ?? { in: 3, out: 15 };
  return (tokensIn * m.in + tokensOut * m.out) / 1_000_000;
}

export interface UsageInput { ref: string; tokensIn: number; tokensOut: number; ms: number; status?: number; kind?: string }
export function recordUsage(u: UsageInput) {
  const i = u.ref.indexOf(":");
  const provider = u.ref.slice(0, i), model = u.ref.slice(i + 1);
  getDb().prepare("INSERT INTO usage(ts,provider,model,tokens_in,tokens_out,ms,status,cost_usd,kind) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(now(), provider, model, u.tokensIn, u.tokensOut, u.ms, u.status ?? 200, costOf(u.ref, u.tokensIn, u.tokensOut), u.kind ?? "chat");
}

const monthStart = (t = now()) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
export function monthlySpend(t = now()): number {
  const r = getDb().prepare("SELECT COALESCE(SUM(cost_usd),0) s FROM usage WHERE ts>=?").get(monthStart(t)) as { s: number };
  return r.s;
}
export interface BudgetState { spent: number; cap: number; pct: number; warn: boolean; exceeded: boolean }
export function budgetState(spent = monthlySpend(), cap = cfg.MONTHLY_BUDGET_USD): BudgetState {
  const pct = cap > 0 ? spent / cap : 0;
  return { spent: Math.round(spent * 10000) / 10000, cap, pct: Math.round(pct * 1000) / 10, warn: pct >= 0.8, exceeded: cap > 0 && pct >= 1 };
}
/** Paid models are usable only while enabled and under budget (auto-switch to free/local at 100%). */
export const paidAllowed = () => cfg.ENABLE_PAID && !budgetState().exceeded;

export function dailyUsage(provider: string, t = now()) {
  const start = new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
  return getDb().prepare("SELECT COUNT(*) requests, COALESCE(SUM(tokens_in+tokens_out),0) tokens FROM usage WHERE provider=? AND ts>=?").get(provider, start) as { requests: number; tokens: number };
}
