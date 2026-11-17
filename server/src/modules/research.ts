import { getDb, now, uid } from "../db.js";
import { routedJSON, runRouted, type RouteInfo } from "../router/router.js";
import { fetchPage, search, type SearchResult } from "./search.js";
import { stripInvalidCites } from "../shared/cite.js";

export interface Source { n: number; title: string; url: string; domain: string; snippet: string; text: string; fetched: boolean }
export interface Step { id: string; label: string; status: "running" | "done" | "error"; detail?: string; ms?: number }
export type ResearchEvent =
  | { event: "step"; data: Step } | { event: "plan"; data: { queries: string[]; fresh: boolean } }
  | { event: "sources"; data: Omit<Source, "text">[] } | { event: "route"; data: RouteInfo }
  | { event: "text"; data: { text: string } } | { event: "final"; data: { text: string } }
  | { event: "followups"; data: string[] } | { event: "done"; data: { id: string } } | { event: "error"; data: { message: string; fix?: string } };

export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_|mc_|igshid)/i.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.replace(/^(www|m|amp)\./, "");
    if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
    x.searchParams.sort();
    let s = x.toString().replace(/\/$/, "");
    if (x.protocol === "http:") s = s.replace(/^http:/, "https:");
    return s.toLowerCase();
  } catch { return u.toLowerCase(); }
}
export function dedupeResults(rs: SearchResult[]): SearchResult[] {
  const seen = new Set<string>(), seenTitle = new Set<string>(), out: SearchResult[] = [];
  for (const r of rs) {
    const k = normalizeUrl(r.url), t = r.title.toLowerCase().replace(/\W+/g, " ").trim();
    if (seen.has(k) || (t.length > 12 && seenTitle.has(t))) continue;
    seen.add(k); seenTitle.add(t); out.push(r);
  }
  return out;
}
const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** Run async tasks with bounded concurrency. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!, k); } }));
  return out;
}

async function planQueries(question: string, deep: boolean, signal?: AbortSignal): Promise<{ queries: string[]; fresh: boolean }> {
  try {
    const { value } = await routedJSON<{ queries?: string[]; fresh?: boolean }>({
      task: "quick", purpose: "research-plan", signal, maxTokens: 300, temperature: 0.2,
      messages: [
        { role: "system", content: `You plan web research. Break the question into ${deep ? "3 to 5" : "2 to 3"} diverse, specific search queries (different angles, no duplicates). "fresh" is true if recent information matters. Reply with ONLY JSON {"queries":["..."],"fresh":false}.` },
        { role: "user", content: question },
      ],
    });
    const qs = [...new Set((value.queries ?? []).map((q) => String(q).trim()).filter(Boolean))].slice(0, deep ? 5 : 3);
    if (qs.length) return { queries: qs, fresh: !!value.fresh };
  } catch (e: any) { if (e?.name === "AbortError") throw e; }
  return { queries: [question], fresh: /\b(latest|today|news|current|recent|2026)\b/i.test(question) };
}

async function gather(queries: string[], fresh: boolean, have: Source[], maxNew: number, signal?: AbortSignal, onStep?: (s: Step) => void): Promise<Source[]> {
  const t0 = Date.now();
  const lists = await Promise.all(queries.map((q) => search(q, { timeRange: fresh ? "month" : undefined, limit: 8, signal }).catch(() => [] as SearchResult[])));
  const known = new Set(have.map((s) => normalizeUrl(s.url)));
  const fresh1 = dedupeResults(lists.flat()).filter((r) => !known.has(normalizeUrl(r.url))).slice(0, maxNew);
  onStep?.({ id: "search", label: `Searched ${queries.length} queries`, status: "done", detail: `${fresh1.length} new unique results`, ms: Date.now() - t0 });
  const t1 = Date.now();
  const fetched = await pool(fresh1, 5, async (r) => {
    try { const p = await fetchPage(r.url, { maxChars: 6000, signal }); return { text: p.text || r.snippet, fetched: !!p.text }; }
    catch { return { text: r.snippet, fetched: false }; }
  });
  onStep?.({ id: "fetch", label: `Read ${fetched.filter((f) => f.fetched).length} pages`, status: "done", detail: `${fetched.length - fetched.filter((f) => f.fetched).length} fell back to snippets`, ms: Date.now() - t1 });
  return fresh1.map((r, i) => ({ n: 0, title: r.title, url: r.url, domain: domainOf(r.url), snippet: r.snippet, text: fetched[i]!.text, fetched: fetched[i]!.fetched }));
}

