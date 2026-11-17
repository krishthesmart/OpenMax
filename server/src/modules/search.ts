import { cfg } from "../config.js";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export interface SearchResult { title: string; url: string; snippet: string; engine?: string }
export interface SearchOptions { timeRange?: "day" | "week" | "month" | "year"; limit?: number; signal?: AbortSignal }
export type StubSearch = (q: string, o: SearchOptions) => SearchResult[] | Promise<SearchResult[]>;
let stub: StubSearch = (q) => [
  { title: `Stub result for ${q}`, url: "https://example.test/a", snippet: `Snippet about ${q}.` },
  { title: `Another stub for ${q}`, url: "https://example.test/b", snippet: `More detail on ${q}.` },
];
export const setStubSearch = (f: StubSearch) => { stub = f; };
let stubPages: (url: string) => string | undefined = (u) => `Stub page text for ${u}. It discusses the topic in detail with several facts.`;
export const setStubPages = (f: (url: string) => string | undefined) => { stubPages = f; };

export async function search(q: string, o: SearchOptions = {}): Promise<SearchResult[]> {
  if (cfg.OPENMAX_STUB) return stub(q, o);
  const limit = o.limit ?? 8;
  if (cfg.SEARCH_BACKEND === "brave") {
    if (!cfg.BRAVE_API_KEY) throw new Error("Brave search selected but BRAVE_API_KEY is empty.");
    const fresh = o.timeRange ? { day: "pd", week: "pw", month: "pm", year: "py" }[o.timeRange] : undefined;
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", q); u.searchParams.set("count", String(limit)); if (fresh) u.searchParams.set("freshness", fresh);
    const r = await fetch(u, { headers: { "x-subscription-token": cfg.BRAVE_API_KEY, accept: "application/json" }, signal: o.signal });
    if (!r.ok) throw new Error(`Brave search returned ${r.status}.`);
    const j: any = await r.json();
    return (j.web?.results ?? []).slice(0, limit).map((x: any) => ({ title: x.title, url: x.url, snippet: x.description ?? "", engine: "brave" }));
  }
  const u = new URL(`${cfg.SEARXNG_URL}/search`);
  u.searchParams.set("q", q); u.searchParams.set("format", "json");
  if (o.timeRange) u.searchParams.set("time_range", o.timeRange);
  let r: Response;
  try { r = await fetch(u, { signal: o.signal ?? AbortSignal.timeout(15000) }); }
  catch { throw new Error("SearXNG is not reachable. Start it with `docker compose up -d searxng` or set SEARCH_BACKEND=brave with a BRAVE_API_KEY."); }
  if (!r.ok) throw new Error(`SearXNG returned ${r.status}. Ensure json is enabled under search.formats in its settings.yml.`);
  const j: any = await r.json();
  return (j.results ?? []).slice(0, limit).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "", engine: x.engine }));
}

export function htmlToText(html: string, url = "https://example.invalid/"): { title: string; text: string } {
  const { document } = parseHTML(html);
  try {
    const art = new Readability(document as any).parse();
    if (art?.textContent && art.textContent.trim().length > 200) return { title: art.title ?? "", text: art.textContent.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim() };
  } catch { /* fall through */ }
  document.querySelectorAll("script,style,noscript,nav,footer,header,svg").forEach((n: any) => n.remove());
  const text = (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  void url;
  return { title: document.title ?? "", text };
}

export function assertPublicUrl(u: string) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs can be fetched.");
  return url;
}

export async function fetchPage(u: string, opts: { maxChars?: number; signal?: AbortSignal; allowLocal?: boolean } = {}): Promise<{ url: string; title: string; text: string }> {
  const url = assertPublicUrl(u);
  if (cfg.OPENMAX_STUB) {
    const t = stubPages(u);
    if (t !== undefined) return { url: u, title: "Stub page", text: t.slice(0, opts.maxChars ?? 12000) };
  }
  if (!opts.allowLocal && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(url.hostname) && !cfg.OPENMAX_STUB)
    throw new Error("Refusing to fetch a local/private address.");
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; OpenMax/0.1)", accept: "text/html,text/plain,application/pdf" }, signal: opts.signal ?? AbortSignal.timeout(20000), redirect: "follow" });
  if (!r.ok) throw new Error(`Fetching ${u} returned ${r.status}.`);
  const type = r.headers.get("content-type") ?? "";
  if (/pdf/.test(type)) {
    const { pdfToText } = await import("./pdf.js");
    const t = await pdfToText(Buffer.from(await r.arrayBuffer()));
    return { url: u, title: u, text: t.slice(0, opts.maxChars ?? 12000) };
  }
  const body = await r.text();
  const { title, text } = /html/.test(type) || /^\s*</.test(body) ? htmlToText(body, u) : { title: u, text: body };
  return { url: u, title, text: text.slice(0, opts.maxChars ?? 12000) };
}

export async function searchStatus(): Promise<{ backend: string; ok: boolean; detail?: string }> {
  if (cfg.OPENMAX_STUB) return { backend: "stub", ok: true };
  if (cfg.SEARCH_BACKEND === "brave") return { backend: "brave", ok: !!cfg.BRAVE_API_KEY, detail: cfg.BRAVE_API_KEY ? undefined : "BRAVE_API_KEY missing" };
  try {
    const r = await fetch(`${cfg.SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(1500) });
    return { backend: "searxng", ok: r.ok || r.status === 404, detail: r.ok ? undefined : `status ${r.status}` };
  } catch { return { backend: "searxng", ok: false, detail: "not reachable (docker compose up -d searxng)" }; }
}
