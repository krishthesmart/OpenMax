import { useCallback, useEffect, useState } from "react";
import { api, subscribeSSE } from "../lib/api";
import { useFetch } from "../lib/hooks";
import { ApprovalCard } from "../components/ApprovalCard";
import { Markdown } from "../components/Markdown";

const EXAMPLES = ["Write a Python script that computes the first 50 primes, run it, and give me the results as a PDF report", "Build a small single-page website for a coffee shop and deliver it so I can preview it", "Find the three most recent posts on the Hacker News front page about open-source AI and save a summary to notes.txt", "Look up the weather forecast for Lisbon this weekend and create a calendar event for the best day for a picnic", "Draft an email to team@example.com summarizing today's top tech news (I will approve before it sends)"];
const STATUS: Record<string, string> = { ok: "text-good", error: "text-bad", blocked: "text-bad", rejected: "text-warn", pending_approval: "text-warn" };


function Csv({ text }: { text: string }) {
  const rows: string[][] = []; let cur: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]!; if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; } else if (c === '"') q = true; else if (c === ",") { cur.push(cell); cell = ""; } else if (c === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; } else if (c !== "\r") cell += c; }
  if (cell || cur.length) { cur.push(cell); rows.push(cur); }
  return <div className="overflow-auto"><table className="w-full text-[12px]"><thead><tr>{rows[0]?.map((h, i) => <th key={i} className="border border-line bg-panel2 px-2 py-1 text-left">{h}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="max-w-[360px] border border-line px-2 py-1 align-top">{c}</td>)}</tr>)}</tbody></table></div>;
}

function DeliverablePreview({ d, onClose }: { d: any; onClose: () => void }) {
  const url = `/api/agent/deliverables/${d.id}`;
  const [text, setText] = useState<string>();
  const textual = /^text\/(markdown|csv|plain)|application\/json/.test(d.mime);
  useEffect(() => { setText(undefined); if (textual) fetch(url).then((r) => r.text()).then(setText).catch(() => setText("Could not load this file.")); }, [url, textual]);
  const body = d.kind === "site" || d.mime === "text/html" ? <iframe title={d.title} src={url} sandbox="allow-scripts allow-forms" className="h-full w-full bg-white" />
    : d.mime === "application/pdf" ? <iframe title={d.title} src={url} className="h-full w-full bg-white" />
    : d.mime.startsWith("image/") ? <div className="grid h-full place-items-center overflow-auto p-4"><img src={url} alt={d.title} className="max-h-full max-w-full" /></div>
    : d.mime === "text/csv" ? <div className="p-4">{text === undefined ? "Loading…" : <Csv text={text} />}</div>
    : d.mime === "text/markdown" ? <div className="p-5">{text === undefined ? "Loading…" : <Markdown text={text} />}</div>
    : textual ? <pre className="whitespace-pre-wrap p-4 text-[12px]">{text ?? "Loading…"}</pre>
    : <div className="grid h-full place-items-center text-dim"><div className="text-center"><p>No inline preview for this file type.</p><a className="btn btn-primary mt-3" href={`${url}?download=1`}>Download {d.title}</a></div></div>;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-5" onClick={onClose}>
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden rounded-xl border border-line bg-bg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-2"><b className="truncate">{d.title}</b><span className="chip">{d.kind === "site" ? "website" : d.mime}</span><a className="btn ml-auto !py-0.5" href={`${url}?download=1`}>Download</a><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      </div>
    </div>
  );
}

function PlanList({ plan }: { plan: { text: string; status: string }[] }) {
  const done = plan.filter((p) => p.status === "done").length;
  return (
    <div className="card p-3 text-[13px]">
      <div className="mb-1.5 flex items-center gap-2"><span className="label">Plan</span><span className="text-[11px] text-faint">{done}/{plan.length} done</span><div className="ml-auto h-1.5 w-32 overflow-hidden rounded bg-line"><div className="h-full bg-good transition-all" style={{ width: `${(done / plan.length) * 100}%` }} /></div></div>
      {plan.map((p, i) => <div key={i} className={`flex gap-2 py-0.5 ${p.status === "done" ? "text-dim line-through" : p.status === "doing" ? "text-accent" : "text-ink"}`}><span className="w-4">{p.status === "done" ? "✓" : p.status === "doing" ? "▶" : "○"}</span>{p.text}</div>)}
    </div>
  );
}