export async function* runResearch(o: { query: string; deep?: boolean; signal?: AbortSignal }): AsyncGenerator<ResearchEvent> {
  const { query, deep = false, signal } = o;
  const steps: Step[] = [];
  const queue: ResearchEvent[] = [];
  const step = (s: Step) => { const i = steps.findIndex((x) => x.id === s.id); if (i >= 0) steps[i] = s; else steps.push(s); queue.push({ event: "step", data: s }); };
  const flush = function* () { while (queue.length) yield queue.shift()!; };
  const t0 = Date.now();
  try {
    step({ id: "plan", label: "Planning queries", status: "running" });
    yield* flush();
    const plan = await planQueries(query, deep, signal);
    step({ id: "plan", label: "Planned queries", status: "done", detail: plan.queries.join(" · "), ms: Date.now() - t0 });
    yield { event: "plan", data: plan };
    yield* flush();

    step({ id: "search", label: "Searching the web", status: "running" });
    yield* flush();
    let sources = await gather(plan.queries, plan.fresh, [], deep ? 14 : 8, signal, step);
    yield* flush();

    if (deep && sources.length) {
      step({ id: "gap", label: "Looking for gaps", status: "running" });
      yield* flush();
      try {
        const brief = sources.slice(0, 8).map((s, i) => `[${i + 1}] ${s.title}: ${s.text.slice(0, 400)}`).join("\n");
        const { value } = await routedJSON<{ missing?: string; queries?: string[] }>({
          task: "reasoning", purpose: "research-gap", signal, maxTokens: 300, temperature: 0.2,
          messages: [{ role: "system", content: 'You review research notes. State what important aspect of the question is still missing or weakly supported, and give 1-3 new search queries that would fill it. Reply with ONLY JSON {"missing":"...","queries":["..."]}.' }, { role: "user", content: `Question: ${query}\n\nNotes:\n${brief}` }],
        });
        const more = (value.queries ?? []).map(String).filter(Boolean).slice(0, 3);
        step({ id: "gap", label: "Gap analysis", status: "done", detail: value.missing?.slice(0, 200) });
        yield* flush();
        if (more.length) {
          step({ id: "gap-search", label: "Filling gaps", status: "running", detail: more.join(" · ") });
          yield* flush();
          sources = [...sources, ...(await gather(more, plan.fresh, sources, 6, signal, (s) => step({ ...s, id: `gap-${s.id}` })))];
          step({ id: "gap-search", label: "Filled gaps", status: "done", detail: `${sources.length} sources total` });
          yield* flush();
        }
      } catch (e: any) { if (e?.name === "AbortError") throw e; step({ id: "gap", label: "Gap analysis skipped", status: "error", detail: e.message }); yield* flush(); }
    }

    sources = sources.slice(0, deep ? 16 : 10).map((s, i) => ({ ...s, n: i + 1 }));
    if (!sources.length) { yield { event: "error", data: { message: "The search returned no results.", fix: "Check the search backend in Settings (SearXNG running, or SEARCH_BACKEND=brave with a key), or rephrase the question." } }; return; }
    yield { event: "sources", data: sources.map(({ text: _t, ...s }) => s) };

    step({ id: "write", label: "Writing answer", status: "running" });
    yield* flush();
    const notes = sources.map((s) => `[${s.n}] ${s.title} (${s.domain})\n${s.text.slice(0, deep ? 5000 : 3500)}`).join("\n\n---\n\n");
    let text = "", info: RouteInfo | undefined;
    for await (const ev of runRouted({
      task: "research", purpose: "research", signal, temperature: 0.3,
      messages: [
        { role: "system", content: `You are a meticulous research analyst. Answer the question using ONLY the numbered sources. Cite every factual claim with [n] (e.g. "...grew 12% [2][5]"). Never cite a number that is not in the list, never invent facts, and say plainly when sources disagree or do not cover something. Structure: a direct answer first, then supporting detail with headings or bullets if helpful. Today is ${new Date().toDateString()}.` },
        { role: "user", content: `Question: ${query}\n\nSources:\n${notes}` },
      ],
    })) {
      if (ev.type === "route") { info = ev.info; yield { event: "route", data: ev.info }; }
      else if (ev.type === "text") { text += ev.text; yield { event: "text", data: { text: ev.text } }; }
    }
    const clean = stripInvalidCites(text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), sources.length);
    if (clean !== text) yield { event: "final", data: { text: clean } };
    step({ id: "write", label: "Answer written", status: "done", ms: Date.now() - t0 });
    yield* flush();

    let followups: string[] = [];
    try {
      const { value } = await routedJSON<{ followups?: string[] }>({ task: "quick", purpose: "research-followups", signal, maxTokens: 200, temperature: 0.5,
        messages: [{ role: "system", content: 'Suggest 3 short, genuinely useful follow-up questions. Reply with ONLY JSON {"followups":["...","...","..."]}.' }, { role: "user", content: `Question: ${query}\n\nAnswer:\n${clean.slice(0, 1500)}` }] });
      followups = (value.followups ?? []).map(String).slice(0, 3);
    } catch (e: any) { if (e?.name === "AbortError") throw e; }
    if (followups.length) yield { event: "followups", data: followups };

    const id = uid("r_");
    getDb().prepare("INSERT INTO research(id,query,deep,answer,sources,steps,followups,model,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, query, deep ? 1 : 0, clean, JSON.stringify(sources.map(({ text: _t, ...s }) => s)), JSON.stringify(steps), JSON.stringify(followups), info?.model ?? null, now());
    yield { event: "done", data: { id } };
  } catch (e: any) {
    if (e?.name === "AbortError" || signal?.aborted) return;
    yield { event: "error", data: { message: e.message, fix: e.fix } };
  }
}
