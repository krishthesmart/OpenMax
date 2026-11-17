/** Per-provider cooldowns + token buckets fed by response headers. Pure, injectable clock for tests. */
export interface Bucket { limit?: number; remaining?: number; resetAt?: number }
interface State { cooldownUntil: number; count429: number; reqBucket: Bucket; tokBucket: Bucket; lastError?: string }

let clock = () => Date.now();
export const setClock = (fn: () => number) => { clock = fn; };
const states = new Map<string, State>();
const st = (p: string): State => {
  let s = states.get(p);
  if (!s) { s = { cooldownUntil: 0, count429: 0, reqBucket: {}, tokBucket: {} }; states.set(p, s); }
  return s;
};
export const DEFAULT_COOLDOWN_SEC = 30;

export function parseDuration(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  let total = 0, matched = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n / 1000 : m[2] === "s" ? n : m[2] === "m" ? n * 60 : n * 3600;
  }
  return matched ? total : undefined;
}

export function recordHeaders(provider: string, h: { get(k: string): string | null }) {
  const s = st(provider);
  const num = (k: string) => { const v = h.get(k); return v == null ? undefined : Number(v); };
  const reqLimit = num("x-ratelimit-limit-requests"), reqRem = num("x-ratelimit-remaining-requests");
  const tokLimit = num("x-ratelimit-limit-tokens"), tokRem = num("x-ratelimit-remaining-tokens");
  if (reqLimit !== undefined || reqRem !== undefined) {
    const reset = parseDuration(h.get("x-ratelimit-reset-requests"));
    s.reqBucket = { limit: reqLimit, remaining: reqRem, resetAt: reset !== undefined ? clock() + reset * 1000 : undefined };
  }
  if (tokLimit !== undefined || tokRem !== undefined) {
    const reset = parseDuration(h.get("x-ratelimit-reset-tokens"));
    s.tokBucket = { limit: tokLimit, remaining: tokRem, resetAt: reset !== undefined ? clock() + reset * 1000 : undefined };
  }
}
export function record429(provider: string, retryAfterSec?: number, msg?: string) {
  const s = st(provider);
  s.count429++;
  s.cooldownUntil = clock() + (retryAfterSec ?? DEFAULT_COOLDOWN_SEC) * 1000;
  s.lastError = msg;
}
export function cooldownRemaining(provider: string): number {
  const s = states.get(provider);
  if (!s) return 0;
  const left = s.cooldownUntil - clock();
  if (left > 0) return Math.ceil(left / 1000);
  // an exhausted bucket with a known reset also blocks
  const b = s.reqBucket;
  if (b.remaining !== undefined && b.remaining <= 0 && b.resetAt && b.resetAt > clock()) return Math.ceil((b.resetAt - clock()) / 1000);
  return 0;
}
export const isCoolingDown = (p: string) => cooldownRemaining(p) > 0;
export const count429 = (p: string) => states.get(p)?.count429 ?? 0;
export function snapshot(provider: string) {
  const s = st(provider);
  return { cooldownSec: cooldownRemaining(provider), count429: s.count429, requests: s.reqBucket, tokens: s.tokBucket, lastError: s.lastError };
}
export function resetLimits() { states.clear(); windows.clear(); }

/** Percent of known free-tier daily cap used (0..100+). */
export function capPercent(used: number, cap: number | undefined): number | undefined {
  return cap && cap > 0 ? Math.round((used / cap) * 1000) / 10 : undefined;
}
export const nearCap = (pct: number | undefined) => pct !== undefined && pct >= 80;

/** Conservative requests-per-minute used only until response headers tell us better. */
export const DEFAULT_RPM: Record<string, number> = { groq: 25, google: 8, nvidia: 30, openrouter: 15 };
const windows = new Map<string, number[]>();
/** Reserve a request slot. False means this provider's per-minute window is full (skip to the next lane entry). */
export function tryAcquire(provider: string): boolean {
  const s = st(provider);
  if (cooldownRemaining(provider) > 0) return false;
  const rpm = s.reqBucket.limit === undefined ? DEFAULT_RPM[provider] : undefined;
  if (!rpm) return true;
  const t = clock();
  const w = (windows.get(provider) ?? []).filter((x) => t - x < 60_000);
  if (w.length >= rpm) { windows.set(provider, w); return false; }
  w.push(t); windows.set(provider, w);
  return true;
}
export const resetWindows = () => windows.clear();