function RunView({ id }: { id: string }) {
  const [d, setD] = useState<any>(); const [live, setLive] = useState(""); const [thought, setThought] = useState(""); const [shot, setShot] = useState<string | null>(null); const [view, setView] = useState<any>(null);
  const load = useCallback(async () => { try { setD(await api.get(`/api/agent/runs/${id}`)); } catch { /* ignore */ } }, [id]);
  useEffect(() => {
    setD(undefined); setLive(""); setThought(""); void load();
    return subscribeSSE(`/api/agent/runs/${id}/events`, (ev, data) => {
      if (ev === "status") setLive(data.text); else if (ev === "thought") setThought(data.text);
      if (["step", "approval", "done", "error", "snapshot", "plan", "deliverable", "wide", "terminal"].includes(ev)) { setLive(""); void load(); }
    });
  }, [id, load]);
  if (!d) return <div className="p-6 text-dim">Loading…</div>;
  const { run, steps, approvals } = d; const pending = approvals.filter((a: any) => a.status === "pending");
  const running = run.status === "running";
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-5">
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="label">Goal</div><div className="text-[15px]">{run.goal}</div></div>
        <span className={`chip ${run.status === "done" ? "!text-good" : run.status === "error" ? "!text-bad" : ""}`}>{run.unattended ? "scheduled · " : ""}{run.status}</span>
        {running && <button className="btn btn-danger" onClick={async () => { await api.post(`/api/agent/runs/${id}/stop`); void load(); }}>■ Stop</button>}</div>
      {pending.map((a: any) => <ApprovalCard key={a.id} a={a} onDone={load} />)}
      {run.plan?.length > 0 && <PlanList plan={run.plan} />}
      {d.deliverables?.length > 0 && (
        <div className="card p-3"><div className="label mb-2">Deliverables</div>
          <div className="grid gap-2 sm:grid-cols-2">{d.deliverables.map((x: any) => <button key={x.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-left hover:border-accent/60" onClick={() => setView(x)}><span className="text-lg">{x.kind === "site" ? "🌐" : x.mime === "application/pdf" ? "📕" : x.mime.startsWith("image/") ? "🖼" : x.mime === "text/csv" ? "📊" : x.mime.includes("presentation") ? "📽" : "📄"}</span><span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{x.title}</span><span className="text-[11px] text-faint">{x.kind === "site" ? "website" : x.mime} · {(x.size / 1024).toFixed(1)} KB</span></span></button>)}</div></div>
      )}
      {view && <DeliverablePreview d={view} onClose={() => setView(null)} />}
      <div className="space-y-2">
        {steps.map((s: any) => (
          <div key={s.id} className="card p-3 text-[13px]">
            <div className="flex items-center gap-2"><span className="w-5 text-faint">{s.n}</span><code className="rounded bg-panel2 px-1.5 py-0.5 text-accent">{s.tool}</code><span className={`chip ${STATUS[s.status] ?? ""}`}>{s.status.replace("_", " ")}</span>
              <span className="min-w-0 flex-1 truncate text-dim" title={JSON.stringify(s.args)}>{Object.values(s.args).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" · ").slice(0, 120)}</span></div>
            {s.tool === "shell_run" && <div className="mt-1.5 rounded-lg bg-black/60 p-2 font-mono text-[11.5px]"><div className="text-good">$ {s.args.command}</div><pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap text-dim">{s.result}</pre></div>}
            {s.result && s.tool !== "finish" && s.tool !== "shell_run" && <details className="mt-1.5"><summary className="cursor-pointer text-[12px] text-faint">result</summary><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[12px] text-dim">{s.result}</pre></details>}
            {s.screenshot && <button className="mt-2 block" onClick={() => setShot(`/api/agent/shots/${id}/${s.screenshot}`)}><img src={`/api/agent/shots/${id}/${s.screenshot}`} alt="screenshot" className="h-24 rounded-lg border border-line" /></button>}
          </div>
        ))}
        {running && !pending.length && <div className="animate-pulse px-1 text-[13px] text-dim">{live || "Working…"}{thought && <div className="mt-1 text-faint">💭 {thought}</div>}</div>}
      </div>
      {!running && run.result && <div className="card p-4"><div className="label mb-1">Result</div><Markdown text={run.result} /></div>}
      {shot && <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6" onClick={() => setShot(null)}><img src={shot} alt="" className="max-h-full max-w-full rounded-lg" /></div>}
    </div>
  );
}

function Schedules() {
  const { data, reload } = useFetch<any>("/api/schedules", [], 8000);
  const [f, setF] = useState({ name: "", cron: "0 8 * * 1-5", goal: "" }); const [err, setErr] = useState<any>();
  const save = async () => { setErr(undefined); try { await api.post("/api/schedules", f); setF({ name: "", cron: "0 8 * * 1-5", goal: "" }); reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-5">
      <div className="card space-y-2 p-4">
        <div className="label">New schedule</div>
        <input className="input" placeholder="Name (e.g. Morning brief)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="flex gap-2"><input className="input !w-48 font-mono" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} /><span className="self-center text-[12px] text-dim">min hour day month weekday</span></div>
        <textarea className="input min-h-20" placeholder="What should the agent do each time?" value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} />
        {err && <p className="text-[12px] text-bad">{err.message} {err.fix}</p>}
        <button className="btn btn-primary" disabled={!f.name || !f.goal} onClick={save}>Save schedule</button>
        <p className="text-[12px] text-faint">Scheduled runs are unattended: emails and deletions are queued in your Inbox and only happen after you approve them there. Browser actions that need approval are refused.</p>
      </div>
      {data?.schedules.map((s: any) => (
        <div key={s.id} className="card flex items-center gap-3 p-3 text-[13px]">
          <input type="checkbox" checked={s.enabled} onChange={async (e) => { await api.post("/api/schedules", { ...s, enabled: e.target.checked }); reload(); }} title="Enabled" />
          <div className="min-w-0 flex-1"><div className="font-medium">{s.name} <code className="ml-1 text-[11px] text-faint">{s.cron}</code></div><div className="truncate text-dim">{s.goal}</div>{s.last_run && <div className="text-[11px] text-faint">last run {new Date(s.last_run).toLocaleString()}</div>}</div>
          <button className="btn" onClick={async () => { await api.post(`/api/schedules/${s.id}/run`); }}>Run now</button>
          <button className="btn btn-danger" onClick={async () => { await api.del(`/api/schedules/${s.id}`); reload(); }}>Delete</button>
        </div>
      ))}
    </div>
  );
}

export function Agent() {
  const runs = useFetch<any>("/api/agent/runs", [], 4000);
  const [tab, setTab] = useState<"run" | "sched" | "wide">("run"); const [long, setLong] = useState(false); const [wide, setWide] = useState({ items: "", task: "", columns: "" }); const [goal, setGoal] = useState(""); const [sel, setSel] = useState<string | null>(null); const [err, setErr] = useState<any>();
  const start = async (g = goal) => { setErr(undefined); try { const r = await api.post("/api/agent/runs", { goal: g, long }); setGoal(""); setSel(r.id); setTab("run"); runs.reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  const startWide = async () => { setErr(undefined); try { const r = await api.post("/api/agent/wide", { items: wide.items.split("\n").map((x) => x.trim()).filter(Boolean), task: wide.task, columns: wide.columns.split(",").map((x) => x.trim()).filter(Boolean) }); setSel(r.id); setTab("run"); runs.reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  const caps = useFetch<any>("/api/agent/capabilities");
  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line max-lg:hidden">
        <div className="flex gap-1 p-3">{([["run", "Runs"], ["wide", "Wide"], ["sched", "Schedules"]] as const).map(([k, l]) => <button key={k} className={`btn flex-1 justify-center !py-1 ${tab === k ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(k)}>{l}</button>)}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <button className="btn mb-2 w-full justify-center" onClick={() => { setSel(null); setTab("run"); }}>＋ New task</button>
          {runs.data?.runs.map((r: any) => <button key={r.id} onClick={() => { setSel(r.id); setTab("run"); }} className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] ${sel === r.id ? "bg-panel2" : "hover:bg-panel"}`}><span className={`dot ${r.status === "running" ? "animate-pulse bg-accent" : r.status === "done" ? "bg-good" : r.status === "error" ? "bg-bad" : "bg-faint"}`} /><span className="truncate">{r.goal}</span></button>)}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {tab === "sched" ? <Schedules /> : tab === "wide" ? (
          <div className="mx-auto max-w-2xl space-y-3 p-8">
            <h1 className="text-2xl font-semibold tracking-tight">Wide research</h1>
            <p className="text-dim">One researcher per item, run in parallel: each searches and reads the web, then you get a comparison table (CSV), a written synthesis and every source. Up to 40 items.</p>
            <textarea className="input min-h-40" placeholder={"One item per line, e.g.\nNotion\nObsidian\nLogseq"} value={wide.items} onChange={(e) => setWide({ ...wide, items: e.target.value })} />
            <input className="input" placeholder="What to find out about EACH item (e.g. pricing, offline support, open source?)" value={wide.task} onChange={(e) => setWide({ ...wide, task: e.target.value })} />
            <input className="input" placeholder="Optional columns, comma separated (e.g. Price, Open source, Platforms)" value={wide.columns} onChange={(e) => setWide({ ...wide, columns: e.target.value })} />
            {err && <p className="text-[13px] text-bad">{err.message} {err.fix}</p>}
            <button className="btn btn-primary" disabled={!wide.items.trim() || wide.task.length < 5} onClick={startWide}>Research {wide.items.split("\n").filter((x) => x.trim()).length || ""} items</button>
          </div>
        ) : sel ? <RunView id={sel} /> : (
          <div className="mx-auto max-w-2xl p-8">
            <h1 className="text-2xl font-semibold tracking-tight">What should the agent do?</h1>
            <p className="mt-1 text-dim">It searches, reads, browses in an isolated browser, works in a sandbox folder, and can email or schedule. It plans, writes and runs code in a sandbox, and hands back deliverables (reports, decks, sites). Anything irreversible (sending, buying, deleting, submitting personal data, network access for code) pauses for your click.</p>
            <textarea className="input mt-5 min-h-28 !text-[15px]" placeholder="Describe the goal…" value={goal} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && goal.trim().length > 2) void start(); }} />
            {err && <p className="mt-2 text-[13px] text-bad">{err.message} {err.fix}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-3"><button className="btn btn-primary" disabled={goal.trim().length < 3} onClick={() => start()}>Run agent ⌘↵</button><label className="flex items-center gap-1.5 text-[12px] text-dim" title="Up to 60 steps instead of 25"><input type="checkbox" checked={long} onChange={(e) => setLong(e.target.checked)} />long task (60 steps)</label></div>
            {caps.data && <p className="mt-2 text-[11px] text-faint">{caps.data.sandbox ? "🛡" : "⚠"} {caps.data.note}</p>}
            <div className="mt-8 space-y-2"><div className="label">Try</div>{EXAMPLES.map((e) => <button key={e} className="btn block w-full !whitespace-normal text-left" onClick={() => setGoal(e)}>{e}</button>)}</div>
          </div>
        )}
      </section>
    </div>
  );
}
