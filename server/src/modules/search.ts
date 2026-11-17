import { cfg } from "../config.js";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export interface SearchResult { title: string; url: string; snippet: string; engine?: string }
export interface SearchOptions { timeRange?: "day" | "week" | "month" | "year"; limit?: number; signal?: AbortSignal }
export type SearchBackend = "searxng" | "brave" | "duckduckgo" | "wikipedia";

const UA = "Mozilla/5.0 (compatible; OpenMax/0.1)";
const BLOCKED_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)/;

// ───────── backend selection ─────────
let reach: { at: number; ok: boolean } | undefined;
async function searxngReachable(): Promise<boolean> {
  if (reach && Date.now() - reach.at < 30_000) return reach.ok;
  let ok = false;
  try { const r = await fetch(`${cfg.SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(1500) }); ok = r.ok || r.status === 404; } catch { ok = false; }
  reach = { at: Date.now(), ok };
  return ok;
}
export const resetSearchCache = () => { reach = undefined; };

let ddgState: { at: number; ok: boolean } | undefined;
const DDG_TTL = 10 * 60_000;
export const resetSearchCache2 = () => { ddgState = undefined; };

/**
 * SEARCH_BACKEND=auto: SearXNG if it is running, else Brave if a key is set, else DuckDuckGo if it will answer automated requests
 * (it often shows a bot challenge), else Wikipedia, which is always reachable but only covers encyclopedic topics.
 */
export async function chooseBackend(): Promise<SearchBackend> {
  const want = cfg.SEARCH_BACKEND;
  if (want === "searxng" || want === "brave" || want === "duckduckgo" || want === "wikipedia") return want;
  if (await searxngReachable()) return "searxng";
  if (cfg.BRAVE_API_KEY) return "brave";
  if (!ddgState || Date.now() - ddgState.at > DDG_TTL) {
    try { await duckduckgo("openmax", { limit: 1, signal: AbortSignal.timeout(8000) }); ddgState = { at: Date.now(), ok: true }; } catch { ddgState = { at: Date.now(), ok: false }; }
  }
  return ddgState.ok ? "duckduckgo" : "wikipedia";
}

async function searxng(q: string, o: SearchOptions): Promise<SearchResult[]> {
  const u = new URL(`${cfg.SEARXNG_URL}/search`);
  u.searchParams.set("q", q); u.searchParams.set("format", "json"); if (o.timeRange) u.searchParams.set("time_range", o.timeRange);
  let r: Response;
  try { r = await fetch(u, { signal: o.signal ?? AbortSignal.timeout(15000) }); }
  catch { throw new Error("SearXNG is not reachable. Start it with `docker compose up -d searxng`, or set SEARCH_BACKEND=auto to use DuckDuckGo."); }
  if (!r.ok) throw new Error(`SearXNG returned ${r.status}. Ensure json is enabled under search.formats in its settings.yml.`);
  const j: any = await r.json();
  return (j.results ?? []).slice(0, o.limit ?? 8).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "", engine: x.engine }));
}

async function brave(q: string, o: SearchOptions): Promise<SearchResult[]> {
  if (!cfg.BRAVE_API_KEY) throw new Error("Brave search selected but BRAVE_API_KEY is empty.");
  const fresh = o.timeRange ? { day: "pd", week: "pw", month: "pm", year: "py" }[o.timeRange] : undefined;
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", q); u.searchParams.set("count", String(o.limit ?? 8)); if (fresh) u.searchParams.set("freshness", fresh);
  const r = await fetch(u, { headers: { "x-subscription-token": cfg.BRAVE_API_KEY, accept: "application/json" }, signal: o.signal });
  if (!r.ok) throw new Error(`Brave search returned ${r.status}.`);
  const j: any = await r.json();
  return (j.web?.results ?? []).slice(0, o.limit ?? 8).map((x: any) => ({ title: x.title, url: x.url, snippet: x.description ?? "", engine: "brave" }));
}

/** DuckDuckGo's HTML endpoint: real results without an API key. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const { document } = parseHTML(html);
  const out: SearchResult[] = [];
  for (const el of document.querySelectorAll(".result, .web-result")) {
    const a: any = el.querySelector("a.result__a");
    if (!a) continue;
    let href: string = a.getAttribute("href") ?? "";
    if (href.startsWith("//")) href = "https:" + href;
    try { const u = new URL(href, "https://duckduckgo.com"); const real = u.searchParams.get("uddg"); if (real) href = real; else href = u.toString(); } catch { continue; }
    if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // skip ads
    const snip: any = el.querySelector(".result__snippet");
    out.push({ title: (a.textContent ?? "").trim(), url: href, snippet: (snip?.textContent ?? "").replace(/\s+/g, " ").trim(), engine: "duckduckgo" });
  }
  return out;
}
async function duckduckgo(q: string, o: SearchOptions): Promise<SearchResult[]> {
  const df = o.timeRange ? { day: "d", week: "w", month: "m", year: "y" }[o.timeRange] : "";
  const r = await fetch("https://html.duckduckgo.com/html/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA }, body: new URLSearchParams({ q, ...(df ? { df } : {}) }).toString(), signal: o.signal ?? AbortSignal.timeout(20000) })
    .catch(() => { throw new Error("Could not reach DuckDuckGo. Check your internet connection, or run SearXNG (docker compose up -d searxng)."); });
  if (!r.ok) throw new Error(`DuckDuckGo returned ${r.status} (it may be rate limiting). Try again shortly, or configure SearXNG/Brave.`);
  const results = parseDuckDuckGo(await r.text()).slice(0, o.limit ?? 8);
  if (!results.length) throw new Error("DuckDuckGo returned no results (it may have shown a challenge page). Try again, or configure SearXNG/Brave.");
  return results;
}

/** MediaWiki search: real, keyless and always reachable, but limited to Wikipedia. */
export async function wikipedia(q: string, o: SearchOptions): Promise<SearchResult[]> {
  const u = new URL("https://en.wikipedia.org/w/api.php");
  u.searchParams.set("action", "query"); u.searchParams.set("list", "search"); u.searchParams.set("srsearch", q); u.searchParams.set("format", "json"); u.searchParams.set("srlimit", String(o.limit ?? 8));
  const r = await fetch(u, { headers: { "user-agent": UA }, signal: o.signal ?? AbortSignal.timeout(15000) }).catch(() => { throw new Error("Could not reach Wikipedia. Check your internet connection, or configure SearXNG/Brave."); });
  if (!r.ok) throw new Error(`Wikipedia search returned ${r.status}.`);
  const j: any = await r.json();
  return (j.query?.search ?? []).map((x: any) => ({ title: x.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(x.title).replace(/ /g, "_"))}`, snippet: String(x.snippet ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#039;/g, "'"), engine: "wikipedia" }));
}

export async function search(q: string, o: SearchOptions = {}): Promise<SearchResult[]> {
  const backend = await chooseBackend();
  if (backend === "searxng") return searxng(q, o);
  if (backend === "brave") return brave(q, o);
  if (backend === "wikipedia") return wikipedia(q, o);
  return duckduckgo(q, o);
}

// ───────── pages ─────────
export function htmlToText(html: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  try {
    const art = new Readability(document as any).parse();
    if (art?.textContent && art.textContent.trim().length > 200) return { title: art.title ?? "", text: art.textContent.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim() };
  } catch { /* fall through */ }
  document.querySelectorAll("script,style,noscript,nav,footer,header,svg").forEach((n: any) => n.remove());
  return { title: document.title ?? "", text: (document.body?.textContent ?? "").replace(/\s+/g, " ").trim() };
}

export function assertPublicUrl(u: string) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs can be fetched.");
  return url;
}

export async function fetchPage(u: string, opts: { maxChars?: number; signal?: AbortSignal; allowLocal?: boolean } = {}): Promise<{ url: string; title: string; text: string }> {
  const url = assertPublicUrl(u);
  if (!opts.allowLocal && !cfg.ALLOW_LOCAL_FETCH && BLOCKED_HOST.test(url.hostname)) throw new Error("Refusing to fetch a local/private address.");
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,text/plain,application/pdf" }, signal: opts.signal ?? AbortSignal.timeout(20000), redirect: "follow" });
  if (!r.ok) throw new Error(`Fetching ${u} returned ${r.status}.`);
  const type = r.headers.get("content-type") ?? "";
  if (/pdf/.test(type)) {
    const { pdfToText } = await import("./pdf.js");
    return { url: u, title: u, text: (await pdfToText(Buffer.from(await r.arrayBuffer()))).slice(0, opts.maxChars ?? 12000) };
  }
  const body = await r.text();
  const { title, text } = /html/.test(type) || /^\s*</.test(body) ? htmlToText(body) : { title: u, text: body };
  return { url: u, title, text: text.slice(0, opts.maxChars ?? 12000) };
}

export async function searchStatus(): Promise<{ backend: string; ok: boolean; detail?: string }> {
  const backend = await chooseBackend();
  if (backend === "brave") return { backend, ok: !!cfg.BRAVE_API_KEY, detail: cfg.BRAVE_API_KEY ? undefined : "BRAVE_API_KEY missing" };
  if (backend === "searxng") { const ok = await searxngReachable(); return { backend, ok, detail: ok ? undefined : "SearXNG is not reachable (docker compose up -d searxng)" }; }
  if (backend === "wikipedia") return { backend, ok: true, detail: "Limited: only Wikipedia. General web search needs SearXNG (docker compose up -d searxng) or a free Brave key (BRAVE_API_KEY)." };
  return { backend, ok: true, detail: "keyless DuckDuckGo; may be rate limited. SearXNG or Brave is more reliable." };
}
