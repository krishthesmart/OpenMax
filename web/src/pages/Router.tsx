import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/hooks";

function Lane({ task, refs, statuses, suggestion, onChange, models }: { task: string; refs: string[]; statuses: Record<string, any>; suggestion?: string[]; onChange: (r: string[]) => void; models: string[] }) {
  const [add, setAdd] = useState("");
  const move = (i: number, d: number) => { const n = [...refs]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; onChange(n); };
  return (
    <div className="card p-3">
      <div className="mb-2 flex items-center gap-2"><span className="font-medium">{task}</span>
        {suggestion && suggestion.length > 0 && <button className="btn btn-ghost !py-0.5 text-[11px] text-accent" title={suggestion.join("\n")} onClick={() => onChange([...new Set([...suggestion, ...refs])])}>apply suggestion</button>}
      </div>
      <ol className="space-y-1">
        {refs.map((r, i) => {
          const s = statuses[r];
          return (
            <li key={r} className="flex items-center gap-2 rounded-md bg-bg px-2 py-1 font-mono text-[12px]">
              <span className="w-4 text-faint">{i + 1}</span>
              <span className={`dot ${s ? (s.ok ? "bg-good" : "bg-bad") : "bg-faint"}`} title={s ? (s.ok ? `alive ${s.ms ?? ""}ms${s.tools ? " · tools ✓" : ""}` : `dead: ${s.error}`) : "not tested yet"} />
              <span className="min-w-0 flex-1 truncate" title={r}>{r}</span>
              {s && !s.ok && <span className="chip !text-bad">dead</span>}
              {s?.tools && <span className="chip !text-good">tools</span>}
              <button className="text-faint hover:text-ink" onClick={() => move(i, -1)} aria-label="move up">↑</button>
              <button className="text-faint hover:text-ink" onClick={() => move(i, 1)} aria-label="move down">↓</button>
              <button className="text-faint hover:text-bad" onClick={() => onChange(refs.filter((x) => x !== r))} aria-label="remove">✕</button>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex gap-2">
        <input className="input !py-1 font-mono text-[12px]" list={`models-${task}`} placeholder="provider:model" value={add} onChange={(e) => setAdd(e.target.value)} />
        <datalist id={`models-${task}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
        <button className="btn" disabled={!/^[a-z0-9]+:.+/i.test(add)} onClick={() => { onChange([...refs, add]); setAdd(""); }}>add</button>
      </div>
    </div>
  );
}

export function RouterPage() {
  const { data, reload } = useFetch<any>("/api/router/config");
  const stats = useFetch<any>("/api/router/stats", [], 6000);
  const catalog = useFetch<any>("/api/providers/models");
  const [cfg, setCfg] = useState<any>();
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [text, setText] = useState("");
  const [explain, setExplain] = useState<any>();
  useEffect(() => { if (data && !dirty) setCfg(data.config); }, [data, dirty]);
  if (!cfg || !data) return <div className="p-6 text-dim">Loading…</div>;
  const models: string[] = Object.entries(catalog.data?.catalog ?? {}).flatMap(([p, ms]: any) => ms.filter((m: any) => m.kind === "chat").map((m: any) => `${p}:${m.id}`));
  const setLane = (task: string, refs: string[]) => { setCfg({ ...cfg, lanes: { ...cfg.lanes, [task]: refs } }); setDirty(true); };
  const save = async () => { try { await api.put("/api/router/config", cfg); setDirty(false); setMsg("Saved."); await reload(); } catch (e: any) { setMsg(e.message + (e.fix ? ` — ${e.fix}` : "")); } };
  const test = async () => { setTesting(true); try { await api.post("/api/providers/test"); await reload(); await catalog.reload(); } catch (e: any) { setMsg(e.message); } finally { setTesting(false); } };
  const ex = async () => { try { setExplain(await api.post("/api/router/explain", { text })); } catch (e: any) { setExplain({ error: e.message }); } };
  const st = stats.data;
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Router</h1>
          <span className="text-[12px] text-dim">First live model in each lane wins; errors and 429s fall through to the next.</span>
          <div className="ml-auto flex items-center gap-2">
            {msg && <span className="text-[12px] text-dim">{msg}</span>}
            <button className="btn" onClick={test} disabled={testing}>{testing ? "Testing…" : "Test providers"}</button>
            <button className="btn btn-primary" onClick={save} disabled={!dirty}>Save lanes</button>
          </div>
        </div>

        <section className="card p-4">
          <div className="label mb-2">Explain a prompt</div>
          <div className="flex gap-2"><input className="input" placeholder="Paste a prompt to see how it would be routed" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ex()} /><button className="btn btn-primary" onClick={ex} disabled={!text}>Explain</button></div>
          {explain && (explain.error ? <p className="mt-2 text-bad">{explain.error}</p> : (
            <div className="mt-3 space-y-1 text-[13px]">
              <div>Task <b>{explain.classification.task}</b> · {explain.classification.source} {explain.classification.confidence} · <span className="text-dim">{explain.classification.reason}</span></div>
              <div>Chosen <code className="text-accent">{explain.chosen ?? "none available"}</code>{explain.privacy && <span className="ml-2 chip">🔒 {explain.privacy}</span>}</div>
              <div className="text-dim">Order: {explain.candidates.map((c: any) => c.ref + (c.note ? ` (${c.note})` : "")).join(" → ") || "—"}</div>
              {explain.skipped.length > 0 && <div className="text-faint">Skipped: {explain.skipped.map((s: any) => `${s.ref} (${s.reason})`).join(", ")}</div>}
            </div>
          ))}
        </section>

        <section>
          <div className="label mb-2">Lanes</div>
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(cfg.lanes).map(([task, refs]: any) => <Lane key={task} task={task} refs={refs} statuses={data.statuses} suggestion={data.suggestions[task]} models={models} onChange={(r) => setLane(task, r)} />)}
          </div>
          <p className="mt-2 text-[12px] text-faint">Suggestions come from your live model catalog (size/capability keywords) and are never applied automatically. Paid-lane flagships ({Object.keys(cfg.paidLanes).join(", ")}) are only used when ENABLE_PAID=true.</p>
        </section>

        <section>
          <div className="label mb-2">Per-task stats</div>
          <div className="card overflow-x-auto">
            <table className="w-full text-[13px]"><thead className="text-left text-faint"><tr>{["Task", "Requests", "OK", "Avg latency", "Avg tok/s", "👍", "👎"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>{st?.byTask.map((r: any) => <tr key={r.task} className="border-t border-line"><td className="px-3 py-1.5">{r.task}</td><td className="px-3">{r.requests}</td><td className="px-3">{r.ok}</td><td className="px-3">{r.avg_latency ?? "—"} ms</td><td className="px-3">{r.avg_tps ?? "—"}</td><td className="px-3">{r.up}</td><td className="px-3">{r.down}</td></tr>)}
                {!st?.byTask.length && <tr><td colSpan={7} className="px-3 py-4 text-dim">No routed requests yet.</td></tr>}</tbody></table>
          </div>
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full text-[13px]"><thead className="text-left text-faint"><tr>{["Task", "Model", "Wins", "Failures", "429s", "Win rate", "Latency"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>{st?.byModel.map((r: any) => <tr key={r.task + r.model} className="border-t border-line"><td className="px-3 py-1.5">{r.task}</td><td className="px-3 font-mono text-[12px]">{r.model}</td><td className="px-3">{r.wins}</td><td className="px-3">{r.failures}</td><td className="px-3">{r.r429}</td><td className="px-3">{r.winRate}%</td><td className="px-3">{r.avgLatency ?? "—"} ms</td></tr>)}</tbody></table>
          </div>
        </section>
      </div>
    </div>
  );
}
