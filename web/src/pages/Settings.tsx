import { useState } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/hooks";

function Memories() {
  const { data, reload } = useFetch<any>("/api/memories");
  const [text, setText] = useState(""); const [url, setUrl] = useState<string | null>(null); const [status, setStatus] = useState<any>();
  const u = url ?? data?.memoryos?.url ?? "";
  return (
    <section className="card p-4">
      <div className="label mb-2">Long-term memory</div>
      <div className="mb-3 flex gap-2">
        <input className="input" placeholder="MemoryOS MCP URL (optional), e.g. http://localhost:3000/mcp" value={u} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn" onClick={async () => setStatus(await api.put("/api/memories/memoryos", { url: u }))}>Connect</button>
      </div>
      {status && <p className="mb-2 text-[12px] text-dim">{status.connected ? `Connected. read: ${status.read ?? "—"} · write: ${status.write ?? "—"}` : u ? "Could not connect; using the local memory table." : "Using the local memory table."}</p>}
      <div className="mb-2 flex gap-2"><input className="input" placeholder="Add a memory, e.g. I prefer metric units" value={text} onChange={(e) => setText(e.target.value)} /><button className="btn btn-primary" disabled={text.length < 2} onClick={async () => { await api.post("/api/memories", { text }); setText(""); reload(); }}>Add</button></div>
      <div className="max-h-48 overflow-y-auto">{data?.memories.map((m: any) => <div key={m.id} className="flex gap-2 py-1 text-[13px]"><span className="min-w-0 flex-1">{m.text}</span><button className="text-faint hover:text-bad" onClick={async () => { await api.del(`/api/memories/${m.id}`); reload(); }}>✕</button></div>)}
        {data?.memories.length === 0 && <p className="text-[12px] text-faint">Nothing yet. Say “remember that …” in chat.</p>}</div>
    </section>
  );
}

export function Settings() {
  const { data, reload } = useFetch<any>("/api/health", [], 8000);
  const [test, setTest] = useState<any>();
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setTest(await api.post("/api/providers/test")); await reload(); } catch (e: any) { setTest({ error: e.message }); } finally { setBusy(false); } };
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Settings & health</h1>
          <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? "Testing…" : "Test providers"}</button>
        </div>
        {!data ? <p className="text-dim">Loading…</p> : (
          <>
            <section className="card p-4">
              <div className="label mb-2">Providers</div>
              <div className="divide-y divide-line">
                {data.providers.map((p: any) => (
                  <div key={p.id} className="flex items-center gap-3 py-2">
                    <span className={`dot ${p.cooldownSec ? "bg-warn" : p.enabled ? "bg-good" : "bg-faint"}`} />
                    <span className="w-40 font-medium">{p.label}</span>
                    <span className="chip">{p.paid ? "paid" : p.local ? "local" : "free"}</span>
                    <span className="text-dim text-[12px]">{p.enabled ? `${p.models} models` : p.fix}</span>
                    {p.cooldownSec > 0 && <span className="ml-auto text-warn text-[12px]">cooling down {p.cooldownSec}s</span>}
                    {p.count429 > 0 && <span className="ml-auto text-faint text-[12px]">{p.count429}× 429</span>}
                  </div>
                ))}
              </div>
            </section>
            <section className="grid gap-4 md:grid-cols-3">
              <div className="card p-4"><div className="label mb-1">Search</div><div>{data.search.backend} <span className={data.search.ok ? "text-good" : "text-bad"}>●</span></div><div className="text-[12px] text-dim">{data.search.detail}</div></div>
              <div className="card p-4"><div className="label mb-1">Media</div><div>{data.media.backend} <span className={data.media.ok ? "text-good" : "text-bad"}>●</span></div><div className="text-[12px] text-dim">{data.media.detail}</div></div>
              <div className="card p-4"><div className="label mb-1">Hardware</div><div>{data.hardware.memoryGb} GB · {data.gpu.kind}</div><div className="text-[12px] text-dim">tier {data.hardware.recommended.label}</div></div>
            </section>
            <section className="card p-4">
              <div className="label mb-2">Loaded local models · MCP</div>
              <div className="text-[13px] text-dim">{data.localModels.length ? data.localModels.map((m: any) => `${m.name} (${m.sizeGb} GB)`).join(", ") : "none loaded"}</div>
              <div className="mt-1 text-[13px] text-dim">{data.mcp.length ? data.mcp.map((m: any) => `${m.name}: ${m.connected ? "connected" : m.error}`).join(", ") : "no MCP servers connected"}</div>
            </section>
          </>
        )}
        <Memories />
        {test && (
          <section className="card p-4">
            <div className="label mb-2">Last test</div>
            {test.error ? <p className="text-bad">{test.error}</p> : (
              <div className="space-y-1 text-[13px]">
                {test.providers.map((p: any) => <div key={p.provider}><span className={p.ok ? "text-good" : "text-bad"}>●</span> {p.label}: {p.ok ? `${p.models} models` : `${p.error} — ${p.fix ?? ""}`}</div>)}
                <div className="label mt-3 mb-1">Router refs</div>
                {test.refs.filter((r: any) => !r.skipped).map((r: any) => <div key={r.ref} className="font-mono text-[12px]"><span className={r.ok ? "text-good" : "text-bad"}>{r.ok ? "✓" : "✗"}</span> {r.ref} {r.ms ? `${r.ms}ms` : ""} {r.error ? <span className="text-dim">— {r.error}</span> : null}</div>)}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
