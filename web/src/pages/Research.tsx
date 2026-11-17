import { useRef, useState } from "react";
import { api, streamPost } from "../lib/api";
import { useFetch } from "../lib/hooks";
import { Markdown } from "../components/Markdown";

interface Step { id: string; label: string; status: string; detail?: string; ms?: number }
export function Research() {
  const [q, setQ] = useState(""); const [deep, setDeep] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]); const [sources, setSources] = useState<any[]>([]);
  const [text, setText] = useState(""); const [follow, setFollow] = useState<string[]>([]);
  const [route, setRoute] = useState<any>(); const [err, setErr] = useState<any>(); const [busy, setBusy] = useState(false); const [shown, setShown] = useState("");
  const [hl, setHl] = useState<number | null>(null);
  const ac = useRef<AbortController | null>(null);
  const hist = useFetch<any>("/api/research");

  const run = async (query = q) => {
    if (query.trim().length < 2 || busy) return;
    setQ(query); setSteps([]); setSources([]); setText(""); setFollow([]); setErr(undefined); setRoute(undefined); setBusy(true); setShown(query);
    ac.current = new AbortController();
    try {
      await streamPost("/api/research", { query, deep }, (ev, d) => {
        if (ev === "step") setSteps((s) => { const i = s.findIndex((x) => x.id === d.id); return i >= 0 ? s.map((x, j) => (j === i ? d : x)) : [...s, d]; });
        else if (ev === "sources") setSources(d);
        else if (ev === "route") setRoute(d);
        else if (ev === "text") setText((t) => t + d.text);
        else if (ev === "final") setText(d.text);
        else if (ev === "followups") setFollow(d);
        else if (ev === "error") setErr(d);
      }, ac.current.signal);
    } catch (e: any) { if (e.name !== "AbortError") setErr({ message: e.message, fix: e.fix }); }
    setBusy(false); hist.reload();
  };
  const open = async (id: string) => { const r = await api.get(`/api/research/${id}`); setQ(r.query); setShown(r.query); setText(r.answer); setSources(r.sources); setSteps(r.steps); setFollow(r.followups); setErr(undefined); setRoute(r.model ? { model: r.model, task: "research", source: "saved", confidence: 1 } : undefined); };
  const cite = (n: number) => { setHl(n); document.getElementById(`src-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => setHl(null), 1600); };

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 overflow-y-auto border-r border-line p-3 max-lg:hidden">
        <div className="label mb-2">History</div>
        {hist.data?.items.map((h: any) => (
          <div key={h.id} className="group flex items-center rounded-lg px-2 py-1.5 text-[13px] hover:bg-panel"><button className="min-w-0 flex-1 truncate text-left" onClick={() => open(h.id)}>{h.deep ? "🔬 " : ""}{h.query}</button>
            <button className="hidden text-faint hover:text-bad group-hover:block" onClick={async () => { await api.del(`/api/research/${h.id}`); hist.reload(); }}>✕</button></div>
        ))}
        {hist.data?.items.length === 0 && <p className="text-[12px] text-faint">No research yet.</p>}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-6">
          <div className="flex gap-2"><input className="input !py-3 !text-[15px]" placeholder="Ask anything that needs sources…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
            {busy ? <button className="btn btn-danger" onClick={() => ac.current?.abort()}>■ Stop</button> : <button className="btn btn-primary" onClick={() => run()} disabled={q.trim().length < 2}>Research</button>}</div>
          <label className="mt-2 flex items-center gap-2 text-[12px] text-dim"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />Deep mode: adds a gap-analysis round and reads more sources (slower)</label>

          {steps.length > 0 && (
            <div className="card mt-5 p-3">
              <div className="label mb-1.5">Live steps</div>
              {steps.map((s) => <div key={s.id} className="flex gap-2 py-0.5 text-[13px]"><span className={s.status === "done" ? "text-good" : s.status === "error" ? "text-bad" : "animate-pulse text-accent"}>{s.status === "done" ? "✓" : s.status === "error" ? "✗" : "●"}</span><span>{s.label}</span><span className="min-w-0 flex-1 truncate text-dim">{s.detail}</span>{s.ms ? <span className="text-faint">{(s.ms / 1000).toFixed(1)}s</span> : null}</div>)}
            </div>
          )}
          {err && <div className="mt-4 rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px]"><div className="text-bad">{err.message}</div>{err.fix && <div className="mt-1 text-dim">{err.fix}</div>}</div>}
          {sources.length > 0 && (
            <div className="mt-5 grid grid-cols-2 gap-2 md:grid-cols-3">
              {sources.map((s) => <a key={s.n} id={`src-${s.n}`} href={s.url} target="_blank" rel="noreferrer" className={`card block p-2.5 transition ${hl === s.n ? "!border-accent" : "hover:border-accent/50"}`}><div className="flex items-center gap-1.5 text-[11px] text-dim"><span className="cite !align-baseline">{s.n}</span><span className="truncate">{s.domain}</span>{!s.fetched && <span title="only the search snippet was available">~</span>}</div><div className="mt-1 line-clamp-2 text-[12.5px]">{s.title}</div></a>)}
            </div>
          )}
          {(text || busy) && <div className="mt-5"><h2 className="mb-2 text-lg font-semibold">{shown}</h2>{route && <div className="mb-2"><span className="chip">⚡ {route.task} → {route.model}</span></div>}<Markdown text={text} sources={sources} onCite={cite} />{busy && !text && <span className="animate-pulse text-dim">Working…</span>}</div>}
          {follow.length > 0 && <div className="mt-6"><div className="label mb-2">Follow-ups</div><div className="flex flex-col gap-2">{follow.map((f) => <button key={f} className="btn justify-start !whitespace-normal text-left" onClick={() => run(f)}>↳ {f}</button>)}</div></div>}
          {!text && !busy && steps.length === 0 && <p className="mt-10 text-center text-dim">Plans 2–5 searches, reads the best pages, and writes a cited answer. Click a [n] to jump to its source.</p>}
        </div>
      </div>
    </div>
  );
}
